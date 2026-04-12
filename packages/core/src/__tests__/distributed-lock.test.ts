/**
 * Integration tests for the distributed branch lock (BEC-48 fix).
 *
 * The `withBranchLock` function prevents simultaneous push+PR creation for the
 * same branch across multiple server instances by serialising via a shared lock
 * backend.
 *
 * Tests cover:
 *   1. Basic lock lifecycle (acquire → run fn → release)
 *   2. Lock released on fn() error (no deadlock)
 *   3. Concurrent calls for the SAME branch are serialised
 *   4. Concurrent calls for DIFFERENT branches run in parallel
 *   5. LockTimeoutError when lock cannot be acquired within the timeout
 *   6. No-op adapter (SQLite path) — always acquires immediately
 *   7. Simulated multi-instance PR creation race — FIXED with shared lock
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  withBranchLock,
  createNoopLockAdapter,
  LockTimeoutError,
  type LockAdapter,
} from "../pipeline/distributed-lock.js";

// ---------------------------------------------------------------------------
// Test helper: in-memory lock adapter (mirrors PostgreSQL advisory lock logic)
// ---------------------------------------------------------------------------
function createInMemoryLockAdapter(): LockAdapter & {
  heldKeys: Set<string>;
  acquireCallCount: number;
  releaseCallCount: number;
} {
  const heldKeys = new Set<string>();
  let acquireCallCount = 0;
  let releaseCallCount = 0;

  return {
    get heldKeys() {
      return heldKeys;
    },
    get acquireCallCount() {
      return acquireCallCount;
    },
    get releaseCallCount() {
      return releaseCallCount;
    },

    async tryAcquire(key: string): Promise<boolean> {
      acquireCallCount++;
      if (heldKeys.has(key)) return false;
      heldKeys.add(key);
      return true;
    },

    async release(key: string): Promise<void> {
      releaseCallCount++;
      heldKeys.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Basic lock lifecycle
// ---------------------------------------------------------------------------
describe("withBranchLock — basic lifecycle", () => {
  it("calls fn() and returns its result", async () => {
    const adapter = createInMemoryLockAdapter();
    const result = await withBranchLock(adapter, "agent/BEC-1", 1000, async () => 42);
    expect(result).toBe(42);
  });

  it("lock is held during fn() execution", async () => {
    const adapter = createInMemoryLockAdapter();
    let lockHeldDuringFn = false;

    await withBranchLock(adapter, "agent/BEC-1", 1000, async () => {
      lockHeldDuringFn = adapter.heldKeys.has("agent/BEC-1");
    });

    expect(lockHeldDuringFn).toBe(true);
  });

  it("lock is released after fn() completes", async () => {
    const adapter = createInMemoryLockAdapter();
    await withBranchLock(adapter, "agent/BEC-1", 1000, async () => {});
    expect(adapter.heldKeys.has("agent/BEC-1")).toBe(false);
    expect(adapter.releaseCallCount).toBe(1);
  });

  it("lock is released even when fn() throws", async () => {
    const adapter = createInMemoryLockAdapter();

    await expect(
      withBranchLock(adapter, "agent/BEC-1", 1000, async () => {
        throw new Error("fn failed");
      }),
    ).rejects.toThrow("fn failed");

    // Lock must be released so the next caller can acquire it
    expect(adapter.heldKeys.has("agent/BEC-1")).toBe(false);
    expect(adapter.releaseCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Concurrent serialisation for the same branch
// ---------------------------------------------------------------------------
describe("withBranchLock — same-branch serialisation (multi-instance fix)", () => {
  it("serialises two concurrent calls for the same branch", async () => {
    const adapter = createInMemoryLockAdapter();
    const log: string[] = [];
    let maxConcurrent = 0;
    let concurrent = 0;

    const makeTask = (label: string) => async () => {
      await withBranchLock(adapter, "agent/BEC-48", 5000, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        log.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, 30));
        log.push(`${label}:end`);
        concurrent--;
      });
    };

    // Both tasks start concurrently — only one should hold the lock at a time
    await Promise.all([makeTask("instanceA")(), makeTask("instanceB")()]);

    // Never more than one concurrent PR creation
    expect(maxConcurrent).toBe(1);
    // One must complete before the other starts
    expect(log[1]).toBe("instanceA:end"); // A ends before B starts
    expect(log[2]).toBe("instanceB:start");
    expect(log).toHaveLength(4);
  });

  it("simulates multi-instance duplicate PR race — FIXED", async () => {
    // This mirrors the scenario from reproduce-bec48-distributed-race.test.ts
    // but with the distributed lock applied.
    const sharedAdapter = createInMemoryLockAdapter(); // shared across "instances"

    const prUrls: string[] = [];
    let concurrentPrCreations = 0;
    let maxConcurrentPrCreations = 0;

    const makeInstanceTask = (instanceLabel: string) => async (): Promise<void> => {
      await withBranchLock(sharedAdapter, "agent/BEC-48-branch", 5000, async () => {
        concurrentPrCreations++;
        maxConcurrentPrCreations = Math.max(maxConcurrentPrCreations, concurrentPrCreations);
        // Simulate GitHub API latency for PR creation
        await new Promise((r) => setTimeout(r, 20));
        prUrls.push(`https://github.com/test/repo/pull/42`); // same branch → same PR target
        concurrentPrCreations--;
      });
    };

    // Both server instances receive the webhook simultaneously
    await Promise.all([
      makeInstanceTask("serverA")(),
      makeInstanceTask("serverB")(),
    ]);

    // Only one PR creation at a time — no duplicates due to locking
    expect(maxConcurrentPrCreations).toBe(1);
    // Both attempts ran (second one should detect existing PR in real code)
    expect(prUrls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Different branches can run in parallel
// ---------------------------------------------------------------------------
describe("withBranchLock — different branches run in parallel", () => {
  it("does not block concurrent calls for different branches", async () => {
    const adapter = createInMemoryLockAdapter();
    const log: string[] = [];
    let maxConcurrent = 0;
    let concurrent = 0;

    const makeTask = (branch: string) => async () => {
      await withBranchLock(adapter, branch, 5000, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        log.push(`${branch}:start`);
        await new Promise((r) => setTimeout(r, 30));
        log.push(`${branch}:end`);
        concurrent--;
      });
    };

    await Promise.all([
      makeTask("agent/issue-1")(),
      makeTask("agent/issue-2")(),
    ]);

    // Different branches can overlap — no artificial serialisation
    expect(maxConcurrent).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. LockTimeoutError
// ---------------------------------------------------------------------------
describe("withBranchLock — timeout", () => {
  it("throws LockTimeoutError when lock cannot be acquired within timeoutMs", async () => {
    // Adapter that never releases (simulates another instance holding the lock)
    const neverReleasingAdapter: LockAdapter = {
      async tryAcquire(_key: string): Promise<boolean> {
        return false; // lock always held by another instance
      },
      async release(_key: string): Promise<void> {},
    };

    await expect(
      withBranchLock(neverReleasingAdapter, "agent/stuck-branch", 300, async () => {}),
    ).rejects.toThrow(LockTimeoutError);
  });

  it("LockTimeoutError message includes the branch name", async () => {
    const neverReleasingAdapter: LockAdapter = {
      async tryAcquire(_key: string): Promise<boolean> {
        return false;
      },
      async release(_key: string): Promise<void> {},
    };

    const err = await withBranchLock(
      neverReleasingAdapter,
      "agent/my-feature-branch",
      200,
      async () => {},
    ).catch((e) => e);

    expect(err).toBeInstanceOf(LockTimeoutError);
    expect(err.message).toContain("agent/my-feature-branch");
    expect(err.name).toBe("LockTimeoutError");
  });

  it("succeeds when lock becomes available before timeout", async () => {
    let callCount = 0;
    const adapter: LockAdapter = {
      async tryAcquire(_key: string): Promise<boolean> {
        callCount++;
        // Fail the first two attempts, succeed on the third
        return callCount >= 3;
      },
      async release(_key: string): Promise<void> {},
    };

    const result = await withBranchLock(adapter, "agent/branch", 5000, async () => "ok");
    expect(result).toBe("ok");
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 5. No-op adapter (SQLite / single-process path)
// ---------------------------------------------------------------------------
describe("createNoopLockAdapter — SQLite passthrough", () => {
  it("always acquires immediately", async () => {
    const adapter = createNoopLockAdapter();

    const result = await withBranchLock(adapter, "any-branch", 100, async () => "done");
    expect(result).toBe("done");
  });

  it("allows concurrent calls (no serialisation)", async () => {
    const adapter = createNoopLockAdapter();
    let maxConcurrent = 0;
    let concurrent = 0;

    const makeTask = () => async () => {
      await withBranchLock(adapter, "same-branch", 1000, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
      });
    };

    await Promise.all([makeTask()(), makeTask()()]);

    // Noop adapter doesn't serialise — both run concurrently
    expect(maxConcurrent).toBe(2);
  });

  it("tryAcquire always returns true", async () => {
    const adapter = createNoopLockAdapter();
    const acquired = await adapter.tryAcquire("any-key");
    expect(acquired).toBe(true);
  });
});

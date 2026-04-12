/**
 * BEC-48 Reproduction: Multi-instance PR creation race condition
 *
 * The pipeline runner serialises push/PR creation with an in-process queue
 * (concurrency=1). This queue lives INSIDE each PipelineRunner instance.
 * When two server instances run simultaneously, each has its own independent
 * pushQueue, so both can execute push/PR creation concurrently for the same
 * branch — producing duplicate PRs.
 *
 * This test file demonstrates the gap:
 *   1. A single-instance pushQueue(1) correctly serialises operations.
 *   2. Two independent pushQueues(1) — simulating two server instances — do NOT
 *      serialise with each other. Both run concurrently, causing the race.
 *   3. No distributed lock exists in the push path (only in pm/scheduler.ts for
 *      the PM Agent tick — not used here).
 */

import { describe, it, expect, vi } from "vitest";
import { createQueue } from "../pipeline/queue.js";

// ---------------------------------------------------------------------------
// Helper: simulate a "create PR" operation with a short delay
// ---------------------------------------------------------------------------
function makePrCreator(label: string, log: string[]) {
  return async (): Promise<string> => {
    log.push(`${label}:start`);
    // Simulate network I/O for PR creation (GitHub API call)
    await new Promise((r) => setTimeout(r, 30));
    log.push(`${label}:end`);
    return `https://github.com/test/repo/pull/${label}`;
  };
}

// ---------------------------------------------------------------------------
// Test 1 — baseline: single in-process queue serialises correctly
// ---------------------------------------------------------------------------
describe("BEC-48 baseline: single in-process pushQueue serialises PR creation", () => {
  it("two concurrent enqueue calls on the SAME queue execute sequentially", async () => {
    const singleQueue = createQueue(1);
    const log: string[] = [];

    // Both tasks enqueued simultaneously into the SAME queue
    await Promise.all([
      singleQueue.enqueue(makePrCreator("instanceA", log)),
      singleQueue.enqueue(makePrCreator("instanceB", log)),
    ]);

    // Because concurrency=1, instanceA must fully complete before instanceB starts
    expect(log).toEqual([
      "instanceA:start",
      "instanceA:end",
      "instanceB:start",
      "instanceB:end",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — reproduce the bug: two independent queues (two server instances)
//           DO NOT protect each other → race condition
// ---------------------------------------------------------------------------
describe("BEC-48 reproduction: two independent pushQueues race on the same branch", () => {
  it("DEMONSTRATES RACE: two separate PipelineRunner instances create PRs simultaneously", async () => {
    // Each "server instance" has its own PipelineRunner with its own pushQueue.
    // Simulated here as two independent createQueue(1) instances.
    const instanceAQueue = createQueue(1); // Server A's pushQueue
    const instanceBQueue = createQueue(1); // Server B's pushQueue

    const log: string[] = [];
    let concurrentPrCreations = 0;
    let maxConcurrentPrCreations = 0;
    const duplicatePrUrls: string[] = [];

    const prCreator = (label: string) => async (): Promise<string> => {
      concurrentPrCreations++;
      maxConcurrentPrCreations = Math.max(
        maxConcurrentPrCreations,
        concurrentPrCreations,
      );
      log.push(`${label}:start`);
      // Simulate GitHub API call latency
      await new Promise((r) => setTimeout(r, 30));
      log.push(`${label}:end`);
      concurrentPrCreations--;
      const prUrl = "https://github.com/test/repo/pull/42"; // same branch → same PR target
      duplicatePrUrls.push(prUrl);
      return prUrl;
    };

    // Both server instances receive the same webhook at roughly the same time
    // and independently enqueue push+PR creation for the same branch.
    await Promise.all([
      instanceAQueue.enqueue(prCreator("serverA")),
      instanceBQueue.enqueue(prCreator("serverB")),
    ]);

    // RACE CONFIRMED: both PR creation calls ran concurrently
    // (maxConcurrentPrCreations === 2 proves there was no mutual exclusion)
    expect(maxConcurrentPrCreations).toBe(2); // ← BUG: should be 1 with a distributed lock

    // Both instances created a PR for the same branch → duplicate PRs
    expect(duplicatePrUrls).toHaveLength(2); // ← BUG: duplicate PR created

    // The log interleaving shows the race: both started before either finished
    expect(log[0]).toBe("serverA:start");
    expect(log[1]).toBe("serverB:start"); // serverB started while serverA was still running
  });

  it("CONTRAST: a shared external lock would prevent concurrent PR creation", async () => {
    // Simulate what a distributed lock (DB advisory lock / Redis SET NX) would do:
    // only one holder at a time, regardless of which process holds it.
    const sharedLock = createQueue(1); // shared across both "instances"

    const instanceAQueue = createQueue(1);
    const instanceBQueue = createQueue(1);

    const log: string[] = [];
    let concurrentPrCreations = 0;
    let maxConcurrentPrCreations = 0;

    const prCreator = (label: string) => async (): Promise<void> => {
      // Acquire the shared distributed lock BEFORE push/PR creation
      await sharedLock.enqueue(async () => {
        concurrentPrCreations++;
        maxConcurrentPrCreations = Math.max(
          maxConcurrentPrCreations,
          concurrentPrCreations,
        );
        log.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, 30));
        log.push(`${label}:end`);
        concurrentPrCreations--;
      });
    };

    await Promise.all([
      instanceAQueue.enqueue(prCreator("serverA")),
      instanceBQueue.enqueue(prCreator("serverB")),
    ]);

    // With a shared lock, PR creation is serialised across both instances
    expect(maxConcurrentPrCreations).toBe(1); // ← FIXED behaviour
    expect(log).toEqual([
      "serverA:start",
      "serverA:end",
      "serverB:start",
      "serverB:end",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — confirm no distributed lock exists in the push path
// ---------------------------------------------------------------------------
describe("BEC-48 gap: no distributed lock in runner push path", () => {
  it("pm/scheduler uses advisory lock — but runner.ts pushQueue does NOT", async () => {
    // The advisory lock pattern exists in packages/core/src/pm/scheduler.ts:
    //
    //   async function tryAcquireLock(): Promise<boolean> {
    //     if (!isPostgres(deps.db)) return true;
    //     const result = await db.execute(
    //       sql`SELECT pg_try_advisory_lock(hashtext('pm-agent-tick')) as acquired`
    //     );
    //     return result?.[0]?.acquired === true;
    //   }
    //
    // This lock guards only the PM Agent scheduler tick.
    // The push/PR creation in runner.ts (lines 1146–1297) uses only:
    //
    //   await this.pushQueue.enqueue(async () => { ... });
    //
    // Where `this.pushQueue = createQueue(1)` — an in-process semaphore.
    //
    // There is NO call to pg_try_advisory_lock, Redis SET NX, or any other
    // cross-process coordination mechanism in the push path.

    // We can verify the gap directly by reading the queue module:
    // createQueue() returns a pure in-memory object with no DB/Redis state.
    const q1 = createQueue(1);
    const q2 = createQueue(1);

    // Both queues are fully independent — there is no shared state
    expect(q1.pending).toBe(0);
    expect(q2.pending).toBe(0);

    let q1Running = false;
    let q2StartedWhileQ1Running = false;

    const blocker = q1.enqueue(async () => {
      q1Running = true;
      await new Promise((r) => setTimeout(r, 50));
      q1Running = false;
    });

    // Give q1 a tick to start
    await new Promise((r) => setTimeout(r, 5));

    await q2.enqueue(async () => {
      // q2 runs while q1 is still holding its slot — confirms no cross-instance lock
      if (q1Running) {
        q2StartedWhileQ1Running = true;
      }
    });

    await blocker;

    // This assertion confirms the bug: q2 ran while q1 was still executing
    expect(q2StartedWhileQ1Running).toBe(true);
  });
});

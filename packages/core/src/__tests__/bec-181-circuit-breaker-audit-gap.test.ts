/**
 * BEC-181 — Fix: circuit breaker now emits pm.skipped_circuit_breaker audit events.
 *
 * This file verifies:
 *
 * 1. WORKING: The circuit breaker correctly skips issues in both promoteReadyIssues
 *    and startTodoIssues when an issue has ≥ maxConsecutiveFailures failed runs.
 *    countConsecutiveFailures returns 4 for 4 consecutive failed runs with no
 *    intervening completion.
 *
 * 2. FIXED: When the breaker fires in promote or start-todo, a `pm.skipped_circuit_breaker`
 *    audit event is now written to the database. Operators can distinguish
 *    "breaker prevented a re-promotion" from "issue was never a candidate"
 *    by querying audit_events.
 *
 * Acceptance criteria from BEC-181 that this test covers:
 *   - countConsecutiveFailures is verified to return 4 for 4 consecutive failures
 *   - promote and start-todo skip issues at/above the threshold (end-to-end)
 *   - audit_events table has 1 row with eventType "pm.skipped_circuit_breaker" after a skip
 *   - AuditEventTypeSchema contains "pm.skipped_circuit_breaker"
 *   - audit/events.ts exports pmSkippedCircuitBreakerEvent builder
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createDb } from "../db/index.js";
import { pipelineRuns, auditEvents } from "../db/schema.js";
import { countConsecutiveFailures } from "../pm/actions/db-queries.js";
import { promoteReadyIssues } from "../pm/actions/promote.js";
import { startTodoIssues, type StartTodoInput } from "../pm/actions/start-todo.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDbPath(): string {
  return `/tmp/bec-181-repro-${randomBytes(8).toString("hex")}.sqlite`;
}

const paths: string[] = [];
afterEach(() => {
  for (const p of paths) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(p + suffix); } catch { /* ignore */ }
    }
  }
  paths.length = 0;
});

async function makeDb() {
  const path = tmpDbPath();
  paths.push(path);
  return createDb({ driver: "sqlite", connectionString: path });
}

/**
 * Seed N consecutive failed runs for issueId, spaced 5 seconds apart.
 * All are terminal (status="failed") with no completion between them.
 */
async function seedConsecutiveFailures(db: any, issueId: string, count: number) {
  const t0 = new Date(Date.now() - 60 * 60_000); // 1 hour ago so not "recent"
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `run-${issueId}-${i}`,
    issueId,
    issueTitle: `Issue ${issueId}`,
    pipelineKey: "auto-implement",
    repoUrl: "https://github.com/org/repo",
    status: "failed",
    startedAt: new Date(t0.getTime() + i * 5_000),
    completedAt: new Date(t0.getTime() + i * 5_000 + 1_000),
  }));
  await db.insert(pipelineRuns).values(rows);
}

// ---------------------------------------------------------------------------
// PART 1: Verify countConsecutiveFailures returns 4 for 4 consecutive failures
// ---------------------------------------------------------------------------

describe("BEC-181 Part 1: countConsecutiveFailures (working correctly)", () => {
  it("returns 4 when issue has 4 consecutive failed runs and no completed run", async () => {
    const db = await makeDb() as any;
    await seedConsecutiveFailures(db, "BEC-147", 4);
    const count = await countConsecutiveFailures(db, "BEC-147");
    // EXPECTED: 4 — the circuit breaker should engage at threshold 3
    expect(count).toBe(4);
  });

  it("returns 3 when issue has exactly 3 consecutive failed runs (at default threshold)", async () => {
    const db = await makeDb() as any;
    await seedConsecutiveFailures(db, "BEC-157", 3);
    const count = await countConsecutiveFailures(db, "BEC-157");
    // EXPECTED: 3 — at the default threshold of 3, breaker should engage
    expect(count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// PART 2: Verify promoteReadyIssues skips the issue (circuit breaker fires)
// ---------------------------------------------------------------------------

/** Allow fire-and-forget audit DB writes to complete before asserting. */
async function flushFireAndForget() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

/**
 * Shared helper: runs promoteReadyIssues with the circuit breaker enabled
 * for a single pre-seeded issue and asserts both the skip and the audit event.
 */
async function assertPromoteBreakerSkip(opts: {
  issueId: string;
  issueTitle: string;
  linearUuid: string;
  failureCount: number;
  threshold: number;
}) {
  const db = await makeDb() as any;
  await seedConsecutiveFailures(db, opts.issueId, opts.failureCount);

  const issues = [
    {
      id: opts.linearUuid,
      identifier: opts.issueId,
      title: opts.issueTitle,
      description: "Some description",
      priority: 2,
      labels: vi.fn().mockResolvedValue({ nodes: [{ name: "auto-implement" }] }),
      team: Promise.resolve({ id: "team-1" }),
      url: `https://linear.app/beckerspace/issue/${opts.issueId}`,
    },
  ];
  const client = {
    issues: vi.fn().mockResolvedValue({ nodes: issues }),
    updateIssue: vi.fn(),
    createComment: vi.fn(),
  };
  const stateMap = new Map([["team-1:Todo", "state-todo"]]);
  const conflictChecker = vi.fn();

  // Omit getFailureCount to exercise the batchCountConsecutiveFailures path.
  // The production scheduler also omits getFailureCount after BEC-181 so
  // both promote and start-todo benefit from the batch optimization.
  const results = await promoteReadyIssues({
    linearClient: client as any,
    teamIds: ["team-1"],
    slotsAvailable: 1,
    checkConflict: conflictChecker,
    stateMap,
    db,
    maxConsecutiveFailures: opts.threshold,
  });

  // Circuit breaker fires and prevents promotion
  expect(results).toHaveLength(1);
  expect(results[0].promoted).toBe(false);
  expect(results[0].reason).toMatch(/circuit.breaker/i);
  expect(results[0].reason).toContain(`${opts.failureCount} consecutive failed runs`);
  expect(client.updateIssue).not.toHaveBeenCalled();
  // Breaker fires before conflict detection (saves tokens)
  expect(conflictChecker).not.toHaveBeenCalled();

  await flushFireAndForget();

  // Audit event is now written when the breaker fires
  const auditRows = await (db as any).select().from(auditEvents);
  expect(auditRows).toHaveLength(1);
  expect(auditRows[0].eventType).toBe("pm.skipped_circuit_breaker");
  expect(auditRows[0].issueId).toBe(opts.issueId);
  expect(JSON.parse(auditRows[0].payload).failureCount).toBe(opts.failureCount);
  expect(JSON.parse(auditRows[0].payload).threshold).toBe(opts.threshold);
  expect(JSON.parse(auditRows[0].payload).action).toBe("promote");
}

describe("BEC-181 Part 2: promoteReadyIssues circuit-breaker skip (working correctly)", () => {
  it("skips promotion for issue with 4 consecutive failures and writes a pm.skipped_circuit_breaker audit event (fix verified)", () =>
    assertPromoteBreakerSkip({
      issueId: "BEC-147",
      issueTitle: "Tech debt: changelog UNRELEASED section stale",
      linearUuid: "uuid-bec147",
      failureCount: 4,
      threshold: 3,
    }));

  it("skips promotion for BEC-157 with exactly 3 consecutive failures (at threshold)", () =>
    assertPromoteBreakerSkip({
      issueId: "BEC-157",
      issueTitle: "Pipeline: filter agent scratchpad files",
      linearUuid: "uuid-bec157",
      failureCount: 3,
      threshold: 3,
    }));
});

// ---------------------------------------------------------------------------
// PART 3: Verify startTodoIssues skips the issue (circuit breaker fires)
// ---------------------------------------------------------------------------

describe("BEC-181 Part 3: startTodoIssues circuit-breaker skip (working correctly)", () => {
  const pipelineConfigs: Record<string, any> = {
    "auto-implement": {
      stages: ["triage", "implement", "review"],
    },
  };
  const repoConfigs: Record<string, any> = {
    "team-1": {
      url: "https://github.com/org/repo",
      defaultBranch: "main",
    },
  };

  it("skips start for issue with 4 consecutive failures WITHOUT touching Linear SDK, and writes an audit event (fix verified)", async () => {
    const db = await makeDb() as any;
    await seedConsecutiveFailures(db, "BEC-147", 4);

    // Spy on Linear SDK lazy relations to prove they are NOT called
    const labelsSpy = vi.fn().mockResolvedValue({ nodes: [{ name: "auto-implement" }] });
    const issue = {
      id: "uuid-bec147",
      identifier: "BEC-147",
      title: "Tech debt: changelog UNRELEASED section stale",
      description: "",
      priority: 2,
      team: Promise.resolve({ id: "team-1" }),
      project: Promise.resolve({ id: "proj-1" }),
      labels: labelsSpy,
    };

    // Use the real DB — seeded rows are 1 hour old, outside the 30-minute recent window,
    // and all are "failed" (not "queued"/"running"), so getActiveAndRecentIssueIds
    // correctly returns empty sets, making BEC-147 appear as an orphaned Todo issue.
    const runner = { start: vi.fn() };
    // Omit getFailureCount to exercise the batchCountConsecutiveFailures path
    // (single DB round-trip). The production scheduler also omits getFailureCount
    // after BEC-181 so it benefits from the batch optimization.
    const input: StartTodoInput = {
      linearClient: { issues: vi.fn().mockResolvedValue({ nodes: [issue] }) },
      db,
      teamIds: ["team-1"],
      runner: runner as any,
      pipelineConfigs,
      repoConfigs,
      maxPerTick: 5,
      maxConsecutiveFailures: 3,
    };

    const results = await startTodoIssues(input);

    // VERIFIED WORKING: breaker skips the issue
    expect(results).toHaveLength(1);
    expect(results[0].started).toBe(false);
    expect(results[0].reason).toMatch(/circuit.breaker/i);
    expect(results[0].reason).toContain("4 consecutive failed runs");
    expect(runner.start).not.toHaveBeenCalled();
    // Breaker fires BEFORE Linear SDK calls (saves 3 round-trips per tick per doom-looping issue)
    expect(labelsSpy).not.toHaveBeenCalled();

    // Allow fire-and-forget audit DB writes to complete before asserting.
    await flushFireAndForget();

    // VERIFIED FIX: audit event is now written when the circuit breaker fires in start-todo
    const auditRows = await (db as any).select().from(auditEvents);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].eventType).toBe("pm.skipped_circuit_breaker");
    expect(auditRows[0].issueId).toBe("BEC-147");
    expect(JSON.parse(auditRows[0].payload).failureCount).toBe(4);
    expect(JSON.parse(auditRows[0].payload).threshold).toBe(3);
    expect(JSON.parse(auditRows[0].payload).action).toBe("start-todo");
  });
});

// ---------------------------------------------------------------------------
// PART 4: Confirm pm.skipped_circuit_breaker is present in AuditEventTypeSchema (fix verified)
// ---------------------------------------------------------------------------

describe("BEC-181 Part 4: pm.skipped_circuit_breaker event type is now defined (gap closed)", () => {
  it("AuditEventTypeSchema contains pm.skipped_circuit_breaker", async () => {
    const { AuditEventTypeSchema } = await import("../types.js");
    const types: string[] = AuditEventTypeSchema.options;
    expect(types).toContain("pm.skipped_circuit_breaker");
  });

  it("audit/events.ts exports pmSkippedCircuitBreakerEvent builder", async () => {
    const auditModule = await import("../audit/events.js");
    expect(typeof (auditModule as any).pmSkippedCircuitBreakerEvent).toBe("function");
  });
});

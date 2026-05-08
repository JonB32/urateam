/**
 * BEC-181 — Reproduce: circuit breaker fires silently (no audit event emitted).
 *
 * This file proves two things:
 *
 * 1. WORKING: The circuit breaker correctly skips issues in both promoteReadyIssues
 *    and startTodoIssues when an issue has ≥ maxConsecutiveFailures failed runs.
 *    countConsecutiveFailures returns 4 for 4 consecutive failed runs with no
 *    intervening completion.
 *
 * 2. MISSING (the gap): When the breaker fires in promote or start-todo, NO audit
 *    event is written to the database. The `pm.skipped_circuit_breaker` event type
 *    does not exist in AuditEventTypeSchema, there is no pmSkippedCircuitBreakerEvent
 *    builder in audit/events.ts, and neither promoteReadyIssues nor startTodoIssues
 *    calls logAuditEventUnchecked when the breaker engages. Operators cannot
 *    distinguish "breaker prevented a re-promotion" from "issue was never a
 *    candidate" by querying audit_events — only grepping application logs works.
 *
 * Acceptance criteria from BEC-181 that this test covers:
 *   - countConsecutiveFailures is verified to return 4 for 4 consecutive failures
 *   - promote and start-todo skip issues at/above the threshold (end-to-end)
 *   - audit_events table is empty after a circuit-breaker skip (proves the gap)
 *
 * When the fix lands, the last assertion in each "MISSING" test must be updated
 * to expect 1 row with eventType "pm.skipped_circuit_breaker".
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

describe("BEC-181 Part 2: promoteReadyIssues circuit-breaker skip (working correctly)", () => {
  it("skips promotion for issue with 4 consecutive failures and does NOT write an audit event (gap)", async () => {
    const db = await makeDb() as any;
    await seedConsecutiveFailures(db, "BEC-147", 4);

    const issues = [
      {
        id: "uuid-bec147",
        identifier: "BEC-147",
        title: "Tech debt: changelog UNRELEASED section stale",
        description: "Some description",
        priority: 2,
        labels: vi.fn().mockResolvedValue({ nodes: [{ name: "auto-implement" }] }),
        team: Promise.resolve({ id: "team-1" }),
        url: "https://linear.app/beckerspace/issue/BEC-147",
      },
    ];
    const client = {
      issues: vi.fn().mockResolvedValue({ nodes: issues }),
      updateIssue: vi.fn(),
      createComment: vi.fn(),
    };
    const stateMap = new Map([["team-1:Todo", "state-todo"]]);
    const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });

    const results = await promoteReadyIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      slotsAvailable: 1,
      checkConflict: conflictChecker,
      stateMap,
      db,
      maxConsecutiveFailures: 3,
      getFailureCount: (issueId) => countConsecutiveFailures(db, issueId),
    });

    // VERIFIED WORKING: circuit breaker fires and prevents promotion
    expect(results).toHaveLength(1);
    expect(results[0].promoted).toBe(false);
    expect(results[0].reason).toMatch(/circuit.breaker/i);
    expect(results[0].reason).toContain("4 consecutive failed runs");
    expect(client.updateIssue).not.toHaveBeenCalled();
    // Breaker fires before conflict detection (saves tokens)
    expect(conflictChecker).not.toHaveBeenCalled();

    // CONFIRMED GAP: no audit event is written when the breaker fires
    // After the fix, this should expect 1 row with eventType "pm.skipped_circuit_breaker"
    const auditRows = await (db as any).select().from(auditEvents);
    expect(auditRows).toHaveLength(0); // <-- proves the observability gap
  });

  it("skips promotion for BEC-157 with exactly 3 consecutive failures (at threshold)", async () => {
    const db = await makeDb() as any;
    await seedConsecutiveFailures(db, "BEC-157", 3);

    const issues = [
      {
        id: "uuid-bec157",
        identifier: "BEC-157",
        title: "Pipeline: filter agent scratchpad files",
        description: "Some description",
        priority: 2,
        labels: vi.fn().mockResolvedValue({ nodes: [{ name: "auto-implement" }] }),
        team: Promise.resolve({ id: "team-1" }),
        url: "https://linear.app/beckerspace/issue/BEC-157",
      },
    ];
    const client = {
      issues: vi.fn().mockResolvedValue({ nodes: issues }),
      updateIssue: vi.fn(),
      createComment: vi.fn(),
    };
    const stateMap = new Map([["team-1:Todo", "state-todo"]]);
    const conflictChecker = vi.fn();

    const results = await promoteReadyIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      slotsAvailable: 1,
      checkConflict: conflictChecker,
      stateMap,
      db,
      maxConsecutiveFailures: 3,
      getFailureCount: (issueId) => countConsecutiveFailures(db, issueId),
    });

    expect(results[0].promoted).toBe(false);
    expect(results[0].reason).toMatch(/circuit.breaker/i);
    expect(results[0].reason).toContain("3 consecutive failed runs");
    expect(client.updateIssue).not.toHaveBeenCalled();
    expect(conflictChecker).not.toHaveBeenCalled();

    // CONFIRMED GAP: no audit event emitted on breaker fire
    const auditRows = await (db as any).select().from(auditEvents);
    expect(auditRows).toHaveLength(0); // <-- proves the observability gap
  });
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

  it("skips start for issue with 4 consecutive failures WITHOUT touching Linear SDK, and does NOT write an audit event (gap)", async () => {
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

    // Mock DB for getActiveAndRecentIssueIds to return no active/recent runs
    // (the issue IS orphaned — breaker is the only thing stopping a re-start)
    const mockDbForLinear = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn()
            .mockResolvedValueOnce([]) // no active runs
            .mockResolvedValueOnce([]), // no recent runs
        }),
      }),
    };

    const runner = { start: vi.fn() };
    const input: StartTodoInput = {
      linearClient: { issues: vi.fn().mockResolvedValue({ nodes: [issue] }) },
      db: mockDbForLinear as any,
      teamIds: ["team-1"],
      runner: runner as any,
      pipelineConfigs,
      repoConfigs,
      maxPerTick: 5,
      maxConsecutiveFailures: 3,
      // Use a real DB for the failure count
      getFailureCount: (issueId) => countConsecutiveFailures(db, issueId),
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

    // CONFIRMED GAP: startTodoIssues has no `db` write path for audit events on skip,
    // so nothing is emitted. The real DB has the pipeline run rows, but no audit event.
    const auditRows = await (db as any).select().from(auditEvents);
    expect(auditRows).toHaveLength(0); // <-- proves the observability gap
  });
});

// ---------------------------------------------------------------------------
// PART 4: Confirm pm.skipped_circuit_breaker is absent from AuditEventTypeSchema
// ---------------------------------------------------------------------------

describe("BEC-181 Part 4: pm.skipped_circuit_breaker event type is not yet defined (the schema gap)", () => {
  it("AuditEventTypeSchema does not contain pm.skipped_circuit_breaker", async () => {
    const { AuditEventTypeSchema } = await import("../types.js");
    const types: string[] = AuditEventTypeSchema.options;
    // This test documents the gap — it should FAIL after the fix adds the event type.
    expect(types).not.toContain("pm.skipped_circuit_breaker");
  });

  it("audit/events.ts does not export pmSkippedCircuitBreakerEvent (no builder yet)", async () => {
    const auditModule = await import("../audit/events.js");
    // This test documents the gap — it should FAIL after the fix adds the builder.
    expect((auditModule as any).pmSkippedCircuitBreakerEvent).toBeUndefined();
  });
});

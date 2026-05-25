import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDb, type AnyDb } from "../db/client.js";
import { circuitBreakerState, pipelineRuns } from "../db/schema.js";
import { sweepRecoveredCircuitBreakers } from "../pm/actions/sweep-recovered-circuit-breakers.js";

function fakeLinearClient() {
  return {
    issue: vi.fn().mockResolvedValue({
      id: "issue-uuid",
      labels: vi.fn().mockResolvedValue({
        nodes: [
          { id: "lbl-bug", name: "bug" },
          { id: "lbl-nd", name: "needs-design" },
        ],
      }),
    }),
    updateIssue: vi.fn().mockResolvedValue({}),
  };
}

describe("sweepRecoveredCircuitBreakers", () => {
  let db: AnyDb;
  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
  });

  it("no-ops when no state rows exist", async () => {
    const client = fakeLinearClient();
    const result = await sweepRecoveredCircuitBreakers(db, client as any, {
      maxConsecutiveFailures: 3,
    });
    expect(result.recovered).toEqual([]);
    expect(client.updateIssue).not.toHaveBeenCalled();
  });

  it("leaves rows in place when the issue is still circuit-broken", async () => {
    // 3 failed runs → batchCount = 3 ≥ threshold → still broken → no recovery
    for (let i = 0; i < 3; i++) {
      await db.insert(pipelineRuns).values({
        id: `BEC-1-r${i}`,
        issueId: "BEC-1",
        issueTitle: "test",
        pipelineKey: "auto-implement",
        repoUrl: "https://example.com/r.git",
        status: "failed",
        startedAt: new Date(1_000_000_000 + i * 1000),
      });
    }
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(),
      probeAttempts: 0,
    });

    const client = fakeLinearClient();
    const result = await sweepRecoveredCircuitBreakers(db, client as any, {
      maxConsecutiveFailures: 3,
    });
    expect(result.recovered).toEqual([]);
    const rows = await db.select().from(circuitBreakerState);
    expect(rows).toHaveLength(1);
  });

  it("recovers issues whose latest run is `completed` (count = 0)", async () => {
    // 2 failed runs, then 1 completed → batchCount = 0 → recoverable
    for (let i = 0; i < 2; i++) {
      await db.insert(pipelineRuns).values({
        id: `BEC-1-fail-${i}`,
        issueId: "BEC-1",
        issueTitle: "test",
        pipelineKey: "auto-implement",
        repoUrl: "https://example.com/r.git",
        status: "failed",
        startedAt: new Date(1_000_000_000 + i * 1000),
      });
    }
    await db.insert(pipelineRuns).values({
      id: "BEC-1-ok",
      issueId: "BEC-1",
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "completed",
      startedAt: new Date(1_000_000_999_999),
    });
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(),
      probeAttempts: 1,
    });

    const client = fakeLinearClient();
    const result = await sweepRecoveredCircuitBreakers(db, client as any, {
      maxConsecutiveFailures: 3,
    });
    expect(result.recovered).toEqual(["BEC-1"]);
    const rows = await db.select().from(circuitBreakerState);
    expect(rows).toHaveLength(0);
    expect(client.updateIssue).toHaveBeenCalledOnce();
  });

  it("recovers multiple issues in a single sweep", async () => {
    for (const id of ["BEC-1", "BEC-2"]) {
      await db.insert(pipelineRuns).values({
        id: `${id}-ok`,
        issueId: id,
        issueTitle: "test",
        pipelineKey: "auto-implement",
        repoUrl: "https://example.com/r.git",
        status: "completed",
        startedAt: new Date(1_000_000_000),
      });
      await db.insert(circuitBreakerState).values({
        issueId: id,
        escalatedAt: new Date(),
        probeAttempts: 1,
      });
    }
    const client = fakeLinearClient();
    const result = await sweepRecoveredCircuitBreakers(db, client as any, {
      maxConsecutiveFailures: 3,
    });
    expect(result.recovered.sort()).toEqual(["BEC-1", "BEC-2"]);
  });
});

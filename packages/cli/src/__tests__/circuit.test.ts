import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDb, pipelineRuns, stageRuns, agentLogs, circuitBreakerState, type AnyDb } from "@urateam/core";
import { runCircuitList, runCircuitReset, runCircuitResetAll } from "../commands/circuit.js";

describe("ura circuit list", () => {
  let db: AnyDb;
  let logs: string[];
  let log: (msg: string) => void;
  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    logs = [];
    log = (m: string) => logs.push(m);
  });

  it("prints a friendly message when no issues are circuit-broken", async () => {
    await runCircuitList({ db, log, maxConsecutiveFailures: 3 });
    expect(logs.some((l) => l.toLowerCase().includes("no circuit-broken issues"))).toBe(true);
  });

  it("lists issues with ≥ threshold failures, joined to state when present", async () => {
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
      escalatedAt: new Date(1_000_000_000),
      probeAttempts: 1,
    });

    await runCircuitList({ db, log, maxConsecutiveFailures: 3 });
    const out = logs.join("\n");
    expect(out).toContain("BEC-1");
    expect(out).toContain("3"); // failures column
  });

  it("lists broken issues without a state row too (pre-deploy bootstrap case)", async () => {
    for (let i = 0; i < 3; i++) {
      await db.insert(pipelineRuns).values({
        id: `BEC-2-r${i}`,
        issueId: "BEC-2",
        issueTitle: "test",
        pipelineKey: "auto-implement",
        repoUrl: "https://example.com/r.git",
        status: "failed",
        startedAt: new Date(1_000_000_000 + i * 1000),
      });
    }
    // No circuit_breaker_state row — mimics pre-deploy bootstrap

    await runCircuitList({ db, log, maxConsecutiveFailures: 3 });
    const out = logs.join("\n");
    expect(out).toContain("BEC-2");
  });
});

function fakeLinearClient(currentLabels: Array<{ id: string; name: string }>) {
  return {
    issue: vi.fn().mockResolvedValue({
      id: "issue-uuid",
      labels: vi.fn().mockResolvedValue({ nodes: currentLabels }),
    }),
    updateIssue: vi.fn().mockResolvedValue({}),
  };
}

describe("ura circuit reset <issueId>", () => {
  let db: AnyDb;
  let logs: string[];
  let log: (msg: string) => void;
  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    logs = [];
    log = (m: string) => logs.push(m);
  });

  it("deletes the failed pipeline_runs cascade + state row, strips needs-design label", async () => {
    // 3 failed runs, each with 1 stage_run, each with 1 agent_log
    for (let i = 0; i < 3; i++) {
      const runId = `BEC-1-r${i}`;
      const stageRunId = `BEC-1-r${i}-stage`;
      await db.insert(pipelineRuns).values({
        id: runId,
        issueId: "BEC-1",
        issueTitle: "test",
        pipelineKey: "auto-implement",
        repoUrl: "https://example.com/r.git",
        status: "failed",
        startedAt: new Date(1_000_000_000 + i * 1000),
      });
      await db.insert(stageRuns).values({
        id: stageRunId,
        pipelineRunId: runId,
        stage: "implement",
        status: "failed",
        startedAt: new Date(1_000_000_000 + i * 1000),
      });
      await db.insert(agentLogs).values({
        id: `${stageRunId}-log`,
        stageRunId,
        type: "system",
        content: "test log",
        timestamp: new Date(1_000_000_000 + i * 1000),
      });
    }
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(),
      probeAttempts: 0,
    });
    const linearClient = fakeLinearClient([
      { id: "lbl-bug", name: "bug" },
      { id: "lbl-nd", name: "needs-design" },
    ]);

    const result = await runCircuitReset({
      db,
      log,
      issueId: "BEC-1",
      linearClient: linearClient as any,
    });
    expect(result.failedRunsDeleted).toBe(3);

    expect((await db.select().from(pipelineRuns)).length).toBe(0);
    expect((await db.select().from(stageRuns)).length).toBe(0);
    expect((await db.select().from(agentLogs)).length).toBe(0);
    expect((await db.select().from(circuitBreakerState)).length).toBe(0);
    expect(linearClient.updateIssue).toHaveBeenCalledOnce();
    const [, payload] = linearClient.updateIssue.mock.calls[0];
    expect(payload.labelIds).toEqual(["lbl-bug"]); // only bug survives
  });

  it("preserves `completed` runs — only deletes failed", async () => {
    await db.insert(pipelineRuns).values({
      id: "BEC-1-ok",
      issueId: "BEC-1",
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "completed",
      startedAt: new Date(),
    });
    await db.insert(pipelineRuns).values({
      id: "BEC-1-bad",
      issueId: "BEC-1",
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "failed",
      startedAt: new Date(),
    });
    const linearClient = fakeLinearClient([]);

    const result = await runCircuitReset({
      db,
      log,
      issueId: "BEC-1",
      linearClient: linearClient as any,
    });
    expect(result.failedRunsDeleted).toBe(1);
    const remaining = await db.select().from(pipelineRuns);
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as any).id).toBe("BEC-1-ok");
  });

  it("no state row → does NOT touch Linear (preserves human-added needs-design)", async () => {
    await db.insert(pipelineRuns).values({
      id: "BEC-1-bad",
      issueId: "BEC-1",
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "failed",
      startedAt: new Date(),
    });
    // NO circuit_breaker_state row
    const linearClient = fakeLinearClient([{ id: "lbl-nd", name: "needs-design" }]);

    const result = await runCircuitReset({
      db,
      log,
      issueId: "BEC-1",
      linearClient: linearClient as any,
    });
    expect(result.failedRunsDeleted).toBe(1);
    expect(linearClient.updateIssue).not.toHaveBeenCalled();
  });
});

describe("ura circuit reset --all", () => {
  let db: AnyDb;
  let logs: string[];
  let log: (msg: string) => void;
  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    logs = [];
    log = (m: string) => logs.push(m);
  });

  it("resets every currently-broken issue (works without pre-existing state rows)", async () => {
    // Seed two broken issues; only one has a state row (mimics first-deploy bootstrap).
    for (const id of ["BEC-1", "BEC-2"]) {
      for (let i = 0; i < 3; i++) {
        await db.insert(pipelineRuns).values({
          id: `${id}-r${i}`,
          issueId: id,
          issueTitle: "test",
          pipelineKey: "auto-implement",
          repoUrl: "https://example.com/r.git",
          status: "failed",
          startedAt: new Date(1_000_000_000 + i * 1000),
        });
      }
    }
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(),
      probeAttempts: 0,
    });
    const linearClient = {
      issue: vi.fn().mockResolvedValue({
        id: "uuid",
        labels: vi.fn().mockResolvedValue({ nodes: [] }),
      }),
      updateIssue: vi.fn().mockResolvedValue({}),
    };

    const result = await runCircuitResetAll({
      db,
      log,
      linearClient: linearClient as any,
      maxConsecutiveFailures: 3,
    });

    expect(result.cleared.sort()).toEqual(["BEC-1", "BEC-2"]);
    expect(result.failed).toEqual([]);
    expect((await db.select().from(pipelineRuns)).length).toBe(0);
    expect((await db.select().from(circuitBreakerState)).length).toBe(0);
  });

  it("skips issues whose failure count is below threshold", async () => {
    // BEC-1 has 2 failures (below threshold 3) — should NOT be cleared
    for (let i = 0; i < 2; i++) {
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
    const linearClient = {
      issue: vi.fn().mockResolvedValue({ id: "uuid", labels: vi.fn().mockResolvedValue({ nodes: [] }) }),
      updateIssue: vi.fn().mockResolvedValue({}),
    };

    const result = await runCircuitResetAll({
      db,
      log,
      linearClient: linearClient as any,
      maxConsecutiveFailures: 3,
    });
    expect(result.cleared).toEqual([]);
    expect((await db.select().from(pipelineRuns)).length).toBe(2); // preserved
  });

  it("partial-failure mid-bulk leaves the rest consistent", async () => {
    for (const id of ["BEC-1", "BEC-2", "BEC-3"]) {
      for (let i = 0; i < 3; i++) {
        await db.insert(pipelineRuns).values({
          id: `${id}-r${i}`,
          issueId: id,
          issueTitle: "test",
          pipelineKey: "auto-implement",
          repoUrl: "https://example.com/r.git",
          status: "failed",
          startedAt: new Date(1_000_000_000 + i * 1000),
        });
      }
      await db.insert(circuitBreakerState).values({
        issueId: id,
        escalatedAt: new Date(),
        probeAttempts: 0,
      });
    }
    // BEC-2's updateIssue throws — but BEC-1 and BEC-3 should still complete.
    let callCount = 0;
    const linearClient = {
      issue: vi.fn().mockImplementation(async (id: string) => ({
        id: `${id}-uuid`,
        labels: vi.fn().mockResolvedValue({ nodes: [{ id: "lbl-nd", name: "needs-design" }] }),
      })),
      updateIssue: vi.fn().mockImplementation(async (uuid: string) => {
        callCount++;
        if (uuid === "BEC-2-uuid") throw new Error("Linear API blip");
        return {};
      }),
    };

    const result = await runCircuitResetAll({
      db,
      log,
      linearClient: linearClient as any,
      maxConsecutiveFailures: 3,
    });
    // All three issues had their DB cleanup succeed (the per-issue tx is
    // independent of the Linear call — runCircuitReset wraps Linear in
    // try/catch).
    expect(result.cleared.sort()).toEqual(["BEC-1", "BEC-2", "BEC-3"]);
    expect((await db.select().from(pipelineRuns)).length).toBe(0);
    expect((await db.select().from(circuitBreakerState)).length).toBe(0);
  });
});

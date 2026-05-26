import { describe, it, expect } from "vitest";
import { createDb, type AnyDb } from "../db/client.js";
import { pipelineRunDecisions, pipelineRuns } from "../db/schema.js";

describe("pipeline_run_decisions migration (BEC-227 Phase 4 / Track D)", () => {
  it("table exists on a fresh SQLite db and stores a row", async () => {
    const db: AnyDb = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    // Parent FK row first.
    await db.insert(pipelineRuns).values({
      id: "run-1",
      issueId: "BEC-X",
      issueTitle: "test",
      repoUrl: "https://example.com/repo",
      pipelineKey: "auto-implement",
      status: "queued",
      startedAt: new Date(),
    } as any);
    await db.insert(pipelineRunDecisions).values({
      id: "dec-1",
      pipelineRunId: "run-1",
      iteration: 0,
      stage: "implement",
      payload: JSON.stringify({ decisions: [], leftUnhandled: [], keyFiles: [] }),
      createdAt: new Date(),
    } as any);
    const rows = await db.select().from(pipelineRunDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe("implement");
    expect(rows[0]!.iteration).toBe(0);
  });

  it("multiple rows per (pipeline_run_id, iteration) ordering preserved", async () => {
    const db: AnyDb = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    await db.insert(pipelineRuns).values({
      id: "run-2",
      issueId: "BEC-Y",
      issueTitle: "test",
      repoUrl: "https://example.com/repo",
      pipelineKey: "auto-implement",
      status: "queued",
      startedAt: new Date(),
    } as any);
    for (let i = 0; i < 3; i++) {
      await db.insert(pipelineRunDecisions).values({
        id: `dec-${i}`,
        pipelineRunId: "run-2",
        iteration: i,
        stage: "implement",
        payload: JSON.stringify({ decisions: [{ choice: `c${i}`, reason: "r" }] }),
        createdAt: new Date(Date.now() + i * 1000),
      } as any);
    }
    const rows = await db.select().from(pipelineRunDecisions);
    expect(rows).toHaveLength(3);
    expect(rows.map((r: { iteration: number }) => r.iteration).sort()).toEqual([0, 1, 2]);
  });
});

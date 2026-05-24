/**
 * BEC-250 — Reproduction test: orphan stage_runs with status='running'
 *
 * Demonstrates that when pipeline_runs transitions to a terminal state
 * (failed / cancelled / completed), child stage_runs rows still in
 * status='running' are NOT updated — they become permanent false positives
 * in any query that checks for active stages.
 *
 * This test EXPECTS the bug to be present (assertions prove the gap).
 * The implementation fix should invert these assertions.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../db/client.js";
import { pipelineRuns, stageRuns } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

describe("BEC-250: orphan stage_runs repro", () => {
  let db: Awaited<ReturnType<typeof createDb>>;

  beforeEach(async () => {
    db = await createDb({ driver: "sqlite", connectionString: ":memory:" });
  });

  /**
   * Seed helpers — insert minimal valid rows into pipeline_runs and stage_runs.
   */
  async function seedRunningPipelineRun(id: string) {
    await db.insert(pipelineRuns).values({
      id,
      issueId: `issue-${id}`,
      issueTitle: "Test issue",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      status: "running",
    });
  }

  async function seedRunningStageRun(id: string, pipelineRunId: string, stage = "implement") {
    await db.insert(stageRuns).values({
      id,
      pipelineRunId,
      stage,
      status: "running",
    });
  }

  it("BUG CONFIRMED: failPipeline-style transition leaves child stage_runs in status='running'", async () => {
    const runId = nanoid();
    const stageRunId = nanoid();

    await seedRunningPipelineRun(runId);
    await seedRunningStageRun(stageRunId, runId);

    // Simulate exactly what failPipeline() does at runner.ts:3280-3288:
    // it only updates pipeline_runs — never touches stage_runs.
    await (db as any)
      .update(pipelineRuns)
      .set({ status: "failed", completedAt: new Date(), errorMessage: "simulated failure" })
      .where(eq(pipelineRuns.id, runId));

    // Parent is now terminal
    const [parent] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(parent.status).toBe("failed");

    // BUG: child stage_run is still 'running' even though parent is 'failed'
    const [child] = await db.select().from(stageRuns).where(eq(stageRuns.id, stageRunId));
    expect(child.status).toBe("running"); // <-- this is the orphan
  });

  it("BUG CONFIRMED: markRunCancelled-style transition leaves child stage_runs in status='running'", async () => {
    const runId = nanoid();
    const stageRunId = nanoid();

    await seedRunningPipelineRun(runId);
    await seedRunningStageRun(stageRunId, runId);

    // Simulate exactly what markRunCancelledImpl() does at runner.ts:690-697:
    // updates pipeline_runs to 'cancelled' but never touches stage_runs.
    await (db as any)
      .update(pipelineRuns)
      .set({ status: "cancelled", completedAt: new Date(), errorMessage: "cancelled by operator (cancel)" })
      .where(eq(pipelineRuns.id, runId));

    const [parent] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(parent.status).toBe("cancelled");

    // BUG: child still running
    const [child] = await db.select().from(stageRuns).where(eq(stageRuns.id, stageRunId));
    expect(child.status).toBe("running"); // <-- orphan
  });

  it("BUG CONFIRMED: recoverStuckRuns-style transition leaves child stage_runs in status='running'", async () => {
    const runId = nanoid();
    const stageRunId = nanoid();

    await seedRunningPipelineRun(runId);
    await seedRunningStageRun(stageRunId, runId);

    // Simulate exactly what recoverStuckRuns() does at runner.ts:3411-3417:
    await (db as any)
      .update(pipelineRuns)
      .set({ status: "failed", errorMessage: "Pipeline interrupted by server restart" })
      .where(eq(pipelineRuns.id, runId));

    const [parent] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(parent.status).toBe("failed");

    // BUG: child still running
    const [child] = await db.select().from(stageRuns).where(eq(stageRuns.id, stageRunId));
    expect(child.status).toBe("running"); // <-- orphan
  });

  it("BUG CONFIRMED: query for 'which stages are running' returns orphans from failed parent", async () => {
    const runId = nanoid();
    const stageRunId = nanoid();

    await seedRunningPipelineRun(runId);
    await seedRunningStageRun(stageRunId, runId);

    // Fail the parent
    await (db as any)
      .update(pipelineRuns)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(pipelineRuns.id, runId));

    // A dashboard or quality-observer query asking "which stages are running?"
    // will return this orphan row, producing a permanent false positive.
    const runningStages = await db
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.status, "running"));

    // BUG: there is 1 orphan — the dashboard / quality observer will see this
    // as an active stage even though the parent pipeline has failed.
    expect(runningStages).toHaveLength(1);
    expect(runningStages[0].id).toBe(stageRunId);
    expect(runningStages[0].status).toBe("running");
  });
});

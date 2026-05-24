import { eq } from "drizzle-orm";
import { pipelineRuns } from "../db/schema.js";
import { removeActiveWork } from "../pm/coordination.js";
import type { AnyDb } from "../db/client.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "terminate" });

export interface TerminateRunResult {
  runId: string;
  issueId: string;
  previousStatus: string;
}

/**
 * Manually terminates a running pipeline run by run ID.
 *
 * Marks the pipeline_runs row as `status='failed'`, sets
 * `error_message='manually terminated via CLI'`, and removes the
 * active_work coordination entry so the issue can be resubmitted without
 * orphaned process state.
 *
 * Note: this does NOT signal an in-process executor to stop — the running
 * stage will still hit its own wall-clock timeout (WALL_CLOCK_STAGE_TIMEOUT_MS).
 * Use this to recover runs whose process has already exited uncleanly, or to
 * force-mark a zombie run as failed before the PM Agent's stuck-issue recovery
 * sweep fires (default 60-minute threshold, BEC-184).
 */
export async function terminateRun(
  db: AnyDb,
  runId: string,
): Promise<TerminateRunResult> {
  const rows = await db
    .select()
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);

  if (!rows || rows.length === 0) {
    throw new Error(`Run not found: ${runId}`);
  }

  const run = rows[0];
  const previousStatus = run.status as string;

  if (previousStatus === "completed" || previousStatus === "aborted") {
    throw new Error(`Run ${runId} is already ${previousStatus} — cannot terminate`);
  }

  await db
    .update(pipelineRuns)
    .set({
      status: "failed",
      errorMessage: "manually terminated via CLI",
      completedAt: new Date(),
    })
    .where(eq(pipelineRuns.id, runId));

  await removeActiveWork(db, runId);

  log.info(
    { runId, issueId: run.issueId, previousStatus },
    "run manually terminated",
  );

  return {
    runId,
    issueId: run.issueId as string,
    previousStatus,
  };
}

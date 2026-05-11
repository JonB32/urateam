import type { AnyDb } from "../../db/client.js";
import { activeWork, pipelineRuns } from "../../db/schema.js";
import { eq, lt } from "drizzle-orm";
import { createLogger } from "../../logger.js";

const log = createLogger({ component: "PmAgent:checkStalledStages" });

/** Default stall threshold: 30 minutes with no active_work update. */
export const DEFAULT_STALLED_STAGE_THRESHOLD_MINUTES = 30;

export interface CheckStalledStagesInput {
  db: AnyDb;
  /**
   * Age threshold (in minutes) after which a stage with no active_work updates
   * is considered stalled. Defaults to 30 minutes.
   * Set via PM_AGENT_STALLED_STAGE_THRESHOLD_MIN env var.
   */
  staleAgeMinutes?: number;
  /** Maximum number of stalled stages to return per call. Defaults to 20. */
  maxResults?: number;
}

export interface StalledStageResult {
  /** Pipeline run ID. */
  runId: string;
  /** Linear issue identifier (e.g. "BEC-91") tracked by the run. */
  issueId: string;
  /** Current stage name (e.g. "implement"). */
  stageName: string;
  /** Timestamp of the last active_work update for this run. */
  lastActiveTimestamp: Date;
  /** How long (in seconds) since the last active_work update. */
  stalledDurationSeconds: number;
}

/**
 * Detects pipeline runs whose current stage has made no active_work progress
 * for longer than `staleAgeMinutes` (default 30 minutes).
 *
 * A run is considered stalled when:
 *  - It has an entry in the `active_work` table (i.e. it is currently being
 *    executed by the pipeline runner)
 *  - The `active_work.updatedAt` timestamp is older than the stale threshold
 *
 * This is the PM-scheduler-level complement to the in-executor
 * `StageStalledError` / `StagePreStreamStalledError` defences (BEC-183).
 * Those defences fire from inside the agent stream; this function detects
 * hangs that survive past the executor (e.g. process restart with orphaned
 * `active_work` rows, or hangs in infrastructure layers outside the agent).
 *
 * When stalled runs are found, a structured alert is logged with keys:
 *   runId, stageName, lastActiveTimestamp, stalledDurationSeconds
 *
 * The caller (scheduler) is responsible for taking further action — typically
 * notifying operators and/or surfacing the run in the dashboard for manual
 * recovery via `POST /runs/:id/resume-stalled`.
 */
export async function checkStalledStages(
  input: CheckStalledStagesInput,
): Promise<StalledStageResult[]> {
  const { db } = input;
  const staleAgeMinutes = input.staleAgeMinutes ?? DEFAULT_STALLED_STAGE_THRESHOLD_MINUTES;
  const maxResults = input.maxResults ?? 20;
  const staleThresholdMs = staleAgeMinutes * 60 * 1000;
  const staleCutoff = new Date(Date.now() - staleThresholdMs);

  // Query active_work entries that have not been updated within the threshold.
  // These represent pipeline runs that are "stuck" at a stage.
  let staleRows: Array<{
    runId: string;
    issueId: string;
    stage: string;
    updatedAt: Date;
  }>;
  try {
    staleRows = (await db
      .select({
        runId: activeWork.runId,
        issueId: activeWork.issueId,
        stage: activeWork.stage,
        updatedAt: activeWork.updatedAt,
      })
      .from(activeWork)
      .where(lt(activeWork.updatedAt, staleCutoff))
      .limit(maxResults)) as any;
  } catch (err) {
    log.error({ err }, "checkStalledStages: failed to query active_work");
    return [];
  }

  if (staleRows.length === 0) {
    log.debug({ staleAgeMinutes }, "checkStalledStages: no stalled stages detected");
    return [];
  }

  const now = Date.now();
  const results: StalledStageResult[] = staleRows.map((row) => {
    const lastActiveTimestamp = row.updatedAt instanceof Date
      ? row.updatedAt
      : new Date(row.updatedAt as any);
    const stalledDurationSeconds = Math.floor((now - lastActiveTimestamp.getTime()) / 1000);
    return {
      runId: row.runId,
      issueId: row.issueId,
      stageName: row.stage,
      lastActiveTimestamp,
      stalledDurationSeconds,
    };
  });

  // Emit a structured log alert for each stalled stage so operators can
  // diagnose the hang from log aggregators / monitoring systems.
  const stalledMessage = `stalled stage detected: no active_work updates for >${staleAgeMinutes} min — consider POST /runs/:id/resume-stalled for manual recovery`;
  for (const result of results) {
    log.warn(
      {
        runId: result.runId,
        stageName: result.stageName,
        lastActiveTimestamp: result.lastActiveTimestamp.toISOString(),
        stalledDurationSeconds: result.stalledDurationSeconds,
        issueId: result.issueId,
        staleAgeMinutes,
      },
      stalledMessage,
    );
  }

  log.info(
    {
      stalledCount: results.length,
      staleAgeMinutes,
      runIds: results.map((r) => r.runId),
    },
    "checkStalledStages complete",
  );

  return results;
}

/**
 * Marks a pipeline run as eligible for resume by updating its status from
 * "running" to "retriable" so the next PM tick's recovery sweep can pick it
 * up, or the operator can trigger an explicit resume via the dashboard.
 *
 * This is the programmatic equivalent of `POST /runs/:id/resume-stalled`.
 *
 * Only acts on runs that are currently status="running" — calling this on a
 * run in any other status is a no-op and returns false.
 */
export async function markRunAsResumeEligible(
  db: AnyDb,
  runId: string,
): Promise<boolean> {
  try {
    // Verify the run is actually running before changing status
    const rows = await db
      .select({ id: pipelineRuns.id, status: pipelineRuns.status })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId))
      .limit(1);

    if (rows.length === 0) {
      log.warn({ runId }, "markRunAsResumeEligible: run not found");
      return false;
    }
    const run = (rows as any[])[0];
    if (run.status !== "running") {
      log.debug(
        { runId, status: run.status },
        "markRunAsResumeEligible: run is not in 'running' status — no-op",
      );
      return false;
    }

    await db
      .update(pipelineRuns)
      .set({ status: "retriable", errorMessage: "stalled: manually marked for resume" })
      .where(eq(pipelineRuns.id, runId));

    log.info({ runId }, "markRunAsResumeEligible: run marked retriable for resume");
    return true;
  } catch (err) {
    log.error({ runId, err }, "markRunAsResumeEligible: failed to update run status");
    return false;
  }
}

/**
 * Deletes a stale active_work row for a run that is no longer actually running.
 * Called by the resume-stalled handler after marking the run as retriable, so
 * the next tick's stall detection doesn't re-alert on the same run.
 */
export async function removeActiveWorkForRun(
  db: AnyDb,
  runId: string,
): Promise<void> {
  try {
    await db
      .delete(activeWork)
      .where(eq(activeWork.runId, runId));
    log.debug({ runId }, "removeActiveWorkForRun: active_work row removed");
  } catch (err) {
    log.warn({ runId, err }, "removeActiveWorkForRun: failed to remove active_work row");
  }
}


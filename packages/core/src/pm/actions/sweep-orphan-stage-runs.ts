import { pipelineRuns, stageRuns } from "../../db/schema.js";
import type { AnyDb } from "../../db/client.js";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { createLogger } from "../../logger.js";

const log = createLogger({ component: "PmAgent:sweep-orphan-stage-runs" });

/**
 * Terminal statuses for pipeline_runs. A stage_run whose parent has any of
 * these statuses and is itself still 'running' is an orphan.
 */
const TERMINAL_PARENT_STATUSES = [
  "failed",
  "cancelled",
  "completed",
  "aborted",
] as const;

/**
 * BEC-250 — PM tick sweep that reconciles orphan stage_runs.
 *
 * Two classes of orphan are handled:
 *
 * 1. Parent in terminal state (failed/cancelled/completed/aborted) but child
 *    stage_run is still 'running'. This happens when the process crashes
 *    between the pipeline_run terminal-state write and the stage_run update,
 *    or in historical rows created before BEC-250's runner-side fix. These
 *    are marked 'cancelled'.
 *
 * 2. Parent deleted (stage_run.pipeline_run_id references a row that no
 *    longer exists). This predates FK enforcement. These are deleted.
 *
 * Running stage_runs whose parent is still 'running' are NOT touched — those
 * are live in-flight stages. Completed/failed stage_runs are NOT touched
 * regardless of parent state — they are historical record.
 *
 * Idempotent: the WHERE clause on status='running' is a no-op when no orphans
 * remain. Safe to call every PM tick.
 */
export async function sweepOrphanStageRuns(
  db: AnyDb,
): Promise<{ cancelled: number; deleted: number }> {
  // Run both SELECT queries concurrently — they are independent reads.
  const [terminalOrphans, missingParentOrphans] = await Promise.all([
    // Case 1: parent has a terminal status
    db
      .select({ id: stageRuns.id })
      .from(stageRuns)
      .innerJoin(pipelineRuns, eq(stageRuns.pipelineRunId, pipelineRuns.id))
      .where(
        and(
          eq(stageRuns.status, "running"),
          // Spread required: inArray() expects a mutable array; `as const` tuple is readonly.
          inArray(pipelineRuns.status, [...TERMINAL_PARENT_STATUSES]),
        ),
      ) as Promise<Array<{ id: string }>>,

    // Case 2: parent row is missing entirely (predates FK enforcement)
    db
      .select({ id: stageRuns.id })
      .from(stageRuns)
      .leftJoin(pipelineRuns, eq(stageRuns.pipelineRunId, pipelineRuns.id))
      .where(
        and(eq(stageRuns.status, "running"), isNull(pipelineRuns.id)),
      ) as Promise<Array<{ id: string }>>,
  ]);

  let cancelled = 0;
  if (terminalOrphans.length > 0) {
    const ids = terminalOrphans.map((r) => r.id);
    await db
      .update(stageRuns)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(inArray(stageRuns.id, ids));
    cancelled = ids.length;
    log.info({ count: cancelled }, "BEC-250: cancelled orphan stage_runs with terminal parent");
  }

  let deleted = 0;
  if (missingParentOrphans.length > 0) {
    const ids = missingParentOrphans.map((r) => r.id);
    await db.delete(stageRuns).where(inArray(stageRuns.id, ids));
    deleted = ids.length;
    log.info({ count: deleted }, "BEC-250: deleted orphan stage_runs with missing parent");
  }

  return { cancelled, deleted };
}

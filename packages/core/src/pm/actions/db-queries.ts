import type { AnyDb } from "../../db/client.js";
import { pipelineRuns } from "../../db/schema.js";
import { and, desc, eq, gte, inArray } from "drizzle-orm";

/** Statuses considered "active" (pipeline currently running). */
export const ACTIVE_STATUSES = ["queued", "running"] as const;

/** Default window for considering a recently-completed run as still "fresh". */
const RECENT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch two sets of issue identifiers from the pipeline_runs table:
 * - activeIssueIds: issues with a currently running/queued pipeline
 * - recentlyProcessed: issues with a completed/failed run within the recent window
 *
 * Used by both startTodoIssues and recoverStuckInProgressIssues to avoid
 * re-processing issues that already have pipeline activity.
 */
export async function getActiveAndRecentIssueIds(
  db: AnyDb,
  recentWindowMs = RECENT_WINDOW_MS,
): Promise<{ activeIssueIds: Set<string>; recentlyProcessed: Set<string> }> {
  const activeRows = await db
    .select({ issueId: pipelineRuns.issueId })
    .from(pipelineRuns)
    .where(inArray(pipelineRuns.status, [...ACTIVE_STATUSES]));
  const activeIssueIds = new Set<string>((activeRows as any[]).map((r) => r.issueId));

  const recentCutoff = new Date(Date.now() - recentWindowMs);
  const recentRows = await db
    .select({ issueId: pipelineRuns.issueId })
    .from(pipelineRuns)
    .where(
      and(
        inArray(pipelineRuns.status, ["completed", "failed"]),
        gte(pipelineRuns.completedAt, recentCutoff),
      ),
    );
  const recentlyProcessed = new Set<string>((recentRows as any[]).map((r) => r.issueId));

  return { activeIssueIds, recentlyProcessed };
}

/**
 * BEC-161: count consecutive failed pipeline runs for an issue since the last
 * successfully-completed run (or since the first run if none completed). Active
 * runs (queued/running) are ignored — only terminal `completed`/`failed` rows
 * count.
 *
 * Promote and start-todo use this to short-circuit candidates whose pipeline
 * keeps failing — preventing the doom loop where recover-stuck → promote →
 * start-todo → fail repeats indefinitely on tickets the agent can't progress.
 */
export async function countConsecutiveFailures(
  db: AnyDb,
  issueId: string,
): Promise<number> {
  const rows = await db
    .select({ status: pipelineRuns.status })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.issueId, issueId),
        inArray(pipelineRuns.status, ["completed", "failed"]),
      ),
    )
    .orderBy(desc(pipelineRuns.startedAt));

  let count = 0;
  for (const row of rows as Array<{ status: string }>) {
    if (row.status === "failed") count++;
    else break;
  }
  return count;
}

import type { AnyDb } from "../../db/client.js";
import { pipelineRuns } from "../../db/schema.js";
import { sql } from "drizzle-orm";

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
    .where(sql`${pipelineRuns.status} in ('running', 'queued')`);
  const activeIssueIds = new Set<string>((activeRows as any[]).map((r) => r.issueId));

  const recentCutoff = new Date(Date.now() - recentWindowMs);
  const recentRows = await db
    .select({ issueId: pipelineRuns.issueId })
    .from(pipelineRuns)
    .where(
      sql`${pipelineRuns.status} in ('completed', 'failed')
        AND ${pipelineRuns.completedAt} >= ${recentCutoff}`,
    );
  const recentlyProcessed = new Set<string>((recentRows as any[]).map((r) => r.issueId));

  return { activeIssueIds, recentlyProcessed };
}

import type { AnyDb } from "../../db/client.js";
import type { CircuitBrokenIssue } from "../types.js";
import { pipelineRuns } from "../../db/schema.js";
import { and, desc, eq, gte, inArray, or } from "drizzle-orm";

/** Statuses considered "active" (pipeline currently running). */
export const ACTIVE_STATUSES = ["queued", "running"] as const;

/**
 * Count leading 'failed' rows in a most-recent-first ordered list of pipeline
 * run rows, stopping at the first non-failed row.  Shared by
 * `countConsecutiveFailures` (single issue) and `batchCountConsecutiveFailures`
 * (batch variant) to keep the counting logic in one place.
 */
function countLeadingFailures(rows: Array<{ status: string }>): number {
  let count = 0;
  for (const row of rows) {
    if (row.status === "failed") count++;
    else break;
  }
  return count;
}

/** Default window for considering a recently-completed run as still "fresh". */
const RECENT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch two sets of issue identifiers from the pipeline_runs table:
 * - activeIssueIds: issues with a currently running/queued pipeline
 * - recentlyProcessed: issues with a completed/failed run within the recent window
 *
 * Used by both startTodoIssues and recoverStuckInProgressIssues to avoid
 * re-processing issues that already have pipeline activity.
 *
 * BEC-184: when `stuckRunAgeMs` is provided, 'running' runs that started MORE
 * THAN `stuckRunAgeMs` ago are excluded from `activeIssueIds`. This allows
 * recoverStuckInProgressIssues to treat zombie/stalled runs as stuck.
 * 'queued' runs are always considered active regardless of age.
 */
export async function getActiveAndRecentIssueIds(
  db: AnyDb,
  recentWindowMs = RECENT_WINDOW_MS,
  stuckRunAgeMs?: number,
): Promise<{ activeIssueIds: Set<string>; recentlyProcessed: Set<string> }> {
  let activeRows: any[];
  if (stuckRunAgeMs !== undefined) {
    // BEC-184: exclude long-running 'running' rows from the active set so they
    // fall through to the stuck detection logic. 'queued' is always active.
    const stuckCutoff = new Date(Date.now() - stuckRunAgeMs);
    activeRows = await db
      .select({ issueId: pipelineRuns.issueId })
      .from(pipelineRuns)
      .where(
        or(
          eq(pipelineRuns.status, "queued"),
          and(
            eq(pipelineRuns.status, "running"),
            gte(pipelineRuns.startedAt, stuckCutoff),
          ),
        ),
      );
  } else {
    activeRows = await db
      .select({ issueId: pipelineRuns.issueId })
      .from(pipelineRuns)
      .where(inArray(pipelineRuns.status, [...ACTIVE_STATUSES]));
  }
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
    // Secondary tie-breaker on `id`: SQL leaves ties on `startedAt` undefined,
    // and runs queued in the same scheduler tick (or in fast test fixtures)
    // can share the second-resolution timestamp. `id` is a monotonic random
    // string, so it gives us a stable ordering when `startedAt` collides.
    .orderBy(desc(pipelineRuns.startedAt), desc(pipelineRuns.id));

  return countLeadingFailures(rows as Array<{ status: string }>);
}

/**
 * BEC-181: batch variant of `countConsecutiveFailures` — fetches terminal
 * pipeline runs for all specified issue IDs in a single DB round-trip, then
 * computes consecutive-failure counts in memory.
 *
 * Use this in promote / start-todo to avoid an N+1 query pattern when
 * checking multiple candidates in the same tick.  The returned Map contains
 * an entry for every issueId in the input list (defaulting to 0 for issues
 * with no terminal runs).
 */
/**
 * Tier 5 — fetch the most recent failed pipeline_runs row's errorMessage for
 * a single issue. Used by the promote-stage escalation to summarize the
 * failure mode in the Linear comment / Slack alert when an issue trips the
 * circuit breaker. Returns the message string or null if no failed run
 * exists (or the column was empty).
 *
 * Single-issue, single-query — escalations are rare (≥ 3 consecutive
 * failures per issue), so an N+1 here is acceptable in practice.
 */
export async function getLastFailureError(
  db: AnyDb,
  issueId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      errorMessage: pipelineRuns.errorMessage,
      startedAt: pipelineRuns.startedAt,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.issueId, issueId),
        eq(pipelineRuns.status, "failed"),
      ),
    )
    .orderBy(desc(pipelineRuns.startedAt), desc(pipelineRuns.id))
    .limit(1);

  const row = (rows as Array<{ errorMessage: string | null }>)[0];
  return row?.errorMessage ?? null;
}

export async function batchCountConsecutiveFailures(
  db: AnyDb,
  issueIds: string[],
): Promise<Map<string, number>> {
  if (issueIds.length === 0) return new Map();

  const rows = await db
    .select({ issueId: pipelineRuns.issueId, status: pipelineRuns.status })
    .from(pipelineRuns)
    .where(
      and(
        inArray(pipelineRuns.issueId, issueIds),
        inArray(pipelineRuns.status, ["completed", "failed"]),
      ),
    )
    // Same ordering as countConsecutiveFailures: most-recent first, with id
    // as a stable tie-breaker for runs sharing the same startedAt timestamp.
    .orderBy(desc(pipelineRuns.startedAt), desc(pipelineRuns.id));

  // Group rows by issueId preserving the DESC order from the DB query.
  const byIssue = new Map<string, Array<{ status: string }>>();
  for (const row of rows as Array<{ issueId: string; status: string }>) {
    const bucket = byIssue.get(row.issueId);
    if (bucket) {
      bucket.push({ status: row.status });
    } else {
      byIssue.set(row.issueId, [{ status: row.status }]);
    }
  }

  // Count leading "failed" rows for each issue (delegates to shared helper).
  const result = new Map<string, number>();
  for (const issueId of issueIds) {
    const issueRows = byIssue.get(issueId) ?? [];
    result.set(issueId, countLeadingFailures(issueRows));
  }
  return result;
}

/**
 * BEC-223: Fetch issues that have hit the circuit-breaker threshold (≥
 * `minConsecutiveFailures` consecutive failed pipeline runs) and had at
 * least one failed run within the last `windowDays` days.
 *
 * Issues whose most-recent terminal run is `'completed'` are automatically
 * excluded by `batchCountConsecutiveFailures` (it returns 0 for recovered
 * issues), so no extra filter is needed.
 *
 * Avoids N+1 queries: a single `batchCountConsecutiveFailures` round-trip
 * processes all candidate issue IDs.
 *
 * BEC-187 (CLAUDE.md hot-path note): `pipeline_runs` lacks an index on
 * `(status, started_at)` until BEC-187 ships. This query is bounded by:
 *   - a 7-day cutoff on `started_at`,
 *   - a row LIMIT (`CIRCUIT_BROKEN_FETCH_LIMIT`),
 *   - frequency: invoked once per PM tick (default 30 min).
 * The Slack digest only renders the top 10, so 50 candidate rows is more
 * than enough headroom for dedup-by-issue-id.
 */
const CIRCUIT_BROKEN_FETCH_LIMIT = 50;

export async function fetchCircuitBrokenIssues(
  db: AnyDb,
  minConsecutiveFailures: number = 3,
  windowDays: number = 7,
): Promise<CircuitBrokenIssue[]> {
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Fetch up to CIRCUIT_BROKEN_FETCH_LIMIT most-recent failed runs in the
  // window (most-recent first). See BEC-187 note above re: hot-path query
  // budget.
  const rows = await db
    .select({
      issueId: pipelineRuns.issueId,
      issueTitle: pipelineRuns.issueTitle,
      errorMessage: pipelineRuns.errorMessage,
      startedAt: pipelineRuns.startedAt,
      completedAt: pipelineRuns.completedAt,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.status, "failed"),
        gte(pipelineRuns.startedAt, cutoff),
      ),
    )
    .orderBy(desc(pipelineRuns.startedAt), desc(pipelineRuns.id))
    .limit(CIRCUIT_BROKEN_FETCH_LIMIT);

  // Dedupe by issueId — keep the most-recent failed run's display data.
  const byIssue = new Map<string, CircuitBrokenIssue>();
  for (const row of rows as Array<{
    issueId: string;
    issueTitle: string;
    errorMessage: string | null;
    startedAt: Date;
    completedAt: Date | null;
  }>) {
    if (!byIssue.has(row.issueId)) {
      byIssue.set(row.issueId, {
        issueId: row.issueId,
        issueTitle: row.issueTitle,
        errorMessage: row.errorMessage ?? undefined,
        // Prefer completedAt (exact failure time); fall back to startedAt.
        failedAt: row.completedAt ?? row.startedAt,
        url: `https://linear.app/issue/${row.issueId}`,
      });
    }
  }

  if (byIssue.size === 0) return [];

  const issueIds = Array.from(byIssue.keys());
  const failureCounts = await batchCountConsecutiveFailures(db, issueIds);

  // Retain only issues at or above the failure threshold.
  // batchCountConsecutiveFailures returns 0 for recovered issues.
  const results: CircuitBrokenIssue[] = [];
  for (const issueId of issueIds) {
    const count = failureCounts.get(issueId) ?? 0;
    if (count >= minConsecutiveFailures) {
      results.push(byIssue.get(issueId)!);
    }
  }

  // Most-recently-broken first so the digest is stable across ticks.
  results.sort((a, b) => b.failedAt.getTime() - a.failedAt.getTime());

  return results;
}

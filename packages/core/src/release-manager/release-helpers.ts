/**
 * release-helpers.ts
 *
 * Responsibility: persistence and Slack notification helpers for the release manager.
 *
 * Exports:
 *   - SlackPoster                 — interface for the injectable Slack client
 *   - SlackDedupState             — mutable dedup counters passed between ticks
 *   - MAX_QA_RETRY_ATTEMPTS       — threshold before escalating to a permanent skip reason
 *   - maybePostSlack              — post to Slack with 24-hour same-reason dedup
 *   - persistDecision             — write a release_decisions row
 *   - consumeApprovalRow          — mark the most-recent fresh approval as consumed
 *   - getMaxAttemptCountForReason — query the attempt count from the most-recent row for a (repo, branch, reason) triple
 *   - tryFileQaGapIssue           — file a QA gap issue via Linear and handle transient errors
 */
import { and, desc, eq, isNull, max } from "drizzle-orm";
import type { LinearClient } from "@linear/sdk";
import type { AnyDb } from "../db/client.js";
import { releaseApprovals, releaseDecisions } from "../db/schema.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { slackPostFailedEvent } from "../audit/events.js";
import { createLogger } from "../logger.js";
import { fileGapIssue } from "../qa/gap.js";

const log = createLogger({ component: "ReleaseManager:helpers" });

/** Minimal Slack client interface required by the release manager. */
export interface SlackPoster {
  postMessage: (channel: string, text: string) => Promise<boolean>;
}

/** 24-hour dedup window — same reason within this window is suppressed. */
const SLACK_DEDUP_WINDOW_MS = 24 * 3600 * 1000;

/**
 * Mutable Slack dedup state shared between ticks.
 *
 * Both `lastSkipReason` and `lastPostAt` are mutated in-place by
 * `maybePostSlack` on a successful post, and by the tick orchestrator when
 * transitioning to fire or awaiting-approval.
 */
export interface SlackDedupState {
  /** Skip-reason string from the last successful Slack post, or null. */
  lastSkipReason: string | null;
  /** Epoch-ms timestamp of the last successful Slack post. */
  lastPostAt: number;
}

/**
 * Maximum consecutive QA-related retry attempts before escalating to a
 * permanent skip reason (e.g. `"qa_dispatch_error"` or `"qa_gap_file_error"`).
 */
export const MAX_QA_RETRY_ATTEMPTS = 3;

/**
 * Post a Slack message, deduplicating same-reason posts within 24 hours.
 *
 * - When `currentSkipReason` is non-null: suppresses the post if the same
 *   reason was posted within `SLACK_DEDUP_WINDOW_MS`.
 * - When `currentSkipReason` is null (fire / awaiting-approval transitions):
 *   always posts regardless of the dedup window.
 *
 * Mutates `dedupState.lastPostAt` and `dedupState.lastSkipReason` on success.
 * Writes a `slackPostFailedEvent` audit entry if `postMessage` returns false.
 */
export async function maybePostSlack(
  slack: SlackPoster | undefined,
  slackChannel: string | undefined,
  db: AnyDb,
  dedupState: SlackDedupState,
  text: string,
  currentSkipReason: string | null,
): Promise<void> {
  if (!slack || !slackChannel) return;
  const now = Date.now();
  // Always post when transitioning to fire / awaiting-approval.
  // Otherwise dedup: same reason + within window → suppress.
  if (currentSkipReason) {
    const sameReason = currentSkipReason === dedupState.lastSkipReason;
    const withinWindow = now - dedupState.lastPostAt < SLACK_DEDUP_WINDOW_MS;
    if (sameReason && withinWindow) return;
  }
  const ok = await slack.postMessage(slackChannel, text).catch(() => false);
  if (!ok) {
    void logAuditEventUnchecked(db, slackPostFailedEvent({ channel: slackChannel, reason: "post_returned_false" }));
    return;
  }
  dedupState.lastPostAt = now;
  dedupState.lastSkipReason = currentSkipReason;
}

/**
 * Persist a release decision row to the `release_decisions` table.
 *
 * @param db       - Database client.
 * @param repoUrl  - Repository URL (used as the partition key).
 * @param branch   - Branch name being managed.
 * @param row      - Decision fields. `attemptCount` defaults to 0 when omitted.
 */
export async function persistDecision(
  db: AnyDb,
  repoUrl: string,
  branch: string,
  row: {
    id: string;
    decision: string;
    reason: string;
    triggerStateJson: string;
    proposedVersion?: string;
    firedTag?: string;
    firedSha?: string;
    attemptCount?: number;
    qaRunId?: number;
    qaRunSha?: string;
  },
): Promise<void> {
  await (db as any).insert(releaseDecisions).values({
    id: row.id,
    repoUrl,
    branch,
    decidedAt: new Date(),
    decision: row.decision,
    reason: row.reason,
    triggerStateJson: row.triggerStateJson,
    proposedVersion: row.proposedVersion,
    firedTag: row.firedTag,
    firedSha: row.firedSha,
    attemptCount: row.attemptCount ?? 0,
    qaRunId: row.qaRunId,
    qaRunSha: row.qaRunSha,
  });
}

/**
 * Mark the most-recent un-consumed approval row for `(repoUrl, branch)` as
 * consumed by `decisionId`.
 *
 * No-op when no fresh approval exists (e.g. approval was already consumed by a
 * concurrent tick or the approval row was deleted manually).
 */
export async function consumeApprovalRow(
  db: AnyDb,
  repoUrl: string,
  branch: string,
  decisionId: string,
): Promise<void> {
  const fresh = await (db as any)
    .select({ id: releaseApprovals.id })
    .from(releaseApprovals)
    .where(
      and(
        eq(releaseApprovals.repoUrl, repoUrl),
        eq(releaseApprovals.branch, branch),
        isNull(releaseApprovals.consumedAt),
      ),
    )
    .orderBy(desc(releaseApprovals.approvedAt))
    .limit(1);
  if (fresh?.[0]?.id) {
    await (db as any)
      .update(releaseApprovals)
      .set({ consumedAt: new Date(), consumedByDecisionId: decisionId })
      .where(eq(releaseApprovals.id, fresh[0].id));
  }
}

/**
 * Query the highest `attemptCount` stored for a given `(repoUrl, branch, reason)` triple.
 *
 * Uses `MAX(attemptCount)` rather than `ORDER BY decidedAt DESC + LIMIT 1` to be stable
 * when multiple rows share the same `decidedAt` timestamp (e.g. rapid consecutive ticks
 * within the same second — `crossTimestamp` stores SQLite epoch with second resolution).
 *
 * BEC-146: the original ORDER BY+LIMIT version was non-deterministic on timestamp ties
 * and caused two regressions: (a) reset row sometimes missed → false escalation, (b)
 * latest failure row sometimes missed → escalation never fires when it should. The
 * counter-reset behavior on `dispatch_pending` is now handled by `clearFailureRowsForSha`
 * (called from release-tick.ts before persisting the reset row), which removes prior
 * failure rows so MAX naturally returns 0 after a reset.
 *
 * @param db        - Database client.
 * @param repoUrl   - Repository URL.
 * @param branch    - Branch name.
 * @param reason    - The `reason` column value to filter on (e.g. `"qa_needs_trigger"`).
 * @param qaRunSha  - Optional: when supplied, further filters to rows with this `qaRunSha`.
 *                    Use when tracking retry attempts for a specific commit SHA.
 * @returns The maximum attempt count found, or `0` when no matching rows exist.
 */
export async function getMaxAttemptCountForReason(
  db: AnyDb,
  repoUrl: string,
  branch: string,
  reason: string,
  qaRunSha?: string,
): Promise<number> {
  const rows = await (db as any)
    .select({ maxAttempts: max(releaseDecisions.attemptCount) })
    .from(releaseDecisions)
    .where(
      qaRunSha !== undefined
        ? and(
            eq(releaseDecisions.repoUrl, repoUrl),
            eq(releaseDecisions.branch, branch),
            eq(releaseDecisions.reason, reason),
            eq(releaseDecisions.qaRunSha, qaRunSha),
          )
        : and(
            eq(releaseDecisions.repoUrl, repoUrl),
            eq(releaseDecisions.branch, branch),
            eq(releaseDecisions.reason, reason),
          ),
    );
  return rows?.[0]?.maxAttempts ?? 0;
}

/**
 * BEC-146: clear prior QA-retry failure rows for a (repoUrl, branch, qaRunSha) so that
 * after a successful dispatch (or `dispatch_pending` — HTTP 204 succeeded but listWorkflowRuns
 * hasn't seen the run yet) the retry counter naturally starts from 0 again.
 *
 * The audit log (`audit_events`) retains the full history; `releaseDecisions` is
 * working state for retry tracking and dedup, not the historical record.
 */
export async function clearFailureRowsForSha(
  db: AnyDb,
  repoUrl: string,
  branch: string,
  reason: string,
  qaRunSha: string,
): Promise<void> {
  await (db as any).delete(releaseDecisions).where(
    and(
      eq(releaseDecisions.repoUrl, repoUrl),
      eq(releaseDecisions.branch, branch),
      eq(releaseDecisions.reason, reason),
      eq(releaseDecisions.qaRunSha, qaRunSha),
      isNull(releaseDecisions.qaRunId),
    ),
  );
}

/**
 * File a QA gap issue via Linear and handle transient filing errors.
 *
 * Wraps `fileGapIssue` with attempt-count tracking. On a `linear_error` response,
 * increments the per-`(repoUrl, branch, "qa_no_workflow")` attempt counter and
 * escalates `finalReason` to `"qa_gap_file_error"` once `MAX_QA_RETRY_ATTEMPTS`
 * consecutive failures have occurred.
 *
 * On success (`"filed"` or `"already_filed"`), returns
 * `{ finalReason: "qa_no_workflow", attemptCount: 0 }` — the attempt counter
 * resets to 0 to signal that no error has been seen for this filing.
 *
 * @param params.db             - Database client.
 * @param params.linear         - Linear client (required; caller is responsible for the
 *                                `if (linear)` guard before calling this helper).
 * @param params.repoUrl        - Repository URL.
 * @param params.branch         - Branch name.
 * @param params.workflowPath   - Configured QA workflow file path (e.g. `".github/workflows/smoke.yml"`).
 * @param params.linearTeamId   - Linear team ID to file the gap issue into.
 * @returns `{ finalReason, attemptCount }` for use in the decision row.
 */
export async function tryFileQaGapIssue(params: {
  db: AnyDb;
  linear: LinearClient;
  repoUrl: string;
  branch: string;
  workflowPath: string;
  linearTeamId: string;
}): Promise<{ finalReason: string; attemptCount: number }> {
  const { db, linear, repoUrl, branch, workflowPath, linearTeamId } = params;
  const gapResult = await fileGapIssue({ db, linear, repoUrl, branch, workflowPath, linearTeamId });
  if (gapResult.kind !== "linear_error") {
    // Filed or already-filed — reset attempt counter for this gap-filing loop.
    return { finalReason: "qa_no_workflow", attemptCount: 0 };
  }
  const prevCount = await getMaxAttemptCountForReason(db, repoUrl, branch, "qa_no_workflow");
  const attemptCount = prevCount + 1;
  const finalReason = attemptCount >= MAX_QA_RETRY_ATTEMPTS ? "qa_gap_file_error" : "qa_no_workflow";
  log.error({ err: gapResult.message, repoUrl, branch }, "fileGapIssue failed; will retry");
  return { finalReason, attemptCount };
}

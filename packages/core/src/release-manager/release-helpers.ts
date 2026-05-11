/**
 * release-helpers.ts
 *
 * Responsibility: persistence and Slack notification helpers for the release manager.
 *
 * Exports:
 *   - SlackPoster       — interface for the injectable Slack client
 *   - SlackDedupState   — mutable dedup counters passed between ticks
 *   - maybePostSlack    — post to Slack with 24-hour same-reason dedup
 *   - persistDecision   — write a release_decisions row
 *   - consumeApprovalRow — mark the most-recent fresh approval as consumed
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { releaseApprovals, releaseDecisions } from "../db/schema.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { slackPostFailedEvent } from "../audit/events.js";

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

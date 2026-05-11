/**
 * Shared utilities for GitLab and Bitbucket webhook handlers.
 *
 * Extracted to avoid duplication between `gitlab-handler.ts` and
 * `bitbucket-handler.ts`. Both providers follow the same general pattern for:
 *  - In-memory comment dedup (TTL-based expiry)
 *  - DB lookups for pipeline runs
 *  - Generic "PR/MR merged" event handling
 *  - Common comment-event filtering and feedback-run triggering
 */

import { eq } from "drizzle-orm";
import { pipelineRuns } from "../db/schema.js";
import type { AnyDb } from "../db/client.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { Notifier, PipelineConfig, PipelineRun, RepoConfig } from "../types.js";
import { createLogger } from "../logger.js";
import type { ReviewFeedbackComment } from "./github-handler.js";

const log = createLogger({ component: "WebhookSharedHandlers" });

// ---------------------------------------------------------------------------
// WebhookDedupSet — in-memory dedup for processed event IDs (24h TTL)
// ---------------------------------------------------------------------------

/**
 * In-memory dedup set for processed webhook event IDs with TTL-based expiry.
 * Used by GitLab (note IDs) and Bitbucket (comment IDs) webhook handlers to
 * prevent double-processing when webhooks are delivered more than once.
 */
export class WebhookDedupSet {
  private entries = new Map<string, number>(); // id -> expiry ms

  has(id: string): boolean {
    const expiry = this.entries.get(id);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.entries.delete(id);
      return false;
    }
    return true;
  }

  add(id: string, ttlMs = 86_400_000 /* 24 h */): void {
    this.entries.set(id, Date.now() + ttlMs);
  }

  /** Purge entries whose TTL has elapsed. Call periodically (e.g. every minute). */
  cleanup(): void {
    const now = Date.now();
    for (const [id, expiry] of this.entries) {
      if (now > expiry) this.entries.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// buildRepoConfigMap — O(1) URL → RepoConfig lookup
// ---------------------------------------------------------------------------

/**
 * Build an O(1) Map<repoUrl, RepoConfig> for fast webhook-time lookups.
 *
 * Call once at handler initialisation (inside `createXxxWebhookHandler()`),
 * store as a closure variable, and replace linear `Object.values(repoConfigs)`
 * scans with `repoConfigsByUrl.get(url)`.
 */
export function buildRepoConfigMap(
  repoConfigs: Record<string, RepoConfig>,
): Map<string, RepoConfig> {
  const map = new Map<string, RepoConfig>();
  for (const rc of Object.values(repoConfigs)) {
    if (rc.url) map.set(rc.url, rc);
  }
  return map;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Look up a pipeline run by PR/MR URL (primary) then by branch name (fallback).
 * Shared by GitLab and Bitbucket webhook handlers.
 */
export async function findPipelineRunByUrlOrBranch(
  db: AnyDb,
  url?: string,
  branch?: string,
): Promise<(typeof pipelineRuns.$inferSelect) | undefined> {
  if (url) {
    const rows = await db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.prUrl, url))
      .limit(1);
    if (rows.length > 0) return rows[0];
  }
  if (branch?.startsWith("agent/")) {
    const rows = await db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.branch, branch))
      .limit(1);
    if (rows.length > 0) return rows[0];
  }
  return undefined;
}

/**
 * Mark a pipeline run as externally merged.
 * Shared by GitLab and Bitbucket webhook handlers.
 */
export async function updatePipelineRunMerged(
  db: AnyDb,
  runId: string,
  merged: boolean | null,
  reason: string,
): Promise<void> {
  await db
    .update(pipelineRuns)
    .set({ autoMerged: merged, autoMergeReason: reason })
    .where(eq(pipelineRuns.id, runId));
}

// ---------------------------------------------------------------------------
// handleMergedEvent — generic PR/MR merged handler
// ---------------------------------------------------------------------------

export interface MergedEventHandlerConfig {
  db: AnyDb;
  notifier?: Notifier;
  /** Human-readable reason stored in autoMergeReason, e.g. "merged via GitLab". */
  mergeReason: string;
}

/**
 * Generic handler for PR/MR merged events.
 *
 * Marks the pipeline run as merged in the DB and calls `notifier.onPRMerged`.
 * The caller is responsible for extracting `url` and `branch` from the
 * provider-specific webhook payload before calling this function.
 *
 * @param url    The PR/MR web URL (e.g. https://gitlab.com/org/repo/-/merge_requests/7)
 * @param branch The source branch of the PR/MR
 * @param config DB, notifier, and merge-reason string
 */
export async function handleMergedEvent(
  url: string,
  branch: string,
  config: MergedEventHandlerConfig,
): Promise<void> {
  if (!url) {
    log.warn("merged-event: no URL extracted from payload — skipping");
    return;
  }

  const originalRun = await findPipelineRunByUrlOrBranch(config.db, url, branch);
  if (!originalRun) {
    log.debug({ url }, "merged-event: no pipeline run found — skipping");
    return;
  }

  if (originalRun.autoMerged) {
    log.debug(
      { runId: originalRun.id },
      "merged-event: run already marked merged — skipping",
    );
    return;
  }

  await updatePipelineRunMerged(config.db, originalRun.id, true, config.mergeReason);
  log.info(
    { runId: originalRun.id, url },
    "merged-event: updated pipeline run auto_merged=true",
  );

  if (config.notifier?.onPRMerged) {
    await config.notifier
      .onPRMerged(originalRun as unknown as PipelineRun)
      .catch((err) =>
        log.error(
          { err, runId: originalRun.id },
          "merged-event: notifier.onPRMerged() failed",
        ),
      );
  }
}

// ---------------------------------------------------------------------------
// processCommentFeedback — shared comment-to-feedback-run logic
// ---------------------------------------------------------------------------

export interface CommentFeedbackInput {
  /** Dedup key for this comment (note ID on GitLab, comment ID on Bitbucket). */
  commentId: string;
  /** Raw comment body text (before sanitisation). */
  commentBody: string;
  /** Author login / username / nickname. */
  commentAuthor: string;
  /** Permalink URL to the comment. */
  commentHtmlUrl: string;
  /** Web URL of the PR or MR. */
  prUrl: string;
  /** Source branch of the PR or MR. */
  prBranch: string;
  /** Numeric PR/MR ID used for startFeedback (iid on GitLab, id on Bitbucket). */
  prNumber: number;
  /** Already-resolved pipeline run for this PR/MR (from findPipelineRunByUrlOrBranch). */
  originalRun: typeof pipelineRuns.$inferSelect;
  /** Already-resolved RepoConfig for this run's repo URL. */
  repoConfig: RepoConfig;
}

export interface CommentFeedbackResult {
  ok: boolean;
  action?: string;
  skipped?: string;
  deduplicated?: boolean;
}

/**
 * Apply all filters and trigger a review-feedback pipeline run for a PR/MR
 * comment event. Returns a JSON-serializable result for the HTTP response.
 *
 * Shared by GitLab and Bitbucket webhook handlers. The caller is responsible
 * for auth/signature verification, payload parsing, field extraction, and
 * resolving `originalRun` + `repoConfig` before calling this function.
 *
 * Filters applied (in order):
 *  1. Bot exclusion (`feedbackCfg.botLogins`)
 *  2. Allowed-reviewer list (`feedbackCfg.allowedReviewers`)
 *  3. Trigger-keyword check (`feedbackCfg.triggerKeyword`)
 *  4. In-memory dedup (24h TTL via `WebhookDedupSet`)
 *  5. Rate-limit (one active feedback run per PR/MR URL)
 *  6. Pipeline config lookup
 */
export async function processCommentFeedback(
  input: CommentFeedbackInput,
  handlerConfig: {
    runner: PipelineRunner;
    pipelineConfigs: Record<string, PipelineConfig>;
    dedup: WebhookDedupSet;
  },
): Promise<CommentFeedbackResult> {
  const {
    commentId,
    commentBody,
    commentAuthor,
    commentHtmlUrl,
    prUrl,
    prBranch,
    prNumber,
    originalRun,
    repoConfig,
  } = input;
  const { runner, pipelineConfigs, dedup } = handlerConfig;

  // Feedback config — `githubFeedback` field applies to all providers
  // (named for historical reasons; used by GitHub, GitLab, and Bitbucket)
  const feedbackCfg = repoConfig.githubFeedback;

  // 1. Bot exclusion
  const botLogins = feedbackCfg?.botLogins ?? [];
  if (botLogins.length > 0 && botLogins.includes(commentAuthor)) {
    return { ok: true, skipped: "comment from bot login" };
  }

  // 2. Allowed-reviewer filter
  const allowedReviewers = feedbackCfg?.allowedReviewers ?? [];
  if (allowedReviewers.length > 0 && !allowedReviewers.includes(commentAuthor)) {
    return { ok: true, skipped: "commenter not in allowedReviewers" };
  }

  // 3. Trigger-keyword check
  const triggerKeyword = feedbackCfg?.triggerKeyword;
  const autoTrigger = feedbackCfg?.autoTrigger !== false;
  if (triggerKeyword) {
    if (!commentBody.includes(triggerKeyword)) {
      return { ok: true, skipped: "trigger keyword not found" };
    }
  } else if (!autoTrigger) {
    return { ok: true, skipped: "autoTrigger is disabled and no triggerKeyword configured" };
  }

  // 4. Dedup
  if (dedup.has(commentId)) {
    return { ok: true, deduplicated: true };
  }

  // 5. Rate-limit: one active feedback run per PR/MR URL
  if (runner.isActiveFeedback(prUrl)) {
    log.info({ prUrl }, "feedback run already in progress for this PR/MR — skipping");
    return { ok: true, skipped: "feedback run already in progress" };
  }

  // 6. Pipeline config lookup
  const pipelineKey = originalRun.pipelineKey;
  const pipelineConfig = pipelineConfigs[pipelineKey];
  if (!pipelineConfig) {
    log.warn({ pipelineKey }, "no pipeline config found for original run's pipelineKey");
    return { ok: true, skipped: "pipeline config not found" };
  }

  // Commit dedup entry now that we're going to trigger a run
  dedup.add(commentId);

  // Sanitise comment body before passing to agent pipeline
  const MAX_COMMENT_LENGTH = 4000;
  const sanitizedBody = commentBody
    .slice(0, MAX_COMMENT_LENGTH)
    .replace(/<\/review-comment>/gi, "[/review-comment]");

  const feedbackComment: ReviewFeedbackComment = {
    commentId,
    author: commentAuthor,
    body: sanitizedBody,
    htmlUrl: commentHtmlUrl,
  };

  // Build minimal issue object from DB row
  const issue = {
    id: originalRun.issueId,
    identifier: originalRun.issueId,
    title: originalRun.issueTitle,
    description: "",
    labels: [] as Array<{ name: string }>,
    priority: 0,
    teamId: "",
  };

  // Resolve branch: caller may have pre-resolved via `|| originalRun.branch`,
  // but we apply the same fallback here for safety.
  const resolvedBranch = prBranch || originalRun.branch || "";
  const branchSlug = resolvedBranch.startsWith("agent/")
    ? resolvedBranch.slice("agent/".length)
    : (originalRun.issueId ?? "feedback");

  const sanitizedIssue = {
    id: originalRun.issueId,
    slug: branchSlug,
    title: originalRun.issueTitle,
    description: "",
    acceptanceCriteria: [] as string[],
    labels: [] as string[],
    priority: 0,
  };

  // Fire-and-forget feedback run
  runner
    .startFeedback({
      issue,
      pipelineKey,
      pipelineConfig,
      repoConfig,
      sanitizedIssue,
      branch: resolvedBranch,
      prUrl,
      prNumber,
      parentRunId: originalRun.id,
      feedbackComments: [feedbackComment],
      rerequestReview: false, // GitLab/Bitbucket don't have GitHub's re-request concept
    })
    .catch((err) => log.error({ err }, "runner.startFeedback() failed"));

  return { ok: true, action: "feedback-triggered" };
}

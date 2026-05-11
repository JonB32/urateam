/**
 * GitLab webhook handler.
 *
 * Mirrors `webhook/github-handler.ts` for GitLab MR events:
 *  - Signature verification via `X-Gitlab-Token` header (shared secret, not HMAC).
 *  - MR comment (Note Hook) events → `review-feedback` pipeline run triggers.
 *  - MR merged events → mark pipeline run as merged in DB.
 *
 * ## Setup
 * In your GitLab project → Settings → Webhooks:
 *  1. Set the URL to `https://<your-host>/webhooks/gitlab`.
 *  2. Set a secret token in the "Secret token" field — this is the value you
 *     set as `gitlabWebhookToken` in your server config.
 *  3. Enable: "Comments" and "Merge request events".
 *
 * The handler validates the `X-Gitlab-Token` header against `gitlabWebhookToken`.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { pipelineRuns } from "../db/schema.js";
import type { AnyDb } from "../db/client.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { Notifier, PipelineConfig, PipelineRun, RepoConfig } from "../types.js";
import { createLogger } from "../logger.js";
import type { ReviewFeedbackComment } from "./github-handler.js";

const log = createLogger({ component: "GitLabWebhookHandler" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitLabWebhookHandlerConfig {
  /**
   * GitLab webhook secret token (the "Secret token" field in the GitLab
   * webhook settings). GitLab sends this verbatim in the `X-Gitlab-Token`
   * header — it is NOT an HMAC signature.
   *
   * Required in production. If omitted, all requests are accepted (dev only).
   */
  webhookToken?: string;
  runner: PipelineRunner;
  pipelineConfigs: Record<string, PipelineConfig>;
  repoConfigs: Record<string, RepoConfig>;
  db: AnyDb;
  /**
   * Notifier instance. When provided, `onPRMerged` is called when an MR is
   * merged externally, which transitions the Linear issue to Done.
   */
  notifier?: Notifier;
}

// ---------------------------------------------------------------------------
// Signature / token verification
// ---------------------------------------------------------------------------

/**
 * Verify a GitLab webhook token.
 *
 * GitLab sends the configured secret as a plain string in `X-Gitlab-Token`.
 * This function performs a constant-time comparison to prevent timing attacks.
 */
export function verifyGitLabToken(
  receivedToken: string,
  expectedToken: string,
): boolean {
  if (!receivedToken || !expectedToken) return false;
  // Pad both to the same length before comparing to maintain constant time
  const a = Buffer.from(receivedToken.padEnd(256, "\0"));
  const b = Buffer.from(expectedToken.padEnd(256, "\0"));
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// Shared DB helpers
// ---------------------------------------------------------------------------

/**
 * Look up a pipeline run by MR URL (primary) then by branch name (fallback).
 */
async function findPipelineRunByMrUrlOrBranch(
  db: AnyDb,
  mrUrl?: string,
  branch?: string,
): Promise<(typeof pipelineRuns.$inferSelect) | undefined> {
  if (mrUrl) {
    const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.prUrl, mrUrl)).limit(1);
    if (rows.length > 0) return rows[0];
  }
  if (branch?.startsWith("agent/")) {
    const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.branch, branch)).limit(1);
    if (rows.length > 0) return rows[0];
  }
  return undefined;
}

async function updatePipelineRunMerged(
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
// In-memory dedup for processed note IDs (24h TTL)
// ---------------------------------------------------------------------------

class NoteDedupSet {
  private entries = new Map<string, number>(); // noteId -> expiry ms

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

  cleanup(): void {
    const now = Date.now();
    for (const [id, expiry] of this.entries) {
      if (now > expiry) this.entries.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * Handle `merge_request` hook events where action === "merge".
 * Marks the pipeline run as merged in DB and calls notifier.onPRMerged.
 */
async function handleMRMergedEvent(
  payload: Record<string, any>,
  config: GitLabWebhookHandlerConfig,
): Promise<void> {
  const attrs = payload.object_attributes;
  if (!attrs) return;

  const mrUrl: string = attrs.url ?? "";
  const branch: string = attrs.source_branch ?? "";

  if (!mrUrl) {
    log.warn({ payload }, "mr-merged: no MR URL in payload — skipping");
    return;
  }

  const originalRun = await findPipelineRunByMrUrlOrBranch(config.db, mrUrl, branch);
  if (!originalRun) {
    log.debug({ mrUrl }, "mr-merged: no pipeline run found for MR — skipping");
    return;
  }

  if (originalRun.autoMerged) {
    log.debug({ runId: originalRun.id }, "mr-merged: run already marked merged — skipping");
    return;
  }

  await updatePipelineRunMerged(config.db, originalRun.id, true, "merged via GitLab");
  log.info({ runId: originalRun.id, mrUrl }, "mr-merged: updated pipeline run auto_merged=true");

  if (config.notifier?.onPRMerged) {
    await config.notifier.onPRMerged(originalRun as unknown as PipelineRun).catch((err) =>
      log.error({ err, runId: originalRun.id }, "mr-merged: notifier.onPRMerged() failed"),
    );
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create a Hono app that handles GitLab webhook events at `/webhooks/gitlab`.
 *
 * Mount in your server: `app.route("/", createGitLabWebhookHandler(config))`.
 */
export function createGitLabWebhookHandler(
  config: GitLabWebhookHandlerConfig,
): Hono {
  const app = new Hono();
  const dedup = new NoteDedupSet();

  // Periodic cleanup
  const cleanupTimer = setInterval(() => dedup.cleanup(), 60_000);
  cleanupTimer.unref();

  app.post("/webhooks/gitlab", async (c) => {
    const rawBody = await c.req.text();

    // 1. Verify token
    if (config.webhookToken) {
      const receivedToken = c.req.header("X-Gitlab-Token") ?? "";
      if (!verifyGitLabToken(receivedToken, config.webhookToken)) {
        return c.json({ error: "Invalid X-Gitlab-Token" }, 401);
      }
    }

    // 2. Parse payload
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const objectKind: string = payload.object_kind ?? "";
    const attrs = payload.object_attributes ?? {};

    // 3a. MR merged event
    if (
      objectKind === "merge_request" &&
      (attrs.action === "merge" || attrs.state === "merged")
    ) {
      await handleMRMergedEvent(payload, config);
      return c.json({ ok: true, action: "mr-merged" });
    }

    // 3b. Note (comment) on a merge request
    // GitLab sends object_kind="note" with noteable_type="MergeRequest"
    if (objectKind !== "note" || attrs.noteable_type !== "MergeRequest") {
      return c.json({ ok: true, skipped: "unhandled event type" });
    }

    // 4. Extract comment metadata
    const noteId = String(attrs.id ?? "");
    const commentBody: string = attrs.note ?? "";
    const commentAuthor: string = payload.user?.username ?? "";
    const commentHtmlUrl: string = attrs.url ?? "";

    if (!commentBody.trim()) {
      return c.json({ ok: true, skipped: "empty comment body" });
    }

    // 5. Extract MR metadata
    const mr = payload.merge_request ?? {};
    const mrUrl: string = mr.url ?? "";
    const mrBranch: string = mr.source_branch ?? "";
    const mrIsDraft: boolean = mr.draft === true || mr.work_in_progress === true;

    if (mrIsDraft) {
      return c.json({ ok: true, skipped: "MR is a draft — feedback loop disabled" });
    }

    if (!mrUrl) {
      return c.json({ ok: true, skipped: "no MR URL in payload" });
    }

    // 6. Find the original pipeline run for this MR
    const db = config.db;
    const originalRun = await findPipelineRunByMrUrlOrBranch(db, mrUrl, mrBranch);

    if (!originalRun) {
      return c.json({ ok: true, skipped: "not an agent-created MR" });
    }

    // Resolve branch from DB if not available in payload
    const prBranch = mrBranch || originalRun.branch || "";

    // 7. Resolve repoConfig for this MR
    const repoUrl = originalRun.repoUrl;
    let repoConfig: RepoConfig | undefined;
    for (const rc of Object.values(config.repoConfigs)) {
      if (rc.url === repoUrl) {
        repoConfig = rc;
        break;
      }
    }

    if (!repoConfig) {
      log.warn({ repoUrl }, "no repoConfig found for MR's repo URL");
      return c.json({ ok: true, skipped: "no repo config for this MR" });
    }

    // 8. Feedback config — re-use githubFeedback settings for GitLab
    // (field is named githubFeedback for historical reasons; applies to all providers)
    const feedbackCfg = repoConfig.githubFeedback;

    // Bot exclusion
    const botLogins = feedbackCfg?.botLogins ?? [];
    if (botLogins.length > 0 && botLogins.includes(commentAuthor)) {
      return c.json({ ok: true, skipped: "comment from bot login" });
    }

    // Allowed-reviewer filter
    const allowedReviewers = feedbackCfg?.allowedReviewers ?? [];
    if (allowedReviewers.length > 0 && !allowedReviewers.includes(commentAuthor)) {
      return c.json({ ok: true, skipped: "commenter not in allowedReviewers" });
    }

    // Trigger-keyword check
    const triggerKeyword = feedbackCfg?.triggerKeyword;
    const autoTrigger = feedbackCfg?.autoTrigger !== false;
    if (triggerKeyword) {
      if (!commentBody.includes(triggerKeyword)) {
        return c.json({ ok: true, skipped: "trigger keyword not found" });
      }
    } else if (!autoTrigger) {
      return c.json({ ok: true, skipped: "autoTrigger is disabled and no triggerKeyword configured" });
    }

    // 9. Dedup
    if (dedup.has(noteId)) {
      return c.json({ ok: true, deduplicated: true });
    }

    // 10. Rate-limit
    if (config.runner.isActiveFeedback(mrUrl)) {
      log.info({ mrUrl }, "feedback run already in progress for this MR — skipping");
      return c.json({ ok: true, skipped: "feedback run already in progress" });
    }

    // 11. Pipeline config
    const pipelineKey = originalRun.pipelineKey;
    const pipelineConfig = config.pipelineConfigs[pipelineKey];
    if (!pipelineConfig) {
      log.warn({ pipelineKey }, "no pipeline config found for original run's pipelineKey");
      return c.json({ ok: true, skipped: "pipeline config not found" });
    }

    // 12. Commit dedup
    dedup.add(noteId);

    // 13. Sanitize
    const MAX_COMMENT_LENGTH = 4000;
    const sanitizedBody = commentBody
      .slice(0, MAX_COMMENT_LENGTH)
      .replace(/<\/review-comment>/gi, "[/review-comment]");

    const feedbackComment: ReviewFeedbackComment = {
      commentId: noteId,
      author: commentAuthor,
      body: sanitizedBody,
      htmlUrl: commentHtmlUrl,
    };

    // 14. Build minimal issue from DB row
    const issue = {
      id: originalRun.issueId,
      identifier: originalRun.issueId,
      title: originalRun.issueTitle,
      description: "",
      labels: [] as Array<{ name: string }>,
      priority: 0,
      teamId: "",
    };

    const branchSlug = prBranch.startsWith("agent/")
      ? prBranch.slice("agent/".length)
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

    // 15. Fire-and-forget feedback run
    config.runner
      .startFeedback({
        issue,
        pipelineKey,
        pipelineConfig,
        repoConfig,
        sanitizedIssue,
        branch: prBranch,
        prUrl: mrUrl,
        prNumber: mr.iid ?? 0,
        parentRunId: originalRun.id,
        feedbackComments: [feedbackComment],
        rerequestReview: false, // GitLab doesn't have the same re-request concept
      })
      .catch((err) => log.error({ err }, "runner.startFeedback() failed"));

    return c.json({ ok: true, action: "feedback-triggered" });
  });

  return app;
}

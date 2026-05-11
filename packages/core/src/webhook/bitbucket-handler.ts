/**
 * Bitbucket Cloud webhook handler.
 *
 * Mirrors `webhook/github-handler.ts` for Bitbucket PR events:
 *  - Signature verification via HMAC-SHA256 (`X-Hub-Signature-256` header).
 *  - PR comment events → `review-feedback` pipeline run triggers.
 *  - PR merged events → mark pipeline run as merged in DB.
 *
 * ## Setup
 * In your Bitbucket repository → Repository settings → Webhooks:
 *  1. Set the URL to `https://<your-host>/webhooks/bitbucket`.
 *  2. Set a secret key — this is the value you configure as `bitbucketWebhookSecret`
 *     in your server config. Bitbucket Cloud signs payloads with HMAC-SHA256 and
 *     sends the digest in the `X-Hub-Signature-256` header (same scheme as GitHub).
 *  3. Enable events: "Pull Request: Comment created" and "Pull Request: Fulfilled".
 *
 * ## Signature format
 * `X-Hub-Signature-256: sha256=<hex-digest>` (same format as GitHub webhooks).
 */

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { pipelineRuns } from "../db/schema.js";
import type { AnyDb } from "../db/client.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { Notifier, PipelineConfig, PipelineRun, RepoConfig } from "../types.js";
import { createLogger } from "../logger.js";
import type { ReviewFeedbackComment } from "./github-handler.js";

const log = createLogger({ component: "BitbucketWebhookHandler" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BitbucketWebhookHandlerConfig {
  /**
   * Webhook secret used to verify the `X-Hub-Signature-256` HMAC-SHA256 header.
   * When not provided, signature verification is skipped (not recommended for production).
   *
   * Set this to the "Secret" value you configured in Bitbucket's webhook settings.
   */
  webhookSecret?: string;
  runner: PipelineRunner;
  pipelineConfigs: Record<string, PipelineConfig>;
  repoConfigs: Record<string, RepoConfig>;
  db: AnyDb;
  /**
   * Notifier instance. When provided, `onPRMerged` is called when a PR is
   * fulfilled (merged), transitioning the Linear issue to Done.
   */
  notifier?: Notifier;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify a Bitbucket webhook HMAC-SHA256 signature.
 *
 * Bitbucket Cloud sends `sha256=<hex-digest>` in `X-Hub-Signature-256`
 * (identical format to GitHub webhooks).
 */
export function verifyBitbucketSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  if (!signature.startsWith("sha256=")) return false;
  const sigHex = signature.slice(7);
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  const expected = hmac.digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sigHex), Buffer.from(expected));
  } catch {
    return false; // Different lengths
  }
}

// ---------------------------------------------------------------------------
// Shared DB helpers
// ---------------------------------------------------------------------------

async function findPipelineRunByPrUrlOrBranch(
  db: AnyDb,
  prUrl?: string,
  branch?: string,
): Promise<(typeof pipelineRuns.$inferSelect) | undefined> {
  if (prUrl) {
    const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.prUrl, prUrl)).limit(1);
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
// In-memory dedup for processed comment IDs (24h TTL)
// ---------------------------------------------------------------------------

class CommentDedupSet {
  private entries = new Map<string, number>();

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
 * Handle `pullrequest:fulfilled` events (Bitbucket's term for "merged").
 */
async function handlePRFulfilledEvent(
  payload: Record<string, any>,
  config: BitbucketWebhookHandlerConfig,
): Promise<void> {
  const pr = payload.pullrequest;
  if (!pr) return;

  const prUrl: string = pr.links?.html?.href ?? "";
  const branch: string = pr.source?.branch?.name ?? "";

  if (!prUrl) {
    log.warn({ payload }, "pr-fulfilled: no PR URL in payload — skipping");
    return;
  }

  const originalRun = await findPipelineRunByPrUrlOrBranch(config.db, prUrl, branch);
  if (!originalRun) {
    log.debug({ prUrl }, "pr-fulfilled: no pipeline run found for PR — skipping");
    return;
  }

  if (originalRun.autoMerged) {
    log.debug({ runId: originalRun.id }, "pr-fulfilled: run already marked merged — skipping");
    return;
  }

  await updatePipelineRunMerged(config.db, originalRun.id, true, "merged via Bitbucket");
  log.info({ runId: originalRun.id, prUrl }, "pr-fulfilled: updated pipeline run auto_merged=true");

  if (config.notifier?.onPRMerged) {
    await config.notifier.onPRMerged(originalRun as unknown as PipelineRun).catch((err) =>
      log.error({ err, runId: originalRun.id }, "pr-fulfilled: notifier.onPRMerged() failed"),
    );
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create a Hono app that handles Bitbucket webhook events at `/webhooks/bitbucket`.
 *
 * Mount in your server: `app.route("/", createBitbucketWebhookHandler(config))`.
 */
export function createBitbucketWebhookHandler(
  config: BitbucketWebhookHandlerConfig,
): Hono {
  const app = new Hono();
  const dedup = new CommentDedupSet();

  const cleanupTimer = setInterval(() => dedup.cleanup(), 60_000);
  cleanupTimer.unref();

  app.post("/webhooks/bitbucket", async (c) => {
    const rawBody = await c.req.text();
    const eventKey = c.req.header("X-Event-Key") ?? "";
    const signature = c.req.header("X-Hub-Signature-256") ?? "";

    // 1. Verify signature
    if (config.webhookSecret) {
      if (!verifyBitbucketSignature(rawBody, signature, config.webhookSecret)) {
        return c.json({ error: "Invalid signature" }, 401);
      }
    }

    // 2. Parse payload
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // 3a. PR fulfilled (merged)
    if (eventKey === "pullrequest:fulfilled") {
      await handlePRFulfilledEvent(payload, config);
      return c.json({ ok: true, action: "pr-merged" });
    }

    // 3b. PR comment events
    if (eventKey !== "pullrequest:comment_created") {
      return c.json({ ok: true, skipped: "unhandled event key" });
    }

    // 4. Extract comment metadata
    const comment = payload.comment ?? {};
    const commentId = String(comment.id ?? "");
    const commentBody: string = comment.content?.raw ?? "";
    const commentAuthor: string = payload.actor?.nickname ?? payload.actor?.display_name ?? "";
    const commentHtmlUrl: string = comment.links?.html?.href ?? "";

    if (!commentBody.trim()) {
      return c.json({ ok: true, skipped: "empty comment body" });
    }

    // 5. Extract PR metadata
    const pr = payload.pullrequest ?? {};
    const prUrl: string = pr.links?.html?.href ?? "";
    const prBranch: string = pr.source?.branch?.name ?? "";
    const prNumber: number = pr.id ?? 0;

    if (!prUrl) {
      return c.json({ ok: true, skipped: "no PR URL in payload" });
    }

    // 6. Find the original pipeline run
    const db = config.db;
    const originalRun = await findPipelineRunByPrUrlOrBranch(db, prUrl, prBranch);

    if (!originalRun) {
      return c.json({ ok: true, skipped: "not an agent-created PR" });
    }

    const resolvedBranch = prBranch || originalRun.branch || "";

    // 7. Resolve repoConfig
    const repoUrl = originalRun.repoUrl;
    let repoConfig: RepoConfig | undefined;
    for (const rc of Object.values(config.repoConfigs)) {
      if (rc.url === repoUrl) {
        repoConfig = rc;
        break;
      }
    }

    if (!repoConfig) {
      log.warn({ repoUrl }, "no repoConfig found for PR's repo URL");
      return c.json({ ok: true, skipped: "no repo config for this PR" });
    }

    // 8. Feedback config
    const feedbackCfg = repoConfig.githubFeedback;

    const botLogins = feedbackCfg?.botLogins ?? [];
    if (botLogins.length > 0 && botLogins.includes(commentAuthor)) {
      return c.json({ ok: true, skipped: "comment from bot login" });
    }

    const allowedReviewers = feedbackCfg?.allowedReviewers ?? [];
    if (allowedReviewers.length > 0 && !allowedReviewers.includes(commentAuthor)) {
      return c.json({ ok: true, skipped: "commenter not in allowedReviewers" });
    }

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
    if (dedup.has(commentId)) {
      return c.json({ ok: true, deduplicated: true });
    }

    // 10. Rate-limit
    if (config.runner.isActiveFeedback(prUrl)) {
      log.info({ prUrl }, "feedback run already in progress for this PR — skipping");
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
    dedup.add(commentId);

    // 13. Sanitize
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

    // 15. Fire-and-forget feedback run
    config.runner
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
        rerequestReview: false,
      })
      .catch((err) => log.error({ err }, "runner.startFeedback() failed"));

    return c.json({ ok: true, action: "feedback-triggered" });
  });

  return app;
}

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
 *
 * ## Environment variables / Authentication
 * - `BITBUCKET_ACCESS_TOKEN` — OAuth 2.0 access token (recommended).
 * - `BITBUCKET_APP_USERNAME` + `BITBUCKET_APP_PASSWORD` — App Password auth (alternative).
 * Set via `ServerConfig.bitbucket` (`accessToken` or `appUsername`/`appPassword`).
 * The webhook secret is set via `ServerConfig.bitbucketWebhookSecret`.
 */

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import type { AnyDb } from "../db/client.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { Notifier, PipelineConfig, RepoConfig } from "../types.js";
import { createLogger } from "../logger.js";
import {
  WebhookDedupSet,
  buildRepoConfigMap,
  findPipelineRunByUrlOrBranch,
  handleMergedEvent,
  processCommentFeedback,
} from "./shared-handlers.js";

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
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create a Hono app that handles Bitbucket webhook events at `/webhooks/bitbucket`.
 *
 * Mount in your server: `app.route("/", createBitbucketWebhookHandler(config))`.
 *
 * Shared DB helpers and comment-filtering logic are provided by
 * `./shared-handlers.ts`. An O(1) Map of repo URL → RepoConfig is built
 * once at initialisation to avoid per-request linear scans.
 */
export function createBitbucketWebhookHandler(
  config: BitbucketWebhookHandlerConfig,
): Hono {
  const app = new Hono();
  const dedup = new WebhookDedupSet();

  // Build O(1) URL → RepoConfig map once at init (avoids per-request O(n) scan)
  const repoConfigsByUrl = buildRepoConfigMap(config.repoConfigs);

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
      const pr = payload.pullrequest ?? {};
      await handleMergedEvent(
        pr.links?.html?.href ?? "",
        pr.source?.branch?.name ?? "",
        {
          db: config.db,
          notifier: config.notifier,
          mergeReason: "merged via Bitbucket",
        },
      );
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
    const commentAuthor: string =
      payload.actor?.nickname ?? payload.actor?.display_name ?? "";
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
    const originalRun = await findPipelineRunByUrlOrBranch(config.db, prUrl, prBranch);
    if (!originalRun) {
      return c.json({ ok: true, skipped: "not an agent-created PR" });
    }

    // 7. Resolve repoConfig — O(1) Map lookup (initialised once at handler creation)
    const repoConfig = repoConfigsByUrl.get(originalRun.repoUrl ?? "");
    if (!repoConfig) {
      log.warn({ repoUrl: originalRun.repoUrl }, "no repoConfig found for PR's repo URL");
      return c.json({ ok: true, skipped: "no repo config for this PR" });
    }

    // 8–15. Shared filter/dedup/rate-limit/fire logic
    const result = await processCommentFeedback(
      {
        commentId,
        commentBody,
        commentAuthor,
        commentHtmlUrl,
        prUrl,
        prBranch,
        prNumber,
        originalRun,
        repoConfig,
      },
      {
        runner: config.runner,
        pipelineConfigs: config.pipelineConfigs,
        dedup,
      },
    );

    return c.json(result);
  });

  return app;
}

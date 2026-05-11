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
 *
 * ## Environment variables
 * No handler-specific env vars. Authentication is configured via `ServerConfig.gitlab.token`
 * and `ServerConfig.gitlabWebhookToken` in your server config object.
 */

import { Hono } from "hono";
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
 *
 * Both inputs are padded to a fixed length (256 bytes) before comparison so
 * the loop always runs for the same number of iterations regardless of the
 * actual token length, preventing timing side-channels.
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
    result |= a[i]! ^ b[i]!;
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create a Hono app that handles GitLab webhook events at `/webhooks/gitlab`.
 *
 * Mount in your server: `app.route("/", createGitLabWebhookHandler(config))`.
 *
 * Shared DB helpers and comment-filtering logic are provided by
 * `./shared-handlers.ts`. An O(1) Map of repo URL → RepoConfig is built
 * once at initialisation to avoid per-request linear scans.
 */
export function createGitLabWebhookHandler(
  config: GitLabWebhookHandlerConfig,
): Hono {
  const app = new Hono();
  const dedup = new WebhookDedupSet();

  // Build O(1) URL → RepoConfig map once at init (avoids per-request O(n) scan)
  const repoConfigsByUrl = buildRepoConfigMap(config.repoConfigs);

  // Periodic cleanup of expired dedup entries
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
      await handleMergedEvent(
        attrs.url ?? "",
        attrs.source_branch ?? "",
        {
          db: config.db,
          notifier: config.notifier,
          mergeReason: "merged via GitLab",
        },
      );
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
    const originalRun = await findPipelineRunByUrlOrBranch(config.db, mrUrl, mrBranch);
    if (!originalRun) {
      return c.json({ ok: true, skipped: "not an agent-created MR" });
    }

    // Resolve branch from DB if not available in payload
    const prBranch = mrBranch || originalRun.branch || "";

    // 7. Resolve repoConfig — O(1) Map lookup (initialised once at handler creation)
    const repoConfig = repoConfigsByUrl.get(originalRun.repoUrl ?? "");
    if (!repoConfig) {
      log.warn({ repoUrl: originalRun.repoUrl }, "no repoConfig found for MR's repo URL");
      return c.json({ ok: true, skipped: "no repo config for this MR" });
    }

    // 8–15. Shared filter/dedup/rate-limit/fire logic
    const result = await processCommentFeedback(
      {
        commentId: noteId,
        commentBody,
        commentAuthor,
        commentHtmlUrl,
        prUrl: mrUrl,
        prBranch,
        prNumber: mr.iid ?? 0,
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

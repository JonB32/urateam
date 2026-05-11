import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { pipelineRuns } from "../db/schema.js";
import type { AnyDb } from "../db/client.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { PipelineConfig, RepoConfig } from "../types.js";
import { createLogger } from "../logger.js";
import { createGitHubClient } from "../repo/github.js";
import type { GitHubConfig } from "../repo/github.js";
import { attemptAutoMerge } from "../pipeline/automerge.js";

const log = createLogger({ component: "GitHubWebhookHandler" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single piece of review feedback from a GitHub PR comment or review. */
export interface ReviewFeedbackComment {
  commentId: string;
  author: string;
  body: string;
  /** File path for inline review comments. */
  filePath?: string;
  /** Line number for inline review comments. */
  lineNumber?: number;
  /** GitHub html_url for the comment — used to link back from change-summary. */
  htmlUrl?: string;
}

export interface GitHubWebhookHandlerConfig {
  /**
   * GitHub webhook secret used to verify X-Hub-Signature-256 HMAC.
   * If not provided, signature verification is skipped (not recommended for production).
   */
  webhookSecret?: string;
  runner: PipelineRunner;
  pipelineConfigs: Record<string, PipelineConfig>;
  repoConfigs: Record<string, RepoConfig>;
  db: AnyDb;
  /**
   * GitHub App credentials for automerge via the GitHub API.
   * Required for autoMergeConfig criteria checks (minimumApprovingReviews,
   * requiredStatusChecks, etc.).  When not provided, automerge events are skipped.
   */
  github?: GitHubConfig;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify a GitHub webhook signature.
 * GitHub sends "sha256=<hex-digest>" in the X-Hub-Signature-256 header.
 */
export function verifyGitHubSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  if (!signature.startsWith("sha256=")) return false;
  const sigHex = signature.slice(7); // strip "sha256=" prefix
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
// In-memory dedup for processed comment IDs (30s TTL per entry)
// ---------------------------------------------------------------------------

class CommentDedupSet {
  private entries = new Map<string, number>(); // commentId -> expiry ms

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
// Automerge helper — invoked for check_suite, status, and pull_request events
// ---------------------------------------------------------------------------

/**
 * Extract (owner, repo, prNumber) candidates from different GitHub event shapes,
 * look them up in the DB to find the associated pipeline run, then check and
 * merge if the pipeline config has `autoMergeConfig` configured.
 */
async function handleAutoMergeEvent(
  event: string,
  action: string,
  payload: Record<string, any>,
  config: GitHubWebhookHandlerConfig,
): Promise<void> {
  if (!config.github) {
    log.debug({ event }, "skipping automerge event — no GitHub App credentials configured");
    return;
  }

  // Build a list of { owner, repo, prNumber } candidates from the event payload
  type PrCandidate = { owner: string; repo: string; prNumber: number; prUrl?: string; prBranch?: string };
  const candidates: PrCandidate[] = [];

  const repoOwner: string = payload.repository?.owner?.login ?? "";
  const repoName: string = payload.repository?.name ?? "";

  if (!repoOwner || !repoName) return;

  if (event === "check_suite") {
    // check_suite events include an array of associated open PRs
    const prs: Array<{ number: number; html_url?: string; head?: { ref?: string } }> =
      payload.check_suite?.pull_requests ?? [];
    for (const pr of prs) {
      candidates.push({
        owner: repoOwner,
        repo: repoName,
        prNumber: pr.number,
        prUrl: pr.html_url,
        prBranch: pr.head?.ref,
      });
    }
  } else if (event === "status") {
    // status events don't include PR numbers directly; use branch names to look up DB
    const branches: Array<{ name: string }> = payload.branches ?? [];
    for (const branch of branches) {
      if (branch.name?.startsWith("agent/")) {
        candidates.push({ owner: repoOwner, repo: repoName, prNumber: 0, prBranch: branch.name });
      }
    }
  } else if (event === "pull_request") {
    const pr = payload.pull_request;
    if (pr?.number) {
      candidates.push({
        owner: repoOwner,
        repo: repoName,
        prNumber: pr.number as number,
        prUrl: pr.html_url as string | undefined,
        prBranch: pr.head?.ref as string | undefined,
      });
    }
  }

  if (candidates.length === 0) return;

  const db = config.db;
  const octokit = await createGitHubClient(config.github);

  for (const candidate of candidates) {
    // Look up pipeline run in DB by PR URL then branch
    let originalRun: (typeof pipelineRuns.$inferSelect) | undefined;

    if (candidate.prUrl) {
      const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.prUrl, candidate.prUrl)).limit(1);
      if (rows.length > 0) originalRun = rows[0];
    }
    if (!originalRun && candidate.prBranch?.startsWith("agent/")) {
      const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.branch, candidate.prBranch)).limit(1);
      if (rows.length > 0) originalRun = rows[0];
    }

    if (!originalRun) {
      log.debug({ candidate }, "automerge: no pipeline run found for PR — skipping");
      continue;
    }

    // Already merged — nothing to do
    if (originalRun.autoMerged) {
      log.debug({ runId: originalRun.id }, "automerge: PR already merged — skipping");
      continue;
    }

    // Resolve pipeline config
    const pipelineConfig = config.pipelineConfigs[originalRun.pipelineKey ?? ""];
    if (!pipelineConfig?.autoMergeConfig) {
      log.debug({ pipelineKey: originalRun.pipelineKey }, "automerge: no autoMergeConfig in pipeline — skipping");
      continue;
    }

    // Resolve the PR number: prefer from payload, otherwise look up via GitHub API by branch
    let prNumber = candidate.prNumber;
    if (!prNumber && candidate.prBranch) {
      try {
        const { data: pulls } = await octokit.pulls.list({
          owner: candidate.owner,
          repo: candidate.repo,
          head: `${candidate.owner}:${candidate.prBranch}`,
          state: "open",
          per_page: 1,
        });
        if (pulls.length > 0) prNumber = pulls[0].number;
      } catch {
        log.warn({ candidate }, "automerge: failed to look up PR number from branch — skipping");
        continue;
      }
    }

    if (!prNumber) {
      log.debug({ candidate }, "automerge: could not determine PR number — skipping");
      continue;
    }

    const autoMergeOptions = pipelineConfig.autoMergeConfig;
    const result = await attemptAutoMerge(
      octokit,
      candidate.owner,
      candidate.repo,
      prNumber,
      autoMergeOptions,
    );

    // Persist result to DB
    await db
      .update(pipelineRuns)
      .set({
        autoMerged: result.merged || null,
        autoMergeReason: result.message,
      })
      .where(eq(pipelineRuns.id, originalRun.id));

    log.info(
      { runId: originalRun.id, prNumber, merged: result.merged, message: result.message },
      "automerge: decision recorded",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createGitHubWebhookHandler(
  config: GitHubWebhookHandlerConfig,
): Hono {
  const app = new Hono();
  const dedup = new CommentDedupSet();

  // Periodic cleanup of expired entries (runs outside the hot path)
  const cleanupTimer = setInterval(() => dedup.cleanup(), 60_000);
  cleanupTimer.unref();

  app.post("/webhooks/github", async (c) => {
    const rawBody = await c.req.text();
    const event = c.req.header("X-GitHub-Event") ?? "";
    const signature = c.req.header("X-Hub-Signature-256") ?? "";

    // 1. Verify signature (required — handler should only be mounted when secret is configured)
    if (!config.webhookSecret) {
      return c.json({ error: "Webhook secret not configured" }, 500);
    }
    if (!verifyGitHubSignature(rawBody, signature, config.webhookSecret)) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    // 2. Parse payload
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // 3. Route by event type
    const action = payload.action as string;

    // 3a. Automerge trigger events: check_suite.completed, status, pull_request.(labeled|synchronize|opened)
    const isAutoMergeEvent =
      event === "check_suite" ||
      event === "status" ||
      (event === "pull_request" && ["labeled", "synchronize", "opened"].includes(action));

    if (isAutoMergeEvent) {
      await handleAutoMergeEvent(event, action, payload, config);
      return c.json({ ok: true, action: "automerge-check-triggered" });
    }

    // 3b. Handle PR review, inline review comment, and issue comment events
    if (
      event !== "pull_request_review" &&
      event !== "pull_request_review_comment" &&
      event !== "issue_comment"
    ) {
      return c.json({ ok: true, skipped: "unhandled event type" });
    }

    // For reviews we only care about "submitted"; for comments only "created"
    if (event === "pull_request_review" && action !== "submitted") {
      return c.json({ ok: true, skipped: "not a submitted review" });
    }
    if (event === "pull_request_review_comment" && action !== "created") {
      return c.json({ ok: true, skipped: "not a created comment" });
    }
    if (event === "issue_comment" && action !== "created") {
      return c.json({ ok: true, skipped: "not a created comment" });
    }

    // issue_comment fires for both issues and PRs — skip non-PR comments
    if (event === "issue_comment" && !payload.issue?.pull_request) {
      return c.json({ ok: true, skipped: "not a PR comment" });
    }

    // 4. Extract comment metadata
    let commentBody: string;
    let commentId: string;
    let commentAuthor: string;
    let filePath: string | undefined;
    let lineNumber: number | undefined;
    let commentHtmlUrl: string | undefined;

    if (event === "pull_request_review") {
      commentBody = (payload.review?.body as string) ?? "";
      commentId = String(payload.review?.id ?? "");
      commentAuthor = (payload.review?.user?.login as string) ?? "";
      commentHtmlUrl = payload.review?.html_url as string | undefined;
    } else {
      // pull_request_review_comment and issue_comment both use payload.comment
      commentBody = (payload.comment?.body as string) ?? "";
      commentId = String(payload.comment?.id ?? "");
      commentAuthor = (payload.comment?.user?.login as string) ?? "";
      commentHtmlUrl = payload.comment?.html_url as string | undefined;
      if (event === "pull_request_review_comment") {
        filePath = payload.comment?.path as string | undefined;
        lineNumber = (payload.comment?.line ?? payload.comment?.original_line) as
          | number
          | undefined;
      }
    }

    // Empty bodies (e.g. approved-without-comment reviews) are ignored
    if (!commentBody.trim()) {
      return c.json({ ok: true, skipped: "empty comment body" });
    }

    // 5. Extract PR metadata
    // issue_comment events have a partial pull_request object under payload.issue.pull_request
    // (only url/html_url/diff_url/patch_url — no head.ref, number, or draft).
    // For full PR events, payload.pull_request has everything.
    let prUrl: string;
    let prBranch: string | undefined;
    let prNumber: number;
    let prIsDraft: boolean;

    if (event === "issue_comment") {
      const issuePr = payload.issue?.pull_request;
      if (!issuePr) {
        return c.json({ ok: true, skipped: "no pull_request in payload" });
      }
      prUrl = (issuePr.html_url as string) ?? "";
      prNumber = payload.issue.number as number;
      // issue_comment doesn't include head.ref or draft — we'll resolve branch
      // from the DB lookup below and skip the draft check (draft PRs are unlikely
      // to have agent pipeline runs in the DB)
      prBranch = undefined;
      prIsDraft = false;
    } else {
      const pr = payload.pull_request;
      if (!pr) {
        return c.json({ ok: true, skipped: "no pull_request in payload" });
      }
      prUrl = pr.html_url as string;
      prBranch = pr.head?.ref as string;
      prNumber = pr.number as number;
      prIsDraft = pr.draft === true;
    }

    // 5b. Skip draft PRs — they have known gaps and should not trigger feedback runs
    if (prIsDraft) {
      return c.json({ ok: true, skipped: "PR is a draft — feedback loop disabled" });
    }

    // 6. Find the original pipeline run for this PR
    //    First try by PR URL (exact match), then by branch name (agent/ prefix).
    const db = config.db;
    let originalRun: (typeof pipelineRuns.$inferSelect) | undefined;

    if (prUrl) {
      const byUrl = await db
        .select()
        .from(pipelineRuns)
        .where(eq(pipelineRuns.prUrl, prUrl))
        .limit(1);
      if (byUrl.length > 0) originalRun = byUrl[0];
    }

    if (!originalRun && prBranch?.startsWith("agent/")) {
      const byBranch = await db
        .select()
        .from(pipelineRuns)
        .where(eq(pipelineRuns.branch, prBranch))
        .limit(1);
      if (byBranch.length > 0) originalRun = byBranch[0];
    }

    if (!originalRun) {
      return c.json({ ok: true, skipped: "not an agent-created PR" });
    }

    // For issue_comment events, resolve branch from the DB since the payload doesn't include it
    if (!prBranch && originalRun.branch) {
      prBranch = originalRun.branch;
    }

    // 7. Look up repo config for this run
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

    const feedbackCfg = repoConfig.githubFeedback;

    // 8. Bot exclusion — never trigger on the bot's own comments
    const botLogins = feedbackCfg?.botLogins ?? [];
    if (botLogins.length > 0 && botLogins.includes(commentAuthor)) {
      return c.json({ ok: true, skipped: "comment from bot login" });
    }

    // 9. Allowed-reviewer filter
    const allowedReviewers = feedbackCfg?.allowedReviewers ?? [];
    if (allowedReviewers.length > 0 && !allowedReviewers.includes(commentAuthor)) {
      return c.json({ ok: true, skipped: "commenter not in allowedReviewers" });
    }

    // 10. Trigger-keyword check
    // When a triggerKeyword is configured, always require it — regardless of autoTrigger.
    // autoTrigger controls whether comments WITHOUT a keyword trigger (when no keyword is configured).
    const triggerKeyword = feedbackCfg?.triggerKeyword;
    const autoTrigger = feedbackCfg?.autoTrigger !== false; // default: true

    if (triggerKeyword) {
      if (!commentBody.includes(triggerKeyword)) {
        return c.json({ ok: true, skipped: "trigger keyword not found" });
      }
    } else if (!autoTrigger) {
      // No keyword configured and autoTrigger is off — require explicit opt-in
      return c.json({ ok: true, skipped: "autoTrigger is disabled and no triggerKeyword configured" });
    }

    // 11. Dedup — ignore if we've already processed this comment ID
    if (dedup.has(commentId)) {
      return c.json({ ok: true, deduplicated: true });
    }

    // 12. Rate-limit — don't start a new feedback run if one is already active for this PR
    // Check BEFORE recording dedup so rejected comments can be reprocessed later.
    if (config.runner.isActiveFeedback(prUrl)) {
      log.info({ prUrl }, "feedback run already in progress for this PR — skipping");
      return c.json({ ok: true, skipped: "feedback run already in progress" });
    }

    // 13. Look up pipeline config from the original run
    const pipelineKey = originalRun.pipelineKey;
    const pipelineConfig = config.pipelineConfigs[pipelineKey];
    if (!pipelineConfig) {
      log.warn({ pipelineKey }, "no pipeline config found for original run's pipelineKey");
      return c.json({ ok: true, skipped: "pipeline config not found" });
    }

    // 14. Commit dedup entry only after all checks pass
    dedup.add(commentId);

    // 15. Build feedback comment payload — sanitize untrusted fields
    const MAX_COMMENT_LENGTH = 4000;
    const MAX_PATH_LENGTH = 500;
    const sanitizedBody = commentBody
      .slice(0, MAX_COMMENT_LENGTH)
      .replace(/<\/review-comment>/gi, "[/review-comment]");
    const sanitizedFilePath = filePath
      ? filePath.slice(0, MAX_PATH_LENGTH).replace(/<\/review-comment>/gi, "[/review-comment]")
      : undefined;

    const feedbackComment: ReviewFeedbackComment = {
      commentId,
      author: commentAuthor,
      body: sanitizedBody,
      filePath: sanitizedFilePath,
      lineNumber,
      htmlUrl: commentHtmlUrl,
    };

    // 16. Build minimal LinearIssue from the DB row (issue was already sanitised earlier)
    const issue = {
      id: originalRun.issueId,
      identifier: originalRun.issueId,
      title: originalRun.issueTitle,
      description: "",
      labels: [] as Array<{ name: string }>,
      priority: 0,
      teamId: "",
    };

    // Reconstruct slug from branch name: "agent/<issueId>-<slug>" → "<issueId>-<slug>"
    const branchSlug = prBranch?.startsWith("agent/")
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

    // 17. Fire and forget — don't await so the webhook returns quickly
    config.runner
      .startFeedback({
        issue,
        pipelineKey,
        pipelineConfig,
        repoConfig,
        sanitizedIssue,
        branch: prBranch ?? originalRun.branch ?? "",
        prUrl,
        prNumber,
        parentRunId: originalRun.id,
        feedbackComments: [feedbackComment],
        rerequestReview: feedbackCfg?.rerequestReview ?? false,
      })
      .catch((err) => log.error({ err }, "runner.startFeedback() failed"));

    return c.json({ ok: true, action: "feedback-triggered" });
  });

  return app;
}

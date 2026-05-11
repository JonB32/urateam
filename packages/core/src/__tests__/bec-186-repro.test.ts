/**
 * BEC-186 Reproduction Test
 *
 * Confirms the bug: pull_request.closed with merged=true is silently skipped
 * by the GitHub webhook handler, so Linear issues stay "In Review" forever
 * after a human merges a PR.
 *
 * Expected behaviour (after fix):
 *   - Handler should detect action=closed + merged=true
 *   - Look up pipeline run by pr_url
 *   - Update auto_merged=true in DB
 *   - Call notifier.onPRMerged() (new method) → Linear transitions to Done
 *
 * Current behaviour (bug):
 *   - pull_request.closed falls through both routing branches:
 *     1. Not in automerge branch (action not in ["labeled","synchronize","opened"])
 *     2. Not a review/comment event
 *   - Handler returns { ok: true, skipped: "unhandled event type" }
 *   - DB is not updated, Linear stays In Review
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { createGitHubWebhookHandler } from "../webhook/github-handler.js";
import type { GitHubWebhookHandlerConfig } from "../webhook/github-handler.js";
import type { PipelineConfig, RepoConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers (mirrors existing test infrastructure)
// ---------------------------------------------------------------------------

const SECRET = "gh-webhook-secret";

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const pipelineConfig: PipelineConfig = {
  name: "auto-implement",
  stages: ["triage", "implement", "test", "review"],
  retry: { maxAttempts: 1, strategy: "fix-and-retry" },
  review: { requiredApprovals: 1 },
  prStrategy: "draft",
};

const repoConfig: RepoConfig = {
  url: "https://github.com/org/repo",
  defaultBranch: "main",
  testCommand: "npm test",
  buildCommand: "npm run build",
  githubFeedback: {
    allowedReviewers: [],
    botLogins: ["linear-agent[bot]"],
    autoTrigger: true,
  },
};

/** Simulated DB row representing a completed pipeline run whose PR was opened. */
const mockRun = {
  id: "run-bec186",
  issueId: "BEC-179",
  issueTitle: "Worktree detached HEAD bug",
  pipelineKey: "auto-implement",
  repoUrl: "https://github.com/org/repo",
  branch: "agent/BEC-179-worktree-detached-head",
  status: "completed",
  prUrl: "https://github.com/org/repo/pull/235",
  autoMerged: null,
  runType: "standard",
  parentRunId: null,
  feedbackContext: null,
};

function makeMockDb(run: typeof mockRun | null = mockRun) {
  const updateMock = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(run ? [run] : []),
        }),
      }),
    }),
    update: updateMock,
    _updateMock: updateMock,
  };
}

function makeMockRunner() {
  return {
    startFeedback: vi.fn().mockResolvedValue(undefined),
    isActiveFeedback: vi.fn().mockReturnValue(false),
  };
}

function buildConfig(
  overrides: Partial<GitHubWebhookHandlerConfig> = {},
): GitHubWebhookHandlerConfig {
  return {
    webhookSecret: SECRET,
    runner: makeMockRunner() as any,
    pipelineConfigs: { "auto-implement": pipelineConfig },
    repoConfigs: { "org/repo": repoConfig },
    db: makeMockDb() as any,
    ...overrides,
  };
}

/** Creates a synthetic pull_request.closed+merged webhook payload. */
function makePRClosedMergedPayload(overrides: Record<string, any> = {}) {
  return {
    action: "closed",
    pull_request: {
      number: 235,
      html_url: "https://github.com/org/repo/pull/235",
      merged: true,
      head: { ref: "agent/BEC-179-worktree-detached-head" },
      merge_commit_sha: "abc123def456",
    },
    repository: {
      name: "repo",
      owner: { login: "org" },
      html_url: "https://github.com/org/repo",
    },
    ...overrides,
  };
}

async function postWebhook(
  app: ReturnType<typeof createGitHubWebhookHandler>,
  body: Record<string, any>,
  event: string,
  secret: string = SECRET,
) {
  const rawBody = JSON.stringify(body);
  const sig = sign(rawBody, secret);
  return app.request("/webhooks/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-Hub-Signature-256": sig,
    },
    body: rawBody,
  });
}

// ---------------------------------------------------------------------------
// BEC-186 reproduction tests
// ---------------------------------------------------------------------------

describe("BEC-186: pull_request.closed + merged=true (no Done transition)", () => {
  let runner: ReturnType<typeof makeMockRunner>;

  beforeEach(() => {
    vi.restoreAllMocks();
    runner = makeMockRunner();
  });

  it("BUG CONFIRMED: pull_request.closed+merged skipped as unhandled event type", async () => {
    // This test proves the current broken behaviour:
    // A valid pull_request.closed+merged=true webhook returns skipped="unhandled event type"
    // because neither routing branch catches action="closed".
    const db = makeMockDb(mockRun);
    const app = createGitHubWebhookHandler(buildConfig({ runner: runner as any, db: db as any }));

    const res = await postWebhook(app, makePRClosedMergedPayload(), "pull_request");

    expect(res.status).toBe(200);
    const json = await res.json();

    // THE BUG: the handler skips the event instead of processing it
    expect(json.skipped).toBe("unhandled event type");

    // Consequence 1: DB is never updated — auto_merged stays null
    expect(db._updateMock).not.toHaveBeenCalled();

    // Consequence 2: no Linear transition to Done can occur
    // (notifier.onPRMerged does not exist, and no existing callback fires)
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("BUG CONFIRMED: pull_request.closed without merged=false is also silently skipped", async () => {
    // Verify the negative case is also correctly ignored (no regression risk).
    // PR closed without merge should NOT transition Linear to Done.
    // Currently this is silently skipped (which is the correct final outcome).
    const db = makeMockDb(mockRun);
    const app = createGitHubWebhookHandler(buildConfig({ runner: runner as any, db: db as any }));

    const res = await postWebhook(
      app,
      makePRClosedMergedPayload({ pull_request: { ...makePRClosedMergedPayload().pull_request, merged: false } }),
      "pull_request",
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    // Also skipped — fine for the closed-without-merge case.
    expect(json.skipped).toBeDefined();
  });

  it("EXPECTED (post-fix): pull_request.closed+merged=true should NOT be skipped", async () => {
    // This test documents what the correct behavior SHOULD be after the fix.
    // Currently it fails because json.skipped is set.
    // After implementing the fix, this test should pass.
    const db = makeMockDb(mockRun);
    const app = createGitHubWebhookHandler(buildConfig({ runner: runner as any, db: db as any }));

    const res = await postWebhook(app, makePRClosedMergedPayload(), "pull_request");

    expect(res.status).toBe(200);
    const json = await res.json();

    // After fix: should NOT have skipped
    // This assertion FAILS today, confirming the feature gap.
    expect(json).not.toHaveProperty("skipped");
    expect(json.ok).toBe(true);
    // And DB should be updated
    expect(db._updateMock).toHaveBeenCalled();
  });
});

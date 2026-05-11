/**
 * BEC-186: pull_request.closed + merged=true must transition Linear to Done.
 *
 * When a human (or GitHub's "auto-merge when ready") merges a PR after the
 * pipeline has already completed, the pipeline's `onPipelineComplete` has
 * already fired and will not re-fire.  Without an explicit handler for
 * `pull_request.closed+merged`, the Linear ticket stays "In Review" forever.
 *
 * Fix implemented in `webhook/github-handler.ts`:
 *   - A new routing branch catches `pull_request.closed` + `merged: true`
 *   - Looks up the pipeline run by pr_url
 *   - Marks `auto_merged = true` in the DB
 *   - Calls `notifier.onPRMerged?.(run)` → LinearNotifier transitions to Done
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

function makeMockNotifier() {
  return {
    onPipelineStart: vi.fn().mockResolvedValue(undefined),
    onStageComplete: vi.fn().mockResolvedValue(undefined),
    onPipelineComplete: vi.fn().mockResolvedValue(undefined),
    onPipelineFailed: vi.fn().mockResolvedValue(undefined),
    onPRMerged: vi.fn().mockResolvedValue(undefined),
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
// BEC-186 tests — verifying the fix
// ---------------------------------------------------------------------------

describe("BEC-186: pull_request.closed + merged=true → Linear Done transition", () => {
  let runner: ReturnType<typeof makeMockRunner>;

  beforeEach(() => {
    vi.restoreAllMocks();
    runner = makeMockRunner();
  });

  it("pull_request.closed+merged=true is handled (not skipped)", async () => {
    // The core fix: action="closed"+merged=true must NOT fall through to
    // the "unhandled event type" branch.
    const db = makeMockDb(mockRun);
    const app = createGitHubWebhookHandler(buildConfig({ runner: runner as any, db: db as any }));

    const res = await postWebhook(app, makePRClosedMergedPayload(), "pull_request");

    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json).not.toHaveProperty("skipped");
    expect(json.ok).toBe(true);
    expect(json.action).toBe("pr-merged");
  });

  it("DB is updated with auto_merged=true on PR merge", async () => {
    const db = makeMockDb(mockRun);
    const app = createGitHubWebhookHandler(buildConfig({ runner: runner as any, db: db as any }));

    await postWebhook(app, makePRClosedMergedPayload(), "pull_request");

    expect(db._updateMock).toHaveBeenCalled();
  });

  it("notifier.onPRMerged is called when notifier is provided", async () => {
    const db = makeMockDb(mockRun);
    const notifier = makeMockNotifier();
    const app = createGitHubWebhookHandler(
      buildConfig({ runner: runner as any, db: db as any, notifier: notifier as any }),
    );

    await postWebhook(app, makePRClosedMergedPayload(), "pull_request");

    expect(notifier.onPRMerged).toHaveBeenCalledOnce();
    expect(notifier.onPRMerged).toHaveBeenCalledWith(expect.objectContaining({ id: "run-bec186" }));
  });

  it("notifier.onPRMerged is NOT called when no pipeline run is found", async () => {
    // PR from a non-agent source — no DB row matches
    const db = makeMockDb(null);
    const notifier = makeMockNotifier();
    const app = createGitHubWebhookHandler(
      buildConfig({ runner: runner as any, db: db as any, notifier: notifier as any }),
    );

    const res = await postWebhook(app, makePRClosedMergedPayload(), "pull_request");

    expect(res.status).toBe(200);
    const json = await res.json();
    // Still returns ok: true, action: "pr-merged" (handler ran, just found no run)
    expect(json.ok).toBe(true);
    expect(notifier.onPRMerged).not.toHaveBeenCalled();
  });

  it("idempotency: already-merged run is not re-processed", async () => {
    // If auto_merged is already true, skip the update and notifier call
    const alreadyMergedRun = { ...mockRun, autoMerged: true };
    const db = makeMockDb(alreadyMergedRun as any);
    const notifier = makeMockNotifier();
    const app = createGitHubWebhookHandler(
      buildConfig({ runner: runner as any, db: db as any, notifier: notifier as any }),
    );

    await postWebhook(app, makePRClosedMergedPayload(), "pull_request");

    expect(db._updateMock).not.toHaveBeenCalled();
    expect(notifier.onPRMerged).not.toHaveBeenCalled();
  });

  it("pull_request.closed WITHOUT merged=true is skipped (no Done transition)", async () => {
    // PR closed without merge (e.g. closed manually) must NOT trigger Done transition.
    const db = makeMockDb(mockRun);
    const notifier = makeMockNotifier();
    const payload = {
      ...makePRClosedMergedPayload(),
      pull_request: {
        ...makePRClosedMergedPayload().pull_request,
        merged: false,
      },
    };
    const app = createGitHubWebhookHandler(
      buildConfig({ runner: runner as any, db: db as any, notifier: notifier as any }),
    );

    const res = await postWebhook(app, payload, "pull_request");

    expect(res.status).toBe(200);
    const json = await res.json();
    // Falls through to "unhandled event type" — correct outcome
    expect(json.skipped).toBeDefined();
    expect(db._updateMock).not.toHaveBeenCalled();
    expect(notifier.onPRMerged).not.toHaveBeenCalled();
  });

  it("works when notifier is not configured (no crash)", async () => {
    // Notifier is optional — handler must not throw when absent
    const db = makeMockDb(mockRun);
    const app = createGitHubWebhookHandler(
      buildConfig({ runner: runner as any, db: db as any /* no notifier */ }),
    );

    const res = await postWebhook(app, makePRClosedMergedPayload(), "pull_request");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.action).toBe("pr-merged");
    // DB still updated even without notifier
    expect(db._updateMock).toHaveBeenCalled();
  });
});

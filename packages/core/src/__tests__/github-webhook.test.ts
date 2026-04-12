import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { createGitHubWebhookHandler, verifyGitHubSignature } from "../webhook/github-handler.js";
import type { GitHubWebhookHandlerConfig } from "../webhook/github-handler.js";
import type { PipelineConfig, RepoConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = "gh-webhook-secret";

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/** Simulated DB row representing a completed pipeline run for the PR. */
const mockRun = {
  id: "run-abc123",
  issueId: "LIN-42",
  issueTitle: "Add user search",
  pipelineKey: "auto-implement",
  repoUrl: "https://github.com/org/repo",
  branch: "agent/LIN-42-add-user-search",
  status: "completed",
  prUrl: "https://github.com/org/repo/pull/7",
  runType: "standard",
  parentRunId: null,
  feedbackContext: null,
};

function makeMockDb(run: typeof mockRun | null = mockRun) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(run ? [run] : []),
        }),
      }),
    }),
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

function makeReviewCommentPayload(overrides: Record<string, any> = {}) {
  return {
    action: "created",
    comment: {
      id: 12345,
      body: "Please rename this variable for clarity.",
      user: { login: "reviewer-alice" },
      path: "src/index.ts",
      line: 42,
    },
    pull_request: {
      number: 7,
      html_url: "https://github.com/org/repo/pull/7",
      head: { ref: "agent/LIN-42-add-user-search" },
    },
    ...overrides,
  };
}

function makeReviewPayload(overrides: Record<string, any> = {}) {
  return {
    action: "submitted",
    review: {
      id: 99999,
      body: "LGTM with minor changes",
      user: { login: "reviewer-alice" },
      state: "changes_requested",
    },
    pull_request: {
      number: 7,
      html_url: "https://github.com/org/repo/pull/7",
      head: { ref: "agent/LIN-42-add-user-search" },
    },
    ...overrides,
  };
}

async function postWebhook(
  app: ReturnType<typeof createGitHubWebhookHandler>,
  body: Record<string, any>,
  event: string = "pull_request_review_comment",
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
// verifyGitHubSignature
// ---------------------------------------------------------------------------

describe("verifyGitHubSignature", () => {
  const body = JSON.stringify({ hello: "world" });

  it("returns true for valid sha256 signature", () => {
    const sig = sign(body, SECRET);
    expect(verifyGitHubSignature(body, sig, SECRET)).toBe(true);
  });

  it("returns false for wrong secret", () => {
    const sig = sign(body, "wrong-secret");
    expect(verifyGitHubSignature(body, sig, SECRET)).toBe(false);
  });

  it("returns false for tampered body", () => {
    const sig = sign(body, SECRET);
    expect(verifyGitHubSignature(body + "x", sig, SECRET)).toBe(false);
  });

  it("returns false when signature lacks sha256= prefix", () => {
    const hmac = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyGitHubSignature(body, hmac /* no prefix */, SECRET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createGitHubWebhookHandler
// ---------------------------------------------------------------------------

describe("createGitHubWebhookHandler", () => {
  let runner: ReturnType<typeof makeMockRunner>;

  beforeEach(() => {
    vi.restoreAllMocks();
    runner = makeMockRunner();
  });

  it("returns 401 for invalid signature", async () => {
    const app = createGitHubWebhookHandler(buildConfig({ runner: runner as any }));
    const rawBody = JSON.stringify(makeReviewCommentPayload());
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request_review_comment",
        "X-Hub-Signature-256": "sha256=bad",
      },
      body: rawBody,
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Invalid signature");
  });

  it("ignores unrelated event types", async () => {
    const app = createGitHubWebhookHandler(buildConfig({ runner: runner as any }));
    const res = await postWebhook(
      app,
      makeReviewCommentPayload(),
      "push", // irrelevant event
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).toBe("unhandled event type");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("ignores pull_request_review_comment action other than 'created'", async () => {
    const app = createGitHubWebhookHandler(buildConfig({ runner: runner as any }));
    const res = await postWebhook(
      app,
      { ...makeReviewCommentPayload(), action: "deleted" },
      "pull_request_review_comment",
    );
    const json = await res.json();
    expect(json.skipped).toBe("not a created comment");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("ignores pull_request_review action other than 'submitted'", async () => {
    const app = createGitHubWebhookHandler(buildConfig({ runner: runner as any }));
    const res = await postWebhook(
      app,
      { ...makeReviewPayload(), action: "dismissed" },
      "pull_request_review",
    );
    const json = await res.json();
    expect(json.skipped).toBe("not a submitted review");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("ignores reviews with empty body", async () => {
    const app = createGitHubWebhookHandler(buildConfig({ runner: runner as any }));
    const payload = makeReviewPayload();
    payload.review.body = "";
    const res = await postWebhook(app, payload, "pull_request_review");
    const json = await res.json();
    expect(json.skipped).toBe("empty comment body");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("ignores comments from bot logins", async () => {
    const app = createGitHubWebhookHandler(buildConfig({ runner: runner as any }));
    const payload = makeReviewCommentPayload();
    payload.comment.user.login = "linear-agent[bot]";
    const res = await postWebhook(app, payload);
    const json = await res.json();
    expect(json.skipped).toBe("comment from bot login");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("ignores comments from non-allowed reviewers when list is configured", async () => {
    const restrictedConfig = buildConfig({
      runner: runner as any,
      repoConfigs: {
        "org/repo": {
          ...repoConfig,
          githubFeedback: {
            ...repoConfig.githubFeedback,
            allowedReviewers: ["only-alice"],
          },
        },
      },
    });
    const app = createGitHubWebhookHandler(restrictedConfig);
    const payload = makeReviewCommentPayload();
    payload.comment.user.login = "some-other-reviewer";
    const res = await postWebhook(app, payload);
    const json = await res.json();
    expect(json.skipped).toBe("commenter not in allowedReviewers");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("ignores comments without trigger keyword when autoTrigger is false", async () => {
    const keywordConfig = buildConfig({
      runner: runner as any,
      repoConfigs: {
        "org/repo": {
          ...repoConfig,
          githubFeedback: {
            triggerKeyword: "@agent fix this",
            autoTrigger: false,
          },
        },
      },
    });
    const app = createGitHubWebhookHandler(keywordConfig);
    const res = await postWebhook(app, makeReviewCommentPayload());
    const json = await res.json();
    expect(json.skipped).toBe("trigger keyword not found");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("triggers when trigger keyword is present (even with autoTrigger false)", async () => {
    const mockDb = makeMockDb();
    const keywordConfig = buildConfig({
      runner: runner as any,
      db: mockDb as any,
      repoConfigs: {
        "org/repo": {
          ...repoConfig,
          githubFeedback: {
            triggerKeyword: "@agent fix this",
            autoTrigger: false,
          },
        },
      },
    });
    const app = createGitHubWebhookHandler(keywordConfig);
    const payload = makeReviewCommentPayload();
    payload.comment.body = "I think @agent fix this and rename the variable";
    const res = await postWebhook(app, payload);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.action).toBe("feedback-triggered");
    expect(runner.startFeedback).toHaveBeenCalledTimes(1);
  });

  it("does not trigger on PR not created by the agent (no DB match, no agent/ branch)", async () => {
    const app = createGitHubWebhookHandler(
      buildConfig({
        runner: runner as any,
        db: makeMockDb(null) as any, // no DB row found
      }),
    );
    const payload = makeReviewCommentPayload();
    payload.pull_request.head.ref = "feature/some-human-branch";
    const res = await postWebhook(app, payload);
    const json = await res.json();
    expect(json.skipped).toBe("not an agent-created PR");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("triggers for a valid review comment on an agent PR", async () => {
    const mockDb = makeMockDb();
    const app = createGitHubWebhookHandler(
      buildConfig({ runner: runner as any, db: mockDb as any }),
    );
    const res = await postWebhook(app, makeReviewCommentPayload());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.action).toBe("feedback-triggered");
    expect(runner.startFeedback).toHaveBeenCalledTimes(1);

    const callArgs = runner.startFeedback.mock.calls[0][0];
    expect(callArgs.branch).toBe("agent/LIN-42-add-user-search");
    expect(callArgs.prUrl).toBe("https://github.com/org/repo/pull/7");
    expect(callArgs.feedbackComments).toHaveLength(1);
    expect(callArgs.feedbackComments[0].author).toBe("reviewer-alice");
    expect(callArgs.feedbackComments[0].filePath).toBe("src/index.ts");
    expect(callArgs.feedbackComments[0].lineNumber).toBe(42);
  });

  it("triggers for a valid pull_request_review event", async () => {
    const mockDb = makeMockDb();
    const app = createGitHubWebhookHandler(
      buildConfig({ runner: runner as any, db: mockDb as any }),
    );
    const res = await postWebhook(app, makeReviewPayload(), "pull_request_review");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.action).toBe("feedback-triggered");
    expect(runner.startFeedback).toHaveBeenCalledTimes(1);
  });

  it("deduplicates the same comment ID within the handler lifetime", async () => {
    const mockDb = makeMockDb();
    const app = createGitHubWebhookHandler(
      buildConfig({ runner: runner as any, db: mockDb as any }),
    );
    const payload = makeReviewCommentPayload();

    // First request triggers
    const res1 = await postWebhook(app, payload);
    expect((await res1.json()).action).toBe("feedback-triggered");
    expect(runner.startFeedback).toHaveBeenCalledTimes(1);

    // Second identical request is deduplicated
    const res2 = await postWebhook(app, payload);
    const json2 = await res2.json();
    expect(json2.deduplicated).toBe(true);
    expect(runner.startFeedback).toHaveBeenCalledTimes(1); // Still 1
  });

  it("rate-limits when a feedback run is already in progress for the PR", async () => {
    const activeRunner = {
      ...makeMockRunner(),
      isActiveFeedback: vi.fn().mockReturnValue(true), // already active
    };
    const app = createGitHubWebhookHandler(
      buildConfig({
        runner: activeRunner as any,
        db: makeMockDb() as any,
      }),
    );
    const res = await postWebhook(app, makeReviewCommentPayload());
    const json = await res.json();
    expect(json.skipped).toBe("feedback run already in progress");
    expect(activeRunner.startFeedback).not.toHaveBeenCalled();
  });

  it("skips when no repo config matches the PR's repo URL", async () => {
    const app = createGitHubWebhookHandler(
      buildConfig({
        runner: runner as any,
        db: makeMockDb() as any,
        repoConfigs: { "other-team": { ...repoConfig, url: "https://github.com/other/repo" } },
      }),
    );
    const res = await postWebhook(app, makeReviewCommentPayload());
    const json = await res.json();
    expect(json.skipped).toBe("no repo config for this PR");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("rejects requests when webhook secret is not configured", async () => {
    const app = createGitHubWebhookHandler(
      buildConfig({
        webhookSecret: undefined,
        runner: runner as any,
        db: makeMockDb() as any,
      }),
    );
    const rawBody = JSON.stringify(makeReviewCommentPayload());
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request_review_comment",
      },
      body: rawBody,
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Webhook secret not configured");
  });
});

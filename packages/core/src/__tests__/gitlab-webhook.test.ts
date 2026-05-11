/**
 * Unit tests for the GitLab webhook handler.
 *
 * Covers:
 *  - Token verification (verifyGitLabToken)
 *  - Valid X-Gitlab-Token → feedback-run trigger
 *  - Invalid / missing token → 401 response
 *  - MR merged event → DB update
 *  - Dedup, bot-exclusion, allowed-reviewer filter, trigger-keyword
 *  - Integration path: handler → runner.startFeedback()
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGitLabWebhookHandler, verifyGitLabToken } from "../webhook/gitlab-handler.js";
import type { GitLabWebhookHandlerConfig } from "../webhook/gitlab-handler.js";
import type { PipelineConfig, RepoConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN = "gl-webhook-secret-token";

const pipelineConfig: PipelineConfig = {
  name: "auto-implement",
  stages: ["triage", "implement", "test", "review"],
  retry: { maxAttempts: 1, strategy: "fix-and-retry" },
  review: { requiredApprovals: 1 },
  prStrategy: "draft",
};

const repoConfig: RepoConfig = {
  url: "https://gitlab.com/org/repo",
  defaultBranch: "main",
  testCommand: "npm test",
  buildCommand: "npm run build",
  provider: "gitlab",
  githubFeedback: {
    botLogins: ["bot[bot]"],
    autoTrigger: true,
  },
};

const mockRun = {
  id: "run-abc123",
  issueId: "LIN-42",
  issueTitle: "Add user search",
  pipelineKey: "auto-implement",
  repoUrl: "https://gitlab.com/org/repo",
  branch: "agent/LIN-42-add-user-search",
  status: "completed",
  prUrl: "https://gitlab.com/org/repo/-/merge_requests/7",
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
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
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
  overrides: Partial<GitLabWebhookHandlerConfig> = {},
): GitLabWebhookHandlerConfig {
  return {
    webhookToken: TOKEN,
    runner: makeMockRunner() as any,
    pipelineConfigs: { "auto-implement": pipelineConfig },
    repoConfigs: { "org/repo": repoConfig },
    db: makeMockDb() as any,
    ...overrides,
  };
}

function makeNotePayload(overrides: Record<string, any> = {}) {
  return {
    object_kind: "note",
    user: { username: "reviewer-alice" },
    object_attributes: {
      id: 12345,
      note: "Please rename this variable for clarity.",
      noteable_type: "MergeRequest",
      url: "https://gitlab.com/org/repo/-/merge_requests/7#note_12345",
      ...overrides.object_attributes,
    },
    merge_request: {
      iid: 7,
      url: "https://gitlab.com/org/repo/-/merge_requests/7",
      source_branch: "agent/LIN-42-add-user-search",
      draft: false,
      work_in_progress: false,
      ...overrides.merge_request,
    },
    ...overrides,
  };
}

async function postWebhook(
  config: GitLabWebhookHandlerConfig,
  payload: Record<string, any>,
  headers: Record<string, string> = {},
) {
  const app = createGitLabWebhookHandler(config);
  const body = JSON.stringify(payload);
  const req = new Request("http://localhost/webhooks/gitlab", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gitlab-Token": TOKEN,
      ...headers,
    },
    body,
  });
  return app.fetch(req);
}

// ---------------------------------------------------------------------------
// verifyGitLabToken
// ---------------------------------------------------------------------------

describe("verifyGitLabToken", () => {
  it("returns true for matching tokens", () => {
    expect(verifyGitLabToken("my-secret", "my-secret")).toBe(true);
  });

  it("returns false for mismatched tokens", () => {
    expect(verifyGitLabToken("wrong-token", "my-secret")).toBe(false);
  });

  it("returns false for empty received token", () => {
    expect(verifyGitLabToken("", "my-secret")).toBe(false);
  });

  it("returns false for empty expected token", () => {
    expect(verifyGitLabToken("some-token", "")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(verifyGitLabToken("My-Secret", "my-secret")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

describe("createGitLabWebhookHandler — token validation", () => {
  it("accepts a valid X-Gitlab-Token and triggers feedback", async () => {
    const config = buildConfig();
    const res = await postWebhook(config, makeNotePayload());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.action).toBe("feedback-triggered");
  });

  it("rejects an invalid X-Gitlab-Token with 401", async () => {
    const config = buildConfig();
    const res = await postWebhook(config, makeNotePayload(), {
      "X-Gitlab-Token": "wrong-token",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a missing X-Gitlab-Token with 401", async () => {
    const config = buildConfig();
    const body = JSON.stringify(makeNotePayload());
    const req = new Request("http://localhost/webhooks/gitlab", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const res = await createGitLabWebhookHandler(config).fetch(req);
    expect(res.status).toBe(401);
  });

  it("skips token check when webhookToken is not configured", async () => {
    const config = buildConfig({ webhookToken: undefined });
    const body = JSON.stringify(makeNotePayload());
    const req = new Request("http://localhost/webhooks/gitlab", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const res = await createGitLabWebhookHandler(config).fetch(req);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Note (comment) events → review-feedback runs
// ---------------------------------------------------------------------------

describe("createGitLabWebhookHandler — note events", () => {
  it("triggers runner.startFeedback() for a qualifying MR note", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({ runner: runner as any });

    const res = await postWebhook(config, makeNotePayload());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.action).toBe("feedback-triggered");
    expect(runner.startFeedback).toHaveBeenCalledOnce();

    const callArgs = runner.startFeedback.mock.calls[0][0];
    expect(callArgs.prUrl).toBe("https://gitlab.com/org/repo/-/merge_requests/7");
    expect(callArgs.feedbackComments).toHaveLength(1);
    expect(callArgs.feedbackComments[0].body).toBe("Please rename this variable for clarity.");
    expect(callArgs.feedbackComments[0].author).toBe("reviewer-alice");
  });

  it("skips non-MergeRequest notes", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({ runner: runner as any });

    const payload = makeNotePayload({
      object_attributes: {
        id: 99,
        note: "comment on an issue",
        noteable_type: "Issue",
        url: "https://gitlab.com/org/repo/-/issues/1#note_99",
      },
    });

    const res = await postWebhook(config, payload);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.skipped).toBeDefined();
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("skips draft MRs", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({ runner: runner as any });

    const res = await postWebhook(
      config,
      makeNotePayload({ merge_request: { iid: 7, url: "https://gitlab.com/org/repo/-/merge_requests/7", source_branch: "agent/LIN-42-add-user-search", draft: true, work_in_progress: false } }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.skipped).toMatch(/draft/i);
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("skips comments from bot logins", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({ runner: runner as any });

    const res = await postWebhook(
      config,
      makeNotePayload({ user: { username: "bot[bot]" } }),
    );

    const body = await res.json() as any;
    expect(body.skipped).toBe("comment from bot login");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("skips when commenter not in allowedReviewers (when list is non-empty)", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({
      runner: runner as any,
      repoConfigs: {
        "org/repo": {
          ...repoConfig,
          githubFeedback: {
            allowedReviewers: ["alice"],
            botLogins: [],
            autoTrigger: true,
          },
        },
      },
    });

    const res = await postWebhook(
      config,
      makeNotePayload({ user: { username: "unknown-person" } }),
    );

    const body = await res.json() as any;
    expect(body.skipped).toBe("commenter not in allowedReviewers");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("skips when trigger keyword is required but missing", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({
      runner: runner as any,
      repoConfigs: {
        "org/repo": {
          ...repoConfig,
          githubFeedback: {
            triggerKeyword: "@agent",
            autoTrigger: false,
          },
        },
      },
    });

    const res = await postWebhook(config, makeNotePayload());
    const body = await res.json() as any;
    expect(body.skipped).toBe("trigger keyword not found");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("triggers when trigger keyword is present", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({
      runner: runner as any,
      repoConfigs: {
        "org/repo": {
          ...repoConfig,
          githubFeedback: {
            triggerKeyword: "@agent",
          },
        },
      },
    });

    const res = await postWebhook(
      config,
      makeNotePayload({
        object_attributes: {
          id: 12345,
          note: "please @agent fix this",
          noteable_type: "MergeRequest",
          url: "https://gitlab.com/org/repo/-/merge_requests/7#note_12345",
        },
      }),
    );

    expect((await res.json() as any).action).toBe("feedback-triggered");
    expect(runner.startFeedback).toHaveBeenCalledOnce();
  });

  it("skips empty comments", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({ runner: runner as any });

    const res = await postWebhook(
      config,
      makeNotePayload({
        object_attributes: {
          id: 12345,
          note: "   ",
          noteable_type: "MergeRequest",
          url: "https://gitlab.com/org/repo/-/merge_requests/7#note_12345",
        },
      }),
    );

    const body = await res.json() as any;
    expect(body.skipped).toBe("empty comment body");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("returns not-found for unrecognised MR (not an agent-created MR)", async () => {
    const db = makeMockDb(null); // No pipeline run found
    const config = buildConfig({ db: db as any });

    const res = await postWebhook(config, makeNotePayload());
    const body = await res.json() as any;
    expect(body.skipped).toBe("not an agent-created MR");
  });

  it("skips when a feedback run is already active for this MR", async () => {
    const runner = makeMockRunner();
    runner.isActiveFeedback.mockReturnValue(true);
    const config = buildConfig({ runner: runner as any });

    const res = await postWebhook(config, makeNotePayload());
    const body = await res.json() as any;
    expect(body.skipped).toBe("feedback run already in progress");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// MR merged events
// ---------------------------------------------------------------------------

describe("createGitLabWebhookHandler — MR merged events", () => {
  it("marks pipeline run merged when MR is merged", async () => {
    const db = makeMockDb();
    const config = buildConfig({ db: db as any });

    const payload = {
      object_kind: "merge_request",
      object_attributes: {
        action: "merge",
        url: "https://gitlab.com/org/repo/-/merge_requests/7",
        source_branch: "agent/LIN-42-add-user-search",
        state: "merged",
      },
    };

    const res = await postWebhook(config, payload);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.action).toBe("mr-merged");
    expect(db.update).toHaveBeenCalled();
  });

  it("calls notifier.onPRMerged when notifier is provided", async () => {
    const db = makeMockDb();
    const notifier = { onPRMerged: vi.fn().mockResolvedValue(undefined) };
    const config = buildConfig({ db: db as any, notifier: notifier as any });

    const payload = {
      object_kind: "merge_request",
      object_attributes: {
        action: "merge",
        url: "https://gitlab.com/org/repo/-/merge_requests/7",
        source_branch: "agent/LIN-42-add-user-search",
        state: "merged",
      },
    };

    await postWebhook(config, payload);
    expect(notifier.onPRMerged).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Unhandled event types
// ---------------------------------------------------------------------------

describe("createGitLabWebhookHandler — unhandled events", () => {
  it("returns skipped for push events", async () => {
    const config = buildConfig();
    const res = await postWebhook(config, { object_kind: "push" });
    const body = await res.json() as any;
    expect(body.skipped).toBeDefined();
  });

  it("returns 400 for invalid JSON", async () => {
    const config = buildConfig();
    const req = new Request("http://localhost/webhooks/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Token": TOKEN,
      },
      body: "not json",
    });
    const res = await createGitLabWebhookHandler(config).fetch(req);
    expect(res.status).toBe(400);
  });
});

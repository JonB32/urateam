/**
 * Unit tests for the Bitbucket webhook handler.
 *
 * Covers:
 *  - HMAC-SHA256 signature verification (verifyBitbucketSignature)
 *  - Valid X-Hub-Signature-256 → feedback-run trigger
 *  - Invalid / missing signature → 401 response
 *  - PR fulfilled (merged) event → DB update
 *  - Dedup, bot-exclusion, allowed-reviewer filter, trigger-keyword
 *  - Integration path: handler → runner.startFeedback()
 */

import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import {
  createBitbucketWebhookHandler,
  verifyBitbucketSignature,
} from "../webhook/bitbucket-handler.js";
import type { BitbucketWebhookHandlerConfig } from "../webhook/bitbucket-handler.js";
import type { PipelineConfig, RepoConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = "bb-webhook-secret";

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
  url: "https://bitbucket.org/myworkspace/myrepo",
  defaultBranch: "main",
  testCommand: "npm test",
  buildCommand: "npm run build",
  provider: "bitbucket",
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
  repoUrl: "https://bitbucket.org/myworkspace/myrepo",
  branch: "agent/LIN-42-add-user-search",
  status: "completed",
  prUrl: "https://bitbucket.org/myworkspace/myrepo/pull-requests/7",
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
  overrides: Partial<BitbucketWebhookHandlerConfig> = {},
): BitbucketWebhookHandlerConfig {
  return {
    webhookSecret: SECRET,
    runner: makeMockRunner() as any,
    pipelineConfigs: { "auto-implement": pipelineConfig },
    repoConfigs: { "myworkspace/myrepo": repoConfig },
    db: makeMockDb() as any,
    ...overrides,
  };
}

function makeCommentPayload(overrides: Record<string, any> = {}) {
  return {
    pullrequest: {
      id: 7,
      links: {
        html: { href: "https://bitbucket.org/myworkspace/myrepo/pull-requests/7" },
      },
      source: { branch: { name: "agent/LIN-42-add-user-search" } },
      ...overrides.pullrequest,
    },
    actor: {
      nickname: "reviewer-alice",
      display_name: "Reviewer Alice",
      ...overrides.actor,
    },
    comment: {
      id: 12345,
      content: { raw: "Please rename this variable for clarity." },
      links: {
        html: {
          href: "https://bitbucket.org/myworkspace/myrepo/pull-requests/7/_/diff#comment-12345",
        },
      },
      ...overrides.comment,
    },
    ...overrides,
  };
}

async function postWebhook(
  config: BitbucketWebhookHandlerConfig,
  payload: Record<string, any>,
  eventKey = "pullrequest:comment_created",
  headers: Record<string, string> = {},
) {
  const app = createBitbucketWebhookHandler(config);
  const body = JSON.stringify(payload);
  const sig = sign(body, SECRET);
  const req = new Request("http://localhost/webhooks/bitbucket", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Event-Key": eventKey,
      "X-Hub-Signature-256": sig,
      ...headers,
    },
    body,
  });
  return app.fetch(req);
}

// ---------------------------------------------------------------------------
// verifyBitbucketSignature
// ---------------------------------------------------------------------------

describe("verifyBitbucketSignature", () => {
  const body = '{"hello":"world"}';

  it("verifies a valid sha256 signature", () => {
    const sig = sign(body, "mysecret");
    expect(verifyBitbucketSignature(body, sig, "mysecret")).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(verifyBitbucketSignature(body, sign(body, "wrong-secret"), "mysecret")).toBe(false);
  });

  it("rejects a signature without sha256= prefix", () => {
    const hmac = createHmac("sha256", "mysecret").update(body).digest("hex");
    expect(verifyBitbucketSignature(body, hmac, "mysecret")).toBe(false);
  });

  it("rejects mismatched-length signatures", () => {
    expect(verifyBitbucketSignature(body, "sha256=abc", "mysecret")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Signature validation in handler
// ---------------------------------------------------------------------------

describe("createBitbucketWebhookHandler — signature validation", () => {
  it("accepts a valid X-Hub-Signature-256 and triggers feedback", async () => {
    const config = buildConfig();
    const res = await postWebhook(config, makeCommentPayload());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.action).toBe("feedback-triggered");
  });

  it("rejects an invalid signature with 401", async () => {
    const config = buildConfig();
    const res = await postWebhook(config, makeCommentPayload(), "pullrequest:comment_created", {
      "X-Hub-Signature-256": "sha256=deadbeef0000000000000000000000000000000000000000000000000000000",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a missing signature with 401 when secret is configured", async () => {
    const config = buildConfig();
    const body = JSON.stringify(makeCommentPayload());
    const req = new Request("http://localhost/webhooks/bitbucket", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Event-Key": "pullrequest:comment_created",
      },
      body,
    });
    const res = await createBitbucketWebhookHandler(config).fetch(req);
    expect(res.status).toBe(401);
  });

  it("skips signature check when webhookSecret is not configured", async () => {
    const config = buildConfig({ webhookSecret: undefined });
    const body = JSON.stringify(makeCommentPayload());
    const req = new Request("http://localhost/webhooks/bitbucket", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Event-Key": "pullrequest:comment_created",
      },
      body,
    });
    const res = await createBitbucketWebhookHandler(config).fetch(req);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PR comment events → review-feedback runs
// ---------------------------------------------------------------------------

describe("createBitbucketWebhookHandler — comment events", () => {
  it("triggers runner.startFeedback() for a qualifying PR comment", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({ runner: runner as any });

    const res = await postWebhook(config, makeCommentPayload());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.action).toBe("feedback-triggered");
    expect(runner.startFeedback).toHaveBeenCalledOnce();

    const callArgs = runner.startFeedback.mock.calls[0][0];
    expect(callArgs.prUrl).toBe("https://bitbucket.org/myworkspace/myrepo/pull-requests/7");
    expect(callArgs.feedbackComments).toHaveLength(1);
    expect(callArgs.feedbackComments[0].body).toBe("Please rename this variable for clarity.");
    expect(callArgs.feedbackComments[0].author).toBe("reviewer-alice");
  });

  it("skips unhandled event keys", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({ runner: runner as any });

    const res = await postWebhook(config, makeCommentPayload(), "pullrequest:created");
    const body = await res.json() as any;
    expect(body.skipped).toBeDefined();
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("skips empty comment bodies", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({ runner: runner as any });

    const payload = makeCommentPayload({
      comment: { id: 12345, content: { raw: "   " }, links: { html: { href: "" } } },
    });

    const res = await postWebhook(config, payload);
    const body = await res.json() as any;
    expect(body.skipped).toBe("empty comment body");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("skips comments from bot logins", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({ runner: runner as any });

    const res = await postWebhook(
      config,
      makeCommentPayload({ actor: { nickname: "bot[bot]", display_name: "Bot" } }),
    );

    const body = await res.json() as any;
    expect(body.skipped).toBe("comment from bot login");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("skips when commenter not in allowedReviewers", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({
      runner: runner as any,
      repoConfigs: {
        "myworkspace/myrepo": {
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
      makeCommentPayload({ actor: { nickname: "unknown-person", display_name: "Unknown" } }),
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
        "myworkspace/myrepo": {
          ...repoConfig,
          githubFeedback: {
            triggerKeyword: "@agent",
            autoTrigger: false,
          },
        },
      },
    });

    const res = await postWebhook(config, makeCommentPayload());
    const body = await res.json() as any;
    expect(body.skipped).toBe("trigger keyword not found");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });

  it("triggers when trigger keyword is present", async () => {
    const runner = makeMockRunner();
    const config = buildConfig({
      runner: runner as any,
      repoConfigs: {
        "myworkspace/myrepo": {
          ...repoConfig,
          githubFeedback: { triggerKeyword: "@agent" },
        },
      },
    });

    const payload = makeCommentPayload({
      comment: {
        id: 12345,
        content: { raw: "please @agent fix this" },
        links: { html: { href: "" } },
      },
    });

    const res = await postWebhook(config, payload);
    expect((await res.json() as any).action).toBe("feedback-triggered");
    expect(runner.startFeedback).toHaveBeenCalledOnce();
  });

  it("returns not-found for unrecognised PR", async () => {
    const db = makeMockDb(null);
    const config = buildConfig({ db: db as any });

    const res = await postWebhook(config, makeCommentPayload());
    const body = await res.json() as any;
    expect(body.skipped).toBe("not an agent-created PR");
  });

  it("skips when a feedback run is already active", async () => {
    const runner = makeMockRunner();
    runner.isActiveFeedback.mockReturnValue(true);
    const config = buildConfig({ runner: runner as any });

    const res = await postWebhook(config, makeCommentPayload());
    const body = await res.json() as any;
    expect(body.skipped).toBe("feedback run already in progress");
    expect(runner.startFeedback).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PR fulfilled (merged) events
// ---------------------------------------------------------------------------

describe("createBitbucketWebhookHandler — PR fulfilled events", () => {
  it("marks pipeline run merged when PR is fulfilled", async () => {
    const db = makeMockDb();
    const config = buildConfig({ db: db as any });

    const payload = {
      pullrequest: {
        id: 7,
        links: {
          html: { href: "https://bitbucket.org/myworkspace/myrepo/pull-requests/7" },
        },
        source: { branch: { name: "agent/LIN-42-add-user-search" } },
      },
    };

    const res = await postWebhook(config, payload, "pullrequest:fulfilled");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.action).toBe("pr-merged");
    expect(db.update).toHaveBeenCalled();
  });

  it("calls notifier.onPRMerged when notifier is provided", async () => {
    const db = makeMockDb();
    const notifier = { onPRMerged: vi.fn().mockResolvedValue(undefined) };
    const config = buildConfig({ db: db as any, notifier: notifier as any });

    const payload = {
      pullrequest: {
        id: 7,
        links: {
          html: { href: "https://bitbucket.org/myworkspace/myrepo/pull-requests/7" },
        },
        source: { branch: { name: "agent/LIN-42-add-user-search" } },
      },
    };

    await postWebhook(config, payload, "pullrequest:fulfilled");
    expect(notifier.onPRMerged).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Invalid JSON
// ---------------------------------------------------------------------------

describe("createBitbucketWebhookHandler — invalid requests", () => {
  it("returns 400 for invalid JSON", async () => {
    const config = buildConfig();
    const badBody = "not json";
    const sig = sign(badBody, SECRET);
    const req = new Request("http://localhost/webhooks/bitbucket", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Event-Key": "pullrequest:comment_created",
        "X-Hub-Signature-256": sig,
      },
      body: badBody,
    });
    const res = await createBitbucketWebhookHandler(config).fetch(req);
    expect(res.status).toBe(400);
  });
});

/**
 * PR Automerge integration tests — BEC-117
 *
 * Tests that the GitHub webhook handler correctly triggers automerge when
 * a PR event is received and the pipeline config has autoMergeConfig set.
 *
 * Covers:
 *  1. check_suite.completed event triggers automerge when all criteria pass
 *  2. check_suite.completed does NOT trigger automerge when criteria fail
 *  3. pull_request.labeled event triggers automerge check
 *  4. status event triggers automerge check via branch lookup
 *  5. No-op when GitHub App credentials are missing
 *  6. No-op when pipeline has no autoMergeConfig
 *
 * Also unit-tests checkAutoMergeEligibility in isolation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { createDb } from "../db/client.js";
import { createGitHubWebhookHandler } from "../webhook/github-handler.js";
import { pipelineRuns } from "../db/schema.js";
import { checkAutoMergeEligibility } from "../pipeline/automerge.js";
import type { PipelineConfig, RepoConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockMergePR = vi.fn().mockResolvedValue({ data: { merged: true, message: "Merged" } });
const mockListReviews = vi.fn().mockResolvedValue({ data: [] });
const mockGetCombinedStatus = vi.fn().mockResolvedValue({ data: { statuses: [] } });
const mockChecksListForRef = vi.fn().mockResolvedValue({ data: { check_runs: [] } });
const mockPullsList = vi.fn().mockResolvedValue({ data: [] });
const mockPullsGet = vi.fn().mockResolvedValue({
  data: {
    draft: false,
    merged: false,
    state: "open",
    base: { ref: "main" },
    head: { sha: "abc123" },
    labels: [],
  },
});

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    pulls: {
      get: mockPullsGet,
      merge: mockMergePR,
      listReviews: mockListReviews,
      list: mockPullsList,
    },
    repos: {
      getCombinedStatusForRef: mockGetCombinedStatus,
    },
    checks: {
      listForRef: mockChecksListForRef,
    },
  })),
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn().mockReturnValue({}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "test-automerge-secret";

function signPayload(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

async function postGitHubWebhook(
  app: Hono,
  event: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = JSON.stringify(payload);
  const res = await app.fetch(
    new Request("http://localhost/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": event,
        "X-Hub-Signature-256": signPayload(body),
      },
      body,
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const GITHUB_CONFIG = { appId: "12345", privateKey: "fake-key", installationId: 1 };

const REPO_CONFIG: RepoConfig = {
  url: "https://github.com/test/repo.git",
  defaultBranch: "main",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
};

function makeAutoMergePipelineConfig(
  overrides: Partial<NonNullable<PipelineConfig["autoMergeConfig"]>> = {},
): PipelineConfig {
  return {
    name: "Auto Implement",
    stages: ["implement"],
    retry: { maxAttempts: 0, strategy: "fail-fast" },
    review: { requiredApprovals: 0 },
    prStrategy: "ready",
    autoMergeConfig: {
      mergeMethod: "squash",
      ...overrides,
    },
  };
}

function checkSuitePayload(prNumber: number, prBranch: string, prUrl: string) {
  return {
    action: "completed",
    check_suite: {
      id: 999,
      conclusion: "success",
      pull_requests: [
        {
          number: prNumber,
          html_url: prUrl,
          head: { ref: prBranch, sha: "abc123" },
        },
      ],
    },
    repository: { name: "repo", owner: { login: "test" } },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PR Automerge — GitHub webhook event handling", () => {
  let db: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPullsGet.mockResolvedValue({
      data: {
        draft: false,
        merged: false,
        state: "open",
        base: { ref: "main" },
        head: { sha: "abc123" },
        labels: [],
      },
    });
    mockMergePR.mockResolvedValue({ data: { merged: true, message: "Merged" } });
    mockListReviews.mockResolvedValue({ data: [] });
    mockGetCombinedStatus.mockResolvedValue({ data: { statuses: [] } });
    mockChecksListForRef.mockResolvedValue({ data: { check_runs: [] } });

    db = await createDb({ driver: "sqlite", connectionString: ":memory:" });
  });

  // ---------------------------------------------------------------------------
  // 1. check_suite.completed → merge triggered when all criteria pass
  // ---------------------------------------------------------------------------
  it("triggers automerge on check_suite.completed when all criteria pass", async () => {
    const prUrl = "https://github.com/test/repo/pull/1";
    const prBranch = "agent/BEC-117-feature";

    // Seed a completed pipeline run with a PR URL
    await db.insert(pipelineRuns).values({
      id: "run-001",
      issueId: "BEC-117",
      issueTitle: "Feature",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: prBranch,
      status: "completed",
      prUrl,
      startedAt: new Date(),
    });

    const pipelineConfig = makeAutoMergePipelineConfig();
    const app = new Hono();
    app.route(
      "/",
      createGitHubWebhookHandler({
        webhookSecret: WEBHOOK_SECRET,
        runner: {} as any,
        pipelineConfigs: { "auto-implement": pipelineConfig },
        repoConfigs: { "test-repo": REPO_CONFIG },
        db: db as any,
        github: GITHUB_CONFIG,
      }),
    );

    const { status, json } = await postGitHubWebhook(
      app,
      "check_suite",
      checkSuitePayload(1, prBranch, prUrl),
    );

    expect(status).toBe(200);
    expect(json.ok).toBe(true);

    // Verify merge API was called
    expect(mockMergePR).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "test",
        repo: "repo",
        pull_number: 1,
        merge_method: "squash",
      }),
    );

    // Verify DB was updated
    const rows = await db.select().from(pipelineRuns).where();
    expect(rows[0].autoMerged).toBeTruthy();
    expect(rows[0].autoMergeReason).toMatch(/auto-merged successfully/);
  });

  // ---------------------------------------------------------------------------
  // 2. check_suite.completed → NO merge when PR is a draft
  // ---------------------------------------------------------------------------
  it("does not merge when PR is a draft", async () => {
    mockPullsGet.mockResolvedValue({
      data: {
        draft: true,
        merged: false,
        state: "open",
        base: { ref: "main" },
        head: { sha: "abc123" },
        labels: [],
      },
    });

    const prUrl = "https://github.com/test/repo/pull/2";
    const prBranch = "agent/BEC-117-draft";

    await db.insert(pipelineRuns).values({
      id: "run-002",
      issueId: "BEC-117-D",
      issueTitle: "Draft Feature",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: prBranch,
      status: "completed",
      prUrl,
      startedAt: new Date(),
    });

    const pipelineConfig = makeAutoMergePipelineConfig();
    const app = new Hono();
    app.route(
      "/",
      createGitHubWebhookHandler({
        webhookSecret: WEBHOOK_SECRET,
        runner: {} as any,
        pipelineConfigs: { "auto-implement": pipelineConfig },
        repoConfigs: {},
        db: db as any,
        github: GITHUB_CONFIG,
      }),
    );

    await postGitHubWebhook(app, "check_suite", checkSuitePayload(2, prBranch, prUrl));

    expect(mockMergePR).not.toHaveBeenCalled();

    const rows = await db.select().from(pipelineRuns).where();
    expect(rows[0].autoMerged).toBeFalsy();
    expect(rows[0].autoMergeReason).toMatch(/draft/i);
  });

  // ---------------------------------------------------------------------------
  // 3. Missing required status check → no merge
  // ---------------------------------------------------------------------------
  it("does not merge when required status check has not passed", async () => {
    mockGetCombinedStatus.mockResolvedValue({ data: { statuses: [] } });
    mockChecksListForRef.mockResolvedValue({ data: { check_runs: [] } });

    const prUrl = "https://github.com/test/repo/pull/3";
    const prBranch = "agent/BEC-117-checks";

    await db.insert(pipelineRuns).values({
      id: "run-003",
      issueId: "BEC-117-C",
      issueTitle: "Checks Feature",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: prBranch,
      status: "completed",
      prUrl,
      startedAt: new Date(),
    });

    const pipelineConfig = makeAutoMergePipelineConfig({ requiredStatusChecks: ["ci/tests"] });
    const app = new Hono();
    app.route(
      "/",
      createGitHubWebhookHandler({
        webhookSecret: WEBHOOK_SECRET,
        runner: {} as any,
        pipelineConfigs: { "auto-implement": pipelineConfig },
        repoConfigs: {},
        db: db as any,
        github: GITHUB_CONFIG,
      }),
    );

    await postGitHubWebhook(app, "check_suite", checkSuitePayload(3, prBranch, prUrl));

    expect(mockMergePR).not.toHaveBeenCalled();
    const rows = await db.select().from(pipelineRuns).where();
    expect(rows[0].autoMerged).toBeFalsy();
    expect(rows[0].autoMergeReason).toMatch(/ci\/tests/);
  });

  // ---------------------------------------------------------------------------
  // 4. Insufficient approvals → no merge
  // ---------------------------------------------------------------------------
  it("does not merge when minimumApprovingReviews is not met", async () => {
    mockListReviews.mockResolvedValue({ data: [] }); // 0 approvals

    const prUrl = "https://github.com/test/repo/pull/4";
    const prBranch = "agent/BEC-117-approvals";

    await db.insert(pipelineRuns).values({
      id: "run-004",
      issueId: "BEC-117-A",
      issueTitle: "Approval Feature",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: prBranch,
      status: "completed",
      prUrl,
      startedAt: new Date(),
    });

    const pipelineConfig = makeAutoMergePipelineConfig({ minimumApprovingReviews: 2 });
    const app = new Hono();
    app.route(
      "/",
      createGitHubWebhookHandler({
        webhookSecret: WEBHOOK_SECRET,
        runner: {} as any,
        pipelineConfigs: { "auto-implement": pipelineConfig },
        repoConfigs: {},
        db: db as any,
        github: GITHUB_CONFIG,
      }),
    );

    await postGitHubWebhook(app, "check_suite", checkSuitePayload(4, prBranch, prUrl));

    expect(mockMergePR).not.toHaveBeenCalled();
    const rows = await db.select().from(pipelineRuns).where();
    expect(rows[0].autoMergeReason).toMatch(/approving review/);
  });

  // ---------------------------------------------------------------------------
  // 5. Required label missing → no merge
  // ---------------------------------------------------------------------------
  it("does not merge when required label is missing from PR", async () => {
    mockPullsGet.mockResolvedValue({
      data: {
        draft: false,
        merged: false,
        state: "open",
        base: { ref: "main" },
        head: { sha: "abc123" },
        labels: [{ name: "bug" }], // missing "ready-to-merge"
      },
    });

    const prUrl = "https://github.com/test/repo/pull/5";
    const prBranch = "agent/BEC-117-labels";

    await db.insert(pipelineRuns).values({
      id: "run-005",
      issueId: "BEC-117-L",
      issueTitle: "Labels Feature",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: prBranch,
      status: "completed",
      prUrl,
      startedAt: new Date(),
    });

    const pipelineConfig = makeAutoMergePipelineConfig({ requiredLabels: ["ready-to-merge"] });
    const app = new Hono();
    app.route(
      "/",
      createGitHubWebhookHandler({
        webhookSecret: WEBHOOK_SECRET,
        runner: {} as any,
        pipelineConfigs: { "auto-implement": pipelineConfig },
        repoConfigs: {},
        db: db as any,
        github: GITHUB_CONFIG,
      }),
    );

    await postGitHubWebhook(app, "check_suite", checkSuitePayload(5, prBranch, prUrl));

    expect(mockMergePR).not.toHaveBeenCalled();
    const rows = await db.select().from(pipelineRuns).where();
    expect(rows[0].autoMergeReason).toMatch(/ready-to-merge/);
  });

  // ---------------------------------------------------------------------------
  // 6. Branch not in allowedBranches → no merge
  // ---------------------------------------------------------------------------
  it("does not merge when base branch is not in allowedBranches", async () => {
    mockPullsGet.mockResolvedValue({
      data: {
        draft: false,
        merged: false,
        state: "open",
        base: { ref: "develop" }, // not in allowedBranches
        head: { sha: "abc123" },
        labels: [],
      },
    });

    const prUrl = "https://github.com/test/repo/pull/6";
    const prBranch = "agent/BEC-117-branches";

    await db.insert(pipelineRuns).values({
      id: "run-006",
      issueId: "BEC-117-B",
      issueTitle: "Branch Feature",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: prBranch,
      status: "completed",
      prUrl,
      startedAt: new Date(),
    });

    const pipelineConfig = makeAutoMergePipelineConfig({ allowedBranches: ["main", "release"] });
    const app = new Hono();
    app.route(
      "/",
      createGitHubWebhookHandler({
        webhookSecret: WEBHOOK_SECRET,
        runner: {} as any,
        pipelineConfigs: { "auto-implement": pipelineConfig },
        repoConfigs: {},
        db: db as any,
        github: GITHUB_CONFIG,
      }),
    );

    await postGitHubWebhook(app, "check_suite", checkSuitePayload(6, prBranch, prUrl));

    expect(mockMergePR).not.toHaveBeenCalled();
    const rows = await db.select().from(pipelineRuns).where();
    expect(rows[0].autoMergeReason).toMatch(/develop/);
  });

  // ---------------------------------------------------------------------------
  // 7. No GitHub credentials → skip without error
  // ---------------------------------------------------------------------------
  it("skips automerge when no GitHub App credentials are configured", async () => {
    const prUrl = "https://github.com/test/repo/pull/7";
    const prBranch = "agent/BEC-117-no-creds";

    await db.insert(pipelineRuns).values({
      id: "run-007",
      issueId: "BEC-117-NC",
      issueTitle: "NoCreds Feature",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: prBranch,
      status: "completed",
      prUrl,
      startedAt: new Date(),
    });

    const pipelineConfig = makeAutoMergePipelineConfig();
    const app = new Hono();
    app.route(
      "/",
      createGitHubWebhookHandler({
        webhookSecret: WEBHOOK_SECRET,
        runner: {} as any,
        pipelineConfigs: { "auto-implement": pipelineConfig },
        repoConfigs: {},
        db: db as any,
        // no github credentials
      }),
    );

    const { status } = await postGitHubWebhook(
      app,
      "check_suite",
      checkSuitePayload(7, prBranch, prUrl),
    );

    expect(status).toBe(200);
    expect(mockMergePR).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 8. No autoMergeConfig in pipeline → skip
  // ---------------------------------------------------------------------------
  it("skips automerge when pipeline has no autoMergeConfig", async () => {
    const prUrl = "https://github.com/test/repo/pull/8";
    const prBranch = "agent/BEC-117-no-config";

    await db.insert(pipelineRuns).values({
      id: "run-008",
      issueId: "BEC-117-NP",
      issueTitle: "NoPipeline Feature",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: prBranch,
      status: "completed",
      prUrl,
      startedAt: new Date(),
    });

    // Pipeline config without autoMergeConfig
    const pipelineConfig: PipelineConfig = {
      name: "Auto Implement",
      stages: ["implement"],
      retry: { maxAttempts: 0, strategy: "fail-fast" },
      review: { requiredApprovals: 0 },
      prStrategy: "ready",
    };

    const app = new Hono();
    app.route(
      "/",
      createGitHubWebhookHandler({
        webhookSecret: WEBHOOK_SECRET,
        runner: {} as any,
        pipelineConfigs: { "auto-implement": pipelineConfig },
        repoConfigs: {},
        db: db as any,
        github: GITHUB_CONFIG,
      }),
    );

    await postGitHubWebhook(app, "check_suite", checkSuitePayload(8, prBranch, prUrl));

    expect(mockMergePR).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 9. pull_request.labeled event also triggers automerge check
  // ---------------------------------------------------------------------------
  it("triggers automerge on pull_request.labeled event", async () => {
    const prUrl = "https://github.com/test/repo/pull/9";
    const prBranch = "agent/BEC-117-labeled";

    await db.insert(pipelineRuns).values({
      id: "run-009",
      issueId: "BEC-117-PL",
      issueTitle: "Labeled Feature",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: prBranch,
      status: "completed",
      prUrl,
      startedAt: new Date(),
    });

    const pipelineConfig = makeAutoMergePipelineConfig();
    const app = new Hono();
    app.route(
      "/",
      createGitHubWebhookHandler({
        webhookSecret: WEBHOOK_SECRET,
        runner: {} as any,
        pipelineConfigs: { "auto-implement": pipelineConfig },
        repoConfigs: {},
        db: db as any,
        github: GITHUB_CONFIG,
      }),
    );

    const payload = {
      action: "labeled",
      label: { name: "automerge" },
      pull_request: {
        number: 9,
        html_url: prUrl,
        draft: false,
        head: { ref: prBranch, sha: "abc123" },
        base: { ref: "main" },
        labels: [{ name: "automerge" }],
      },
      repository: { name: "repo", owner: { login: "test" } },
    };

    await postGitHubWebhook(app, "pull_request", payload);

    expect(mockMergePR).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 10. status event with agent/ branch → triggers automerge (BEC-200)
  // ---------------------------------------------------------------------------
  it("triggers automerge on status event with agent/ branch via branch lookup", async () => {
    const prBranch = "agent/BEC-200-status-test";
    const prUrl = "https://github.com/test/repo/pull/99";

    // Seed a completed pipeline run for this branch
    await db.insert(pipelineRuns).values({
      id: "run-status-bec200",
      issueId: "BEC-200-ST",
      issueTitle: "Status Event Test",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: prBranch,
      status: "completed",
      prUrl,
      startedAt: new Date(),
    });

    // Mock PR list lookup by branch (used when prNumber is 0)
    mockPullsList.mockResolvedValue({
      data: [
        {
          number: 99,
          html_url: prUrl,
          head: { ref: prBranch, sha: "deadbeef" },
        },
      ],
    });

    const pipelineConfig = makeAutoMergePipelineConfig();
    const app = new Hono();
    app.route(
      "/",
      createGitHubWebhookHandler({
        webhookSecret: WEBHOOK_SECRET,
        runner: {} as any,
        pipelineConfigs: { "auto-implement": pipelineConfig },
        repoConfigs: {},
        db: db as any,
        github: GITHUB_CONFIG,
      }),
    );

    // GitHub status event — branches array contains the agent branch
    const statusPayload = {
      state: "success",
      branches: [{ name: prBranch }],
      repository: { name: "repo", owner: { login: "test" } },
    };

    const { status } = await postGitHubWebhook(app, "status", statusPayload);

    expect(status).toBe(200);

    // Automerge flow fired: merge API was called
    expect(mockMergePR).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "test",
        repo: "repo",
        pull_number: 99,
        merge_method: "squash",
      }),
    );

    // DB row updated
    const rows = await db.select().from(pipelineRuns).where();
    expect(rows[0].autoMerged).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // 11. Branch protection prevents merge (405)
  // ---------------------------------------------------------------------------
  it("handles branch protection preventing merge gracefully", async () => {
    mockMergePR.mockRejectedValue(Object.assign(new Error("Required status check failed"), { status: 405 }));

    const prUrl = "https://github.com/test/repo/pull/10";
    const prBranch = "agent/BEC-117-protected";

    await db.insert(pipelineRuns).values({
      id: "run-010",
      issueId: "BEC-117-P",
      issueTitle: "Protected Branch Feature",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: prBranch,
      status: "completed",
      prUrl,
      startedAt: new Date(),
    });

    const pipelineConfig = makeAutoMergePipelineConfig();
    const app = new Hono();
    app.route(
      "/",
      createGitHubWebhookHandler({
        webhookSecret: WEBHOOK_SECRET,
        runner: {} as any,
        pipelineConfigs: { "auto-implement": pipelineConfig },
        repoConfigs: {},
        db: db as any,
        github: GITHUB_CONFIG,
      }),
    );

    const { status } = await postGitHubWebhook(
      app,
      "check_suite",
      checkSuitePayload(10, prBranch, prUrl),
    );

    expect(status).toBe(200); // Handler should not crash

    const rows = await db.select().from(pipelineRuns).where();
    expect(rows[0].autoMerged).toBeFalsy();
    expect(rows[0].autoMergeReason).toMatch(/[Bb]ranch protection/);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for checkAutoMergeEligibility
// ---------------------------------------------------------------------------

describe("checkAutoMergeEligibility unit tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPullsGet.mockResolvedValue({
      data: {
        draft: false,
        merged: false,
        state: "open",
        base: { ref: "main" },
        head: { sha: "abc123" },
        labels: [],
      },
    });
  });

  /**
   * Build a minimal Octokit-shaped mock that delegates to the module-level
   * mock functions.  This avoids calling `new Octokit()` (which bypasses
   * vi.mock when used via require() inside a function) and keeps the test
   * behaviour deterministic.
   */
  function makeOctokit() {
    return {
      pulls: { get: mockPullsGet, listReviews: mockListReviews, merge: mockMergePR, list: mockPullsList },
      repos: { getCombinedStatusForRef: mockGetCombinedStatus },
      checks: { listForRef: mockChecksListForRef },
    } as any;
  }

  it("returns eligible when no criteria are configured", async () => {
    const result = await checkAutoMergeEligibility(makeOctokit(), "owner", "repo", 1, {});
    expect(result.eligible).toBe(true);
  });

  it("returns ineligible for draft PRs", async () => {
    mockPullsGet.mockResolvedValue({
      data: { draft: true, merged: false, state: "open", base: { ref: "main" }, head: { sha: "x" }, labels: [] },
    });
    const result = await checkAutoMergeEligibility(makeOctokit(), "owner", "repo", 1, {});
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/draft/i);
  });

  it("returns ineligible for already-merged PRs", async () => {
    mockPullsGet.mockResolvedValue({
      data: { draft: false, merged: true, state: "closed", base: { ref: "main" }, head: { sha: "x" }, labels: [] },
    });
    const result = await checkAutoMergeEligibility(makeOctokit(), "owner", "repo", 1, {});
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/merged/i);
  });

  it("returns ineligible when required label is absent", async () => {
    mockPullsGet.mockResolvedValue({
      data: { draft: false, merged: false, state: "open", base: { ref: "main" }, head: { sha: "x" }, labels: [] },
    });
    const result = await checkAutoMergeEligibility(makeOctokit(), "owner", "repo", 1, {
      requiredLabels: ["ready-to-merge"],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/ready-to-merge/);
  });

  it("returns ineligible when base branch is not allowed", async () => {
    mockPullsGet.mockResolvedValue({
      data: { draft: false, merged: false, state: "open", base: { ref: "dev" }, head: { sha: "x" }, labels: [] },
    });
    const result = await checkAutoMergeEligibility(makeOctokit(), "owner", "repo", 1, {
      allowedBranches: ["main"],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/dev/);
  });

  it("counts approvals correctly — only APPROVED state counts", async () => {
    mockListReviews.mockResolvedValue({
      data: [
        { user: { id: 1 }, state: "APPROVED" },
        { user: { id: 2 }, state: "CHANGES_REQUESTED" },
        { user: { id: 3 }, state: "COMMENTED" },
      ],
    });
    // Only 1 approver out of 3 reviews
    const result = await checkAutoMergeEligibility(makeOctokit(), "owner", "repo", 1, {
      minimumApprovingReviews: 2,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/1 approving/);
  });

  it("uses latest review per reviewer when counting approvals", async () => {
    // User 1 approved then requested changes → not counted as approved
    mockListReviews.mockResolvedValue({
      data: [
        { user: { id: 1 }, state: "APPROVED" },
        { user: { id: 1 }, state: "CHANGES_REQUESTED" },
        { user: { id: 2 }, state: "APPROVED" },
      ],
    });
    const result = await checkAutoMergeEligibility(makeOctokit(), "owner", "repo", 1, {
      minimumApprovingReviews: 2,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/1 approving/);
  });

  it("passes when required status check is present and successful", async () => {
    mockGetCombinedStatus.mockResolvedValue({
      data: { statuses: [{ context: "ci/tests", state: "success" }] },
    });
    const result = await checkAutoMergeEligibility(makeOctokit(), "owner", "repo", 1, {
      requiredStatusChecks: ["ci/tests"],
    });
    expect(result.eligible).toBe(true);
  });

  it("returns ineligible when required check run has not passed", async () => {
    mockChecksListForRef.mockResolvedValue({
      data: { check_runs: [{ name: "ci/tests", conclusion: "failure" }] },
    });
    const result = await checkAutoMergeEligibility(makeOctokit(), "owner", "repo", 1, {
      requiredStatusChecks: ["ci/tests"],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/ci\/tests/);
  });
});

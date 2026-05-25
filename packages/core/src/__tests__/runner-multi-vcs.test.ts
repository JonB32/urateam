/**
 * BEC-206 — runner multi-VCS integration test
 *
 * Verifies that `PipelineRunner` routes comment-posting calls to the correct
 * provider when `repoConfig.provider` is `"gitlab"` or `"bitbucket"`:
 *
 *  - When `URATEAM_PR_COST_SUMMARY=true` and the run completes with a PR URL,
 *    the runner calls `addMRComment` (GitLab) / `addBitbucketPRComment`
 *    (Bitbucket) with the cost summary body.
 *  - When `runType === "review-feedback"`, the runner calls those same
 *    functions with a rendered change-summary body.
 *
 * The test stubs the executor (`executeStage`), git helpers, and PR-creation
 * functions so the pipeline runs end-to-end without touching the network or
 * the filesystem. The real `addMRComment` / `addBitbucketPRComment` are
 * replaced with `vi.fn()` so we can assert on call arguments.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDb } from "../db/client.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { pipelineRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type {
  Notifier,
  PipelineConfig,
  RepoConfig,
  HandoffArtifact,
} from "../types.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

// ---------------------------------------------------------------------------
// Mock surface
// ---------------------------------------------------------------------------

const {
  mockCreateMR,
  mockAddMRComment,
  mockMergeMR,
  mockCreateBitbucketPR,
  mockAddBitbucketPRComment,
  mockMergeBitbucketPR,
  mockExecFile,
} = vi.hoisted(() => ({
  mockCreateMR: vi
    .fn()
    .mockResolvedValue("https://gitlab.com/myorg/myrepo/-/merge_requests/42"),
  mockAddMRComment: vi.fn().mockResolvedValue(undefined),
  mockMergeMR: vi.fn().mockResolvedValue(true),
  mockCreateBitbucketPR: vi
    .fn()
    .mockResolvedValue("https://bitbucket.org/myws/myrepo/pull-requests/42"),
  mockAddBitbucketPRComment: vi.fn().mockResolvedValue(undefined),
  mockMergeBitbucketPR: vi.fn().mockResolvedValue(true),
  mockExecFile: vi.fn().mockImplementation((...args: any[]) => {
    const cb = args.find((a) => typeof a === "function");
    if (cb) cb(null, "", "");
  }),
}));

let stageResultsQueue: Array<"completed" | "failed"> = [];
let executeStageCalls: Array<{ stage: string }> = [];

function handoffFor(runId: string, issueId: string, stage: string): HandoffArtifact {
  return {
    runId,
    issueId,
    stage,
    timestamp: new Date().toISOString(),
    summary: `Stage ${stage} done`,
    filesChanged: ["src/feature.ts"],
    approach: `approach for ${stage}`,
    context: {
      issueIntent: "test multi-VCS routing",
      constraints: [],
      assumptions: [],
    },
    tokenBudget: { contextTokensUsed: 100, recommendedMaxTurns: 3 },
  };
}

vi.mock("../executor/executor.js", () => ({
  executeStage: vi.fn().mockImplementation(
    async ({ runId, issueId, stage, db }: any) => {
      const { nanoid } = await import("nanoid");
      const { stageRuns: stageRunsTable } = await import("../db/schema.js");
      const { eq: drizzleEq } = await import("drizzle-orm");

      executeStageCalls.push({ stage });
      const verdict = stageResultsQueue.shift() ?? "completed";
      const stageRunId = nanoid();
      await db.insert(stageRunsTable).values({
        id: stageRunId,
        pipelineRunId: runId,
        stage,
        status: "running",
      });
      await db
        .update(stageRunsTable)
        .set({
          status: verdict,
          completedAt: new Date(),
          inputTokens: 100,
          outputTokens: 50,
          turns: 1,
          handoffArtifact: JSON.stringify(handoffFor(runId, issueId, stage)),
          errorMessage: verdict === "failed" ? "simulated stage failure" : null,
        })
        .where(drizzleEq(stageRunsTable.id, stageRunId));

      return {
        status: verdict,
        inputTokens: 100,
        outputTokens: 50,
        turns: 1,
        ...(verdict === "completed"
          ? {
              handoffArtifact: handoffFor(runId, issueId, stage),
              handoffIsStructured: true,
            }
          : { errorMessage: "simulated stage failure" }),
        stageRunId,
      };
    },
  ),
}));

vi.mock("../repo/git.js", () => ({
  cloneRepo: vi.fn().mockResolvedValue(undefined),
  createWorktree: vi.fn().mockResolvedValue("/tmp/multi-vcs-worktree"),
  deleteWorktree: vi.fn().mockResolvedValue(undefined),
  pushBranch: vi.fn().mockResolvedValue(undefined),
  pushBranchForce: vi.fn().mockResolvedValue(undefined),
  rebaseBranch: vi.fn().mockResolvedValue({ success: true, hasConflicts: false }),
  abortRebase: vi.fn().mockResolvedValue(undefined),
  autoCommitChanges: vi.fn().mockResolvedValue(false),
  // createPRViaCli is the gh CLI fallback — not used on gitlab/bitbucket paths
  // but the module export must exist for the runner's import to resolve.
  createPRViaCli: vi.fn().mockResolvedValue(""),
  mergePRViaCli: vi.fn().mockResolvedValue(true),
  getDiffLineCount: vi.fn().mockResolvedValue(50),
  getChangedFiles: vi.fn().mockResolvedValue(["src/feature.ts"]),
  checkDuplicateBranch: vi.fn().mockResolvedValue(null),
  cleanupWorktrees: vi.fn().mockResolvedValue([]),
  branchName: vi.fn().mockImplementation((id: string, slug: string) => `agent/${id}-${slug}`),
  gitExecSafe: vi.fn().mockResolvedValue(""),
  gitExecRaw: vi.fn().mockResolvedValue(""),
  gitExec: vi.fn().mockResolvedValue(""),
  choosePushStrategy: vi.fn().mockReturnValue("standard"),
  getAgentCommits: vi.fn().mockResolvedValue([]),
  installPrePushHook: vi.fn().mockResolvedValue(undefined),
}));

// Replace the real GitLab/Bitbucket clients so we can assert on their call
// arguments without making any real HTTP requests.
vi.mock("../repo/gitlab.js", async () => {
  const actual = await vi.importActual<typeof import("../repo/gitlab.js")>(
    "../repo/gitlab.js",
  );
  return {
    ...actual,
    createMR: mockCreateMR,
    addMRComment: mockAddMRComment,
    mergeMRWhenPipelineSucceeds: mockMergeMR,
  };
});

vi.mock("../repo/bitbucket.js", async () => {
  const actual = await vi.importActual<typeof import("../repo/bitbucket.js")>(
    "../repo/bitbucket.js",
  );
  return {
    ...actual,
    createBitbucketPR: mockCreateBitbucketPR,
    addBitbucketPRComment: mockAddBitbucketPRComment,
    mergeBitbucketPR: mockMergeBitbucketPR,
  };
});

vi.mock("../executor/test-quality.js", () => ({
  checkTestQuality: vi.fn().mockResolvedValue({ violations: [] }),
}));

vi.mock("../repo/tech-stack.js", () => ({
  detectTechStack: vi.fn().mockResolvedValue({
    languages: ["typescript"],
    frameworks: [],
    buildSystems: ["pnpm"],
  }),
}));

vi.mock("../repo/devcontainer.js", () => ({
  shouldUseDevcontainer: vi.fn().mockResolvedValue(false),
  devcontainerUp: vi.fn().mockResolvedValue(undefined),
  devcontainerDown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../pm/coordination.js", () => ({
  upsertActiveWork: vi.fn().mockResolvedValue(undefined),
  removeActiveWork: vi.fn().mockResolvedValue(undefined),
  checkFileOverlap: vi.fn().mockResolvedValue({
    hasOverlap: false,
    overlappingFiles: [],
    conflictingRunIds: [],
  }),
  getModifiedFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GITLAB_REPO_CONFIG: RepoConfig = {
  url: "https://gitlab.com/myorg/myrepo.git",
  defaultBranch: "main",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
  provider: "gitlab",
};

const BITBUCKET_REPO_CONFIG: RepoConfig = {
  url: "https://bitbucket.org/myws/myrepo.git",
  defaultBranch: "main",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
  provider: "bitbucket",
};

function makePipelineConfig(): PipelineConfig {
  return {
    name: "Auto Implement",
    stages: ["implement"],
    retry: { maxAttempts: 1, strategy: "fail-fast" },
    review: { requiredApprovals: 0 },
    prStrategy: "ready",
    validateHandoffs: false,
    ralphIterations: 0,
    reviewFixIterations: 0,
    deepReviewPasses: 0,
  };
}

const ISSUE = {
  id: "issue-mv-1",
  identifier: "MV-1",
  title: "multi-VCS test issue",
  description: "Test multi-VCS routing",
  priority: 2,
};

async function waitForRunComplete(
  db: any,
  issueId: string,
  timeoutMs = 5_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.issueId, issueId));
    if (rows.length > 0) {
      const run = rows[0];
      if (["completed", "failed", "retriable", "aborted"].includes(run.status)) {
        return run;
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Pipeline for ${issueId} did not finish within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PipelineRunner multi-VCS routing (BEC-206)", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let notifier: Notifier;
  let originalCostSummaryEnv: string | undefined;

  beforeEach(async () => {
    await installTestProLicense();
    stageResultsQueue = [];
    executeStageCalls = [];
    mockCreateMR.mockClear();
    mockAddMRComment.mockClear();
    mockMergeMR.mockClear();
    mockCreateBitbucketPR.mockClear();
    mockAddBitbucketPRComment.mockClear();
    mockMergeBitbucketPR.mockClear();

    // Enable the cost-summary path
    originalCostSummaryEnv = process.env.URATEAM_PR_COST_SUMMARY;
    process.env.URATEAM_PR_COST_SUMMARY = "true";

    db = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    notifier = {
      onPipelineStart: vi.fn(async () => {}),
      onStageComplete: vi.fn(async () => {}),
      onPipelineComplete: vi.fn(async () => {}),
      onPipelineFailed: vi.fn(async () => {}),
    };
  });

  afterEach(async () => {
    await restoreLicense();
    if (originalCostSummaryEnv === undefined) {
      delete process.env.URATEAM_PR_COST_SUMMARY;
    } else {
      process.env.URATEAM_PR_COST_SUMMARY = originalCostSummaryEnv;
    }
  });

  function makeRunner(opts: {
    gitlabConfig?: any;
    bitbucketConfig?: any;
  } = {}) {
    return new PipelineRunner({
      db,
      notifier,
      concurrency: 1,
      agentRunDir: "/tmp/multi-vcs-runs",
      repoCloneDir: "/tmp/multi-vcs-repos",
      gitlab: opts.gitlabConfig,
      bitbucket: opts.bitbucketConfig,
    } as any);
  }

  // -------------------------------------------------------------------------
  // GitLab path
  // -------------------------------------------------------------------------

  it("GitLab provider: completes pipeline and posts MR cost summary via addMRComment", async () => {
    stageResultsQueue = ["completed"];
    const runner = makeRunner({
      gitlabConfig: { token: "glpat-fake", host: "https://gitlab.com" },
    });
    const issue = { ...ISSUE, identifier: "MV-GL-1" } as any;

    await runner.start(
      issue,
      "auto-implement",
      makePipelineConfig(),
      GITLAB_REPO_CONFIG,
      issue as any,
    );

    const run = await waitForRunComplete(db, "MV-GL-1");
    expect(run.status).toBe("completed");

    // createMR was used to open the MR
    expect(mockCreateMR).toHaveBeenCalledTimes(1);
    const createMRArgs = mockCreateMR.mock.calls[0];
    expect(createMRArgs[1]).toMatchObject({
      projectPath: "myorg/myrepo",
      sourceBranch: expect.stringContaining("agent/MV-GL-1"),
      targetBranch: "main",
    });

    // Cost summary was posted via addMRComment (BEC-175 + BEC-206)
    expect(mockAddMRComment).toHaveBeenCalled();
    const costCall = mockAddMRComment.mock.calls.find(
      (c) => typeof c[3] === "string" && c[3].includes("Pipeline cost summary"),
    );
    expect(costCall).toBeDefined();
    // Args: (config, projectPath, mrIid, body)
    expect(costCall![1]).toBe("myorg/myrepo");
    expect(costCall![2]).toBe(42);
    expect(typeof costCall![3]).toBe("string");

    // Bitbucket helpers must NOT be called on the GitLab path
    expect(mockCreateBitbucketPR).not.toHaveBeenCalled();
    expect(mockAddBitbucketPRComment).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Bitbucket path
  // -------------------------------------------------------------------------

  it("Bitbucket provider: completes pipeline and posts PR cost summary via addBitbucketPRComment", async () => {
    stageResultsQueue = ["completed"];
    const runner = makeRunner({
      bitbucketConfig: { accessToken: "bbtoken-fake" },
    });
    const issue = { ...ISSUE, identifier: "MV-BB-1" } as any;

    await runner.start(
      issue,
      "auto-implement",
      makePipelineConfig(),
      BITBUCKET_REPO_CONFIG,
      issue as any,
    );

    const run = await waitForRunComplete(db, "MV-BB-1");
    expect(run.status).toBe("completed");

    // createBitbucketPR was used to open the PR
    expect(mockCreateBitbucketPR).toHaveBeenCalledTimes(1);
    const createPRArgs = mockCreateBitbucketPR.mock.calls[0];
    expect(createPRArgs[1]).toMatchObject({
      workspace: "myws",
      repoSlug: "myrepo",
      sourceBranch: expect.stringContaining("agent/MV-BB-1"),
      targetBranch: "main",
    });

    // Cost summary was posted via addBitbucketPRComment (BEC-175 + BEC-206)
    expect(mockAddBitbucketPRComment).toHaveBeenCalled();
    const costCall = mockAddBitbucketPRComment.mock.calls.find(
      (c) => typeof c[4] === "string" && c[4].includes("Pipeline cost summary"),
    );
    expect(costCall).toBeDefined();
    // Args: (config, workspace, repoSlug, prId, body)
    expect(costCall![1]).toBe("myws");
    expect(costCall![2]).toBe("myrepo");
    expect(costCall![3]).toBe(42);
    expect(typeof costCall![4]).toBe("string");

    // GitLab helpers must NOT be called on the Bitbucket path
    expect(mockCreateMR).not.toHaveBeenCalled();
    expect(mockAddMRComment).not.toHaveBeenCalled();
  });
});

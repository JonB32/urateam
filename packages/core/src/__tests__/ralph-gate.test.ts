/**
 * RALPH gate and draft PR behavior tests — BEC-97
 *
 * Tests the RALPH gate logic and draft PR decision in the pipeline runner:
 *   1. RALPH satisfied on first check → ready PR
 *   2. RALPH satisfied on second check (after re-implement) → ready PR
 *   3. RALPH exhausted (all iterations fail) → draft PR with gap comments
 *   4. Review-fix loop with blocking findings resolved → ready PR
 *   5. Review-fix loop with blocking findings remaining → draft PR
 *   6. shouldDraft computation after deep review introduces new findings → draft PR
 *   7. Draft PR skips auto-merge even when autoMerge: true
 *   8. PR comment construction — gap analysis and next steps are included
 *
 * Uses the same mock strategy as auto-merge.test.ts: mocks git operations,
 * executor, RALPH, and deep-review at the module level, then drives the
 * pipeline through the webhook handler to exercise the full runner code path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { createDb } from "../db/client.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { createWebhookHandler } from "../webhook/handler.js";
import { pipelineRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type {
  Notifier,
  PipelineRun,
  PipelineConfig,
  RepoConfig,
  HandoffArtifact,
  ReviewFinding,
} from "../types.js";
import type { DeepReviewFinding } from "../executor/deep-review.js";
import { _resetLicenseCache } from "../license.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// vi.hoisted ensures these are available when vi.mock factories run (which
// are hoisted above all other code by Vitest).
const {
  mockCreatePRViaCli,
  mockMergePRViaCli,
  mockGetDiffLineCount,
  mockGetChangedFiles,
  mockCheckRequirements,
  mockExecFile,
  mockRunDeepReview,
} = vi.hoisted(() => ({
  mockCreatePRViaCli: vi
    .fn()
    .mockResolvedValue("https://github.com/test/repo/pull/42"),
  mockMergePRViaCli: vi.fn().mockResolvedValue(true),
  mockGetDiffLineCount: vi.fn().mockResolvedValue(50),
  mockGetChangedFiles: vi.fn().mockResolvedValue(["src/feature.ts"]),
  mockCheckRequirements: vi
    .fn()
    .mockResolvedValue({ satisfied: true, gaps: [], suggestions: [] }),
  mockExecFile: vi.fn().mockImplementation((...args: any[]) => {
    const cb = args.find((a) => typeof a === "function");
    if (cb) cb(null, "", "");
  }),
  mockRunDeepReview: vi.fn().mockResolvedValue({
    findings: [] as DeepReviewFinding[],
    inputTokens: 100,
    outputTokens: 50,
  }),
}));

// Queue of findings for successive review-stage calls. Each test populates
// this array; the executeStage mock shifts one entry per review call.
let reviewFindingsQueue: Array<ReviewFinding[] | undefined> = [];

// ---------------------------------------------------------------------------
// Shared fixture factory
// ---------------------------------------------------------------------------

function makeHandoffArtifact(
  runId: string,
  issueId: string,
  stage: string,
  reviewFindings?: ReviewFinding[],
): HandoffArtifact {
  return {
    runId,
    issueId,
    stage,
    timestamp: new Date().toISOString(),
    summary: `Completed ${stage} stage successfully`,
    filesChanged: ["src/feature.ts"],
    approach: `Standard ${stage} approach`,
    context: {
      issueIntent: "Add user search functionality",
      constraints: ["Must not break existing tests"],
      assumptions: ["Input is sanitised upstream"],
      ...(reviewFindings ? { reviewFindings } : {}),
    },
    tokenBudget: { contextTokensUsed: 150, recommendedMaxTurns: 5 },
  };
}

// ---------------------------------------------------------------------------
// vi.mock calls (hoisted by Vitest above all imports)
// ---------------------------------------------------------------------------

vi.mock("../executor/executor.js", () => ({
  executeStage: vi.fn().mockImplementation(
    async ({
      runId,
      issueId,
      stage,
      db,
    }: {
      runId: string;
      issueId: string;
      stage: string;
      db: any;
    }) => {
      const { nanoid } = await import("nanoid");
      const { stageRuns: stageRunsTable } = await import("../db/schema.js");
      const { eq: drizzleEq } = await import("drizzle-orm");
      const stageRunId = nanoid();

      // For the review stage, consume the next entry from the findings queue.
      // This lets individual tests control what each successive review call returns.
      let findings: ReviewFinding[] | undefined;
      if (stage === "review" && reviewFindingsQueue.length > 0) {
        findings = reviewFindingsQueue.shift();
      }

      await db.insert(stageRunsTable).values({
        id: stageRunId,
        pipelineRunId: runId,
        stage,
        status: "running",
      });
      await db
        .update(stageRunsTable)
        .set({
          status: "completed",
          completedAt: new Date(),
          inputTokens: 200,
          outputTokens: 100,
          turns: 2,
          handoffArtifact: JSON.stringify(
            makeHandoffArtifact(runId, issueId, stage, findings),
          ),
        })
        .where(drizzleEq(stageRunsTable.id, stageRunId));

      return {
        status: "completed",
        inputTokens: 200,
        outputTokens: 100,
        turns: 2,
        handoffArtifact: makeHandoffArtifact(runId, issueId, stage, findings),
        handoffIsStructured: true,
      };
    },
  ),
}));

// Keep in sync with git.js/executor exports — add new exports here when they are added to the module
vi.mock("../repo/git.js", () => ({
  cloneRepo: vi.fn().mockResolvedValue(undefined),
  createWorktree: vi.fn().mockResolvedValue("/tmp/ralph-gate-test-worktree"),
  deleteWorktree: vi.fn().mockResolvedValue(undefined),
  pushBranch: vi.fn().mockResolvedValue(undefined),
  pushBranchForce: vi.fn().mockResolvedValue(undefined),
  rebaseBranch: vi
    .fn()
    .mockResolvedValue({ success: true, hasConflicts: false }),
  abortRebase: vi.fn().mockResolvedValue(undefined),
  autoCommitChanges: vi.fn().mockResolvedValue(false),
  createPRViaCli: mockCreatePRViaCli,
  mergePRViaCli: mockMergePRViaCli,
  getDiffLineCount: mockGetDiffLineCount,
  getChangedFiles: mockGetChangedFiles,
  checkDuplicateBranch: vi.fn().mockResolvedValue(null),
  cleanupWorktrees: vi.fn().mockResolvedValue([]),
  branchName: vi
    .fn()
    .mockImplementation(
      (identifier: string, slug: string) => `agent/${identifier}-${slug}`,
    ),
  gitExecSafe: vi.fn().mockResolvedValue(""),
  gitExecRaw: vi.fn().mockResolvedValue(""),
  gitExec: vi.fn().mockResolvedValue(""),
  choosePushStrategy: vi.fn().mockReturnValue("standard"),
  getAgentCommits: vi.fn().mockResolvedValue([]),
  installPrePushHook: vi.fn().mockResolvedValue(undefined),
}));

// Keep in sync with git.js/executor exports — add new exports here when they are added to the module
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

vi.mock("../executor/ralph.js", () => ({
  checkRequirements: mockCheckRequirements,
  buildRalphContext: vi
    .fn()
    .mockReturnValue("<ralph-iteration>mock ralph context</ralph-iteration>"),
}));

// Partial mock: replace only runDeepReview, keep helper functions real
// (deepFindingsToReviewFindings, buildDeepReviewContext, etc.)
vi.mock("../executor/deep-review.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../executor/deep-review.js")>();
  return {
    ...actual,
    runDeepReview: mockRunDeepReview,
  };
});

// Mock node:child_process so the "gh pr comment" call in the runner is
// interceptable (for PR comment content assertions in test 8).
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "test-ralph-gate-secret";

function signPayload(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

let issueCounter = 0;

function buildPayload(identifier?: string): string {
  const id = identifier ?? `RG-${++issueCounter}`;
  return JSON.stringify({
    action: "update",
    type: "Issue",
    data: {
      id: `issue-uuid-${id}`,
      identifier: id,
      title: "RALPH gate test issue",
      description:
        "Implement a new feature.\n\n## Acceptance Criteria\n- [ ] Feature is implemented\n- [ ] Tests pass",
      priority: 2,
      state: { id: "state-todo-uuid", name: "Todo" },
      teamId: "team-rg",
      labels: [{ name: "auto-implement" }],
    },
    updatedFrom: { stateId: "state-backlog-uuid" },
  });
}

async function postWebhook(
  app: Hono,
  body: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const sig = signPayload(body);
  const res = await app.fetch(
    new Request("http://localhost/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Signature": sig,
      },
      body,
    }),
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

async function waitForPipeline(
  db: Awaited<ReturnType<typeof createDb>>,
  issueId: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.issueId, issueId));
    if (rows.length > 0) {
      const run = rows[0] as Record<string, unknown>;
      if (
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "aborted"
      ) {
        return run;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `Pipeline for issue ${issueId} did not complete within ${timeoutMs}ms`,
  );
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const REPO_CONFIG: RepoConfig = {
  url: "https://github.com/test/test-repo.git",
  defaultBranch: "main",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
};

function makePipelineConfig(
  overrides: Partial<PipelineConfig> = {},
): PipelineConfig {
  return {
    name: "Auto Implement",
    stages: ["implement"],
    retry: { maxAttempts: 0, strategy: "fail-fast" },
    review: { requiredApprovals: 0 },
    prStrategy: "ready",
    validateHandoffs: false,
    ralphIterations: 0,
    reviewFixIterations: 0,
    deepReviewPasses: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RALPH gate and draft PR behavior", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let notifier: Notifier;
  let humanReviewCalls: Array<{
    run: PipelineRun;
    prUrl: string;
    reason: string;
  }>;

  beforeEach(async () => {
    // Enable commercial features for tests that exercise them
    process.env.URATEAM_LICENSE_KEY = "test-license-key";
    _resetLicenseCache();

    // Reset all mocks to known state
    mockCheckRequirements
      .mockReset()
      .mockResolvedValue({ satisfied: true, gaps: [], suggestions: [] });
    mockCreatePRViaCli
      .mockReset()
      .mockResolvedValue("https://github.com/test/repo/pull/42");
    mockMergePRViaCli.mockReset().mockResolvedValue(true);
    mockGetDiffLineCount.mockReset().mockResolvedValue(50);
    mockGetChangedFiles.mockReset().mockResolvedValue(["src/feature.ts"]);
    mockExecFile.mockReset().mockImplementation((...args: any[]) => {
      const cb = args.find((a) => typeof a === "function");
      if (cb) cb(null, "", "");
    });
    mockRunDeepReview.mockReset().mockResolvedValue({
      findings: [] as DeepReviewFinding[],
      inputTokens: 100,
      outputTokens: 50,
    });
    reviewFindingsQueue = [];
    humanReviewCalls = [];

    db = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    notifier = {
      onPipelineStart: vi.fn(async () => {}),
      onStageComplete: vi.fn(async () => {}),
      onPipelineComplete: vi.fn(async () => {}),
      onPipelineFailed: vi.fn(async () => {}),
      onHumanReviewNeeded: vi.fn(async (run, prUrl, reason) => {
        humanReviewCalls.push({ run, prUrl, reason });
      }),
    };
  });

  function buildApp(pipelineConfig: PipelineConfig): Hono {
    const runner = new PipelineRunner({
      db,
      notifier,
      concurrency: 2,
      agentRunDir: "/tmp/ralph-gate-agent-runs",
      repoCloneDir: "/tmp/ralph-gate-repos",
    });

    const app = new Hono();
    const webhookApp = createWebhookHandler({
      webhookSecret: WEBHOOK_SECRET,
      runner,
      pipelineConfigs: { "auto-implement": pipelineConfig },
      repoConfigs: { "team-rg": REPO_CONFIG },
    });
    app.route("/", webhookApp);
    return app;
  }

  // ---------------------------------------------------------------------------
  // 1. RALPH satisfied on first check → ready PR
  // ---------------------------------------------------------------------------
  it("RALPH satisfied on first check results in ready PR", async () => {
    // checkRequirements returns satisfied immediately
    mockCheckRequirements.mockResolvedValue({
      satisfied: true,
      gaps: [],
      suggestions: [],
    });

    const config = makePipelineConfig({ ralphIterations: 2 });
    const app = buildApp(config);
    const issueId = `RG-${++issueCounter}`;

    await postWebhook(app, buildPayload(issueId));
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    // RALPH should have been consulted exactly once (first iteration satisfied)
    expect(mockCheckRequirements).toHaveBeenCalledTimes(1);
    // PR must be created as ready (not draft)
    expect(mockCreatePRViaCli).toHaveBeenCalledTimes(1);
    expect(mockCreatePRViaCli.mock.calls[0][0].draft).toBe(false);
    // No human review notification for a ready PR
    expect(humanReviewCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 2. RALPH satisfied on second check (after re-implement) → ready PR
  // ---------------------------------------------------------------------------
  it("RALPH satisfied on second check after re-implement results in ready PR", async () => {
    // First check finds gaps; second check (after re-implement) is satisfied
    mockCheckRequirements
      .mockResolvedValueOnce({
        satisfied: false,
        gaps: ["Pagination not implemented"],
        suggestions: ["Add limit/offset query params"],
      })
      .mockResolvedValueOnce({
        satisfied: true,
        gaps: [],
        suggestions: [],
      });

    const config = makePipelineConfig({ ralphIterations: 2 });
    const app = buildApp(config);
    const issueId = `RG-${++issueCounter}`;

    await postWebhook(app, buildPayload(issueId));
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    // Two RALPH checks: first unsatisfied, second satisfied
    expect(mockCheckRequirements).toHaveBeenCalledTimes(2);
    // PR must be ready because RALPH eventually passed
    expect(mockCreatePRViaCli).toHaveBeenCalledTimes(1);
    expect(mockCreatePRViaCli.mock.calls[0][0].draft).toBe(false);
    expect(humanReviewCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 3. RALPH exhausted (all iterations fail) → draft PR with gap comments
  // ---------------------------------------------------------------------------
  it("RALPH exhausted after all iterations fail results in draft PR with gap comments", async () => {
    // All RALPH checks return unsatisfied
    mockCheckRequirements.mockResolvedValue({
      satisfied: false,
      gaps: ["Pagination not implemented", "No error handling for empty query"],
      suggestions: ["Add limit/offset params", "Return 400 on invalid input"],
    });

    const config = makePipelineConfig({ ralphIterations: 2 });
    const app = buildApp(config);
    const issueId = `RG-${++issueCounter}`;

    await postWebhook(app, buildPayload(issueId));
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    // Both RALPH iterations should have run
    expect(mockCheckRequirements).toHaveBeenCalledTimes(2);
    // PR must be created as draft
    expect(mockCreatePRViaCli).toHaveBeenCalledTimes(1);
    expect(mockCreatePRViaCli.mock.calls[0][0].draft).toBe(true);
    // PR body should flag the draft status with RALPH gap count
    const prBody: string = mockCreatePRViaCli.mock.calls[0][0].body;
    expect(prBody).toContain("Draft PR");
    expect(prBody).toContain("RALPH found 2 unmet acceptance criteria");
    // Human review notification should be triggered
    expect(humanReviewCalls).toHaveLength(1);
    expect(humanReviewCalls[0].reason).toMatch(/unmet acceptance criteria/);
  });

  // ---------------------------------------------------------------------------
  // 4. Review-fix loop with blocking findings resolved → ready PR
  // ---------------------------------------------------------------------------
  it("Review-fix loop with blocking findings resolved results in ready PR", async () => {
    const blockingFindings: ReviewFinding[] = [
      {
        severity: "blocking",
        file: "src/feature.ts",
        line: 10,
        category: "security",
        description: "SQL injection vulnerability",
        fix: "Use parameterized queries",
      },
    ];
    // First review returns blocking findings; after fix loop, second review is clean
    reviewFindingsQueue = [blockingFindings, undefined];

    const config = makePipelineConfig({
      stages: ["implement", "test", "review"],
      ralphIterations: 0,
      reviewFixIterations: 1,
    });
    const app = buildApp(config);
    const issueId = `RG-${++issueCounter}`;

    await postWebhook(app, buildPayload(issueId));
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    // PR must be ready because the fix loop resolved all blocking findings
    expect(mockCreatePRViaCli).toHaveBeenCalledTimes(1);
    expect(mockCreatePRViaCli.mock.calls[0][0].draft).toBe(false);
    expect(humanReviewCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 5. Review-fix loop with blocking findings remaining → draft PR
  // ---------------------------------------------------------------------------
  it("Review-fix loop with blocking findings remaining results in draft PR", async () => {
    const blockingFindings: ReviewFinding[] = [
      {
        severity: "blocking",
        file: "src/feature.ts",
        line: 10,
        category: "security",
        description: "SQL injection vulnerability",
        fix: "Use parameterized queries",
      },
    ];
    // Both review calls (initial + after fix) return blocking findings
    reviewFindingsQueue = [blockingFindings, blockingFindings];

    const config = makePipelineConfig({
      stages: ["implement", "test", "review"],
      ralphIterations: 0,
      reviewFixIterations: 1,
    });
    const app = buildApp(config);
    const issueId = `RG-${++issueCounter}`;

    await postWebhook(app, buildPayload(issueId));
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    // PR must be draft because blocking findings persist after max iterations
    expect(mockCreatePRViaCli).toHaveBeenCalledTimes(1);
    expect(mockCreatePRViaCli.mock.calls[0][0].draft).toBe(true);
    const prBody: string = mockCreatePRViaCli.mock.calls[0][0].body;
    expect(prBody).toContain("Draft PR");
    expect(prBody).toContain("blocking review findings remain");
    expect(humanReviewCalls).toHaveLength(1);
    expect(humanReviewCalls[0].reason).toMatch(/blocking findings/);
  });

  // ---------------------------------------------------------------------------
  // 6. shouldDraft computation after deep review introduces new findings → draft
  // ---------------------------------------------------------------------------
  it("shouldDraft computation after deep review introduces new findings results in draft PR", async () => {
    // Regular review returns no blocking findings (so review-fix loop does not run)
    // Two review calls: initial pipeline review + deep review re-review
    reviewFindingsQueue = [undefined, undefined];

    // Deep review sub-agents find a blocking issue not caught by regular review
    mockRunDeepReview.mockResolvedValue({
      findings: [
        {
          agent: "quality",
          severity: "blocking",
          file: "src/feature.ts",
          line: 25,
          category: "stringly-typed",
          description: "Magic string used for status filter",
          fix: "Extract StatusEnum constant",
        } as DeepReviewFinding,
      ],
      inputTokens: 200,
      outputTokens: 100,
    });

    const config = makePipelineConfig({
      stages: ["implement", "review"],
      ralphIterations: 0,
      reviewFixIterations: 0,
      deepReviewPasses: 1,
    });
    const app = buildApp(config);
    const issueId = `RG-${++issueCounter}`;

    await postWebhook(app, buildPayload(issueId));
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    expect(mockRunDeepReview).toHaveBeenCalledTimes(1);
    // Deep review blocking finding should cause draft PR
    expect(mockCreatePRViaCli).toHaveBeenCalledTimes(1);
    expect(mockCreatePRViaCli.mock.calls[0][0].draft).toBe(true);
    const prBody: string = mockCreatePRViaCli.mock.calls[0][0].body;
    expect(prBody).toContain("Draft PR");
    expect(humanReviewCalls).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 7. Draft PR skips auto-merge even when autoMerge: true
  // ---------------------------------------------------------------------------
  it("Draft PR skips auto-merge even when autoMerge flag is true", async () => {
    // RALPH remains unsatisfied → shouldDraft = true
    mockCheckRequirements.mockResolvedValue({
      satisfied: false,
      gaps: ["Feature incomplete"],
      suggestions: ["Complete the implementation"],
    });

    const config = makePipelineConfig({
      ralphIterations: 2,
      autoMerge: true,
      autoMergeMaxLines: 200,
    });
    const app = buildApp(config);
    const issueId = `RG-${++issueCounter}`;

    await postWebhook(app, buildPayload(issueId));
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    // PR is created as draft
    expect(mockCreatePRViaCli.mock.calls[0][0].draft).toBe(true);
    // Auto-merge must NOT be attempted for draft PRs (runner guards on !shouldDraft)
    expect(mockMergePRViaCli).not.toHaveBeenCalled();
    // getDiffLineCount is also skipped for drafts
    expect(mockGetDiffLineCount).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 8. PR comment construction — gap analysis and next steps included
  // ---------------------------------------------------------------------------
  it("PR comment construction includes gap analysis and next steps guidance", async () => {
    // RALPH exhausted with specific gaps and suggestions
    mockCheckRequirements.mockResolvedValue({
      satisfied: false,
      gaps: ["Pagination not implemented", "No 400 for empty query"],
      suggestions: ["Add limit/offset params", "Validate input before query"],
    });

    const config = makePipelineConfig({ ralphIterations: 2 });
    const app = buildApp(config);
    const issueId = `RG-${++issueCounter}`;

    await postWebhook(app, buildPayload(issueId));
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    expect(mockCreatePRViaCli.mock.calls[0][0].draft).toBe(true);

    // Locate the "gh pr comment" execFile call made by the runner
    // Call shape: ef("gh", ["pr", "comment", prUrl, "--body", body], opts, cb)
    const commentCall = mockExecFile.mock.calls.find(
      (c: any[]) =>
        c[0] === "gh" &&
        Array.isArray(c[1]) &&
        c[1][0] === "pr" &&
        c[1][1] === "comment",
    );
    expect(commentCall).toBeDefined();

    // Comment body is the 5th element of the gh args array (index 4)
    const commentBody: string = commentCall![1][4];

    // Section heading for RALPH gaps
    expect(commentBody).toContain("Unmet Acceptance Criteria (RALPH)");
    // Individual gap lines
    expect(commentBody).toContain("Pagination not implemented");
    expect(commentBody).toContain("No 400 for empty query");
    // Suggested next steps section
    expect(commentBody).toContain("Suggested next steps");
    expect(commentBody).toContain("Add limit/offset params");
    // Footer guidance for human reviewer
    expect(commentBody).toContain("human reviewer should address");
  });
});

/**
 * Integration test: BEC-96
 * RALPH re-check after review-fix loop re-implement
 *
 * Verifies that RALPH is re-executed after each review-fix loop re-implement
 * so the draft decision reflects the final code state, not just the initial
 * implement's state. Specifically tests the regression scenario:
 *   1. Initial implement PASSES RALPH
 *   2. Review finds blocking issues → review-fix loop starts
 *   3. Review-fix re-implement introduces a REGRESSION
 *   4. RALPH re-check detects the regression → ralphSatisfied = false
 *   5. PR is created as DRAFT (not ready)
 *
 * Without the fix (BEC-96), ralphSatisfied would stay true from step 1,
 * causing the PR to be incorrectly created as ready.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDb } from "../db/client.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { pipelineRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type {
  Notifier,
  StageResult,
  PipelineConfig,
  RepoConfig,
  HandoffArtifact,
  ReviewFinding,
} from "../types.js";

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before imports
// ---------------------------------------------------------------------------

/** Counter for executeStage calls to return different results per call. */
let executeStageCallCount = 0;

/** Counter for checkRequirements calls. */
let checkRequirementsCallCount = 0;

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
    summary: `Completed ${stage} stage`,
    filesChanged: ["src/search.ts"],
    approach: `Standard ${stage} approach`,
    context: {
      issueIntent: "Add user search",
      constraints: [],
      assumptions: [],
      ...(reviewFindings ? { reviewFindings } : {}),
    },
    tokenBudget: { contextTokensUsed: 100, recommendedMaxTurns: 5 },
  };
}

const BLOCKING_FINDING: ReviewFinding = {
  severity: "blocking",
  file: "src/search.ts",
  line: 42,
  category: "correctness",
  description: "Search endpoint does not validate input",
  fix: "Add input validation before processing",
};

/**
 * Mock executeStage — returns different handoffs depending on call order:
 *   Call 1: implement (initial) → completed, no reviewFindings
 *   Call 2: review (initial) → completed, with one BLOCKING finding
 *   Call 3: implement (review-fix) → completed, no reviewFindings
 *   Call 4: review (review-fix) → completed, no reviewFindings
 */
vi.mock("../executor/executor.js", () => ({
  executeStage: vi.fn().mockImplementation(
    async ({ runId, issueId, stage, db }: {
      runId: string;
      issueId: string;
      stage: string;
      db: any;
    }) => {
      executeStageCallCount++;
      const callNum = executeStageCallCount;

      const { nanoid } = await import("nanoid");
      const { stageRuns: stageRunsTable } = await import("../db/schema.js");
      const { eq: drizzleEq } = await import("drizzle-orm");
      const stageRunId = nanoid();
      await db.insert(stageRunsTable).values({
        id: stageRunId,
        pipelineRunId: runId,
        stage,
        status: "running",
      });
      await db
        .update(stageRunsTable)
        .set({ status: "completed", completedAt: new Date(), inputTokens: 100, outputTokens: 50, turns: 1 })
        .where(drizzleEq(stageRunsTable.id, stageRunId));

      // Call 2 = initial review → return blocking findings
      const reviewFindings: ReviewFinding[] | undefined =
        callNum === 2 ? [BLOCKING_FINDING] : undefined;

      return {
        status: "completed",
        inputTokens: 100,
        outputTokens: 50,
        turns: 1,
        handoffArtifact: makeHandoffArtifact(runId, issueId, stage, reviewFindings),
        handoffIsStructured: true,
        stageRunId: `mock-${runId}-${stage}`,
      } satisfies StageResult;
    },
  ),
}));

/**
 * Mock checkRequirements:
 *   Call 1 (after initial implement): PASSES — all criteria satisfied
 *   Call 2 (after review-fix implement): FAILS — regression detected
 */
vi.mock("../executor/ralph.js", () => ({
  checkRequirements: vi.fn().mockImplementation(async () => {
    checkRequirementsCallCount++;
    if (checkRequirementsCallCount === 1) {
      return { satisfied: true, gaps: [], suggestions: [] };
    }
    // Regression: review-fix implement broke a criterion
    return {
      satisfied: false,
      gaps: ["Search endpoint no longer returns paginated results after review-fix"],
      suggestions: ["Restore pagination in search handler"],
    };
  }),
  buildRalphContext: vi.fn().mockReturnValue("RALPH context (mocked)"),
}));

/**
 * Mock extractHandoff — returns a minimal valid HandoffParseResult.
 */
vi.mock("../executor/extract-handoff.js", () => ({
  extractHandoff: vi.fn().mockResolvedValue({
    artifact: {
      runId: "mock-run",
      issueId: "RF-1",
      stage: "implement",
      timestamp: new Date().toISOString(),
      summary: "Implemented search",
      filesChanged: ["src/search.ts"],
      approach: "REST endpoint",
      context: { issueIntent: "Add search", constraints: [], assumptions: [] },
      tokenBudget: { contextTokensUsed: 100, recommendedMaxTurns: 5 },
    },
    structured: true,
    decisions: null,
  }),
}));

// Keep in sync with git.js/executor exports — add new exports here when they are added to the module
vi.mock("../repo/git.js", () => ({
  cloneRepo: vi.fn().mockResolvedValue(undefined),
  createWorktree: vi.fn().mockResolvedValue("/tmp/ralph-rf-test-worktree"),
  deleteWorktree: vi.fn().mockResolvedValue(undefined),
  pushBranch: vi.fn().mockResolvedValue(undefined),
  pushBranchForce: vi.fn().mockResolvedValue(undefined),
  rebaseBranch: vi.fn().mockResolvedValue({ success: true, hasConflicts: false }),
  abortRebase: vi.fn().mockResolvedValue(undefined),
  autoCommitChanges: vi.fn().mockResolvedValue(false),
  createPRViaCli: vi.fn().mockResolvedValue("https://github.com/test/repo/pull/99"),
  mergePRViaCli: vi.fn().mockResolvedValue(false),
  getDiffLineCount: vi.fn().mockResolvedValue(30),
  checkDuplicateBranch: vi.fn().mockResolvedValue(null),
  cleanupWorktrees: vi.fn().mockResolvedValue([]),
  branchName: vi.fn().mockImplementation(
    (identifier: string, slug: string) => `agent/${identifier}-${slug}`,
  ),
  gitExecSafe: vi.fn().mockResolvedValue(""),
  gitExecRaw: vi.fn().mockResolvedValue(""),
  gitExec: vi.fn().mockResolvedValue(""),
  getChangedFiles: vi.fn().mockResolvedValue(["src/search.ts"]),
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
  checkFileOverlap: vi.fn().mockResolvedValue({ hasOverlap: false, overlappingFiles: [], conflictingRunIds: [] }),
  getModifiedFiles: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Pipeline config for this regression test
// ---------------------------------------------------------------------------

const RALPH_RF_PIPELINE_CONFIG: PipelineConfig = {
  name: "RALPH Review-Fix Regression Test",
  stages: ["implement", "review"],
  retry: { maxAttempts: 0, strategy: "fail-fast" },
  review: { requiredApprovals: 0 },
  prStrategy: "ready",
  validateHandoffs: false,
  ralphIterations: 1,     // Enable RALPH — 1 iteration
  reviewFixIterations: 1, // Enable review-fix loop — 1 iteration
};

const TEST_REPO_CONFIG: RepoConfig = {
  url: "https://github.com/test/test-repo.git",
  defaultBranch: "main",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      if (run.status === "completed" || run.status === "failed" || run.status === "aborted") {
        return run;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Pipeline for issue ${issueId} did not reach terminal status within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RALPH re-check after review-fix loop re-implement (BEC-96)", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let notifier: Notifier;
  let runner: PipelineRunner;

  beforeEach(async () => {
    // Reset call counters for test isolation
    executeStageCallCount = 0;
    checkRequirementsCallCount = 0;

    db = await createDb({ driver: "sqlite", connectionString: ":memory:" });

    notifier = {
      onPipelineStart: vi.fn(async () => {}),
      onStageComplete: vi.fn(async () => {}),
      onPipelineComplete: vi.fn(async () => {}),
      onPipelineFailed: vi.fn(async () => {}),
    };

    runner = new PipelineRunner({
      db,
      notifier,
      concurrency: 1,
      agentRunDir: "/tmp/ralph-rf-agent-runs",
      repoCloneDir: "/tmp/ralph-rf-repos",
    });
  });

  it("creates a DRAFT PR when review-fix re-implement introduces a RALPH regression", async () => {
    // Arrange: issue with acceptance criteria that RALPH can check
    const issue = {
      id: "RF-1",
      identifier: "RF-1",
      title: "Add user search",
      description: "Add paginated full-text user search\n\n**Acceptance Criteria:**\n- Search endpoint returns paginated results\n- Results include user metadata",
      priority: 2,
      state: { id: "state-todo", name: "Todo" },
      teamId: "team-rf",
      labels: [{ name: "auto-implement" }],
    };

    const { mapIssueToSchema } = await import("../executor/prompt/schema-mapper.js");
    const sanitized = mapIssueToSchema(issue);

    // Act: run the pipeline directly (bypassing webhook layer for simplicity)
    await runner.start(
      issue,
      "ralph-rf-test",
      RALPH_RF_PIPELINE_CONFIG,
      TEST_REPO_CONFIG,
      sanitized,
    );

    const run = await waitForPipeline(db, "RF-1");

    // Assert: pipeline completed (not failed)
    expect(run.status, `Pipeline should complete, but got: ${run.status}, error: ${run.errorMessage}`).toBe("completed");

    // Assert: PR was created
    expect(run.prUrl).toBe("https://github.com/test/repo/pull/99");

    // Assert: checkRequirements was called twice:
    //   - once after initial implement (passed)
    //   - once after review-fix implement (failed — regression)
    expect(checkRequirementsCallCount).toBe(2);

    // Assert: PR was created as draft because RALPH detected regression after review-fix
    const { createPRViaCli } = await import("../repo/git.js");
    const prCalls = (createPRViaCli as ReturnType<typeof vi.fn>).mock.calls;
    expect(prCalls).toHaveLength(1);
    expect(prCalls[0][0].draft).toBe(true);
  });

  it("creates a READY PR when review-fix re-implement also satisfies RALPH", async () => {
    // Override checkRequirements to always return satisfied
    const { checkRequirements } = await import("../executor/ralph.js");
    (checkRequirements as ReturnType<typeof vi.fn>).mockResolvedValue({
      satisfied: true,
      gaps: [],
      suggestions: [],
    });

    const issue = {
      id: "RF-2",
      identifier: "RF-2",
      title: "Add user search",
      description: "Add paginated search\n\n**Acceptance Criteria:**\n- Search returns results",
      priority: 2,
      state: { id: "state-todo", name: "Todo" },
      teamId: "team-rf",
      labels: [{ name: "auto-implement" }],
    };

    const { mapIssueToSchema } = await import("../executor/prompt/schema-mapper.js");
    const sanitized = mapIssueToSchema(issue);

    // Reset executeStage call count so call 2 = initial review with blocking findings
    executeStageCallCount = 0;

    await runner.start(
      issue,
      "ralph-rf-test",
      RALPH_RF_PIPELINE_CONFIG,
      TEST_REPO_CONFIG,
      sanitized,
    );

    const run = await waitForPipeline(db, "RF-2");
    expect(run.status).toBe("completed");

    // Assert: PR was created as ready (not draft) because RALPH passed both times
    const { createPRViaCli } = await import("../repo/git.js");
    const prCalls = (createPRViaCli as ReturnType<typeof vi.fn>).mock.calls;
    // Find the call for RF-2 (may be last call given RF-1 ran first in test suite)
    const rf2Call = prCalls[prCalls.length - 1];
    expect(rf2Call[0].draft).toBe(false);
  });
});

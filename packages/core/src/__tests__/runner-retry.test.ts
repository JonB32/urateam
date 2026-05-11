/**
 * BEC-200: Test gaps — runner retry strategies, policyErr fail-open, injectAgentConfig EPERM
 *
 * Covers:
 *  1. fix-and-retry: executeStage retried up to maxAttempts on failure
 *  2. escalate: executeStage NOT retried, pipeline fails with retriesExhausted=true
 *  3. policyErr fail-open: evaluatePolicyGates throws → runner continues with warning log
 *  4. injectAgentConfig EPERM: writeFile throws non-EEXIST → warning logged, pipeline continues
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { Writable } from "node:stream";
import { PipelineRunner, type LinearIssue } from "../pipeline/runner.js";
import { createDb, type Db } from "../db/client.js";
import type { Notifier, PipelineConfig, RepoConfig, SanitizedIssue } from "../types.js";
import { pipelineRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { addLogStream } from "../logger.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

// ---------------------------------------------------------------------------
// Module mocks — infrastructure only; the retry loop itself is NOT mocked
// ---------------------------------------------------------------------------

vi.mock("../repo/git.js", () => ({
  checkDuplicateBranch: vi.fn().mockResolvedValue(null),
  cloneRepo: vi.fn().mockResolvedValue(undefined),
  createWorktree: vi.fn().mockResolvedValue("/tmp/test-worktree"),
  deleteWorktree: vi.fn().mockResolvedValue(undefined),
  pushBranch: vi.fn().mockResolvedValue(undefined),
  pushBranchForce: vi.fn().mockResolvedValue(undefined),
  choosePushStrategy: vi.fn().mockReturnValue("force-with-lease"),
  rebaseBranch: vi.fn().mockResolvedValue({ success: true, hasConflicts: false }),
  abortRebase: vi.fn().mockResolvedValue(undefined),
  autoCommitChanges: vi.fn().mockResolvedValue(false),
  getAgentCommits: vi.fn().mockResolvedValue([]),
  createPRViaCli: vi.fn().mockResolvedValue("https://github.com/test/repo/pull/1"),
  mergePRViaCli: vi.fn().mockResolvedValue(undefined),
  getDiffLineCount: vi.fn().mockResolvedValue(0),
  getChangedFiles: vi.fn().mockResolvedValue([]),
  branchName: vi.fn().mockImplementation((issueId: string, slug: string) => `agent/${issueId}-${slug}`),
  createWorktreeFromRemote: vi.fn().mockResolvedValue(undefined),
  pruneWorktreesInRepoDirs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../executor/executor.js", () => ({
  executeStage: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => false }),
}));

vi.mock("../repo/tech-stack.js", () => ({
  detectTechStack: vi.fn().mockResolvedValue({
    languages: [],
    frameworks: [],
    buildSystems: [],
  }),
}));

vi.mock("../repo/devcontainer.js", () => ({
  shouldUseDevcontainer: vi.fn().mockResolvedValue(false),
  devcontainerUp: vi.fn(),
  devcontainerDown: vi.fn(),
}));

vi.mock("../pm/coordination.js", () => ({
  upsertActiveWork: vi.fn().mockResolvedValue(undefined),
  removeActiveWork: vi.fn().mockResolvedValue(undefined),
  checkFileOverlap: vi.fn().mockResolvedValue({ hasOverlap: false }),
  getModifiedFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock("../pipeline/distributed-lock.js", () => ({
  withBranchLock: vi.fn().mockImplementation(
    (_adapter: unknown, _branch: unknown, _timeout: unknown, fn: () => Promise<unknown>) => fn(),
  ),
  createBranchLockAdapter: vi.fn().mockReturnValue({
    tryAcquire: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
  }),
  LockTimeoutError: class LockTimeoutError extends Error {},
}));

vi.mock("../policy/evaluate.js", () => ({
  evaluatePolicyGates: vi.fn().mockResolvedValue({
    shouldDraft: false,
    overrideActive: false,
    violations: [],
  }),
}));

vi.mock("../pipeline/pr-description.js", () => ({
  generatePRDescription: vi.fn().mockReturnValue("Test PR body"),
}));

vi.mock("../repo/config.js", () => ({
  parseRepoUrl: vi.fn().mockReturnValue({ owner: "test", repo: "repo" }),
  parseGitLabUrl: vi.fn().mockReturnValue(null),
}));

vi.mock("../policy/index.js", () => ({
  buildReviewerRequest: vi.fn().mockReturnValue(null),
  verifyApprovalsReceived: vi.fn().mockResolvedValue({ satisfied: true }),
}));

vi.mock("../executor/validate.js", () => ({
  validateHandoff: vi.fn().mockResolvedValue({ valid: true, issues: [] }),
}));

vi.mock("../pipeline/pr-change-summary.js", () => ({
  maybePostChangeSummary: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../audit/index.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
  logAuditEventUnchecked: vi.fn().mockResolvedValue(undefined),
  policyReviewersRequestedEvent: vi.fn().mockReturnValue({}),
  reviewFanoutFallbackUsedEvent: vi.fn().mockReturnValue({}),
  budgetRefusedEvent: vi.fn().mockReturnValue({}),
}));

// ---------------------------------------------------------------------------
// Imports of mocked modules for per-test configuration
// ---------------------------------------------------------------------------

const { executeStage } = await import("../executor/executor.js");
const { writeFile } = await import("node:fs/promises");
const { evaluatePolicyGates } = await import("../policy/evaluate.js");

// ---------------------------------------------------------------------------
// Log capture (for policyErr warn assertion)
// ---------------------------------------------------------------------------

const logCapture = { lines: [] as Array<{ level: number; msg: string; [key: string]: unknown }> };

beforeAll(() => {
  const captureStream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      const text = chunk.toString().trim();
      try {
        if (text) logCapture.lines.push(JSON.parse(text));
      } catch {
        // skip non-JSON lines (e.g. pino-pretty output)
      }
      cb();
    },
  });
  addLogStream(captureStream);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PINO_WARN_LEVEL = 40;

function makeFailedStageResult() {
  return {
    status: "failed" as const,
    errorMessage: "stage failed in test",
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
    stageRunId: "sr-test",
  };
}

function makeCompletedStageResult() {
  return {
    status: "completed" as const,
    handoffArtifact: null,
    handoffIsStructured: false,
    inputTokens: 10,
    outputTokens: 20,
    turns: 1,
    stageRunId: "sr-test",
  };
}

/**
 * Poll the DB until the pipeline run reaches a terminal status or timeout.
 */
async function waitForRunStatus(
  db: Db,
  issueId: string,
  terminalStatuses = ["completed", "failed", "retriable"],
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.issueId, issueId))
      .limit(1);
    if (rows.length > 0 && terminalStatuses.includes(rows[0].status)) {
      return rows[0].status;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  // Return last known status for debugging
  const rows = await (db as any).select().from(pipelineRuns).where(eq(pipelineRuns.issueId, issueId)).limit(1);
  throw new Error(
    `Run ${issueId} did not reach terminal status within ${timeoutMs}ms. Current: ${rows[0]?.status ?? "unknown"}`,
  );
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const MOCK_ISSUE: LinearIssue = {
  id: "issue-bec200",
  identifier: "BEC-200",
  title: "Retry test issue",
  description: "Testing retry strategies",
  labels: [{ name: "auto-implement" }],
  priority: 2,
  teamId: "team-1",
};

const MOCK_SANITIZED_ISSUE: SanitizedIssue = {
  id: "BEC-200",
  slug: "retry-test-issue",
  title: "Retry test issue",
  description: "Testing retry strategies",
  acceptanceCriteria: ["Retries work"],
  labels: ["auto-implement"],
  priority: 2,
};

const MOCK_REPO_CONFIG: RepoConfig = {
  url: "https://github.com/test/repo.git",
  defaultBranch: "main",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
};

// ---------------------------------------------------------------------------
// Tests: Retry strategies
// ---------------------------------------------------------------------------

describe("PipelineRunner — retry strategies (BEC-200)", () => {
  let db: Db;
  let notifier: Notifier;
  let runner: PipelineRunner;

  beforeEach(async () => {
    db = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    notifier = {
      onPipelineStart: vi.fn().mockResolvedValue(undefined),
      onStageComplete: vi.fn().mockResolvedValue(undefined),
      onPipelineComplete: vi.fn().mockResolvedValue(undefined),
      onPipelineFailed: vi.fn().mockResolvedValue(undefined),
    };
    runner = new PipelineRunner({
      db,
      notifier,
      concurrency: 2,
      agentRunDir: "/tmp/test-agent-runs",
      repoCloneDir: "/tmp/test-repos",
    });
    // Reset all mocks to clean state
    vi.clearAllMocks();
    // Clear log capture for this test
    logCapture.lines = [];
    // Restore safe defaults for infrastructure mocks
    vi.mocked(executeStage).mockResolvedValue(makeCompletedStageResult() as any);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(evaluatePolicyGates).mockResolvedValue({
      shouldDraft: false,
      overrideActive: false,
      violations: [],
    });
    // Re-apply defaults that clearAllMocks wiped
    const { checkDuplicateBranch, cloneRepo, createWorktree, deleteWorktree,
            pushBranchForce, rebaseBranch, autoCommitChanges, getAgentCommits,
            getChangedFiles, createPRViaCli, choosePushStrategy, branchName } =
      await import("../repo/git.js");
    vi.mocked(checkDuplicateBranch).mockResolvedValue(null);
    vi.mocked(cloneRepo).mockResolvedValue(undefined);
    vi.mocked(createWorktree).mockResolvedValue("/tmp/test-worktree");
    vi.mocked(deleteWorktree).mockResolvedValue(undefined);
    vi.mocked(pushBranchForce).mockResolvedValue(undefined);
    vi.mocked(rebaseBranch).mockResolvedValue({ success: true, hasConflicts: false });
    vi.mocked(autoCommitChanges).mockResolvedValue(false);
    vi.mocked(getAgentCommits).mockResolvedValue([]);
    vi.mocked(getChangedFiles).mockResolvedValue([]);
    vi.mocked(createPRViaCli).mockResolvedValue("https://github.com/test/repo/pull/1");
    vi.mocked(choosePushStrategy).mockReturnValue("force-with-lease");
    vi.mocked(branchName).mockImplementation(
      (issueId: string, slug: string) => `agent/${issueId}-${slug}`,
    );
    const { appendFile, access } = await import("node:fs/promises");
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(access).mockResolvedValue(undefined);
    const { detectTechStack } = await import("../repo/tech-stack.js");
    vi.mocked(detectTechStack).mockResolvedValue({ languages: [], frameworks: [], buildSystems: [] });
    const { shouldUseDevcontainer } = await import("../repo/devcontainer.js");
    vi.mocked(shouldUseDevcontainer).mockResolvedValue(false);
    const { upsertActiveWork, removeActiveWork, checkFileOverlap, getModifiedFiles } =
      await import("../pm/coordination.js");
    vi.mocked(upsertActiveWork).mockResolvedValue(undefined);
    vi.mocked(removeActiveWork).mockResolvedValue(undefined);
    vi.mocked(checkFileOverlap).mockResolvedValue({ hasOverlap: false });
    vi.mocked(getModifiedFiles).mockResolvedValue([]);
    const { withBranchLock, createBranchLockAdapter } = await import("../pipeline/distributed-lock.js");
    vi.mocked(withBranchLock).mockImplementation(
      (_adapter: unknown, _branch: unknown, _timeout: unknown, fn: () => Promise<unknown>) => fn(),
    );
    vi.mocked(createBranchLockAdapter).mockReturnValue({
      tryAcquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    });
    const { generatePRDescription } = await import("../pipeline/pr-description.js");
    vi.mocked(generatePRDescription).mockReturnValue("Test PR body");
    const { buildReviewerRequest } = await import("../policy/index.js");
    vi.mocked(buildReviewerRequest).mockReturnValue(null);
  });

  afterEach(async () => {
    await restoreLicense();
  });

  // ─── 1. fix-and-retry ──────────────────────────────────────────────────────

  it("fix-and-retry: retries executeStage up to maxAttempts on failure", async () => {
    // All calls fail → 1 initial + maxAttempts retries = 3 total calls
    vi.mocked(executeStage).mockResolvedValue(makeFailedStageResult() as any);

    const pipelineConfig: PipelineConfig = {
      name: "test-fix-and-retry",
      stages: ["implement"],
      retry: { maxAttempts: 2, strategy: "fix-and-retry" },
      review: { requiredApprovals: 0 },
      prStrategy: "ready",
      validateHandoffs: false,
      ralphIterations: 0,
    };

    await runner.start(
      { ...MOCK_ISSUE, identifier: "BEC-200-FNR" },
      "auto-implement",
      pipelineConfig,
      MOCK_REPO_CONFIG,
      { ...MOCK_SANITIZED_ISSUE, id: "BEC-200-FNR" },
    );

    const finalStatus = await waitForRunStatus(db, "BEC-200-FNR");
    expect(finalStatus).toBe("failed");

    // 1 initial call + 2 retry attempts = 3 total
    expect(vi.mocked(executeStage).mock.calls.length).toBe(3);

    // Notifier should be called with retriesExhausted=true (fix-and-retry = true)
    expect(notifier.onPipelineFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ retriesExhausted: true }),
    );
  });

  it("fix-and-retry: stops retrying when stage succeeds mid-retry", async () => {
    // First call fails, second call (first retry) succeeds → total 2 calls
    vi.mocked(executeStage)
      .mockResolvedValueOnce(makeFailedStageResult() as any)
      .mockResolvedValue(makeCompletedStageResult() as any);

    const pipelineConfig: PipelineConfig = {
      name: "test-fix-and-retry-recovery",
      stages: ["implement"],
      retry: { maxAttempts: 3, strategy: "fix-and-retry" },
      review: { requiredApprovals: 0 },
      prStrategy: "ready",
      validateHandoffs: false,
      ralphIterations: 0,
    };

    await runner.start(
      { ...MOCK_ISSUE, identifier: "BEC-200-FNR2" },
      "auto-implement",
      pipelineConfig,
      MOCK_REPO_CONFIG,
      { ...MOCK_SANITIZED_ISSUE, id: "BEC-200-FNR2" },
    );

    const finalStatus = await waitForRunStatus(db, "BEC-200-FNR2");
    expect(finalStatus).toBe("completed");

    // Initial fail + 1 retry success = 2 calls (stops early on success)
    expect(vi.mocked(executeStage).mock.calls.length).toBe(2);
  });

  // ─── 2. escalate strategy ─────────────────────────────────────────────────

  it("escalate: does NOT retry executeStage on failure (only 1 call despite maxAttempts > 0)", async () => {
    vi.mocked(executeStage).mockResolvedValue(makeFailedStageResult() as any);

    const pipelineConfig: PipelineConfig = {
      name: "test-escalate",
      stages: ["implement"],
      retry: { maxAttempts: 3, strategy: "escalate" },
      review: { requiredApprovals: 0 },
      prStrategy: "ready",
      validateHandoffs: false,
      ralphIterations: 0,
    };

    await runner.start(
      { ...MOCK_ISSUE, identifier: "BEC-200-ESC" },
      "auto-implement",
      pipelineConfig,
      MOCK_REPO_CONFIG,
      { ...MOCK_SANITIZED_ISSUE, id: "BEC-200-ESC" },
    );

    const finalStatus = await waitForRunStatus(db, "BEC-200-ESC");
    expect(finalStatus).toBe("failed");

    // escalate breaks immediately — exactly 1 call, never retried
    expect(vi.mocked(executeStage).mock.calls.length).toBe(1);

    // Notifier called with retriesExhausted=true (escalate = true, not fail-fast)
    expect(notifier.onPipelineFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ retriesExhausted: true }),
    );
  });

  // ─── 3. policyErr fail-open ───────────────────────────────────────────────

  it("policyErr fail-open: runner continues when evaluatePolicyGates throws, logs warning", async () => {
    await installTestProLicense("enterprise"); // enables org-policy feature

    // Stage succeeds
    vi.mocked(executeStage).mockResolvedValue(makeCompletedStageResult() as any);
    // Policy evaluator throws
    vi.mocked(evaluatePolicyGates).mockRejectedValue(
      new Error("policy service unavailable"),
    );

    const pipelineConfig: PipelineConfig = {
      name: "test-policy-err",
      stages: ["implement"],
      retry: { maxAttempts: 0, strategy: "fail-fast" },
      review: { requiredApprovals: 0 },
      prStrategy: "ready",
      validateHandoffs: false,
      ralphIterations: 0,
      policy: {
        pathBlocklist: ["secrets/**"],
        overrideLabel: "bypass-policy",
      },
    };

    await runner.start(
      { ...MOCK_ISSUE, identifier: "BEC-200-POL" },
      "auto-implement",
      pipelineConfig,
      MOCK_REPO_CONFIG,
      { ...MOCK_SANITIZED_ISSUE, id: "BEC-200-POL" },
    );

    // Pipeline should complete (not crash from policy error)
    const finalStatus = await waitForRunStatus(db, "BEC-200-POL");
    expect(finalStatus).toBe("completed");

    // evaluatePolicyGates was called (the policy check ran) and threw
    expect(vi.mocked(evaluatePolicyGates)).toHaveBeenCalled();

    // The warning log should have been emitted (pino level 40 = warn)
    const warnLogs = logCapture.lines.filter((l) => l.level === PINO_WARN_LEVEL);
    expect(
      warnLogs.some((l) => l.msg === "org-policy: gate evaluation failed — skipping"),
    ).toBe(true);
  });

  // ─── 4. injectAgentConfig EPERM ───────────────────────────────────────────

  it("injectAgentConfig EPERM: warns and continues when writeFile throws non-EEXIST error", async () => {
    // Simulate EPERM (permission denied) - NOT EEXIST
    const epermError = Object.assign(new Error("EPERM: permission denied"), {
      code: "EPERM",
    });
    vi.mocked(writeFile).mockRejectedValue(epermError);

    // Stage fails (so we can verify pipeline reached executeStage despite inject failure)
    vi.mocked(executeStage).mockResolvedValue(makeFailedStageResult() as any);

    const pipelineConfig: PipelineConfig = {
      name: "test-inject-eperm",
      stages: ["implement"],
      retry: { maxAttempts: 0, strategy: "fail-fast" },
      review: { requiredApprovals: 0 },
      prStrategy: "ready",
      validateHandoffs: false,
      ralphIterations: 0,
    };

    await runner.start(
      { ...MOCK_ISSUE, identifier: "BEC-200-EPERM" },
      "auto-implement",
      pipelineConfig,
      MOCK_REPO_CONFIG,
      { ...MOCK_SANITIZED_ISSUE, id: "BEC-200-EPERM" },
    );

    await waitForRunStatus(db, "BEC-200-EPERM");

    // writeFile was called (inject was attempted)
    expect(vi.mocked(writeFile)).toHaveBeenCalled();

    // executeStage was still called — pipeline continued past the inject failure
    expect(vi.mocked(executeStage)).toHaveBeenCalled();

    // The warn log should have been emitted
    const warnLogs = logCapture.lines.filter((l) => l.level === PINO_WARN_LEVEL);
    expect(
      warnLogs.some((l) => l.msg === "failed to inject CLAUDE.md — agent will run without it"),
    ).toBe(true);
  });
});

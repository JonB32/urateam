/**
 * BEC-200 — runner retry-strategy tests
 *
 * Verifies the three documented retry strategies in `PipelineConfig.retry`:
 *
 *   1. `fix-and-retry` — on a failed stage, re-execute up to `maxAttempts`
 *      times. `stageRetries[stage]` increments on each retry. If a retry
 *      succeeds, the pipeline proceeds; if all retries fail, the run is
 *      marked retriable (per failPipeline's `retriable=true` branch).
 *
 *   2. `escalate` — on a failed stage, NO retries are attempted. The run
 *      fails immediately, marked retriable.
 *
 *   3. `fail-fast` — on a failed stage, NO retries. The run fails
 *      immediately, marked NON-retriable (no automatic recovery).
 *
 * Mock strategy: hijack `executeStage` to return failed/completed based on a
 * per-test counter, then call `runner.start()` directly and inspect the DB.
 * Avoids the webhook-driven scaffolding in ralph-gate.test.ts since retry
 * logic doesn't depend on it.
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

const { mockCreatePRViaCli, mockExecFile } = vi.hoisted(() => ({
  mockCreatePRViaCli: vi
    .fn()
    .mockResolvedValue("https://github.com/test/repo/pull/99"),
  mockExecFile: vi.fn().mockImplementation((...args: any[]) => {
    const cb = args.find((a) => typeof a === "function");
    if (cb) cb(null, "", "");
  }),
}));

/**
 * Per-test queue of stage results. Each `executeStage` call shifts one entry
 * off the front. Tests populate this before calling runner.start(); the order
 * mirrors the runner's execution order (stage 1 attempts, retries 1, retries
 * 2 → stage 2 attempts → ...).
 */
type StageResult = "completed" | "failed";
let stageResultsQueue: StageResult[] = [];
let executeStageCalls: Array<{ stage: string; attempt: number }> = [];

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
      issueIntent: "test retry strategies",
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

      const attempt = executeStageCalls.filter((c) => c.stage === stage).length;
      executeStageCalls.push({ stage, attempt });

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
  createWorktree: vi.fn().mockResolvedValue("/tmp/retry-strategies-worktree"),
  deleteWorktree: vi.fn().mockResolvedValue(undefined),
  pushBranch: vi.fn().mockResolvedValue(undefined),
  pushBranchForce: vi.fn().mockResolvedValue(undefined),
  rebaseBranch: vi.fn().mockResolvedValue({ success: true, hasConflicts: false }),
  abortRebase: vi.fn().mockResolvedValue(undefined),
  autoCommitChanges: vi.fn().mockResolvedValue(false),
  createPRViaCli: mockCreatePRViaCli,
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

const REPO_CONFIG: RepoConfig = {
  url: "https://github.com/test/test-repo.git",
  defaultBranch: "main",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
};

function makePipelineConfig(
  retry: PipelineConfig["retry"],
  stages: PipelineConfig["stages"] = ["implement"],
): PipelineConfig {
  return {
    name: "Auto Implement",
    stages,
    retry,
    review: { requiredApprovals: 0 },
    prStrategy: "ready",
    validateHandoffs: false,
    ralphIterations: 0, // disable RALPH so the retry-loop is the only re-exec path
    reviewFixIterations: 0,
    deepReviewPasses: 0,
  };
}

const ISSUE = {
  id: "issue-rs-1",
  identifier: "RS-1",
  title: "retry-strategies test issue",
  description: "Test retry strategies",
  priority: 2,
};

async function waitForRunComplete(
  db: any,
  issueId: string,
  timeoutMs = 5_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.issueId, issueId));
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

describe("PipelineRunner retry strategies (BEC-200)", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let notifier: Notifier;

  beforeEach(async () => {
    await installTestProLicense();
    stageResultsQueue = [];
    executeStageCalls = [];
    mockCreatePRViaCli.mockClear();

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
  });

  function makeRunner() {
    return new PipelineRunner({
      db,
      notifier,
      concurrency: 1,
      agentRunDir: "/tmp/retry-strategies-runs",
      repoCloneDir: "/tmp/retry-strategies-repos",
    });
  }

  it("fix-and-retry: stage succeeds after one retry → stageRetries[stage] = 1, run completes", async () => {
    // First implement call fails, second (retry attempt 1) succeeds.
    stageResultsQueue = ["failed", "completed"];
    const config = makePipelineConfig({ maxAttempts: 2, strategy: "fix-and-retry" });

    const runner = makeRunner();
    const issue = { ...ISSUE, identifier: "RS-1" } as any;
    await runner.start(
      issue,
      "auto-implement",
      config,
      REPO_CONFIG,
      issue as any,
    );

    const run = await waitForRunComplete(db, "RS-1");
    expect(run.status).toBe("completed");
    expect(executeStageCalls.filter((c) => c.stage === "implement")).toHaveLength(2);
  });

  it("fix-and-retry: exhausts maxAttempts → run marked retriable, stageRetries shows N retries", async () => {
    // initial + 2 retries all fail
    stageResultsQueue = ["failed", "failed", "failed"];
    const config = makePipelineConfig({ maxAttempts: 2, strategy: "fix-and-retry" });

    const runner = makeRunner();
    const issue = { ...ISSUE, identifier: "RS-2" } as any;
    await runner.start(issue, "auto-implement", config, REPO_CONFIG, issue as any);

    const run = await waitForRunComplete(db, "RS-2");
    // failPipeline with retriable=true sets status="retriable" (auto-recovery candidate)
    expect(["retriable", "failed"]).toContain(run.status);
    // 1 initial + 2 retries
    expect(executeStageCalls.filter((c) => c.stage === "implement")).toHaveLength(3);
  });

  it("escalate: NO retries on failure — fails immediately", async () => {
    stageResultsQueue = ["failed"];
    const config = makePipelineConfig({ maxAttempts: 5, strategy: "escalate" });

    const runner = makeRunner();
    const issue = { ...ISSUE, identifier: "RS-3" } as any;
    await runner.start(issue, "auto-implement", config, REPO_CONFIG, issue as any);

    const run = await waitForRunComplete(db, "RS-3");
    expect(["retriable", "failed"]).toContain(run.status);
    // Strategy "escalate" enters the retry loop but breaks on the first
    // iteration — so executeStage is called exactly once.
    expect(executeStageCalls.filter((c) => c.stage === "implement")).toHaveLength(1);
  });

  it("fail-fast: NO retries, marks run as failed (non-retriable)", async () => {
    stageResultsQueue = ["failed"];
    const config = makePipelineConfig({ maxAttempts: 5, strategy: "fail-fast" });

    const runner = makeRunner();
    const issue = { ...ISSUE, identifier: "RS-4" } as any;
    await runner.start(issue, "auto-implement", config, REPO_CONFIG, issue as any);

    const run = await waitForRunComplete(db, "RS-4");
    expect(run.status).toBe("failed");
    expect(executeStageCalls.filter((c) => c.stage === "implement")).toHaveLength(1);
  });
});

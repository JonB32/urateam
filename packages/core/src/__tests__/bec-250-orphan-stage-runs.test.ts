/**
 * BEC-250 — unit tests for orphan stage_run cleanup
 *
 * Two areas under test:
 *
 * 1. Runner-side fix (cancelRunningStageRuns): when a pipeline_run transitions
 *    to a terminal state, any child stage_runs still in status='running' are
 *    cancelled. Verified by driving runner.start() with a mock that simulates
 *    a mid-execution crash (inserts stage_run as 'running', never updates it).
 *
 * 2. Sweep (sweepOrphanStageRuns): PM-tick sweep that reconciles historical
 *    orphans. Verified directly against an in-memory DB seeded with orphan rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDb } from "../db/client.js";
import { pipelineRuns, stageRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Notifier, PipelineConfig, RepoConfig, HandoffArtifact } from "../types.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { sweepOrphanStageRuns } from "../pm/actions/sweep-orphan-stage-runs.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

// ---------------------------------------------------------------------------
// Shared mock infrastructure (hoisted so vi.mock can reference them)
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
 * The "crash" mock: inserts stage_run as 'running' but does NOT update its
 * status — simulating a mid-execution process crash where the stage_run is
 * left in 'running' state while the pipeline eventually transitions to failed.
 */
vi.mock("../executor/executor.js", () => ({
  executeStage: vi.fn().mockImplementation(async ({ runId, stage, db }: any) => {
    const { nanoid: nid } = await import("nanoid");
    const { stageRuns: stageRunsTable } = await import("../db/schema.js");

    const stageRunId = nid();
    // Insert stage_run as 'running' — intentionally left un-updated to simulate crash
    await db.insert(stageRunsTable).values({
      id: stageRunId,
      pipelineRunId: runId,
      stage,
      status: "running",
    });

    // Return 'failed' — the runner will call failPipeline which should now
    // also cancel any running stage_runs (the BEC-250 fix).
    return {
      status: "failed",
      errorMessage: "simulated mid-execution crash",
      stageRunId,
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
    };
  }),
}));

vi.mock("../repo/git.js", () => ({
  cloneRepo: vi.fn().mockResolvedValue(undefined),
  createWorktree: vi.fn().mockResolvedValue("/tmp/bec250-worktree"),
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
  pruneWorktreesInRepoDirs: vi.fn().mockResolvedValue(undefined),
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

const PIPELINE_CONFIG: PipelineConfig = {
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

async function waitForRunComplete(db: any, issueId: string, timeoutMs = 5_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.issueId, issueId));
    if (rows.length > 0 && ["completed", "failed", "retriable", "aborted", "cancelled"].includes(rows[0].status)) {
      return rows[0];
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Pipeline for ${issueId} did not finish within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BEC-250: runner-side cancelRunningStageRuns fix", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let notifier: Notifier;

  beforeEach(async () => {
    await installTestProLicense();
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
      agentRunDir: "/tmp/bec250-runs",
      repoCloneDir: "/tmp/bec250-repos",
    });
  }

  it("failPipeline cancels child stage_runs still in running state", async () => {
    const runner = makeRunner();
    const issue = {
      id: "issue-bec250-1",
      identifier: "BEC250-1",
      title: "bec250 runner fix test",
      description: "Test that failPipeline cancels running stage_runs",
      priority: 2,
    };

    // Start the pipeline — the mock executeStage inserts a stage_run as 'running'
    // then returns 'failed' without updating it (simulating a crash).
    await runner.start(issue as any, "auto-implement", PIPELINE_CONFIG, REPO_CONFIG, issue as any);
    const run = await waitForRunComplete(db, "BEC250-1");

    // Pipeline must be in a terminal state
    expect(["failed", "retriable"]).toContain(run.status);

    // The stage_run inserted as 'running' must have been cancelled by
    // cancelRunningStageRuns (the BEC-250 fix). No orphans remain.
    const orphans = await (db as any)
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.status, "running"));
    expect(orphans).toHaveLength(0);

    // The stage_run should now be 'cancelled'
    const allStageRuns = await (db as any).select().from(stageRuns);
    expect(allStageRuns.length).toBeGreaterThan(0);
    const cancelledOnes = allStageRuns.filter((sr: any) => sr.status === "cancelled");
    expect(cancelledOnes.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Sweep tests — no mocking needed, pure DB operations
// ---------------------------------------------------------------------------

describe("BEC-250: sweepOrphanStageRuns", () => {
  let db: Awaited<ReturnType<typeof createDb>>;

  beforeEach(async () => {
    db = await createDb({ driver: "sqlite", connectionString: ":memory:" });
  });

  async function insertPipelineRun(id: string, status: string) {
    await (db as any).insert(pipelineRuns).values({
      id,
      issueId: `issue-${id}`,
      issueTitle: "Test",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      status,
    });
  }

  async function insertStageRun(id: string, pipelineRunId: string, status = "running") {
    await (db as any).insert(stageRuns).values({
      id,
      pipelineRunId,
      stage: "implement",
      status,
    });
  }

  it("marks running stage_runs cancelled when parent is in failed state", async () => {
    const runId = nanoid();
    const stageRunId = nanoid();

    await insertPipelineRun(runId, "failed");
    await insertStageRun(stageRunId, runId, "running");

    const result = await sweepOrphanStageRuns(db as any);

    expect(result.cancelled).toBe(1);
    expect(result.deleted).toBe(0);

    const [child] = await (db as any).select().from(stageRuns).where(eq(stageRuns.id, stageRunId));
    expect(child.status).toBe("cancelled");
    expect(child.completedAt).not.toBeNull();
  });

  it("marks running stage_runs cancelled when parent is completed", async () => {
    const runId = nanoid();
    const stageRunId = nanoid();

    await insertPipelineRun(runId, "completed");
    await insertStageRun(stageRunId, runId, "running");

    const result = await sweepOrphanStageRuns(db as any);

    expect(result.cancelled).toBe(1);
    const [child] = await (db as any).select().from(stageRuns).where(eq(stageRuns.id, stageRunId));
    expect(child.status).toBe("cancelled");
  });

  it("marks running stage_runs cancelled when parent is cancelled", async () => {
    const runId = nanoid();
    const stageRunId = nanoid();

    await insertPipelineRun(runId, "cancelled");
    await insertStageRun(stageRunId, runId, "running");

    const result = await sweepOrphanStageRuns(db as any);

    expect(result.cancelled).toBe(1);
    const [child] = await (db as any).select().from(stageRuns).where(eq(stageRuns.id, stageRunId));
    expect(child.status).toBe("cancelled");
  });

  it("deletes running stage_runs whose parent pipeline_run is missing", async () => {
    const runId = nanoid();
    const stageRunId = nanoid();

    // Insert parent and child with FK satisfied
    await insertPipelineRun(runId, "running");
    await insertStageRun(stageRunId, runId, "running");

    // Simulate historical FK-bypass parent deletion by temporarily disabling FK enforcement
    (db as any).session.client.pragma("foreign_keys = OFF");
    await (db as any).delete(pipelineRuns).where(eq(pipelineRuns.id, runId));
    (db as any).session.client.pragma("foreign_keys = ON");

    // Confirm the orphan exists
    const before = await (db as any).select().from(stageRuns).where(eq(stageRuns.id, stageRunId));
    expect(before).toHaveLength(1);

    const result = await sweepOrphanStageRuns(db as any);

    expect(result.deleted).toBe(1);
    expect(result.cancelled).toBe(0);

    const after = await (db as any).select().from(stageRuns).where(eq(stageRuns.id, stageRunId));
    expect(after).toHaveLength(0);
  });

  it("does NOT touch stage_runs whose parent is still running (live in-flight)", async () => {
    const runId = nanoid();
    const stageRunId = nanoid();

    await insertPipelineRun(runId, "running");
    await insertStageRun(stageRunId, runId, "running");

    const result = await sweepOrphanStageRuns(db as any);

    expect(result.cancelled).toBe(0);
    expect(result.deleted).toBe(0);

    const [child] = await (db as any).select().from(stageRuns).where(eq(stageRuns.id, stageRunId));
    expect(child.status).toBe("running");
  });

  it("does NOT touch completed stage_runs regardless of parent state", async () => {
    const runId = nanoid();
    const stageRunId = nanoid();

    await insertPipelineRun(runId, "failed");
    await insertStageRun(stageRunId, runId, "completed");

    const result = await sweepOrphanStageRuns(db as any);

    expect(result.cancelled).toBe(0);
    expect(result.deleted).toBe(0);

    const [child] = await (db as any).select().from(stageRuns).where(eq(stageRuns.id, stageRunId));
    expect(child.status).toBe("completed");
  });

  it("handles multiple orphans in one sweep and returns correct counts", async () => {
    const run1Id = nanoid();
    const run2Id = nanoid();
    const sr1 = nanoid();
    const sr2 = nanoid();
    const sr3 = nanoid();

    await insertPipelineRun(run1Id, "failed");
    await insertPipelineRun(run2Id, "cancelled");
    await insertStageRun(sr1, run1Id, "running");
    await insertStageRun(sr2, run1Id, "running");
    await insertStageRun(sr3, run2Id, "running");

    const result = await sweepOrphanStageRuns(db as any);

    expect(result.cancelled).toBe(3);

    const orphans = await (db as any).select().from(stageRuns).where(eq(stageRuns.status, "running"));
    expect(orphans).toHaveLength(0);
  });

  it("is idempotent — running it twice produces the same end state", async () => {
    const runId = nanoid();
    const stageRunId = nanoid();

    await insertPipelineRun(runId, "failed");
    await insertStageRun(stageRunId, runId, "running");

    const first = await sweepOrphanStageRuns(db as any);
    expect(first.cancelled).toBe(1);

    // Second call: no running orphans remain, should be a no-op
    const second = await sweepOrphanStageRuns(db as any);
    expect(second.cancelled).toBe(0);
    expect(second.deleted).toBe(0);

    const [child] = await (db as any).select().from(stageRuns).where(eq(stageRuns.id, stageRunId));
    expect(child.status).toBe("cancelled");
  });
});

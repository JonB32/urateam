/**
 * BEC-252 — Reproduction test: pipeline runs interrupted by server restart
 * are marked `status="failed"` even when the worktree AND transcript survive.
 *
 * The bug: runner.ts:3414 unconditionally writes `status: "failed"` regardless
 * of whether the worktree exists or the agent session JSONL is on disk.
 * The fix should write `status: "retriable"` when both conditions hold so the
 * existing `recoverRetriableRuns` path can resume on the next PM tick.
 *
 * Steps to reproduce:
 *   1. An in-flight pipeline run (status="running") is in the DB when the
 *      server restarts.
 *   2. The worktree directory still exists on the persistent volume.
 *   3. The agent session JSONL transcript is present on disk.
 *   4. On startup, `runner.recoverStuckRuns()` is called.
 *   5. CURRENT BEHAVIOR: run is marked `status="failed"`.
 *      EXPECTED BEHAVIOR: run is marked `status="retriable"` so the PM agent
 *      can auto-resume it on the next tick via `recoverRetriableRuns`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../db/client.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { pipelineRuns, stageRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { encodeCwd } from "../executor/session-store.js";
import { nanoid } from "nanoid";

// ---------------------------------------------------------------------------
// Module mocks — prevent real git and executor calls during recoverStuckRuns
// ---------------------------------------------------------------------------

vi.mock("../repo/git.js", () => ({
  cloneRepo: vi.fn().mockResolvedValue(undefined),
  createWorktree: vi.fn().mockResolvedValue("/tmp/worktree"),
  deleteWorktree: vi.fn().mockResolvedValue(undefined),
  pushBranch: vi.fn().mockResolvedValue(undefined),
  pushBranchForce: vi.fn().mockResolvedValue(undefined),
  rebaseBranch: vi.fn().mockResolvedValue({ success: true, hasConflicts: false }),
  abortRebase: vi.fn().mockResolvedValue(undefined),
  autoCommitChanges: vi.fn().mockResolvedValue(false),
  createPRViaCli: vi.fn().mockResolvedValue("https://github.com/test/repo/pull/1"),
  mergePRViaCli: vi.fn().mockResolvedValue(true),
  getDiffLineCount: vi.fn().mockResolvedValue(10),
  getChangedFiles: vi.fn().mockResolvedValue([]),
  checkDuplicateBranch: vi.fn().mockResolvedValue(null),
  cleanupWorktrees: vi.fn().mockResolvedValue([]),
  branchName: vi.fn().mockReturnValue("agent/test-branch"),
  gitExecSafe: vi.fn().mockResolvedValue(""),
  gitExecRaw: vi.fn().mockResolvedValue(""),
  gitExec: vi.fn().mockResolvedValue(""),
  choosePushStrategy: vi.fn().mockReturnValue("standard"),
  getAgentCommits: vi.fn().mockResolvedValue([]),
  installPrePushHook: vi.fn().mockResolvedValue(undefined),
  pruneWorktreesInRepoDirs: vi.fn().mockResolvedValue(undefined),
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
  execFile: vi.fn().mockImplementation((...args: any[]) => {
    const cb = args.find((a) => typeof a === "function");
    if (cb) cb(null, "", "");
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a pipeline run that looks like it was left running when the server
 *  died: started 10 minutes ago, status="running". */
async function insertOrphanedRun(
  db: any,
  runId: string,
  issueId: string,
  agentSessionId: string | null,
): Promise<void> {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  await db.insert(pipelineRuns).values({
    id: runId,
    issueId,
    issueTitle: "BEC-252 test issue",
    pipelineKey: "auto-implement",
    repoUrl: "https://github.com/test/repo",
    agentSessionId,
    branch: `agent/${issueId}-bec252`,
    status: "running",
    startedAt: tenMinutesAgo,
    retryCount: 0,
    runType: "standard",
    totalInputTokens: 0,
    totalOutputTokens: 0,
  });
}

/** Insert a stage_run record so recoverStuckRuns can look up the last stage. */
async function insertLastStageRun(
  db: any,
  runId: string,
  stage: string,
): Promise<void> {
  await db.insert(stageRuns).values({
    id: nanoid(),
    pipelineRunId: runId,
    stage,
    status: "running",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    turns: 0,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BEC-252 — recoverStuckRuns should mark retriable when worktree + transcript exist", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let tmpDir: string;
  let agentRunDir: string;
  let projectsDir: string;

  beforeEach(async () => {
    db = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    tmpDir = await mkdtemp(join(tmpdir(), "bec-252-"));
    agentRunDir = join(tmpDir, "runs");
    projectsDir = join(tmpDir, "projects");
    await mkdir(agentRunDir, { recursive: true });
    await mkdir(projectsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeRunner() {
    return new PipelineRunner({
      db: db as any,
      notifier: {
        onPipelineStart: vi.fn(async () => {}),
        onStageComplete: vi.fn(async () => {}),
        onPipelineComplete: vi.fn(async () => {}),
        onPipelineFailed: vi.fn(async () => {}),
      },
      agentRunDir,
      repoCloneDir: join(tmpDir, "repos"),
    });
  }

  it("marks run 'retriable' when worktree AND transcript both exist", async () => {
    const runId = nanoid();
    const issueId = "BEC-252-repro-1";
    const sessionId = nanoid();

    // 1. A run was in-flight when the server died
    await insertOrphanedRun(db, runId, issueId, sessionId);
    await insertLastStageRun(db, runId, "implement");

    // 2. The worktree survived on the persistent volume
    const worktreePath = join(agentRunDir, runId, "worktree");
    await mkdir(worktreePath, { recursive: true });

    // 3. The agent session JSONL survived (BEC-227 named volume mount)
    const encodedCwd = encodeCwd(worktreePath);
    const sessionDir = join(projectsDir, encodedCwd);
    await mkdir(sessionDir, { recursive: true });
    const transcriptPath = join(sessionDir, `${sessionId}.jsonl`);
    await writeFile(transcriptPath, '{"type":"system","content":"test"}\n');

    // 4. recoverStuckRuns fires on startup
    const runner = makeRunner();
    process.env.URATEAM_CLAUDE_PROJECTS_DIR = projectsDir;
    try {
      await runner.recoverStuckRuns();
    } finally {
      delete process.env.URATEAM_CLAUDE_PROJECTS_DIR;
    }

    // 5. Read back the run's final status — now retriable (BEC-252 fixed)
    const [run] = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));

    expect(run.status).toBe("retriable");
    expect(run.errorMessage).toContain("interrupted by server restart");
  });

  it("should still mark 'failed' when worktree is missing (no resumption possible)", async () => {
    const runId = nanoid();
    const issueId = "BEC-252-repro-2";
    const sessionId = nanoid();

    await insertOrphanedRun(db, runId, issueId, sessionId);
    await insertLastStageRun(db, runId, "implement");
    // No worktree directory created — it was cleaned up

    const runner = makeRunner();
    await runner.recoverStuckRuns();

    const [run] = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));

    // Without worktree, "failed" is correct (can't resume without worktree)
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("worktree not found");
  });

  it("should still mark 'failed' when transcript is missing (session can't be resumed)", async () => {
    const runId = nanoid();
    const issueId = "BEC-252-repro-3";
    const sessionId = nanoid();

    await insertOrphanedRun(db, runId, issueId, sessionId);
    await insertLastStageRun(db, runId, "implement");

    // Worktree exists but JSONL transcript does not (e.g. was on tmpfs)
    const worktreePath = join(agentRunDir, runId, "worktree");
    await mkdir(worktreePath, { recursive: true });
    // No transcript file created

    const runner = makeRunner();
    process.env.URATEAM_CLAUDE_PROJECTS_DIR = projectsDir;
    try {
      await runner.recoverStuckRuns();
    } finally {
      delete process.env.URATEAM_CLAUDE_PROJECTS_DIR;
    }

    const [run] = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));

    // Without transcript, "failed" is correct — BEC-227 resume needs the JSONL
    expect(run.status).toBe("failed");
  });

  it("should mark 'failed' for non-idempotent stages (push) regardless of worktree+transcript", async () => {
    const runId = nanoid();
    const issueId = "BEC-252-repro-4";
    const sessionId = nanoid();

    await insertOrphanedRun(db, runId, issueId, sessionId);
    // Last stage was "push" — resuming this would cause a duplicate push
    await insertLastStageRun(db, runId, "push");

    const worktreePath = join(agentRunDir, runId, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const encodedCwd = encodeCwd(worktreePath);
    const sessionDir = join(projectsDir, encodedCwd);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, `${sessionId}.jsonl`),
      '{"type":"system","content":"test"}\n',
    );

    const runner = makeRunner();
    process.env.URATEAM_CLAUDE_PROJECTS_DIR = projectsDir;
    try {
      await runner.recoverStuckRuns();
    } finally {
      delete process.env.URATEAM_CLAUDE_PROJECTS_DIR;
    }

    const [run] = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));

    // "push" is non-idempotent — should NOT be retriable even with worktree + transcript
    // The fix should keep this as "failed" with a clear "not safe to auto-resume" message
    expect(run.status).toBe("failed");
  });
});

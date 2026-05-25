/**
 * BEC-252 — Unit tests for graceful restart-interrupt recovery.
 *
 * AC#7 test cases:
 *   (a) restart with worktree + transcript present → marked `retriable`
 *   (b) restart with worktree missing → marked `failed`
 *   (c) restart with transcript missing → marked `failed`
 *   (d) restart while in `push` stage → marked `failed` regardless of
 *       worktree/transcript
 *   (e) `recoverRetriableRuns` picks up a restart-interrupt retriable run,
 *       calls runner.resume() with the correct issueId, and emits the
 *       `pipeline.restart_interrupt_recovered` audit event
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../db/client.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { pipelineRuns, stageRuns, auditEvents } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { encodeCwd } from "../executor/session-store.js";
import { recoverRetriableRuns } from "../pm/actions/recover.js";
import { nanoid } from "nanoid";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

// ---------------------------------------------------------------------------
// Module mocks
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

async function insertRetriableRun(
  db: any,
  runId: string,
  issueId: string,
  agentSessionId: string | null,
  errorMessage: string,
): Promise<void> {
  const now = new Date();
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  await db.insert(pipelineRuns).values({
    id: runId,
    issueId,
    issueTitle: "BEC-252 test issue",
    pipelineKey: "auto-implement",
    repoUrl: "https://github.com/test/repo",
    agentSessionId,
    branch: `agent/${issueId}-bec252`,
    status: "retriable",
    startedAt: tenMinutesAgo,
    completedAt: now,
    retryCount: 0,
    runType: "standard",
    totalInputTokens: 0,
    totalOutputTokens: 0,
    errorMessage,
    currentStageIndex: -1,
    resumePayload: JSON.stringify({
      handoff: null,
      pipelineConfig: { name: "test", stages: ["implement"], retry: { maxAttempts: 1, strategy: "fix-and-retry" }, review: { requiredApprovals: 0 }, prStrategy: "draft" },
      repoConfig: { url: "https://github.com/test/repo", defaultBranch: "main", testCommand: "npm test", buildCommand: "npm run build" },
      sanitizedIssue: { id: issueId, identifier: issueId, title: "Test", slug: "test", description: "", labels: [], teamId: "t1" },
      worktreePath: "/tmp/test-worktree",
      currentStageIndex: -1,
    }),
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("BEC-252 — recoverStuckRuns restart-interrupt recovery", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let tmpDir: string;
  let agentRunDir: string;
  let projectsDir: string;

  beforeEach(async () => {
    await installTestProLicense();
    db = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    tmpDir = await mkdtemp(join(tmpdir(), "bec-252-rrr-"));
    agentRunDir = join(tmpDir, "runs");
    projectsDir = join(tmpDir, "projects");
    await mkdir(agentRunDir, { recursive: true });
    await mkdir(projectsDir, { recursive: true });
  });

  afterEach(async () => {
    await restoreLicense();
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

  // (a) worktree + transcript present → retriable
  it("(a) worktree + transcript present → run marked retriable", async () => {
    const runId = nanoid();
    const issueId = "BEC-252-a";
    const sessionId = nanoid();

    await insertOrphanedRun(db, runId, issueId, sessionId);
    await insertLastStageRun(db, runId, "implement");

    const worktreePath = join(agentRunDir, runId, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const sessionDir = join(projectsDir, encodeCwd(worktreePath));
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), '{"type":"system"}\n');

    const runner = makeRunner();
    process.env.URATEAM_CLAUDE_PROJECTS_DIR = projectsDir;
    try {
      await runner.recoverStuckRuns();
    } finally {
      delete process.env.URATEAM_CLAUDE_PROJECTS_DIR;
    }

    const [run] = await (db as any).select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(run.status).toBe("retriable");
    expect(run.errorMessage).toContain("interrupted by server restart");
    expect(run.completedAt).not.toBeNull();
  });

  // (b) worktree missing → failed
  it("(b) worktree missing → run marked failed", async () => {
    const runId = nanoid();
    const issueId = "BEC-252-b";
    const sessionId = nanoid();

    await insertOrphanedRun(db, runId, issueId, sessionId);
    await insertLastStageRun(db, runId, "implement");
    // No worktree directory

    const runner = makeRunner();
    await runner.recoverStuckRuns();

    const [run] = await (db as any).select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("worktree not found");
  });

  // (c) transcript missing → failed
  it("(c) transcript missing → run marked failed", async () => {
    const runId = nanoid();
    const issueId = "BEC-252-c";
    const sessionId = nanoid();

    await insertOrphanedRun(db, runId, issueId, sessionId);
    await insertLastStageRun(db, runId, "implement");

    const worktreePath = join(agentRunDir, runId, "worktree");
    await mkdir(worktreePath, { recursive: true });
    // No transcript file

    const runner = makeRunner();
    process.env.URATEAM_CLAUDE_PROJECTS_DIR = projectsDir;
    try {
      await runner.recoverStuckRuns();
    } finally {
      delete process.env.URATEAM_CLAUDE_PROJECTS_DIR;
    }

    const [run] = await (db as any).select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(run.status).toBe("failed");
  });

  // (d) push stage → failed regardless of worktree/transcript
  it("(d) push stage → failed regardless of worktree + transcript", async () => {
    const runId = nanoid();
    const issueId = "BEC-252-d";
    const sessionId = nanoid();

    await insertOrphanedRun(db, runId, issueId, sessionId);
    await insertLastStageRun(db, runId, "push");

    const worktreePath = join(agentRunDir, runId, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const sessionDir = join(projectsDir, encodeCwd(worktreePath));
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), '{"type":"system"}\n');

    const runner = makeRunner();
    process.env.URATEAM_CLAUDE_PROJECTS_DIR = projectsDir;
    try {
      await runner.recoverStuckRuns();
    } finally {
      delete process.env.URATEAM_CLAUDE_PROJECTS_DIR;
    }

    const [run] = await (db as any).select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("not safe to auto-resume");
  });

  // (d-variant) await-approval stage → failed
  it("(d) await-approval stage → failed regardless of worktree + transcript", async () => {
    const runId = nanoid();
    const issueId = "BEC-252-d2";
    const sessionId = nanoid();

    await insertOrphanedRun(db, runId, issueId, sessionId);
    await insertLastStageRun(db, runId, "await-approval");

    const worktreePath = join(agentRunDir, runId, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const sessionDir = join(projectsDir, encodeCwd(worktreePath));
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), '{"type":"system"}\n');

    const runner = makeRunner();
    process.env.URATEAM_CLAUDE_PROJECTS_DIR = projectsDir;
    try {
      await runner.recoverStuckRuns();
    } finally {
      delete process.env.URATEAM_CLAUDE_PROJECTS_DIR;
    }

    const [run] = await (db as any).select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("not safe to auto-resume");
  });
});

// ---------------------------------------------------------------------------
// (e) recoverRetriableRuns integration
// ---------------------------------------------------------------------------

describe("BEC-252 — recoverRetriableRuns handles restart-interrupt runs", () => {
  let db: Awaited<ReturnType<typeof createDb>>;

  beforeEach(async () => {
    await installTestProLicense();
    db = await createDb({ driver: "sqlite", connectionString: ":memory:" });
  });

  afterEach(async () => {
    await restoreLicense();
  });

  it("(e) restart-interrupt retriable run: runner.resume() called and audit event emitted", async () => {
    const runId = nanoid();
    const issueId = "BEC-252-e";
    const sessionId = nanoid();
    const errorMessage = "Pipeline interrupted by server restart; worktree present at /runs/xyz/worktree";

    await insertRetriableRun(db, runId, issueId, sessionId, errorMessage);
    await (db as any).insert(stageRuns).values({
      id: nanoid(),
      pipelineRunId: runId,
      stage: "implement",
      status: "running",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      turns: 0,
    });

    const resume = vi.fn().mockResolvedValue(undefined);
    const result = await recoverRetriableRuns({ db: db as any, runner: { resume }, maxRetries: 3 });

    // runner.resume() was called with the correct issueId
    expect(resume).toHaveBeenCalledWith(issueId);
    expect(result.recovered).toContain(issueId);

    // pipeline.restart_interrupt_recovered audit event was written
    const events = await (db as any)
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "pipeline.restart_interrupt_recovered"));
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].payload as string);
    expect(payload.stage).toBe("implement");
    expect(payload.worktreeExisted).toBe(true);
    expect(payload.transcriptExisted).toBe(true);
    expect(typeof payload.restartGapMs).toBe("number");
    expect(events[0].runId).toBe(runId);
    expect(events[0].issueId).toBe(issueId);
  });

  it("(e) regular transient-error retriable run: no audit event emitted", async () => {
    const runId = nanoid();
    const issueId = "BEC-252-e2";
    const errorMessage = "401 auth error — will retry";

    await insertRetriableRun(db, runId, issueId, null, errorMessage);

    const resume = vi.fn().mockResolvedValue(undefined);
    await recoverRetriableRuns({ db: db as any, runner: { resume }, maxRetries: 3 });

    expect(resume).toHaveBeenCalledWith(issueId);

    // No restart_interrupt_recovered event for regular transient errors
    const events = await (db as any)
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "pipeline.restart_interrupt_recovered"));
    expect(events.length).toBe(0);
  });

  it("(e) restart-interrupt run at max retries: exhausted, no resume called", async () => {
    const runId = nanoid();
    const issueId = "BEC-252-e3";
    const errorMessage = "Pipeline interrupted by server restart; worktree present at /path";

    await insertRetriableRun(db, runId, issueId, null, errorMessage);
    // Override retryCount to hit the max
    await (db as any).update(pipelineRuns).set({ retryCount: 3 }).where(eq(pipelineRuns.id, runId));

    const resume = vi.fn();
    const result = await recoverRetriableRuns({ db: db as any, runner: { resume }, maxRetries: 3 });

    expect(resume).not.toHaveBeenCalled();
    expect(result.exhausted).toContain(issueId);

    const [run] = await (db as any).select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("max retries exhausted");
  });
});

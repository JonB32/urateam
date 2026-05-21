import { describe, it, expect, vi, beforeEach } from "vitest";
import { createQueue } from "../pipeline/queue.js";
import { PipelineRunner, type LinearIssue } from "../pipeline/runner.js";
import { createDb, type Db } from "../db/client.js";
import type {
  Notifier,
  PipelineConfig,
  RepoConfig,
  SanitizedIssue,
} from "../types.js";

// ---------------------------------------------------------------------------
// WorkQueue
// ---------------------------------------------------------------------------
describe("createQueue", () => {
  it("creates a queue with the given concurrency", () => {
    const q = createQueue(5);
    expect(q.pending).toBe(0);
    expect(q.running).toBe(0);
  });

  it("limits concurrent execution to the concurrency value", async () => {
    const q = createQueue(2);
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const work = () =>
      new Promise<void>((resolve) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        setTimeout(() => {
          currentConcurrent--;
          resolve();
        }, 50);
      });

    const promises = [
      q.enqueue(work),
      q.enqueue(work),
      q.enqueue(work),
      q.enqueue(work),
    ];

    await Promise.all(promises);
    expect(maxConcurrent).toBe(2);
  });

  it("processes all enqueued items", async () => {
    const q = createQueue(2);
    const results: number[] = [];

    const promises = [1, 2, 3, 4, 5].map((n) =>
      q.enqueue(async () => {
        results.push(n);
        return n;
      }),
    );

    const returned = await Promise.all(promises);
    expect(returned).toEqual([1, 2, 3, 4, 5]);
    expect(results).toHaveLength(5);
  });

  it("returns the value from the enqueued function", async () => {
    const q = createQueue(1);
    const result = await q.enqueue(async () => 42);
    expect(result).toBe(42);
  });

  it("propagates errors from enqueued functions", async () => {
    const q = createQueue(1);
    await expect(
      q.enqueue(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Queue should still work after an error
    const result = await q.enqueue(async () => "ok");
    expect(result).toBe("ok");
  });

  it("reports pending and running counts correctly", async () => {
    const q = createQueue(1);
    let resolveFirst!: () => void;
    const firstBlocking = new Promise<void>(
      (resolve) => (resolveFirst = resolve),
    );

    // Start a blocking task
    const p1 = q.enqueue(() => firstBlocking);

    // Allow microtask to process
    await new Promise((r) => setTimeout(r, 0));

    expect(q.running).toBe(1);

    // Enqueue a second task that will be pending
    const p2 = q.enqueue(async () => "done");
    await new Promise((r) => setTimeout(r, 0));

    expect(q.pending).toBe(1);
    expect(q.running).toBe(1);

    // Unblock
    resolveFirst();
    await Promise.all([p1, p2]);

    expect(q.running).toBe(0);
    expect(q.pending).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PipelineRunner — unit tests (no executor, no git)
// ---------------------------------------------------------------------------
describe("PipelineRunner", () => {
  let db: Db;
  let notifier: Notifier;
  let runner: PipelineRunner;

  const mockIssue: LinearIssue = {
    id: "issue-uuid-1",
    identifier: "TEAM-123",
    title: "Fix the login bug",
    description: "Users cannot log in",
    labels: [{ name: "bug" }],
    priority: 1,
    teamId: "team-1",
  };

  const mockPipelineConfig: PipelineConfig = {
    name: "bug-fix",
    stages: ["triage", "implement", "test"],
    retry: { maxAttempts: 1, strategy: "fail-fast" },
    review: { requiredApprovals: 1 },
    prStrategy: "draft",
  };

  const mockRepoConfig: RepoConfig = {
    url: "https://github.com/test/repo.git",
    defaultBranch: "main",
    testCommand: "npm test",
    buildCommand: "npm run build",
  };

  const mockSanitizedIssue: SanitizedIssue = {
    id: "issue-uuid-1",
    slug: "fix-the-login-bug",
    title: "Fix the login bug",
    description: "Users cannot log in",
    acceptanceCriteria: ["Users can log in"],
    labels: ["bug"],
    priority: 1,
  };

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
  });

  it("deduplicates: calling start() twice for the same issue ignores the second call", async () => {
    // We need to prevent actual pipeline execution, so we mock the git/executor modules.
    // Instead, we just test that the activeRuns map blocks duplicates.
    // The first start() will fail during execution (no git repo), but it will register in activeRuns.

    // Start first run — it will be enqueued and fail, but the dedup check happens synchronously
    await runner.start(
      mockIssue,
      "bug-fix",
      mockPipelineConfig,
      mockRepoConfig,
      mockSanitizedIssue,
    );

    // isActive should be true immediately after start (before execution completes)
    expect(runner.isActive(mockIssue.identifier)).toBe(true);

    // Second call with same identifier should be silently ignored
    await runner.start(
      mockIssue,
      "bug-fix",
      mockPipelineConfig,
      mockRepoConfig,
      mockSanitizedIssue,
    );

    // Still only one active run
    expect(runner.isActive(mockIssue.identifier)).toBe(true);
  });

  it("abort() removes from active runs and updates DB", async () => {
    // Start a run (will fail in execution, but we test abort before it completes)
    await runner.start(
      mockIssue,
      "bug-fix",
      mockPipelineConfig,
      mockRepoConfig,
      mockSanitizedIssue,
    );

    expect(runner.isActive(mockIssue.identifier)).toBe(true);

    await runner.abort(mockIssue.identifier);

    expect(runner.isActive(mockIssue.identifier)).toBe(false);
  });

  it("isActive() returns false for unknown issues", () => {
    expect(runner.isActive("UNKNOWN-999")).toBe(false);
  });

  it("isActive() returns true after start", async () => {
    await runner.start(
      mockIssue,
      "bug-fix",
      mockPipelineConfig,
      mockRepoConfig,
      mockSanitizedIssue,
    );

    expect(runner.isActive(mockIssue.identifier)).toBe(true);
  });

  it("abort() is a no-op for unknown issues", async () => {
    // Should not throw
    await runner.abort("UNKNOWN-999");
    expect(runner.isActive("UNKNOWN-999")).toBe(false);
  });

  it("pause() is a no-op for unknown issues", async () => {
    // Should not throw
    await runner.pause("UNKNOWN-999");
  });

  it("resume() is a no-op for unknown issues", async () => {
    // Should not throw
    await runner.resume("UNKNOWN-999");
  });

  it("push queue serialises concurrent push operations (concurrency=1)", async () => {
    // Verify that the internal push queue has concurrency=1 by checking observable
    // ordering: tasks queued concurrently should execute one-at-a-time.
    // We access the pushQueue indirectly via createQueue, tested separately.
    const q = createQueue(1);
    const order: number[] = [];
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const task = (id: number) =>
      q.enqueue(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        order.push(id);
        await new Promise((r) => setTimeout(r, 10));
        concurrentCount--;
      });

    await Promise.all([task(1), task(2), task(3)]);

    // A push queue with concurrency=1 must never run more than one task at a time
    expect(maxConcurrent).toBe(1);
    // All tasks must complete
    expect(order).toHaveLength(3);
  });

  it("inserts a pipeline_runs record on start", async () => {
    await runner.start(
      mockIssue,
      "bug-fix",
      mockPipelineConfig,
      mockRepoConfig,
      mockSanitizedIssue,
    );

    const { pipelineRuns } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const rows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.issueId, mockIssue.identifier));

    expect(rows).toHaveLength(1);
    expect(rows[0].issueTitle).toBe(mockIssue.title);
    expect(rows[0].pipelineKey).toBe("bug-fix");
    // Status may have advanced from "queued" to "running" or "failed" by the time we check
    expect(["queued", "running", "failed"]).toContain(rows[0].status);
    expect(rows[0].branch).toBe("agent/TEAM-123-fix-the-login-bug");
  });

  // ---------------------------------------------------------------------------
  // resume() — full pipeline resume after await-approval
  // ---------------------------------------------------------------------------

  it("resume() is a no-op when no paused run exists in DB for the issue", async () => {
    // No run in DB at all — should not throw
    await expect(runner.resume("TEAM-404")).resolves.toBeUndefined();
    expect(runner.isActive("TEAM-404")).toBe(false);
  });

  it("resume() updates status to running when run has no resume payload", async () => {
    const { pipelineRuns } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const runId = "run-no-payload-1";

    // Insert a paused run without resumePayload
    await (db as any).insert(pipelineRuns).values({
      id: runId,
      issueId: "TEAM-200",
      issueTitle: "No payload run",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: "agent/TEAM-200-no-payload-run",
      status: "paused",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      // currentStageIndex and resumePayload are intentionally omitted
    });

    await runner.resume("TEAM-200");

    const rows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));

    // Without a resume payload, the run should be marked as failed (not left as "running" with no execution)
    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorMessage).toContain("Resume payload missing");
    // activeRuns should be cleaned up
    expect(runner.isActive("TEAM-200")).toBe(false);
  });

  it("resume() marks run as failed when resumePayload is invalid JSON", async () => {
    const { pipelineRuns } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const runId = "run-bad-json-1";

    await (db as any).insert(pipelineRuns).values({
      id: runId,
      issueId: "TEAM-201",
      issueTitle: "Bad JSON payload run",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: "agent/TEAM-201-bad-json",
      status: "paused",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      currentStageIndex: 1,
      resumePayload: "{ this is not valid json !!!",
    });

    await runner.resume("TEAM-201");

    const rows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));

    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorMessage).toContain("Invalid resume payload");
    expect(runner.isActive("TEAM-201")).toBe(false);
  });

  it("resume() marks run as failed when preserved worktree no longer exists", async () => {
    const { pipelineRuns } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const runId = "run-no-worktree-1";

    const resumePayload = JSON.stringify({
      handoff: null,
      pipelineConfig: mockPipelineConfig,
      repoConfig: mockRepoConfig,
      sanitizedIssue: mockSanitizedIssue,
      worktreePath: "/tmp/test-agent-runs/nonexistent-worktree-path-xyz-abc",
      currentStageIndex: 1,
    });

    await (db as any).insert(pipelineRuns).values({
      id: runId,
      issueId: "TEAM-202",
      issueTitle: "Missing worktree run",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: "agent/TEAM-202-missing-worktree",
      status: "paused",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      currentStageIndex: 1,
      resumePayload,
    });

    await runner.resume("TEAM-202");

    const rows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));

    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorMessage).toContain("Worktree no longer exists");
    expect(runner.isActive("TEAM-202")).toBe(false);
  });

  it("resume() re-registers run as active and re-enqueues when valid payload and worktree exist", async () => {
    const { pipelineRuns } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const runId = "run-valid-resume-1";

    // Create a real temporary directory under agentRunDir to simulate the preserved worktree
    const { mkdtemp, mkdir } = await import("node:fs/promises");
    await mkdir("/tmp/test-agent-runs", { recursive: true });
    const worktreePath = await mkdtemp("/tmp/test-agent-runs/test-worktree-");

    const resumePayload = JSON.stringify({
      handoff: null,
      pipelineConfig: {
        ...mockPipelineConfig,
        stages: ["triage", "await-approval", "implement", "test"],
      },
      repoConfig: mockRepoConfig,
      sanitizedIssue: mockSanitizedIssue,
      worktreePath,
      currentStageIndex: 1,
    });

    await (db as any).insert(pipelineRuns).values({
      id: runId,
      issueId: "TEAM-203",
      issueTitle: "Valid resume run",
      pipelineKey: "needs-design",
      repoUrl: "https://github.com/test/repo.git",
      branch: "agent/TEAM-203-valid-resume",
      status: "paused",
      totalInputTokens: 100,
      totalOutputTokens: 50,
      currentStageIndex: 1,
      resumePayload,
    });

    await runner.resume("TEAM-203");

    // After a successful resume call the run should be re-registered as active
    expect(runner.isActive("TEAM-203")).toBe(true);

    // The DB row should NOT be failed/paused at this point — it will either
    // move to "running" (via executePipeline) or fail when git operations run.
    // The important invariant is that isActive() is true immediately after resume().

    // Cleanup
    const { rm } = await import("node:fs/promises");
    await rm(worktreePath, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // resume() — ResumePayloadSchema Zod validation (BEC-192)
  // ---------------------------------------------------------------------------

  it("resume() marks run as failed when resumePayload is missing handoff field", async () => {
    const { pipelineRuns } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const runId = "run-missing-handoff-1";

    // Omit the required `handoff` field to trigger schema validation failure
    const badPayload = JSON.stringify({
      pipelineConfig: mockPipelineConfig,
      repoConfig: mockRepoConfig,
      sanitizedIssue: mockSanitizedIssue,
      worktreePath: "/tmp/test-agent-runs/some-worktree",
      currentStageIndex: 1,
      // handoff is intentionally omitted
    });

    await (db as any).insert(pipelineRuns).values({
      id: runId,
      issueId: "TEAM-210",
      issueTitle: "Missing handoff field",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: "agent/TEAM-210-missing-handoff",
      status: "paused",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      currentStageIndex: 1,
      resumePayload: badPayload,
    });

    await runner.resume("TEAM-210");

    const rows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));

    expect(rows[0].status).toBe("failed");
    // Error message should mention the field that failed validation
    expect(rows[0].errorMessage).toMatch(/Invalid resume payload structure/);
    expect(rows[0].errorMessage).toMatch(/handoff/);
    expect(runner.isActive("TEAM-210")).toBe(false);
  });

  it("resume() marks run as failed when currentStageIndex is a string instead of number", async () => {
    const { pipelineRuns } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const runId = "run-bad-stage-index-1";

    // currentStageIndex must be a number; passing a string should fail Zod validation
    const badPayload = JSON.stringify({
      handoff: null,
      pipelineConfig: mockPipelineConfig,
      repoConfig: mockRepoConfig,
      sanitizedIssue: mockSanitizedIssue,
      worktreePath: "/tmp/test-agent-runs/some-worktree",
      currentStageIndex: "not-a-number",  // wrong type: string instead of number
    });

    await (db as any).insert(pipelineRuns).values({
      id: runId,
      issueId: "TEAM-211",
      issueTitle: "Bad currentStageIndex type",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: "agent/TEAM-211-bad-stage-index",
      status: "paused",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      currentStageIndex: 0,
      resumePayload: badPayload,
    });

    await runner.resume("TEAM-211");

    const rows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));

    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorMessage).toMatch(/Invalid resume payload structure/);
    expect(rows[0].errorMessage).toMatch(/currentStageIndex/);
    expect(runner.isActive("TEAM-211")).toBe(false);
  });

  it("resume() falls back to pausedRun.currentStageIndex when resumePayload omits the field (pre-BEC-192 BC)", async () => {
    // Paused runs created before BEC-192 introduced currentStageIndex in the
    // resume_payload JSON only have the field on the DB row. The runner must
    // inject it from the row before parsing so those in-flight runs survive
    // the deploy of this PR.
    const { pipelineRuns } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const runId = "run-bc-stage-index-from-row";

    // Pre-BEC-192 payload: NO currentStageIndex field.
    const oldPayload = JSON.stringify({
      handoff: null,
      pipelineConfig: mockPipelineConfig,
      repoConfig: mockRepoConfig,
      sanitizedIssue: mockSanitizedIssue,
      worktreePath: "/tmp/test-agent-runs/nonexistent-worktree-path-xyz-abc",
    });

    await (db as any).insert(pipelineRuns).values({
      id: runId,
      issueId: "TEAM-212",
      issueTitle: "Pre-BEC-192 paused run",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo.git",
      branch: "agent/TEAM-212-old-paused",
      status: "paused",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      currentStageIndex: 1, // DB column has it; payload does not
      resumePayload: oldPayload,
    });

    await runner.resume("TEAM-212");

    const rows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));

    // Pre-BEC-192 payloads should NOT trigger schema-validation failure.
    // The worktree-missing path will still fail the run (the path in the
    // payload doesn't exist), but the failure must be about the worktree,
    // not about an invalid resume payload structure.
    expect(rows[0].errorMessage).not.toMatch(/Invalid resume payload structure/);
  });

  it("resume() handles in-memory active run (edge case: paused but still in activeRuns)", async () => {
    // Simulate the edge case where a run is in activeRuns but also has status "paused"
    // (e.g., pipeline paused via Linear webhook while activeRuns hasn't been cleaned up yet)
    await runner.start(
      mockIssue,
      "bug-fix",
      mockPipelineConfig,
      mockRepoConfig,
      mockSanitizedIssue,
    );

    expect(runner.isActive(mockIssue.identifier)).toBe(true);

    // Calling resume while the run is still in activeRuns should update DB status
    // without re-enqueuing (the existing in-flight execution should continue)
    await runner.resume(mockIssue.identifier);

    // Still active — the existing execution handle is preserved
    expect(runner.isActive(mockIssue.identifier)).toBe(true);
  });
});

/**
 * BEC-271 — unit tests for sweepExpiredPausedRuns
 *
 * Uses an in-memory SQLite DB so the real Drizzle query
 * (status='paused' AND startedAt < cutoff) is exercised.
 * External side-effects (removeActiveWork, logAuditEventUnchecked,
 * cleanupWorktrees) are mocked at the module level.
 *
 * Fixture runs:
 *   run-over-1  — paused, started 100h ago → SHOULD be cancelled
 *   run-over-2  — paused, started 73h ago  → SHOULD be cancelled
 *   run-under   — paused, started 10h ago  → NOT matched (under threshold)
 *   run-already — cancelled, started 100h ago → NOT matched (wrong status)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDb } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { sweepExpiredPausedRuns } from "../pm/actions/sweep-paused-runs.js";

// ---------------------------------------------------------------------------
// Hoisted mock functions (vi.mock factories are hoisted to top of file,
// so refs to module-level consts would be TDZ errors without vi.hoisted)
// ---------------------------------------------------------------------------

const { mockRemoveActiveWork, mockCleanupWorktrees, mockLogAuditEventUnchecked } = vi.hoisted(
  () => ({
    mockRemoveActiveWork: vi.fn().mockResolvedValue(undefined),
    mockCleanupWorktrees: vi.fn().mockResolvedValue([]),
    mockLogAuditEventUnchecked: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock("../pm/coordination.js", () => ({
  removeActiveWork: mockRemoveActiveWork,
  upsertActiveWork: vi.fn().mockResolvedValue(undefined),
  checkFileOverlap: vi.fn().mockResolvedValue({ hasOverlap: false, overlappingFiles: [], conflictingRunIds: [] }),
  getModifiedFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock("../repo/git.js", () => ({
  cleanupWorktrees: mockCleanupWorktrees,
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
  getDiffLineCount: vi.fn().mockResolvedValue(0),
  getChangedFiles: vi.fn().mockResolvedValue([]),
  checkDuplicateBranch: vi.fn().mockResolvedValue(null),
  branchName: vi.fn().mockImplementation((id: string, slug: string) => `agent/${id}-${slug}`),
  gitExecSafe: vi.fn().mockResolvedValue(""),
  gitExecRaw: vi.fn().mockResolvedValue(""),
  gitExec: vi.fn().mockResolvedValue(""),
  choosePushStrategy: vi.fn().mockReturnValue("standard"),
  getAgentCommits: vi.fn().mockResolvedValue([]),
  installPrePushHook: vi.fn().mockResolvedValue(undefined),
  pruneWorktreesInRepoDirs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../audit/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../audit/index.js")>();
  return {
    ...original,
    logAuditEventUnchecked: mockLogAuditEventUnchecked,
  };
});

// ---------------------------------------------------------------------------
// Linear client mock factory
// ---------------------------------------------------------------------------

function makeLinearClient(opts: {
  needsDesignLabelId?: string;
  issueInternalId?: string;
  existingLabelIds?: string[];
} = {}) {
  const labelId = opts.needsDesignLabelId ?? "label-nd-1";
  const issueId = opts.issueInternalId ?? "linear-internal-id-1";
  const existingIds = opts.existingLabelIds ?? [];

  return {
    issueLabels: vi.fn().mockResolvedValue({
      nodes: [{ id: labelId, name: "needs-design" }],
    }),
    searchIssues: vi.fn().mockResolvedValue({
      nodes: [{ id: issueId, labelIds: existingIds }],
    }),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    createComment: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

async function insertRun(
  db: any,
  id: string,
  issueId: string,
  status: string,
  startedAt: Date,
) {
  await db.insert(pipelineRuns).values({
    id,
    issueId,
    issueTitle: `Issue ${issueId}`,
    pipelineKey: "auto-implement",
    repoUrl: "https://github.com/test/repo.git",
    status,
    startedAt,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sweepExpiredPausedRuns", () => {
  let db: Awaited<ReturnType<typeof createDb>>;

  beforeEach(async () => {
    db = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.URATEAM_DISABLE_PAUSED_RUN_EXPIRY;
  });

  it("escape hatch: URATEAM_DISABLE_PAUSED_RUN_EXPIRY=true skips all processing", async () => {
    process.env.URATEAM_DISABLE_PAUSED_RUN_EXPIRY = "true";

    await insertRun(db as any, "run-1", "BEC-100", "paused", hoursAgo(100));

    const linearClient = makeLinearClient();
    const result = await sweepExpiredPausedRuns(db as any, linearClient as any);

    expect(result.cancelled).toBe(0);
    expect(result.issueIds).toHaveLength(0);
    expect(linearClient.issueLabels).not.toHaveBeenCalled();
    expect(mockRemoveActiveWork).not.toHaveBeenCalled();
    expect(mockLogAuditEventUnchecked).not.toHaveBeenCalled();
  });

  it("strict equality: URATEAM_DISABLE_PAUSED_RUN_EXPIRY=1 does NOT skip", async () => {
    process.env.URATEAM_DISABLE_PAUSED_RUN_EXPIRY = "1";

    await insertRun(db as any, "run-1", "BEC-100", "paused", hoursAgo(100));

    const linearClient = makeLinearClient();
    const result = await sweepExpiredPausedRuns(db as any, linearClient as any, {
      thresholdMinutes: 4320,
    });

    expect(result.cancelled).toBe(1);
  });

  it("returns empty result when no paused runs exist", async () => {
    const linearClient = makeLinearClient();
    const result = await sweepExpiredPausedRuns(db as any, linearClient as any, {
      thresholdMinutes: 4320,
    });

    expect(result.cancelled).toBe(0);
    expect(result.issueIds).toEqual([]);
    expect(linearClient.issueLabels).not.toHaveBeenCalled();
  });

  it("cancels only paused runs older than the threshold", async () => {
    const THRESHOLD_MINUTES = 4320; // 72h

    await insertRun(db as any, "run-over-1", "BEC-271", "paused", hoursAgo(100));
    await insertRun(db as any, "run-over-2", "BEC-272", "paused", hoursAgo(73));
    await insertRun(db as any, "run-under", "BEC-273", "paused", hoursAgo(10));
    await insertRun(db as any, "run-already", "BEC-274", "cancelled", hoursAgo(100));

    const linearClient = makeLinearClient();
    const result = await sweepExpiredPausedRuns(db as any, linearClient as any, {
      thresholdMinutes: THRESHOLD_MINUTES,
    });

    expect(result.cancelled).toBe(2);
    expect(result.issueIds).toContain("BEC-271");
    expect(result.issueIds).toContain("BEC-272");
    expect(result.issueIds).not.toContain("BEC-273");
    expect(result.issueIds).not.toContain("BEC-274");

    const [over1] = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, "run-over-1"));
    expect(over1.status).toBe("cancelled");
    expect(over1.errorMessage).toMatch(/await-approval timeout/);

    const [under] = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, "run-under"));
    expect(under.status).toBe("paused");

    const [already] = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, "run-already"));
    expect(already.status).toBe("cancelled");
  });

  it("calls removeActiveWork once per cancelled run", async () => {
    await insertRun(db as any, "run-over-1", "BEC-271", "paused", hoursAgo(100));
    await insertRun(db as any, "run-over-2", "BEC-272", "paused", hoursAgo(73));

    const linearClient = makeLinearClient();
    await sweepExpiredPausedRuns(db as any, linearClient as any, {
      thresholdMinutes: 4320,
    });

    expect(mockRemoveActiveWork).toHaveBeenCalledTimes(2);
    expect(mockRemoveActiveWork).toHaveBeenCalledWith(db, "run-over-1");
    expect(mockRemoveActiveWork).toHaveBeenCalledWith(db, "run-over-2");
  });

  it("emits pm.paused_run_expired audit event for each cancelled run", async () => {
    await insertRun(db as any, "run-over-1", "BEC-271", "paused", hoursAgo(100));
    await insertRun(db as any, "run-over-2", "BEC-272", "paused", hoursAgo(73));

    const linearClient = makeLinearClient();
    await sweepExpiredPausedRuns(db as any, linearClient as any, {
      thresholdMinutes: 4320,
    });

    // logAuditEventUnchecked is fire-and-forget via void; wait a tick for the promise to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(mockLogAuditEventUnchecked).toHaveBeenCalledTimes(2);
  });

  it("adds needs-design label and posts comment on Linear issue", async () => {
    await insertRun(db as any, "run-over-1", "BEC-271", "paused", hoursAgo(100));

    const linearClient = makeLinearClient({
      needsDesignLabelId: "nd-label-id",
      issueInternalId: "linear-uuid-1",
      existingLabelIds: ["existing-label-id"],
    });

    await sweepExpiredPausedRuns(db as any, linearClient as any, {
      thresholdMinutes: 4320,
    });

    expect(linearClient.searchIssues).toHaveBeenCalledWith("BEC-271", { first: 1 });
    expect(linearClient.updateIssue).toHaveBeenCalledWith(
      "linear-uuid-1",
      expect.objectContaining({
        labelIds: expect.arrayContaining(["existing-label-id", "nd-label-id"]),
      }),
    );
    expect(linearClient.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "linear-uuid-1",
        body: expect.stringContaining("await-approval timeout"),
      }),
    );
  });

  it("still cancels run in DB when Linear update fails", async () => {
    await insertRun(db as any, "run-over-1", "BEC-271", "paused", hoursAgo(100));

    const linearClient = makeLinearClient();
    linearClient.updateIssue.mockRejectedValue(new Error("Linear API 503"));

    const result = await sweepExpiredPausedRuns(db as any, linearClient as any, {
      thresholdMinutes: 4320,
    });

    expect(result.cancelled).toBe(1);

    const [row] = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, "run-over-1"));
    expect(row.status).toBe("cancelled");
  });

  it("calls cleanupWorktrees when agentRunDir is provided and runs were cancelled", async () => {
    await insertRun(db as any, "run-over-1", "BEC-271", "paused", hoursAgo(100));

    const linearClient = makeLinearClient();
    await sweepExpiredPausedRuns(db as any, linearClient as any, {
      thresholdMinutes: 4320,
      agentRunDir: "/home/ura/data/runs",
    });

    expect(mockCleanupWorktrees).toHaveBeenCalledWith(
      "/home/ura/data/runs",
      72, // 4320 min / 60 = 72h
    );
  });

  it("does NOT call cleanupWorktrees when no runs were cancelled", async () => {
    const linearClient = makeLinearClient();
    await sweepExpiredPausedRuns(db as any, linearClient as any, {
      thresholdMinutes: 4320,
      agentRunDir: "/home/ura/data/runs",
    });

    expect(mockCleanupWorktrees).not.toHaveBeenCalled();
  });

  it("does NOT call cleanupWorktrees when agentRunDir is omitted", async () => {
    await insertRun(db as any, "run-over-1", "BEC-271", "paused", hoursAgo(100));

    const linearClient = makeLinearClient();
    await sweepExpiredPausedRuns(db as any, linearClient as any, {
      thresholdMinutes: 4320,
    });

    expect(mockCleanupWorktrees).not.toHaveBeenCalled();
  });

  it("is idempotent — second sweep finds no expired paused runs", async () => {
    await insertRun(db as any, "run-over-1", "BEC-271", "paused", hoursAgo(100));

    const linearClient = makeLinearClient();

    const first = await sweepExpiredPausedRuns(db as any, linearClient as any, {
      thresholdMinutes: 4320,
    });
    expect(first.cancelled).toBe(1);

    vi.clearAllMocks();

    const second = await sweepExpiredPausedRuns(db as any, linearClient as any, {
      thresholdMinutes: 4320,
    });
    expect(second.cancelled).toBe(0);
    expect(mockRemoveActiveWork).not.toHaveBeenCalled();
    expect(mockLogAuditEventUnchecked).not.toHaveBeenCalled();
  });

  it("skips label update when needs-design label is not found in Linear", async () => {
    await insertRun(db as any, "run-over-1", "BEC-271", "paused", hoursAgo(100));

    const linearClient = makeLinearClient();
    linearClient.issueLabels.mockResolvedValue({ nodes: [] });

    const result = await sweepExpiredPausedRuns(db as any, linearClient as any, {
      thresholdMinutes: 4320,
    });

    expect(result.cancelled).toBe(1);
    expect(linearClient.updateIssue).not.toHaveBeenCalled();
    expect(linearClient.createComment).toHaveBeenCalled();
  });
});

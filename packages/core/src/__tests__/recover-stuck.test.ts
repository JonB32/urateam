/**
 * Tests for BEC-91: recoverStuckInProgressIssues action
 *
 * Verifies that stuck "In Progress" Linear issues (no active pipeline run) are
 * auto-detected, moved to the target state, and Slack notifications are sent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { recoverStuckInProgressIssues } from "../pm/actions/recover-stuck.js";

// vi.hoisted ensures mockLogWarn is created before vi.mock factories execute
// (vi.mock is hoisted above variable declarations by vitest's transform).
const { mockLogWarn } = vi.hoisted(() => ({ mockLogWarn: vi.fn() }));

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLinearClient(inProgressIssues: any[] = []) {
  return {
    issues: vi.fn().mockResolvedValue({ nodes: inProgressIssues }),
    updateIssue: vi.fn().mockResolvedValue({}),
    createComment: vi.fn().mockResolvedValue({}),
    workflowStates: vi.fn().mockResolvedValue({ nodes: [] }),
  };
}

function makeDb(
  activeRows: { issueId: string }[] = [],
  runs: any[] = [],
  recentRows: { issueId: string }[] = [],
) {
  // The real Drizzle select chain: db.select().from().where()
  // We need to mock three calls:
  //   1. active runs query
  //   2. recently completed/failed runs query
  //   3. batch run status query
  const whereFn = vi.fn()
    .mockResolvedValueOnce(activeRows)
    .mockResolvedValueOnce(recentRows)
    .mockResolvedValueOnce(runs);
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: whereFn,
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recoverStuckInProgressIssues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no issues are in In Progress state", async () => {
    const linearClient = makeLinearClient([]);
    const db = makeDb();
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
    });

    expect(result).toEqual([]);
    expect(linearClient.updateIssue).not.toHaveBeenCalled();
  });

  it("does NOT mark issues with active pipeline runs as stuck", async () => {
    const issue = {
      id: "issue-uuid-1",
      identifier: "BEC-10",
      title: "Active issue",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };
    const linearClient = makeLinearClient([issue]);
    // This issue has an active (running) pipeline run — DB stores identifier, not UUID
    const db = makeDb([{ issueId: "BEC-10" }]);
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
    });

    expect(result).toEqual([]);
    expect(linearClient.updateIssue).not.toHaveBeenCalled();
  });

  it("recovers stuck issue with failed last run and moves to Backlog", async () => {
    const issue = {
      id: "issue-uuid-stuck",
      identifier: "BEC-99",
      title: "Stuck issue with failed run",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };
    const linearClient = makeLinearClient([issue]);
    // No active runs — DB stores identifier, not UUID
    const db = makeDb([], [
      {
        issueId: "BEC-99",
        status: "failed",
        startedAt: new Date("2026-04-01"),
      },
    ]);
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      issueId: "issue-uuid-stuck",
      identifier: "BEC-99",
      title: "Stuck issue with failed run",
      previousState: "In Progress",
      lastRunStatus: "failed",
      targetState: "Backlog",
    });

    expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-uuid-stuck", {
      stateId: "state-backlog-1",
    });
    expect(linearClient.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "issue-uuid-stuck" }),
    );
  });

  it("recovers stuck issue with completed last run and moves to Todo", async () => {
    const issue = {
      id: "issue-uuid-done",
      identifier: "BEC-88",
      title: "Completed but stuck in Linear",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };
    const linearClient = makeLinearClient([issue]);
    const db = makeDb([], [
      {
        issueId: "BEC-88",
        status: "completed",
        startedAt: new Date("2026-04-02"),
      },
    ]);
    const stateMap = new Map([["team-1:Todo", "state-todo-1"]]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Todo",
      maxPerTick: 5,
      stateMap,
    });

    expect(result).toHaveLength(1);
    expect(result[0].lastRunStatus).toBe("completed");
    expect(result[0].targetState).toBe("Todo");
    expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-uuid-done", {
      stateId: "state-todo-1",
    });
  });

  it("BEC-165: stuck-In-Progress with completed last run + pr_url moves to In Review (not Backlog)", async () => {
    // Defense-in-depth: even when the runner forgot to move Linear → In Review
    // after PR creation (the original BEC-165 bug at the source), recover-stuck
    // should NOT move the issue back to Backlog and re-trigger the doom loop.
    // It should detect the open PR and move to In Review instead.
    const issue = {
      id: "issue-uuid-completed-with-pr",
      identifier: "BEC-153",
      title: "Stuck issue with completed PR",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };
    const linearClient = makeLinearClient([issue]);
    const db = makeDb([], [
      {
        issueId: "BEC-153",
        status: "completed",
        startedAt: new Date("2026-05-07T15:13:00Z"),
        prUrl: "https://github.com/JonB32/urateam/pull/172",
      },
    ]);
    const stateMap = new Map([
      ["team-1:Backlog", "state-backlog-1"],
      ["team-1:In Review", "state-in-review-1"],
    ]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",  // caller wanted Backlog…
      maxPerTick: 5,
      stateMap,
    });

    expect(result).toHaveLength(1);
    expect(result[0].lastRunStatus).toBe("completed");
    // …but the open-PR override redirected to In Review.
    expect(result[0].targetState).toBe("In Review");
    expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-uuid-completed-with-pr", {
      stateId: "state-in-review-1",
    });
  });

  it("BEC-165: completed last run WITHOUT pr_url falls through to caller's targetState (genuine no-progress recovery)", async () => {
    // Distinguish from the override path — a completed run with no PR is a
    // legitimate "no work shipped" recovery; should still go to Backlog.
    const issue = {
      id: "issue-uuid-completed-no-pr",
      identifier: "BEC-99",
      title: "Stuck no-op completed run",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };
    const linearClient = makeLinearClient([issue]);
    const db = makeDb([], [
      {
        issueId: "BEC-99",
        status: "completed",
        startedAt: new Date("2026-04-02"),
        prUrl: null,
      },
    ]);
    const stateMap = new Map([
      ["team-1:Backlog", "state-backlog-1"],
      ["team-1:In Review", "state-in-review-1"],
    ]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
    });

    expect(result[0].targetState).toBe("Backlog");
    expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-uuid-completed-no-pr", {
      stateId: "state-backlog-1",
    });
  });

  it("BEC-165: open-PR override falls back to caller's targetState when In Review state-id is missing", async () => {
    // Defense in depth shouldn't crash if the workspace has no In Review state
    // (some Linear setups customize the column names). Fall back to original
    // behavior so the issue still moves out of stuck In Progress.
    const issue = {
      id: "issue-uuid-no-in-review",
      identifier: "BEC-100",
      title: "Workspace lacks In Review",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };
    const linearClient = makeLinearClient([issue]);
    const db = makeDb([], [
      {
        issueId: "BEC-100",
        status: "completed",
        startedAt: new Date("2026-04-02"),
        prUrl: "https://github.com/x/y/pull/1",
      },
    ]);
    // Note: stateMap intentionally omits "In Review"
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
    });

    expect(result[0].targetState).toBe("Backlog");
    expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-uuid-no-in-review", {
      stateId: "state-backlog-1",
    });
  });

  it("recovers orphaned issue with no DB record", async () => {
    const issue = {
      id: "issue-orphan",
      identifier: "BEC-77",
      title: "Orphaned with no run",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };
    const linearClient = makeLinearClient([issue]);
    // No active runs, no historical runs either
    const db = makeDb([], []);
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
    });

    expect(result).toHaveLength(1);
    expect(result[0].lastRunStatus).toBeNull();
    expect(result[0].identifier).toBe("BEC-77");
  });

  it("enforces maxPerTick rate limit", async () => {
    const issues = Array.from({ length: 10 }, (_, i) => ({
      id: `issue-uuid-${i}`,
      identifier: `BEC-${i}`,
      title: `Stuck issue ${i}`,
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    }));
    const linearClient = makeLinearClient(issues);
    // No active runs
    const db = makeDb([], []);
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 3, // Only allow 3 per tick
      stateMap,
    });

    expect(result).toHaveLength(3);
    expect(linearClient.updateIssue).toHaveBeenCalledTimes(3);
  });

  it("calls postSlackNotification with recovered issues", async () => {
    const issue = {
      id: "issue-slack-test",
      identifier: "BEC-42",
      title: "Slack notification test",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };
    const linearClient = makeLinearClient([issue]);
    const db = makeDb([], []);
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);
    const postSlackNotification = vi.fn().mockResolvedValue(undefined);

    await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
      postSlackNotification,
    });

    expect(postSlackNotification).toHaveBeenCalledTimes(1);
    const notifiedIssues = postSlackNotification.mock.calls[0][0];
    expect(notifiedIssues).toHaveLength(1);
    expect(notifiedIssues[0].identifier).toBe("BEC-42");
  });

  it("does not call postSlackNotification when no issues are recovered", async () => {
    const linearClient = makeLinearClient([]);
    const db = makeDb();
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);
    const postSlackNotification = vi.fn().mockResolvedValue(undefined);

    await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
      postSlackNotification,
    });

    expect(postSlackNotification).not.toHaveBeenCalled();
  });

  it("skips issue when no target state ID found for team", async () => {
    const issue = {
      id: "issue-no-state",
      identifier: "BEC-55",
      title: "No state mapping",
      team: Promise.resolve({ id: "team-unknown" }),
      state: Promise.resolve({ name: "In Progress" }),
    };
    const linearClient = makeLinearClient([issue]);
    const db = makeDb([], []);
    // stateMap has no entry for team-unknown:Backlog
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
    });

    expect(result).toHaveLength(0);
    expect(linearClient.updateIssue).not.toHaveBeenCalled();
  });

  it("uses most recent run status when multiple runs exist for an issue", async () => {
    const issue = {
      id: "issue-multi-run",
      identifier: "BEC-33",
      title: "Multiple runs",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };
    const linearClient = makeLinearClient([issue]);
    // Two runs: older completed, newer failed — DB stores identifier
    const db = makeDb([], [
      {
        issueId: "BEC-33",
        status: "completed",
        startedAt: new Date("2026-03-01"),
      },
      {
        issueId: "BEC-33",
        status: "failed",
        startedAt: new Date("2026-04-01"), // more recent
      },
    ]);
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
    });

    expect(result).toHaveLength(1);
    // Most recent run (failed) is used
    expect(result[0].lastRunStatus).toBe("failed");
  });

  it("logs truncation warning when Linear returns exactly 50 issues", async () => {
    // Build exactly 50 issues — the hard cap for the query
    const issues = Array.from({ length: 50 }, (_, i) => ({
      id: `issue-uuid-${i}`,
      identifier: `BEC-${i + 200}`,
      title: `Stuck issue ${i}`,
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    }));
    const linearClient = makeLinearClient(issues);
    // No active runs so all are considered stuck
    const db = makeDb([], []);
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 50,
      stateMap,
    });

    // The truncation warning must be logged with the exact required message
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ count: 50 }),
      "stuck-issue query may be truncated — consider pagination",
    );
  });

  it("does NOT log truncation warning when Linear returns fewer than 50 issues", async () => {
    const issues = Array.from({ length: 3 }, (_, i) => ({
      id: `issue-uuid-${i}`,
      identifier: `BEC-${i + 300}`,
      title: `Stuck issue ${i}`,
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    }));
    const linearClient = makeLinearClient(issues);
    const db = makeDb([], []);
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
    });

    // No truncation warning should be emitted
    const truncationWarningCalls = mockLogWarn.mock.calls.filter(
      (args) => args[1] === "stuck-issue query may be truncated — consider pagination",
    );
    expect(truncationWarningCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // BEC-262 regression: already-shipped issues should be skipped entirely
  // ---------------------------------------------------------------------------

  it("BEC-262 REPRODUCE: skips issue when most-recent run is completed + auto_merged=true (currently FAILS — bug present)", async () => {
    // This is the exact scenario from BEC-262:
    //   1. urateam shipped the work (pipeline_run: status=completed, auto_merged=true, pr_url set)
    //   2. Linear PR-automation (an external sidecar PR mentioning the issue) moved the issue back
    //      to "In Progress"
    //   3. Next PM tick calls recoverStuckInProgressIssues, which should see the shipped run and
    //      do NOTHING — but currently it moves the issue to "In Review" instead.
    const issue = {
      id: "issue-uuid-bec262",
      identifier: "BEC-142",
      title: "Already-shipped issue ping-ponged by Linear PR automation",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };
    const linearClient = makeLinearClient([issue]);
    // Most-recent run: completed, auto-merged (work shipped), has a prUrl
    const db = makeDb([], [
      {
        id: "run-shipped",
        issueId: "BEC-142",
        status: "completed",
        autoMerged: true,
        startedAt: new Date("2026-05-25T23:45:00Z"),
        prUrl: "https://github.com/JonB32/urateam/pull/410",
      },
    ]);
    const stateMap = new Map([
      ["team-1:Backlog", "state-backlog-1"],
      ["team-1:In Review", "state-in-review-1"],
    ]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
    });

    // The issue was already shipped — recoverStuck should skip it entirely.
    expect(result).toHaveLength(0);
    expect(linearClient.updateIssue).not.toHaveBeenCalled();
    expect(linearClient.createComment).not.toHaveBeenCalled();
  });

  it("handles Linear updateIssue error gracefully and continues with other issues", async () => {
    const issues = [
      {
        id: "issue-fail",
        identifier: "BEC-11",
        title: "Will fail update",
        team: Promise.resolve({ id: "team-1" }),
        state: Promise.resolve({ name: "In Progress" }),
      },
      {
        id: "issue-ok",
        identifier: "BEC-12",
        title: "Will succeed",
        team: Promise.resolve({ id: "team-1" }),
        state: Promise.resolve({ name: "In Progress" }),
      },
    ];
    const linearClient = makeLinearClient(issues);
    // First updateIssue throws, second succeeds
    linearClient.updateIssue
      .mockRejectedValueOnce(new Error("Linear API error"))
      .mockResolvedValueOnce({});

    const db = makeDb([], []);
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
    });

    // Only the successful issue is returned
    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe("BEC-12");
  });
});

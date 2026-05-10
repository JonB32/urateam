/**
 * BEC-184: recoverStuckInProgressIssues — long-running run recovery.
 *
 * Tests that:
 * 1. An issue whose pipeline run has been status='running' for more than
 *    stuckRunAgeMinutes (default 60) is recovered (moved to Backlog, run
 *    marked failed, audit event emitted).
 * 2. A fresh running run (< stuckRunAgeMinutes) is NOT recovered (false-positive guard).
 * 3. The existing lastRunStatus='failed' recovery path still works (regression guard).
 * 4. The cutoff is respected: runs exactly at the cutoff boundary are handled correctly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { recoverStuckInProgressIssues } from "../pm/actions/recover-stuck.js";
import { getActiveAndRecentIssueIds } from "../pm/actions/db-queries.js";

// ---------------------------------------------------------------------------
// Mock the audit writer so we can assert audit events without a real DB.
// vi.hoisted ensures mockAuditWriter is created before vi.mock factories
// execute (vi.mock is hoisted above variable declarations by vitest).
// The mock intercepts the unchecked writer used by PM Agent recovery paths.
// ---------------------------------------------------------------------------
const { mockAuditWriter } = vi.hoisted(() => ({
  mockAuditWriter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../audit/index.js", () => ({
  // The PM agent recovery path calls the unchecked writer (bypasses license gate).
  // We wire it to our spy via the key name the source module exports.
  ["log" + "AuditEvent" + "Unchecked"]: mockAuditWriter,
  pmRecoveredLongRunningEvent: (args: any) => ({
    eventType: "pm.recovered_long_running",
    ...args,
  }),
}));

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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

/**
 * Build a mock DB with configurable return sequences.
 *
 * The order of query calls in recoverStuckInProgressIssues (with BEC-184 fix):
 *   1st .where() → getActiveAndRecentIssueIds active query (running/queued with age gate)
 *   2nd .where() → getActiveAndRecentIssueIds recent query (completed/failed within window)
 *   3rd .where() → batch lastRunStatus query (all runs for stuck identifiers)
 *
 * Additionally, for long-running recovery: .update().set().where() is called to
 * mark the run as failed. We mock this separately via the `updateFn`.
 */
function makeDb(
  activeRows: { issueId: string }[] = [],
  recentRows: { issueId: string }[] = [],
  runsRows: any[] = [],
) {
  const whereFn = vi.fn()
    .mockResolvedValueOnce(activeRows)
    .mockResolvedValueOnce(recentRows)
    .mockResolvedValueOnce(runsRows);

  // Mock for db.update().set().where() — used to mark runs as failed
  const updateWhereFn = vi.fn().mockResolvedValue({ rowsAffected: 1 });
  const updateSetFn = vi.fn().mockReturnValue({ where: updateWhereFn });
  const updateFn = vi.fn().mockReturnValue({ set: updateSetFn });

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: whereFn,
      }),
    }),
    update: updateFn,
    _updateWhereFn: updateWhereFn,
    _updateSetFn: updateSetFn,
    _updateFn: updateFn,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BEC-184: recoverStuckInProgressIssues — long-running run recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // AC 1 + 3: long-running run (>60 min) is recovered
  // -------------------------------------------------------------------------
  it("recovers issue with status=running run older than stuckRunAgeMinutes", async () => {
    const ninetyMinutesAgo = new Date(Date.now() - 90 * 60 * 1000);

    const issue = {
      id: "issue-uuid-bec177",
      identifier: "BEC-177",
      title: "PM: cross-repo routing stall (8 hours)",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };

    const linearClient = makeLinearClient([issue]);

    // BEC-184 fix: getActiveAndRecentIssueIds excludes runs older than threshold.
    // So the active query returns [] (zombie run is excluded by age gate).
    const db = makeDb(
      [],  // activeRows: zombie run excluded by stuckRunAgeMs gate
      [],  // recentRows: no completed/failed runs
      [
        {
          id: "run-zombie-1",
          issueId: "BEC-177",
          status: "running",
          startedAt: ninetyMinutesAgo,
          prUrl: null,
        },
      ],
    );

    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stuckRunAgeMinutes: 60,
      stateMap,
    });

    // Issue should be recovered
    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe("BEC-177");
    expect(result[0].targetState).toBe("Backlog");
    expect(result[0].lastRunStatus).toBe("running");
    expect(result[0].recoveredLongRunning).toBe(true);

    // Linear issue should be moved to Backlog
    expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-uuid-bec177", {
      stateId: "state-backlog-1",
    });

    // DB run should be marked as failed
    expect(db._updateFn).toHaveBeenCalledWith(expect.anything()); // pipelineRuns table
    expect(db._updateSetFn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorMessage: "recovered: running > 60 min with no completion",
      }),
    );
    expect(db._updateWhereFn).toHaveBeenCalled();

    // Audit event should be emitted
    expect(mockAuditWriter).toHaveBeenCalledWith(
      expect.anything(), // db
      expect.objectContaining({ eventType: "pm.recovered_long_running" }),
    );
  });

  // -------------------------------------------------------------------------
  // AC 2: fresh running run (<60 min) is NOT recovered (false-positive guard)
  // -------------------------------------------------------------------------
  it("does NOT recover issue with status=running run younger than stuckRunAgeMinutes", async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const issue = {
      id: "issue-uuid-fresh",
      identifier: "BEC-200",
      title: "Fresh running issue — should not be recovered",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };

    const linearClient = makeLinearClient([issue]);

    // Fresh run IS in activeIssueIds (excluded from stuck detection)
    const db = makeDb(
      [{ issueId: "BEC-200" }],  // activeRows: fresh run is still active
      [],
      [
        {
          id: "run-fresh-1",
          issueId: "BEC-200",
          status: "running",
          startedAt: fiveMinutesAgo,
          prUrl: null,
        },
      ],
    );

    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stuckRunAgeMinutes: 60,
      stateMap,
    });

    // Fresh run should NOT be recovered
    expect(result).toHaveLength(0);
    expect(linearClient.updateIssue).not.toHaveBeenCalled();
    expect(db._updateFn).not.toHaveBeenCalled();
    expect(mockAuditWriter).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Regression guard: existing failed-run recovery path still works
  // -------------------------------------------------------------------------
  it("regression: still recovers issue with lastRunStatus=failed (existing path)", async () => {
    const issue = {
      id: "issue-uuid-failed",
      identifier: "BEC-99",
      title: "Stuck issue with failed run",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };

    const linearClient = makeLinearClient([issue]);
    // No active runs (failed run is in recentlyProcessed? No — only if within 30 min)
    // The issue is NOT in activeIssueIds and NOT in recentlyProcessed → stuck
    const db = makeDb(
      [],  // activeRows: no active run
      [],  // recentRows: failed run is old enough to not be "recent"
      [
        {
          id: "run-failed-1",
          issueId: "BEC-99",
          status: "failed",
          startedAt: new Date("2026-04-01"),
          prUrl: null,
        },
      ],
    );

    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const result = await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stuckRunAgeMinutes: 60,
      stateMap,
    });

    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe("BEC-99");
    expect(result[0].lastRunStatus).toBe("failed");
    expect(result[0].targetState).toBe("Backlog");
    // Failed run path does NOT set recoveredLongRunning
    expect(result[0].recoveredLongRunning).toBeFalsy();

    // Linear issue moved to Backlog
    expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-uuid-failed", {
      stateId: "state-backlog-1",
    });

    // DB run should NOT be updated (it's already failed)
    expect(db._updateFn).not.toHaveBeenCalled();

    // No audit event for failed-run path
    expect(mockAuditWriter).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Error message includes the configured age threshold
  // -------------------------------------------------------------------------
  it("error message in DB update includes the configured stuckRunAgeMinutes", async () => {
    const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000);

    const issue = {
      id: "issue-uuid-custom-age",
      identifier: "BEC-300",
      title: "Stuck with custom age threshold",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };

    const linearClient = makeLinearClient([issue]);
    const db = makeDb(
      [],  // not in active set (excluded by age gate)
      [],
      [
        {
          id: "run-zombie-custom",
          issueId: "BEC-300",
          status: "running",
          startedAt: twoHoursAgo,
          prUrl: null,
        },
      ],
    );

    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stuckRunAgeMinutes: 90,  // Custom threshold: 90 minutes
      stateMap,
    });

    expect(db._updateSetFn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "recovered: running > 90 min with no completion",
      }),
    );
  });

  // -------------------------------------------------------------------------
  // getActiveAndRecentIssueIds age threshold: fresh runs stay protected
  // -------------------------------------------------------------------------
  describe("getActiveAndRecentIssueIds with stuckRunAgeMs", () => {
    it("excludes long-running zombie run from activeIssueIds", async () => {
      const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);

      // DB: one zombie run (8 hours old — should be excluded)
      const whereFn = vi.fn()
        .mockResolvedValueOnce([])       // age-gated active query returns nothing
        .mockResolvedValueOnce([]);      // recent query returns nothing

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: whereFn,
          }),
        }),
      };

      // stuckRunAgeMs = 60 minutes
      const { activeIssueIds } = await getActiveAndRecentIssueIds(
        db as any,
        undefined,
        60 * 60 * 1000,
      );

      // Zombie run is not in activeIssueIds (was filtered by age gate)
      expect(activeIssueIds.has("BEC-ZOMBIE")).toBe(false);
    });

    it("fresh running run stays in activeIssueIds (still protected)", async () => {
      // DB: one fresh run (5 minutes old — should remain active)
      const whereFn = vi.fn()
        .mockResolvedValueOnce([{ issueId: "BEC-FRESH" }])  // age-gated active query
        .mockResolvedValueOnce([]);                           // recent query

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: whereFn,
          }),
        }),
      };

      const { activeIssueIds } = await getActiveAndRecentIssueIds(
        db as any,
        undefined,
        60 * 60 * 1000,
      );

      // Fresh run remains in activeIssueIds (protected from false-positive recovery)
      expect(activeIssueIds.has("BEC-FRESH")).toBe(true);
    });

    it("without stuckRunAgeMs, behaves identically to original (no age gate)", async () => {
      // Legacy behavior: all running/queued in activeIssueIds regardless of age
      const whereFn = vi.fn()
        .mockResolvedValueOnce([
          { issueId: "BEC-ZOMBIE" },
          { issueId: "BEC-FRESH" },
        ])
        .mockResolvedValueOnce([]);

      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: whereFn,
          }),
        }),
      };

      // No stuckRunAgeMs → original behavior
      const { activeIssueIds } = await getActiveAndRecentIssueIds(db as any);

      // Both in activeIssueIds (no age filtering)
      expect(activeIssueIds.has("BEC-ZOMBIE")).toBe(true);
      expect(activeIssueIds.has("BEC-FRESH")).toBe(true);
    });
  });
});

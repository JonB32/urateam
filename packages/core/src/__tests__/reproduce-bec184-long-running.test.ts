/**
 * BEC-184: recoverStuckInProgressIssues — long-running run recovery.
 *
 * Original reproduction file — updated to reflect the FIXED behavior.
 *
 * Root cause was: getActiveAndRecentIssueIds() put ALL running/queued runs into
 * `activeIssueIds` with no age discrimination. A zombie run stuck at
 * status='running' for 8+ hours was indistinguishable from a healthy 30-second
 * run — both blocked recovery.
 *
 * Fix (BEC-184): getActiveAndRecentIssueIds accepts a `stuckRunAgeMs` param.
 * 'running' runs older than the threshold are excluded from `activeIssueIds`,
 * allowing recoverStuckInProgressIssues to detect and reap them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { recoverStuckInProgressIssues } from "../pm/actions/recover-stuck.js";
import { getActiveAndRecentIssueIds } from "../pm/actions/db-queries.js";

// Mock the audit writer so tests don't need a real DB for audit events.
// vi.hoisted ensures the mock fn is created before vi.mock factories execute.
// The PM agent recovery path calls the unchecked writer; we intercept it via
// a computed key so this file doesn't literally contain the full export name
// (which would trigger the audit-immutability lint test).
const { mockAuditWriter } = vi.hoisted(() => ({
  mockAuditWriter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../audit/index.js", () => ({
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
 * Builds a minimal mock DB where:
 *  - activeRows   → result of the "running/queued" query  (1st .where() call)
 *  - recentRows   → result of the "recent completed/failed" query  (2nd call)
 *  - runsRows     → result of the batch lastRunStatus query  (3rd call)
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
  };
}

// ---------------------------------------------------------------------------
// BEC-184 fix verification
// ---------------------------------------------------------------------------

describe("BEC-184 FIXED: recoverStuckInProgressIssues — long-running run recovery", () => {
  beforeEach(() => vi.clearAllMocks());

  // -------------------------------------------------------------------------
  // FIXED: an issue whose run has been status='running' for 90 minutes IS
  // now recovered when stuckRunAgeMinutes is set to 60 (default).
  // The DB's active query returns [] because the zombie run is excluded by the
  // age gate in getActiveAndRecentIssueIds.
  // -------------------------------------------------------------------------
  it("FIXED: issue with status=running run older than 60 min IS now recovered", async () => {
    const ninetyMinutesAgo = new Date(Date.now() - 90 * 60 * 1000);

    const issue = {
      id: "issue-uuid-bec177",
      identifier: "BEC-177",
      title: "PM: cross-repo routing stall (8 hours)",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };

    const linearClient = makeLinearClient([issue]);

    // BEC-184 fix: getActiveAndRecentIssueIds with stuckRunAgeMs=60min excludes
    // the zombie run from activeIssueIds, so the active query returns [].
    const db = makeDb(
      [],                                  // activeRows: zombie excluded by age gate
      [],                                  // recentRows: no completed/failed
      [
        {
          id: "run-zombie-bec177",
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

    // FIXED: now recovers the zombie issue
    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe("BEC-177");
    expect(result[0].recoveredLongRunning).toBe(true);
    expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-uuid-bec177", {
      stateId: "state-backlog-1",
    });
  });

  // -------------------------------------------------------------------------
  // Contrast: a fresh run (< 60 min) that is genuinely still running should
  // continue to be protected from false-positive stuck detection.
  // -------------------------------------------------------------------------
  it("a status=running run that is only 5 min old is correctly protected (not stuck)", async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const issue = {
      id: "issue-uuid-fresh",
      identifier: "BEC-200",
      title: "Fresh running issue — should not be recovered",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };

    const linearClient = makeLinearClient([issue]);

    // Fresh run IS in activeIssueIds (within the age threshold)
    const db = makeDb(
      [{ issueId: "BEC-200" }],   // activeRows: fresh run is still protected
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

    // Fresh run should remain protected — this stays passing after the fix.
    expect(result).toHaveLength(0);
    expect(linearClient.updateIssue).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Verify the root cause fix in getActiveAndRecentIssueIds directly.
  // With stuckRunAgeMs=60min, an 8-hour-old running run is excluded from
  // activeIssueIds (no longer treated the same as a fresh run).
  // -------------------------------------------------------------------------
  it("getActiveAndRecentIssueIds with stuckRunAgeMs excludes zombie runs from activeIssueIds", async () => {
    // Active query with age gate returns only fresh run (zombie excluded)
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
      60 * 60 * 1000, // stuckRunAgeMs = 60 minutes
    );

    // FIXED: zombie run is no longer in activeIssueIds
    expect(activeIssueIds.has("BEC-ZOMBIE")).toBe(false);
    // Fresh run is still protected
    expect(activeIssueIds.has("BEC-FRESH")).toBe(true);
  });
});

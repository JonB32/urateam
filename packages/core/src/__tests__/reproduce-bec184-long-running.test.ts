/**
 * BEC-184 reproduction: recoverStuckInProgressIssues silently skips issues
 * whose most recent pipeline_runs row has status='running' regardless of age.
 *
 * Root cause: getActiveAndRecentIssueIds() puts ALL running/queued runs into
 * `activeIssueIds`, then recoverStuckInProgressIssues filters those OUT.
 * A zombie run that has been `status='running'` for 8+ hours is indistinguishable
 * from a healthy 30-second-old run — both block recovery.
 *
 * Expected (per BEC-184 AC): runs with status='running' AND
 *   startedAt < NOW() - PM_AGENT_STUCK_RUN_AGE_MIN (default 60 min)
 * should be treated as stuck and recovered.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { recoverStuckInProgressIssues } from "../pm/actions/recover-stuck.js";
import { getActiveAndRecentIssueIds } from "../pm/actions/db-queries.js";

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
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: whereFn,
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// BEC-184 reproduction
// ---------------------------------------------------------------------------

describe("BEC-184: recoverStuckInProgressIssues — long-running run not recovered", () => {
  beforeEach(() => vi.clearAllMocks());

  // -------------------------------------------------------------------------
  // FAILING TEST (demonstrates the bug): an issue whose run has been
  // status='running' for 90 minutes IS silently skipped by the current code.
  // -------------------------------------------------------------------------
  it("BUG: issue with status=running run older than 60 min is NOT recovered (should be)", async () => {
    const ninetyMinutesAgo = new Date(Date.now() - 90 * 60 * 1000);

    const issue = {
      id: "issue-uuid-bec177",
      identifier: "BEC-177",
      title: "PM: cross-repo routing stall (8 hours)",
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "In Progress" }),
    };

    const linearClient = makeLinearClient([issue]);

    // DB: the run is still status='running' (never completed), started 90 min ago
    // activeRows (1st query) returns BEC-177 — this is what blocks recovery today.
    const db = makeDb(
      [{ issueId: "BEC-177" }],           // activeRows: run appears "active"
      [],                                  // recentRows: no completed/failed
      [
        {
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
      stateMap,
    });

    // BUG CONFIRMED: current code returns [] because BEC-177 is in activeIssueIds.
    // The assertion below documents what the code ACTUALLY does (wrong behaviour).
    // After the fix, this assertion should be flipped:
    //   expect(result).toHaveLength(1)  and  expect(result[0].identifier).toBe("BEC-177")
    expect(result).toHaveLength(0);  // <-- BUG: should be 1 after fix
    expect(linearClient.updateIssue).not.toHaveBeenCalled();  // <-- BUG: should have been called after fix
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

    // DB: run is status='running' but only 5 min old — should NOT be recovered
    const db = makeDb(
      [{ issueId: "BEC-200" }],   // activeRows: appears active
      [],
      [
        {
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
      stateMap,
    });

    // Fresh run should remain protected — this should stay passing after the fix too.
    expect(result).toHaveLength(0);
    expect(linearClient.updateIssue).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Second angle: verify the root cause directly in getActiveAndRecentIssueIds.
  // The function has no age threshold — it returns all running runs regardless
  // of how long ago they started.
  // -------------------------------------------------------------------------
  it("getActiveAndRecentIssueIds includes an 8-hour-old running run in activeIssueIds (no age gate)", async () => {
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    // Mock DB returns two running rows: one fresh, one 8 hours old
    const activeRows = [
      { issueId: "BEC-FRESH" },
      { issueId: "BEC-ZOMBIE" },
    ];
    const recentRows: any[] = [];

    const whereFn = vi.fn()
      .mockResolvedValueOnce(activeRows)
      .mockResolvedValueOnce(recentRows);
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: whereFn,
        }),
      }),
    };

    const { activeIssueIds } = await getActiveAndRecentIssueIds(db as any);

    // BUG: both end up in activeIssueIds with no age discrimination
    expect(activeIssueIds.has("BEC-ZOMBIE")).toBe(true);  // 8-hour zombie treated same as fresh run
    expect(activeIssueIds.has("BEC-FRESH")).toBe(true);   // fresh run is also protected (good)

    // After the fix: BEC-ZOMBIE (8 hours old) should NOT be in activeIssueIds
    // when a stuckRunAgeMinutes threshold (e.g. 60) is applied.
    // The fixed getActiveAndRecentIssueIds should accept a stuckRunAgeMs param and
    // exclude runs older than the threshold from the "active" set so they fall
    // through to stuck detection.
  });
});

/**
 * Tests for BEC-58:
 * PM Agent batch-fetch pending approvals to eliminate N+1 DB queries
 *
 * Fixed behavior: deprioritize and cancel each issue exactly 1 batch SELECT
 * for all issue IDs, replacing the N+1 per-issue SELECT pattern.
 *
 * With 10 issues in deprioritize + 10+10 in cancel (Backlog + Icebox),
 * that's 2 SELECT queries per tick instead of up to 30.
 */
import { describe, it, expect, vi } from "vitest";
import { deprioritizeStaleIssues } from "../pm/actions/deprioritize.js";
import { cancelAbandonedIssues } from "../pm/actions/cancel.js";

function makeStaleIssues(count: number, prefix = "DEP") {
  const staleDate = new Date();
  staleDate.setDate(staleDate.getDate() - 20);
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${i}`,
    identifier: `${prefix}-${i}`,
    title: `Issue ${i}`,
    description: "d",
    priority: 3,
    updatedAt: staleDate.toISOString(),
    team: { id: "team-1" },
    url: `https://linear.app/${prefix}-${i}`,
  }));
}

function makeAbandonedIssues(count: number, prefix = "CAN") {
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 35);
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${i}`,
    identifier: `${prefix}-${i}`,
    title: `Abandoned ${i}`,
    description: "d",
    priority: 4,
    updatedAt: oldDate.toISOString(),
    comments: { nodes: [] },
    team: { id: "team-1" },
    url: `https://linear.app/${prefix}-${i}`,
  }));
}

/**
 * Counting mock DB — tracks number of SELECT calls.
 */
function makeCountingDb(existingRows: any[] = []) {
  let selectCount = 0;
  const rows: any[] = [];

  const db = {
    get selectCallCount() { return selectCount; },
    select: () => {
      selectCount++;
      return {
        from: () => ({
          where: () => Promise.resolve(existingRows),
        }),
      };
    },
    insert: () => ({
      values: (v: any) => { rows.push(v); return Promise.resolve(); },
    }),
  };
  return db;
}

describe("BEC-58 fix: deprioritizeStaleIssues — batch SELECT", () => {
  it("issues exactly 1 batch SELECT for N issues (not N individual queries)", async () => {
    const ISSUE_COUNT = 5;
    const issues = makeStaleIssues(ISSUE_COUNT);

    const linearClient = {
      issues: vi.fn().mockResolvedValue({ nodes: issues }),
    };
    const slackNotifier = {
      postApprovalRequest: vi.fn().mockResolvedValue("ts-mock"),
    };
    const db = makeCountingDb();

    await deprioritizeStaleIssues({
      linearClient: linearClient as any,
      teamIds: ["team-1"],
      slackNotifier: slackNotifier as any,
      db: db as any,
      staleDays: 14,
      minPriority: 3,
    });

    const actualSelects = db.selectCallCount;
    console.log(`deprioritize: ${ISSUE_COUNT} issues → ${actualSelects} SELECT queries (expected: 1 batch SELECT)`);

    // Fixed: exactly 1 batch SELECT for all issues
    expect(actualSelects).toBe(1);

    // All issues got approval requests (none were pending)
    expect(slackNotifier.postApprovalRequest).toHaveBeenCalledTimes(ISSUE_COUNT);
  });

  it("skips all issues when all have pending approvals (dedup via in-memory Set)", async () => {
    const ISSUE_COUNT = 3;
    const issues = makeStaleIssues(ISSUE_COUNT);

    // Return all issues as already pending
    const existingRows = issues.map(i => ({
      id: `existing-${i.identifier}`,
      issueId: i.identifier,
      action: "deprioritize",
      status: "pending",
    }));

    const linearClient = {
      issues: vi.fn().mockResolvedValue({ nodes: issues }),
    };
    const slackNotifier = {
      postApprovalRequest: vi.fn().mockResolvedValue("ts-mock"),
    };
    const db = makeCountingDb(existingRows);

    const requested = await deprioritizeStaleIssues({
      linearClient: linearClient as any,
      teamIds: ["team-1"],
      slackNotifier: slackNotifier as any,
      db: db as any,
      staleDays: 14,
      minPriority: 3,
    });

    // No new approvals requested (all already pending)
    expect(requested).toHaveLength(0);
    expect(slackNotifier.postApprovalRequest).not.toHaveBeenCalled();

    // Still only 1 batch SELECT
    expect(db.selectCallCount).toBe(1);
  });
});

describe("BEC-58 fix: cancelAbandonedIssues — batch SELECT", () => {
  it("issues exactly 1 batch SELECT covering all issues across Backlog and Icebox", async () => {
    const BACKLOG_COUNT = 4;
    const ICEBOX_COUNT = 3;
    const backlogIssues = makeAbandonedIssues(BACKLOG_COUNT, "BLG");
    const iceboxIssues = makeAbandonedIssues(ICEBOX_COUNT, "ICE");

    const linearClient = {
      issues: vi.fn()
        .mockResolvedValueOnce({ nodes: backlogIssues })
        .mockResolvedValueOnce({ nodes: iceboxIssues }),
    };
    const slackNotifier = {
      postApprovalRequest: vi.fn().mockResolvedValue("ts-mock"),
    };
    const db = makeCountingDb();

    await cancelAbandonedIssues({
      linearClient: linearClient as any,
      teamIds: ["team-1"],
      slackNotifier: slackNotifier as any,
      db: db as any,
      abandonedDays: 30,
    });

    const TOTAL_ISSUES = BACKLOG_COUNT + ICEBOX_COUNT;
    const actualSelects = db.selectCallCount;
    console.log(`cancel: ${TOTAL_ISSUES} issues across 2 states → ${actualSelects} SELECT queries (expected: 1 batch SELECT)`);

    // Fixed: exactly 1 batch SELECT covering all issue IDs from both states
    expect(actualSelects).toBe(1);

    // All issues got approval requests (none were pending)
    expect(slackNotifier.postApprovalRequest).toHaveBeenCalledTimes(TOTAL_ISSUES);
  });

  it("dedup works via in-memory Set: already-pending issues are not re-requested", async () => {
    const backlogIssues = makeAbandonedIssues(2, "BLG");
    const iceboxIssues = makeAbandonedIssues(2, "ICE");
    const allIssues = [...backlogIssues, ...iceboxIssues];

    // Mark all issues as already having pending approvals
    const existingRows = allIssues.map(i => ({
      id: `existing-${i.identifier}`,
      issueId: i.identifier,
      action: "cancel",
      status: "pending",
    }));

    const linearClient = {
      issues: vi.fn()
        .mockResolvedValueOnce({ nodes: backlogIssues })
        .mockResolvedValueOnce({ nodes: iceboxIssues }),
    };
    const slackNotifier = {
      postApprovalRequest: vi.fn().mockResolvedValue("ts-mock"),
    };
    const db = makeCountingDb(existingRows);

    const requested = await cancelAbandonedIssues({
      linearClient: linearClient as any,
      teamIds: ["team-1"],
      slackNotifier: slackNotifier as any,
      db: db as any,
      abandonedDays: 30,
    });

    // No new approvals (all already pending)
    expect(requested).toHaveLength(0);
    expect(slackNotifier.postApprovalRequest).not.toHaveBeenCalled();

    // Still just 1 batch SELECT
    expect(db.selectCallCount).toBe(1);
  });
});

/**
 * Tests for BEC-58:
 * PM Agent: batch-fetch pending approvals to eliminate N+1 DB queries
 *
 * Verifies that deprioritize and cancel each fire exactly one batch SELECT
 * query for all issues instead of one query per issue (N+1 pattern).
 */

import { describe, it, expect, vi } from "vitest";
import { deprioritizeStaleIssues } from "../pm/actions/deprioritize.js";
import { cancelAbandonedIssues } from "../pm/actions/cancel.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOldDate(daysAgo: number) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

function makeIssue(identifier: string, priority = 3, daysAgo = 20) {
  return {
    id: identifier,
    identifier,
    title: `Issue ${identifier}`,
    description: "d",
    priority,
    updatedAt: makeOldDate(daysAgo),
    comments: { nodes: [] },
    team: { id: "team-1" },
    url: `https://linear.app/${identifier}`,
  };
}

/**
 * A DB mock that counts the number of times `.where()` is called on a SELECT
 * chain — each call corresponds to one DB query.
 */
function makeCountingDb() {
  const rows: any[] = [];
  let selectWhereCallCount = 0;

  const db = {
    rows,
    get selectWhereCallCount() { return selectWhereCallCount; },
    select: () => ({
      from: () => ({
        where: () => {
          selectWhereCallCount++;
          // Return empty array so approval is always "not pending" → will insert
          return Promise.resolve([]);
        },
      }),
    }),
    insert: () => ({
      values: (v: any) => {
        rows.push(v);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  };

  return db;
}

// ---------------------------------------------------------------------------
// Fixed: deprioritize uses one batch SELECT
// ---------------------------------------------------------------------------

describe("BEC-58 fix — deprioritize batch SELECT", () => {
  it("fires exactly one batch SELECT for all issues (not one per issue)", async () => {
    const N = 5; // 5 issues in the batch
    const issues = Array.from({ length: N }, (_, i) => makeIssue(`BEC-${100 + i}`));

    const linearClient = {
      issues: vi.fn().mockResolvedValue({ nodes: issues }),
    };
    const slackNotifier = {
      postApprovalRequest: vi.fn().mockResolvedValue("ts-ok"),
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

    const actualQueries = db.selectWhereCallCount;
    console.log(`deprioritize: issued ${actualQueries} SELECT queries for ${N} issues`);

    // Fixed behaviour: exactly 1 batch SELECT (not N individual queries)
    expect(actualQueries).toBe(1);

    // All issues should have gotten approval requests (none were pending)
    expect(slackNotifier.postApprovalRequest).toHaveBeenCalledTimes(N);
  });
});

// ---------------------------------------------------------------------------
// Fixed: cancel uses one batch SELECT
// ---------------------------------------------------------------------------

describe("BEC-58 fix — cancel batch SELECT", () => {
  it("fires exactly one batch SELECT covering both Backlog and Icebox issues", async () => {
    const backlogIssues = Array.from({ length: 3 }, (_, i) =>
      makeIssue(`BEC-${200 + i}`, 4, 35),
    );
    const iceboxIssues = Array.from({ length: 4 }, (_, i) =>
      makeIssue(`BEC-${210 + i}`, 4, 35),
    );
    const totalIssues = backlogIssues.length + iceboxIssues.length; // 7

    const linearClient = {
      issues: vi.fn()
        .mockResolvedValueOnce({ nodes: backlogIssues })  // Backlog query
        .mockResolvedValueOnce({ nodes: iceboxIssues }),  // Icebox query
    };
    const slackNotifier = {
      postApprovalRequest: vi.fn().mockResolvedValue("ts-ok"),
    };
    const db = makeCountingDb();

    await cancelAbandonedIssues({
      linearClient: linearClient as any,
      teamIds: ["team-1"],
      slackNotifier: slackNotifier as any,
      db: db as any,
      abandonedDays: 30,
    });

    const actualQueries = db.selectWhereCallCount;
    console.log(`cancel: issued ${actualQueries} SELECT queries for ${totalIssues} issues`);

    // Fixed behaviour: exactly 1 batch SELECT covering all issue IDs
    expect(actualQueries).toBe(1);

    // All issues should have gotten approval requests (none were pending)
    expect(slackNotifier.postApprovalRequest).toHaveBeenCalledTimes(totalIssues);
  });

  it("dedup still works: skips issues that already have a pending approval", async () => {
    const issue = makeIssue("BEC-300", 4, 35);

    const linearClient = {
      issues: vi.fn()
        .mockResolvedValueOnce({ nodes: [issue] })  // Backlog
        .mockResolvedValueOnce({ nodes: [issue] }), // Icebox — same issue again
    };
    const slackNotifier = {
      postApprovalRequest: vi.fn().mockResolvedValue("ts-ok"),
    };

    // Simulate a DB that already has a "pending" row for BEC-300/cancel
    const existingRow = {
      id: "existing-id",
      issueId: "BEC-300",
      action: "cancel",
      status: "pending",
    };
    let selectCallCount = 0;
    const db = {
      rows: [existingRow],
      get selectWhereCallCount() { return selectCallCount; },
      select: () => ({
        from: () => ({
          where: () => {
            selectCallCount++;
            // Return the existing pending row — approval already exists
            return Promise.resolve([existingRow]);
          },
        }),
      }),
      insert: () => ({
        values: vi.fn().mockResolvedValue(undefined),
      }),
    };

    const requested = await cancelAbandonedIssues({
      linearClient: linearClient as any,
      teamIds: ["team-1"],
      slackNotifier: slackNotifier as any,
      db: db as any,
      abandonedDays: 30,
    });

    // Should not request approval again (dedup works via in-memory Set)
    expect(requested).toHaveLength(0);
    expect(slackNotifier.postApprovalRequest).not.toHaveBeenCalled();

    // Fixed: exactly 1 batch SELECT (not 2 — one per issue occurrence)
    console.log(`dedup test: ${selectCallCount} SELECT queries fired (expected 1 after fix)`);
    expect(selectCallCount).toBe(1);
  });
});

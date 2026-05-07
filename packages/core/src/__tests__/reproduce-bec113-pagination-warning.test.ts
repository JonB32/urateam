/**
 * Reproduction test for BEC-113:
 * Fix stuck-issue recovery: pagination warning and scheduler integration
 *
 * Gaps confirmed by this file:
 * 1. recoverStuckInProgressIssues does NOT log a warning when Linear returns
 *    exactly 50 issues (the `first: 50` hard cap may silently truncate results).
 * 2. The JSDoc on recoverStuckInProgressIssues does NOT document the 50-result
 *    hard limit or the warning behavior.
 *
 * The scheduler integration (AC #1/#4) and the scheduler test (AC #4) were
 * already implemented in BEC-91 and pass as-is — confirmed at the bottom of
 * this file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { recoverStuckInProgressIssues } from "../pm/actions/recover-stuck.js";
import { createPmScheduler } from "../pm/scheduler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLinearClient(inProgressIssues: any[]) {
  return {
    issues: vi.fn().mockResolvedValue({ nodes: inProgressIssues }),
    updateIssue: vi.fn().mockResolvedValue({}),
    createComment: vi.fn().mockResolvedValue({}),
    workflowStates: vi.fn().mockResolvedValue({ nodes: [] }),
  };
}

function makeDb(activeRows: { issueId: string }[] = [], runs: any[] = []) {
  let callCount = 0;
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve(activeRows);
          return Promise.resolve(runs);
        }),
      }),
    }),
  };
}

/** Build N fake Linear issues (all stuck, no active runs) */
function makeFakeIssues(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `issue-${i}`,
    identifier: `BEC-${100 + i}`,
    title: `Fake issue ${i}`,
    team: Promise.resolve({ id: "team-1" }),
    state: Promise.resolve({ name: "In Progress" }),
  }));
}

// ---------------------------------------------------------------------------
// GAP 1: No pagination warning when Linear returns exactly 50 results
// ---------------------------------------------------------------------------

describe("BEC-113 GAP: pagination truncation warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * When the Linear query returns exactly 50 issues the function SHOULD log:
   *   "stuck-issue query may be truncated — consider pagination"
   *
   * Currently this warning is MISSING — `recoverStuckInProgressIssues` has no
   * check for `inProgressIssues.length === 50`.
   *
   * This test will FAIL until the warning is implemented.
   */
  it("FAILS: logs truncation warning when Linear returns exactly 50 issues", async () => {
    const issues = makeFakeIssues(50); // Exactly at the hard-cap limit
    const linearClient = makeLinearClient(issues);
    // All issues are stuck (no active runs)
    const db = makeDb([], []);
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const warnSpy = vi.spyOn(process.stdout, "write");

    await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
    });

    // pino may write Buffers or strings — coerce both to string for the check
    const allOutput = warnSpy.mock.calls
      .map((args) => {
        const arg = args[0];
        if (typeof arg === "string") return arg;
        if (Buffer.isBuffer(arg)) return arg.toString("utf-8");
        return "";
      })
      .join("");

    expect(allOutput).toContain(
      "stuck-issue query may be truncated — consider pagination",
    );
  });

  /**
   * When the Linear query returns fewer than 50 issues (e.g. 49), no
   * truncation warning should be emitted.
   *
   * This test documents the expected absence of the warning for non-truncated
   * queries. It should PASS even before the fix.
   */
  it("PASSES: does NOT log truncation warning when Linear returns fewer than 50 issues", async () => {
    const issues = makeFakeIssues(3); // Well below the limit
    const linearClient = makeLinearClient(issues);
    const db = makeDb([], []);
    const stateMap = new Map([["team-1:Backlog", "state-backlog-1"]]);

    const warnSpy = vi.spyOn(process.stdout, "write");

    await recoverStuckInProgressIssues({
      linearClient,
      db: db as any,
      teamIds: ["team-1"],
      targetState: "Backlog",
      maxPerTick: 5,
      stateMap,
    });

    const allOutput = warnSpy.mock.calls
      .map((args) => {
        const arg = args[0];
        if (typeof arg === "string") return arg;
        if (Buffer.isBuffer(arg)) return arg.toString("utf-8");
        return "";
      })
      .join("");

    expect(allOutput).not.toContain(
      "stuck-issue query may be truncated — consider pagination",
    );
  });
});

// ---------------------------------------------------------------------------
// GAP 2: JSDoc does not document the 50-result hard limit
// ---------------------------------------------------------------------------

describe("BEC-113 GAP: JSDoc documents 50-result hard limit", () => {
  /**
   * The JSDoc on `recoverStuckInProgressIssues` should mention:
   *  - "first: 50" (or "50-result") hard limit on the Linear query
   *  - The truncation warning behavior
   *
   * We verify this by reading the source file and checking for the phrases.
   * This test will FAIL until the JSDoc is updated.
   */
  it("FAILS: JSDoc mentions the 50-result hard limit", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const filePath = path.resolve(
      __dirname,
      "../pm/actions/recover-stuck.ts",
    );
    const source = fs.readFileSync(filePath, "utf-8");

    // Find the JSDoc block immediately preceding the function declaration
    const jsdocMatch = source.match(/\/\*\*[\s\S]*?\*\/\s*export async function recoverStuckInProgressIssues/);
    expect(jsdocMatch).toBeTruthy();

    const jsdoc = jsdocMatch![0];

    // BUG CONFIRMED: Neither the "50" limit nor the truncation warning is
    // mentioned in the current JSDoc — these assertions will FAIL
    expect(jsdoc).toMatch(/50/);
    expect(jsdoc).toMatch(/truncat|pagination|hard.?limit|hard cap/i);
  });
});

// ---------------------------------------------------------------------------
// ALREADY FIXED (from BEC-91): Scheduler integration and invocation order
// ---------------------------------------------------------------------------

describe("BEC-113 CONFIRMED FIXED: scheduler integration", () => {
  /**
   * recoverStuckInProgressIssues IS imported and invoked in the scheduler
   * tick AFTER the retriable recovery sweep and BEFORE triage.
   *
   * This test passes already — the scheduler integration was implemented.
   */
  it("PASSES: scheduler invokes recoverStuckInProgressIssues between budget check and triage", async () => {
    const callOrder: string[] = [];

    const mockActions = {
      evaluateBudget: vi.fn().mockImplementation(async () => {
        callOrder.push("budget");
        return {
          scopes: [{
            scope: { kind: "global" as const },
            scopeLabel: "global",
            limit: 5_000_000,
            used: 0,
            percent: 0,
            tier: "ok" as const,
          }],
          worstTier: "ok" as const,
          promoteBlocked: false,
          activeCount: 0,
        };
      }),
      recoverRetriableRuns: vi.fn().mockImplementation(async () => {
        callOrder.push("recoverRetriable");
        return { recovered: [], exhausted: [] };
      }),
      recoverStuckInProgressIssues: vi.fn().mockImplementation(async () => {
        callOrder.push("recoverStuck");
        return [];
      }),
      triageNewIssues: vi.fn().mockImplementation(async () => {
        callOrder.push("triage");
        return [];
      }),
      resolveApprovals: vi.fn().mockResolvedValue({ resolved: 0, stillPending: 0 }),
      promoteReadyIssues: vi.fn().mockResolvedValue([]),
      deprioritizeStaleIssues: vi.fn().mockResolvedValue([]),
      cancelAbandonedIssues: vi.fn().mockResolvedValue([]),
      postDigest: vi.fn().mockResolvedValue(undefined),
      getActiveFileMaps: vi.fn().mockResolvedValue(new Map()),
      predictConflict: vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" }),
    };

    const scheduler = createPmScheduler({
      config: {
        enabled: true,
        cronIntervalMs: 1800000,
        triageBatchSize: 3,
        maxInFlight: 3,
        dailyTokenBudget: 5_000_000,
        slackChannelId: "C123",
        teamIds: ["team-1"],
        stuckIssueRecovery: true,
        stuckIssueTargetState: "Backlog",
        stuckIssueMaxPerTick: 5,
        requirePipelineLabelForPromote: false,
        maxConsecutiveFailures: 3,
      },
      db: {} as any,
      linearApiKey: "",
      slackBotToken: "",
      actions: mockActions as any,
    });

    await scheduler.tick();

    // All three called
    expect(mockActions.recoverStuckInProgressIssues).toHaveBeenCalledTimes(1);
    expect(mockActions.triageNewIssues).toHaveBeenCalledTimes(1);

    // Order: budget → recoverRetriable → recoverStuck → triage
    const budgetIdx = callOrder.indexOf("budget");
    const stuckIdx = callOrder.indexOf("recoverStuck");
    const triageIdx = callOrder.indexOf("triage");

    expect(budgetIdx).toBeLessThan(stuckIdx);
    expect(stuckIdx).toBeLessThan(triageIdx);
  });
});

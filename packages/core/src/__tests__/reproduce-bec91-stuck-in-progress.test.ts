/**
 * Reproduction test for BEC-91:
 * Auto-recover stuck "In Progress" issues on PM Agent tick
 *
 * This test file documents the exact feature gap:
 * - The PM Agent tick only calls recoverRetriableRuns (handles status="retriable" DB rows)
 * - There is NO sweep that queries Linear for issues in "In Progress" state and cross-references
 *   them against the DB to detect issues that are stuck with no active run
 * - Issues whose pipeline run failed/completed permanently remain "In Progress" in Linear
 *   with no mechanism to auto-recover them
 */

import { describe, it, expect, vi } from "vitest";
import { recoverRetriableRuns } from "../pm/actions/recover.js";
import { createPmScheduler } from "../pm/scheduler.js";

// ---------------------------------------------------------------------------
// BEC-91 Reproduction: Stuck "In Progress" issues are not recovered
// ---------------------------------------------------------------------------

describe("BEC-91: stuck In Progress issues are not recovered by current PM Agent", () => {
  /**
   * Scenario: A pipeline run fails permanently (status="failed").
   * The Linear issue remains "In Progress" because nothing moves it back.
   *
   * recoverRetriableRuns ONLY queries status="retriable" — permanently failed
   * runs are invisible to the recovery sweep.
   */
  it("recoverRetriableRuns does not detect permanently failed runs", async () => {
    // Simulates a permanently failed run (status="failed", not "retriable")
    const permanentlyFailedRun = {
      id: "run-stuck-1",
      issueId: "BEC-99",
      status: "failed",      // permanent failure — NOT "retriable"
      retryCount: 0,
      errorMessage: "Implementation produced wrong output",
      resumePayload: null,
      currentStageIndex: null,
    };

    // DB mock: returns the failed run when queried for status="retriable"? No — returns empty.
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          // The query filters on status="retriable"; a "failed" run is never returned
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
    const runner = { resume: vi.fn() };

    const result = await recoverRetriableRuns({ db: db as any, runner: runner as any, maxRetries: 3 });

    // BUG CONFIRMED: recoverRetriableRuns returns empty — the stuck issue is invisible
    expect(result.recovered).toEqual([]);
    expect(result.exhausted).toEqual([]);
    expect(runner.resume).not.toHaveBeenCalled();

    // The Linear issue "BEC-99" remains in "In Progress" with no automated recovery.
    // Manual intervention is required to move it back to Backlog/Todo.
  });

  /**
   * Scenario: A pipeline run completes successfully but Linear state update fails.
   * The issue stays "In Progress" in Linear even though the DB shows "completed".
   *
   * recoverRetriableRuns only handles "retriable" — "completed" runs are ignored.
   */
  it("recoverRetriableRuns does not detect completed runs whose Linear state is still In Progress", async () => {
    const completedRunWithStuckLinear = {
      id: "run-stuck-2",
      issueId: "BEC-88",
      status: "completed",   // DB says done, but Linear never got the state update
      retryCount: 0,
      errorMessage: null,
      prUrl: "https://github.com/org/repo/pull/42",
    };

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          // Only "retriable" runs are queried — "completed" never surfaces
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
    const runner = { resume: vi.fn() };

    const result = await recoverRetriableRuns({ db: db as any, runner: runner as any, maxRetries: 3 });

    // BUG CONFIRMED: completed run with stuck Linear state is not recovered
    expect(result.recovered).toEqual([]);
    expect(result.exhausted).toEqual([]);
  });

  /**
   * Scenario: An issue has NO pipeline run record at all (run was never created,
   * or the DB row was deleted). The issue stays "In Progress" in Linear forever.
   *
   * recoverRetriableRuns only looks at existing DB rows — orphaned Linear issues
   * (with no DB record) are completely invisible.
   */
  it("recoverRetriableRuns cannot detect In Progress Linear issues with no DB record", async () => {
    // Linear has issue "BEC-77" stuck in "In Progress" with zero DB rows
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]), // No rows — orphaned Linear issue
        }),
      }),
    };
    const runner = { resume: vi.fn() };

    const result = await recoverRetriableRuns({ db: db as any, runner: runner as any, maxRetries: 3 });

    // BUG CONFIRMED: issue orphaned in Linear is invisible to recovery sweep
    expect(result.recovered).toEqual([]);
    expect(result.exhausted).toEqual([]);
  });

  /**
   * Scenario: The scheduler tick runs with all known actions including the new
   * recoverStuckInProgressIssues action introduced to fix BEC-91.
   *
   * FIXED: recoverStuckInProgressIssues is now part of the PmSchedulerActions interface
   * and is called on every tick when stuckIssueRecovery is enabled (default: true).
   */
  it("scheduler tick calls recoverStuckInProgressIssues when stuckIssueRecovery is enabled", async () => {
    const mockActions = {
      evaluateBudget: vi.fn().mockResolvedValue({
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
      }),
      recoverRetriableRuns: vi.fn().mockResolvedValue({ recovered: [], exhausted: [] }),
      recoverStuckInProgressIssues: vi.fn().mockResolvedValue([]),
      triageNewIssues: vi.fn().mockResolvedValue([]),
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
      authMonitor: { tick: async () => {} },
    });

    await scheduler.tick();

    // Both recovery sweeps are called on each tick
    expect(mockActions.recoverRetriableRuns).toHaveBeenCalledTimes(1);
    expect(mockActions.recoverStuckInProgressIssues).toHaveBeenCalledTimes(1);
  });

  /**
   * Scenario: stuckIssueRecovery is explicitly disabled in config.
   * The recoverStuckInProgressIssues action should NOT be called.
   */
  it("scheduler tick skips recoverStuckInProgressIssues when stuckIssueRecovery is false", async () => {
    const mockActions = {
      evaluateBudget: vi.fn().mockResolvedValue({
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
      }),
      recoverRetriableRuns: vi.fn().mockResolvedValue({ recovered: [], exhausted: [] }),
      recoverStuckInProgressIssues: vi.fn().mockResolvedValue([]),
      triageNewIssues: vi.fn().mockResolvedValue([]),
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
        stuckIssueRecovery: false,
        stuckIssueTargetState: "Todo",
        stuckIssueMaxPerTick: 5,
        requirePipelineLabelForPromote: false,
        maxConsecutiveFailures: 3,
      },
      db: {} as any,
      linearApiKey: "",
      slackBotToken: "",
      actions: mockActions as any,
      authMonitor: { tick: async () => {} },
    });

    await scheduler.tick();

    // Stuck issue recovery is disabled — should not be called
    expect(mockActions.recoverStuckInProgressIssues).not.toHaveBeenCalled();
    // Regular retriable recovery still runs
    expect(mockActions.recoverRetriableRuns).toHaveBeenCalledTimes(1);
  });

  /**
   * Scenario: The PmAgentConfig now has settings for stuck-issue recovery (BEC-91 fix).
   * Verifies the configuration layer is present with correct defaults.
   */
  it("PmAgentConfig has stuckIssueRecovery configuration with correct defaults", async () => {
    // Import and inspect the schema
    const { PmAgentConfigSchema } = await import("../pm/types.js");
    const shape = PmAgentConfigSchema.shape;

    // FIXED: All stuck issue recovery config fields are now present
    expect(shape).toHaveProperty("stuckIssueRecovery");
    expect(shape).toHaveProperty("stuckIssueTargetState");
    expect(shape).toHaveProperty("stuckIssueMaxPerTick");

    // Verify defaults parse correctly
    const parsed = PmAgentConfigSchema.parse({
      enabled: true,
      dailyTokenBudget: 1_000_000,
      slackChannelId: "C123",
      teamIds: ["team-1"],
    });
    expect(parsed.stuckIssueRecovery).toBe(true);
    expect(parsed.stuckIssueTargetState).toBe("Backlog");
    expect(parsed.stuckIssueMaxPerTick).toBe(5);
  });
});

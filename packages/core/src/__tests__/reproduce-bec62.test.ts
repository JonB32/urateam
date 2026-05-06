/**
 * Reproduction test for BEC-62:
 *   "/pm pause" sets isPmPaused() = true, but scheduler.ts never checks it —
 *   promote, deprioritize, and cancel all run even when the PM Agent is paused.
 *
 * Expected (after fix): those three actions are skipped when isPmPaused() === true.
 * Actual (current):     all actions run regardless of pause state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPmScheduler } from "../pm/scheduler.js";
import { setPmPaused, isPmPaused } from "../pm/slack-interface.js";

describe("BEC-62 reproduction — scheduler ignores isPmPaused()", () => {
  const mockActions = {
    evaluateBudget: vi.fn().mockResolvedValue({
      scopes: [{
        scope: { kind: "global" as const },
        scopeLabel: "global",
        limit: 5_000_000,
        used: 500_000,
        percent: 10,
        tier: "ok" as const,
      }],
      worstTier: "ok" as const,
      promoteBlocked: false,
      activeCount: 0,
    }),
    triageNewIssues: vi.fn().mockResolvedValue([]),
    resolveApprovals: vi.fn().mockResolvedValue({ resolved: 0, stillPending: 0 }),
    promoteReadyIssues: vi.fn().mockResolvedValue([]),
    deprioritizeStaleIssues: vi.fn().mockResolvedValue([]),
    cancelAbandonedIssues: vi.fn().mockResolvedValue([]),
    postDigest: vi.fn().mockResolvedValue(undefined),
    getActiveFileMaps: vi.fn().mockResolvedValue(new Map()),
    predictConflict: vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" }),
  };

  function makeScheduler() {
    return createPmScheduler({
      config: {
        enabled: true,
        cronIntervalMs: 1800000,
        maxInFlight: 3,
        triageBatchSize: 3,
        dailyTokenBudget: 5000000,
        slackChannelId: "C123",
        teamIds: ["team-1"],
        stuckIssueRecovery: true,
        stuckIssueTargetState: "Todo",
        stuckIssueMaxPerTick: 5,
        requirePipelineLabelForPromote: false,
      },
      db: {} as any,
      linearApiKey: "",
      slackBotToken: "",
      actions: mockActions,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setPmPaused(false);
  });

  it("confirms isPmPaused() returns true after /pm pause is issued", () => {
    // Simulates what executePmCommand does for { type: "pause" }
    setPmPaused(true);
    expect(isPmPaused()).toBe(true);
  });

  async function testActionSkippedWhenPaused(
    actionName: string,
    mockAction: ReturnType<typeof vi.fn>,
  ) {
    setPmPaused(true);
    const scheduler = makeScheduler();
    await scheduler.tick();
    expect(mockAction, `${actionName} must NOT be called when paused`).not.toHaveBeenCalled();
  }

  it("promote is skipped when isPmPaused() === true", async () => {
    // Also verify the flag is set correctly (simulates what /pm pause does)
    setPmPaused(true);
    expect(isPmPaused()).toBe(true);
    await testActionSkippedWhenPaused("promoteReadyIssues", mockActions.promoteReadyIssues);
  });

  it("deprioritize is skipped when isPmPaused() === true", async () => {
    await testActionSkippedWhenPaused("deprioritizeStaleIssues", mockActions.deprioritizeStaleIssues);
  });

  it("cancel is skipped when isPmPaused() === true", async () => {
    await testActionSkippedWhenPaused("cancelAbandonedIssues", mockActions.cancelAbandonedIssues);
  });

  it("non-destructive actions (triage + resolveApprovals) still run when paused", async () => {
    setPmPaused(true);

    const scheduler = makeScheduler();
    await scheduler.tick();

    // Both triage and resolveApprovals should still run — they are non-destructive.
    // CURRENT behavior: they do run (correct, even if for the wrong reason).
    expect(mockActions.triageNewIssues).toHaveBeenCalled();
    expect(mockActions.resolveApprovals).toHaveBeenCalled();
  });
});

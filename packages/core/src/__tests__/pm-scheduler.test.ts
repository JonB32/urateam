import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPmScheduler } from "../pm/scheduler.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";
import type { BudgetEvaluation } from "../pm/types.js";

function mockOkEvaluation(overrides: Partial<BudgetEvaluation> = {}): BudgetEvaluation {
  return {
    scopes: [
      {
        scope: { kind: "global" as const },
        scopeLabel: "global",
        limit: 5_000_000,
        used: 0,
        percent: 0,
        tier: "ok" as const,
      },
    ],
    worstTier: "ok",
    promoteBlocked: false,
    activeCount: 0,
    ...overrides,
  };
}

function mockBlockedEvaluation(): BudgetEvaluation {
  return {
    scopes: [
      {
        scope: { kind: "global" as const },
        scopeLabel: "global",
        limit: 5_000_000,
        used: 5_000_000,
        percent: 100,
        tier: "blocked-100" as const,
      },
    ],
    worstTier: "blocked-100",
    promoteBlocked: true,
    blockReason: "global at 100% (5,000,000 / 5,000,000 tokens)",
    activeCount: 0,
  };
}

describe("PmScheduler.tick", () => {
  const mockActions = {
    evaluateBudget: vi.fn().mockResolvedValue(mockOkEvaluation()),
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

  function makeScheduler() {
    return createPmScheduler({
      config: {
        enabled: true,
        cronIntervalMs: 1800000,
        triageBatchSize: 3,
        maxInFlight: 3,
        dailyTokenBudget: 5000000,
        slackChannelId: "C123",
        teamIds: ["team-1"],
        stuckIssueRecovery: true,
        stuckIssueTargetState: "Todo",
        stuckIssueMaxPerTick: 5,
        requirePipelineLabelForPromote: false,
      },
      db: {} as any, // Not used when actions are injected
      linearApiKey: "",
      slackBotToken: "",
      actions: mockActions,
    });
  }

  beforeEach(async () => {
    await installTestProLicense();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await restoreLicense();
  });

  it("executes actions in correct sequence", async () => {
    const callOrder: string[] = [];
    mockActions.evaluateBudget.mockImplementation(async () => {
      callOrder.push("budget");
      return mockOkEvaluation({ activeCount: 1 });
    });
    mockActions.recoverRetriableRuns.mockImplementation(async () => { callOrder.push("recover"); return { recovered: [], exhausted: [] }; });
    mockActions.recoverStuckInProgressIssues.mockImplementation(async () => { callOrder.push("recoverStuck"); return []; });
    mockActions.triageNewIssues.mockImplementation(async () => { callOrder.push("triage"); return []; });
    mockActions.resolveApprovals.mockImplementation(async () => { callOrder.push("resolveApprovals"); return { resolved: 0, stillPending: 0 }; });
    mockActions.promoteReadyIssues.mockImplementation(async () => { callOrder.push("promote"); return []; });
    mockActions.deprioritizeStaleIssues.mockImplementation(async () => { callOrder.push("deprioritize"); return []; });
    mockActions.cancelAbandonedIssues.mockImplementation(async () => { callOrder.push("cancel"); return []; });

    const scheduler = makeScheduler();
    await scheduler.tick();

    expect(callOrder).toEqual([
      "budget", "recover", "recoverStuck", "triage", "resolveApprovals", "promote", "deprioritize", "cancel",
    ]);
  });

  it("calls recoverStuckInProgressIssues on each tick (after budget check, before triage)", async () => {
    const scheduler = makeScheduler();
    await scheduler.tick();
    await scheduler.tick();

    // Verify it was called on each tick
    expect(mockActions.recoverStuckInProgressIssues).toHaveBeenCalledTimes(2);

    // Verify ordering: recoverStuck must be called after budget and before triage
    const budgetOrder = mockActions.evaluateBudget.mock.invocationCallOrder[0];
    const recoverStuckOrder = mockActions.recoverStuckInProgressIssues.mock.invocationCallOrder[0];
    const triageOrder = mockActions.triageNewIssues.mock.invocationCallOrder[0];
    expect(recoverStuckOrder).toBeGreaterThan(budgetOrder);
    expect(recoverStuckOrder).toBeLessThan(triageOrder);
  });

  it("skips promote when budget blocked", async () => {
    mockActions.evaluateBudget.mockResolvedValue(mockBlockedEvaluation());

    const scheduler = makeScheduler();
    await scheduler.tick();

    expect(mockActions.promoteReadyIssues).not.toHaveBeenCalled();
    expect(mockActions.triageNewIssues).toHaveBeenCalled();
  });

  it("calls postDigest with tick results", async () => {
    mockActions.triageNewIssues.mockResolvedValue([
      { issueId: "BEC-1", priority: 2, labels: ["bug"], complexity: "small", rationale: "test" },
    ]);

    const scheduler = makeScheduler();
    await scheduler.tick();

    expect(mockActions.postDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        triaged: expect.arrayContaining([expect.objectContaining({ issueId: "BEC-1" })]),
      }),
      expect.any(Number),
    );
  });

  it("catches and records errors from individual actions", async () => {
    mockActions.triageNewIssues.mockRejectedValue(new Error("Linear API down"));

    const scheduler = makeScheduler();
    await scheduler.tick();

    expect(mockActions.postDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("triage")]),
      }),
      expect.any(Number),
    );
  });
});

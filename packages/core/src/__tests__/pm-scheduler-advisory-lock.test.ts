/**
 * BEC-200: PM scheduler pg_advisory_lock contention test.
 *
 * Verifies that when the Postgres advisory lock is already held by another
 * tick process, scheduler.tick() exits immediately without invoking any actions.
 *
 * The pg advisory lock is a Postgres-only code path (tryAcquireLock returns
 * true immediately for SQLite). To exercise it without a real Postgres instance
 * we mock isPostgres so it returns true for a specially-marked sentinel DB,
 * and make the DB's execute() return acquired=false.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPmScheduler } from "../pm/scheduler.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";
import type { BudgetEvaluation } from "../pm/types.js";

// ---------------------------------------------------------------------------
// Mock isPostgres to recognise a sentinel mock DB as Postgres.
// All other DB objects (including real SQLite DBs) are unaffected because
// they don't carry the __testForcePostgres flag.
// ---------------------------------------------------------------------------

vi.mock("../db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/client.js")>();
  return {
    ...actual,
    isPostgres: (db: any) => db?.__testForcePostgres === true,
  };
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

const BASE_SCHEDULER_CONFIG = {
  enabled: true,
  cronIntervalMs: 1_800_000,
  triageBatchSize: 3,
  maxInFlight: 3,
  dailyTokenBudget: 5_000_000,
  slackChannelId: "C123",
  teamIds: ["team-1"],
  stuckIssueRecovery: true,
  stuckIssueTargetState: "Todo",
  stuckIssueMaxPerTick: 5,
  requirePipelineLabelForPromote: false,
  maxConsecutiveFailures: 3,
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PmScheduler — pg_advisory_lock contention (BEC-200)", () => {
  const mockActions = {
    evaluateBudget: vi.fn(),
    recoverRetriableRuns: vi.fn(),
    recoverStuckInProgressIssues: vi.fn(),
    triageNewIssues: vi.fn(),
    resolveApprovals: vi.fn(),
    promoteReadyIssues: vi.fn(),
    deprioritizeStaleIssues: vi.fn(),
    cancelAbandonedIssues: vi.fn(),
    postDigest: vi.fn(),
    getActiveFileMaps: vi.fn(),
    predictConflict: vi.fn(),
  };

  beforeEach(async () => {
    await installTestProLicense();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await restoreLicense();
  });

  // ─── 6. pg_advisory_lock not acquired → tick exits early ──────────────────

  it("skips tick entirely when pg_advisory_lock is already held (acquired=false)", async () => {
    // Sentinel mock DB: isPostgres() returns true, execute() returns acquired=false
    const mockDb = {
      __testForcePostgres: true,
      execute: vi.fn().mockResolvedValue([{ acquired: false }]),
    } as any;

    const scheduler = createPmScheduler({
      config: BASE_SCHEDULER_CONFIG,
      db: mockDb,
      linearApiKey: "",
      slackBotToken: "",
      actions: mockActions,
    });

    await scheduler.tick();

    // Lock was checked (the pg_try_advisory_lock query was executed)
    expect(mockDb.execute).toHaveBeenCalledTimes(1);

    // All actions must be skipped — tick exits immediately after the lock check
    expect(mockActions.evaluateBudget).not.toHaveBeenCalled();
    expect(mockActions.recoverRetriableRuns).not.toHaveBeenCalled();
    expect(mockActions.triageNewIssues).not.toHaveBeenCalled();
    expect(mockActions.promoteReadyIssues).not.toHaveBeenCalled();
    expect(mockActions.postDigest).not.toHaveBeenCalled();
  });

  it("proceeds with full tick when pg_advisory_lock is successfully acquired (acquired=true)", async () => {
    // Sentinel mock DB: isPostgres() returns true, execute() returns acquired=true
    // The scheduler also calls execute() again in releaseLock() at the end.
    const mockDb = {
      __testForcePostgres: true,
      execute: vi.fn().mockResolvedValue([{ acquired: true }]),
    } as any;

    // Wire up action mocks with valid responses so the tick completes
    mockActions.evaluateBudget.mockResolvedValue(mockOkEvaluation());
    mockActions.recoverRetriableRuns.mockResolvedValue({ recovered: [], exhausted: [] });
    mockActions.recoverStuckInProgressIssues.mockResolvedValue([]);
    mockActions.triageNewIssues.mockResolvedValue([]);
    mockActions.resolveApprovals.mockResolvedValue({ resolved: 0, stillPending: 0 });
    mockActions.promoteReadyIssues.mockResolvedValue([]);
    mockActions.deprioritizeStaleIssues.mockResolvedValue([]);
    mockActions.cancelAbandonedIssues.mockResolvedValue([]);
    mockActions.postDigest.mockResolvedValue(undefined);

    const scheduler = createPmScheduler({
      config: BASE_SCHEDULER_CONFIG,
      db: mockDb,
      linearApiKey: "",
      slackBotToken: "",
      actions: mockActions,
    });

    await scheduler.tick();

    // Lock was acquired → tick ran → actions were invoked
    expect(mockActions.evaluateBudget).toHaveBeenCalledTimes(1);
    expect(mockActions.triageNewIssues).toHaveBeenCalledTimes(1);
    expect(mockActions.postDigest).toHaveBeenCalledTimes(1);

    // execute() called at least twice: once for tryAcquireLock, once for releaseLock
    expect(mockDb.execute).toHaveBeenCalledTimes(2);
  });

  it("skips tick on second concurrent call when first tick holds the lock", async () => {
    // Simulate a race: first call acquires, second call finds the lock taken
    const mockDb = {
      __testForcePostgres: true,
      execute: vi
        .fn()
        // First tick: acquire → proceed
        .mockResolvedValueOnce([{ acquired: true }])
        // Second tick: lock already held → skip
        .mockResolvedValueOnce([{ acquired: false }])
        // First tick's release lock call
        .mockResolvedValueOnce([{ released: true }]),
    } as any;

    mockActions.evaluateBudget.mockResolvedValue(mockOkEvaluation());
    mockActions.recoverRetriableRuns.mockResolvedValue({ recovered: [], exhausted: [] });
    mockActions.recoverStuckInProgressIssues.mockResolvedValue([]);
    mockActions.triageNewIssues.mockResolvedValue([]);
    mockActions.resolveApprovals.mockResolvedValue({ resolved: 0, stillPending: 0 });
    mockActions.promoteReadyIssues.mockResolvedValue([]);
    mockActions.deprioritizeStaleIssues.mockResolvedValue([]);
    mockActions.cancelAbandonedIssues.mockResolvedValue([]);
    mockActions.postDigest.mockResolvedValue(undefined);

    const scheduler = createPmScheduler({
      config: BASE_SCHEDULER_CONFIG,
      db: mockDb,
      linearApiKey: "",
      slackBotToken: "",
      actions: mockActions,
    });

    // Sequential: first tick runs, second finds lock held
    await scheduler.tick(); // tick 1: acquires, runs
    vi.clearAllMocks();     // reset call counts
    await scheduler.tick(); // tick 2: lock not acquired → exits immediately

    // Second tick skipped all actions
    expect(mockActions.evaluateBudget).not.toHaveBeenCalled();
    expect(mockActions.postDigest).not.toHaveBeenCalled();
  });
});

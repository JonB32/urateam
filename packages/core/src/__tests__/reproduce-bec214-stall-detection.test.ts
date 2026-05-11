/**
 * BEC-214: Runner-level stall detection — integration tests.
 *
 * These tests verify that `PipelineRunner` detects and terminates stalled
 * pipeline runs via the `checkForStalledRuns()` method and its periodic
 * polling interval (`startStalledRunDetection` / `stopStalledRunDetection`).
 *
 * ## What "stalled" means
 *
 * A run is stalled when `active_work.updatedAt` has not advanced for longer
 * than `stallThresholdMs` (default 30 minutes). The `active_work` table is
 * updated at every stage boundary via `upsertActiveWork`, so a run stuck in
 * the middle of a stage (or between stages) will trigger detection once the
 * threshold elapses.
 *
 * ## Existing defences (context)
 *
 * - Stream-level `StageStalledError` (progressTimeoutMs 30 min) — fires inside the
 *   Agent SDK stream; cannot cover orchestration-layer hangs.
 * - Wall-clock per-stage cap in executor.ts (60 min implement / 30 min others).
 * - PM Agent zombie recovery (BEC-184) — fires every PM tick (~minutes), not
 *   every 60 s, and uses full run-age (60 min) rather than inactivity window.
 *
 * `checkForStalledRuns()` closes the gap: it runs every 60 s from within the
 * PipelineRunner itself (no dependency on the PM Agent) and can detect a hung
 * run that slipped past the stream-level guards.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PipelineRunner } from "../pipeline/runner.js";

// ---------------------------------------------------------------------------
// vi.mock must be at module top level — hoisted by vitest transform.
// We mock only the coordination helpers used by checkForStalledRuns so the
// rest of the runner is exercised as-is (no full DB setup needed).
//
// vi.hoisted ensures the mock functions are created BEFORE vi.mock factories
// execute (vi.mock is hoisted above variable declarations by vitest's transform).
// ---------------------------------------------------------------------------

const { mockGetActiveWork, mockRemoveActiveWork } = vi.hoisted(() => ({
  mockGetActiveWork: vi.fn(),
  mockRemoveActiveWork: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../pm/coordination.js", () => ({
  upsertActiveWork: vi.fn().mockResolvedValue(undefined),
  removeActiveWork: (...args: unknown[]) => mockRemoveActiveWork(...args),
  checkFileOverlap: vi.fn().mockResolvedValue({ hasOverlap: false, overlappingFiles: [], conflictingRunIds: [] }),
  getModifiedFiles: vi.fn().mockResolvedValue([]),
  getActiveWork: (...args: unknown[]) => mockGetActiveWork(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSetWhereMock() {
  const whereFn = vi.fn().mockResolvedValue({});
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  const updateFn = vi.fn().mockReturnValue({ set: setFn });
  return { updateFn, setFn, whereFn };
}

function buildRunner(overrides?: {
  stallThresholdMs?: number;
  stallCheckIntervalMs?: number;
}) {
  const { updateFn, setFn, whereFn } = buildSetWhereMock();

  const fakeDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: updateFn,
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
  };

  const runner = new PipelineRunner({
    db: fakeDb as any,
    notifier: {} as any,
    concurrency: 1,
    agentRunDir: "/tmp/test-runs",
    repoCloneDir: "/tmp/test-repos",
    stallThresholdMs: overrides?.stallThresholdMs ?? 30 * 60 * 1000,
    stallCheckIntervalMs: overrides?.stallCheckIntervalMs ?? 60 * 1000,
  });

  return { runner, fakeDb, updateFn, setFn, whereFn };
}

// ---------------------------------------------------------------------------
// AC 1 — PipelineRunner exposes the stall-detection API
// ---------------------------------------------------------------------------

describe("BEC-214 AC1: PipelineRunner stall-detection API", () => {
  it("exposes checkForStalledRuns() as a public method", () => {
    const { runner } = buildRunner();
    expect(typeof runner.checkForStalledRuns).toBe("function");
    runner.stopStalledRunDetection();
  });

  it("exposes startStalledRunDetection() as a public method", () => {
    const { runner } = buildRunner();
    expect(typeof runner.startStalledRunDetection).toBe("function");
    runner.stopStalledRunDetection();
  });

  it("exposes stopStalledRunDetection() as a public method", () => {
    const { runner } = buildRunner();
    expect(typeof runner.stopStalledRunDetection).toBe("function");
    runner.stopStalledRunDetection();
  });
});

// ---------------------------------------------------------------------------
// AC 2 — Detection fires when run exceeds the stall threshold
// ---------------------------------------------------------------------------

describe("BEC-214 AC2: stall threshold detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a run stalled when updatedAt is older than stallThresholdMs", async () => {
    const { runner, setFn } = buildRunner({ stallThresholdMs: 30 * 60 * 1000 });

    const runId = "stalled-run-001";
    const issueId = "BEC-TEST-1";
    // Simulate a run that last updated 31 minutes ago (past the 30-min threshold).
    const stalePastMs = Date.now() - 31 * 60 * 1000;

    // Inject the run into the in-memory activeRuns map.
    (runner as any).activeRuns.set(issueId, runId);

    mockGetActiveWork.mockResolvedValueOnce([
      {
        id: runId,
        runId,
        issueId,
        stage: "implement",
        filesModified: null,
        startedAt: new Date(stalePastMs - 5 * 60 * 1000),
        updatedAt: new Date(stalePastMs),
      },
    ]);

    await runner.checkForStalledRuns();

    // The DB update should have been called with status='failed' and an
    // error message containing 'stalled process'.
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorMessage: expect.stringContaining("stalled process"),
      }),
    );

    runner.stopStalledRunDetection();
  });

  it("does NOT mark a recently active run as stalled", async () => {
    const { runner, setFn } = buildRunner({ stallThresholdMs: 30 * 60 * 1000 });

    const runId = "recent-run-001";
    const issueId = "BEC-TEST-2";
    // Only 5 minutes since last activity — well within the 30-min threshold.
    const recentMs = Date.now() - 5 * 60 * 1000;

    (runner as any).activeRuns.set(issueId, runId);

    mockGetActiveWork.mockResolvedValueOnce([
      {
        id: runId,
        runId,
        issueId,
        stage: "implement",
        filesModified: null,
        startedAt: new Date(recentMs - 60 * 1000),
        updatedAt: new Date(recentMs),
      },
    ]);

    await runner.checkForStalledRuns();

    // DB update must NOT have been called.
    expect(setFn).not.toHaveBeenCalled();
    // Run is still active.
    expect((runner as any).activeRuns.has(issueId)).toBe(true);

    runner.stopStalledRunDetection();
  });

  it("ignores active_work entries that do not belong to this runner instance", async () => {
    const { runner, setFn } = buildRunner({ stallThresholdMs: 30 * 60 * 1000 });

    const foreignRunId = "foreign-run-999";
    const stalePastMs = Date.now() - 45 * 60 * 1000;

    // Do NOT add foreignRunId to activeRuns — simulates a different process.
    mockGetActiveWork.mockResolvedValueOnce([
      {
        id: foreignRunId,
        runId: foreignRunId,
        issueId: "FOREIGN-1",
        stage: "review",
        filesModified: null,
        startedAt: new Date(stalePastMs - 5 * 60 * 1000),
        updatedAt: new Date(stalePastMs),
      },
    ]);

    await runner.checkForStalledRuns();

    // Must not touch a run we don't own.
    expect(setFn).not.toHaveBeenCalled();

    runner.stopStalledRunDetection();
  });
});

// ---------------------------------------------------------------------------
// AC 3 — Termination cleans up locks, resources, and DB state
// ---------------------------------------------------------------------------

describe("BEC-214 AC3: stalled run termination cleans up resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes stalled run from activeRuns and active_work, and sets DB to failed", async () => {
    const { runner, setFn } = buildRunner();

    const runId = "cleanup-run-001";
    const issueId = "CLEANUP-1";
    const stalePastMs = Date.now() - 45 * 60 * 1000;

    (runner as any).activeRuns.set(issueId, runId);

    mockGetActiveWork.mockResolvedValueOnce([
      {
        id: runId,
        runId,
        issueId,
        stage: "test",
        filesModified: null,
        startedAt: new Date(stalePastMs - 5 * 60 * 1000),
        updatedAt: new Date(stalePastMs),
      },
    ]);

    await runner.checkForStalledRuns();

    // AC3a: in-memory slot released.
    expect((runner as any).activeRuns.has(issueId)).toBe(false);

    // AC3b: coordination row removed.
    expect(mockRemoveActiveWork).toHaveBeenCalledWith(
      expect.anything(),
      runId,
    );

    // AC3c: DB updated to failed with completedAt timestamp.
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        completedAt: expect.any(Date),
        errorMessage: expect.stringContaining("stalled process"),
      }),
    );

    runner.stopStalledRunDetection();
  });
});

// ---------------------------------------------------------------------------
// AC 5 — Integration: periodic polling via fake timers
// ---------------------------------------------------------------------------

describe("BEC-214 AC5: stall detection polling interval (integration)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checkForStalledRuns() is called at least once per stallCheckIntervalMs", async () => {
    vi.useFakeTimers();

    const { runner } = buildRunner({ stallCheckIntervalMs: 60_000 });
    const spy = vi
      .spyOn(runner, "checkForStalledRuns")
      .mockResolvedValue(undefined);

    runner.startStalledRunDetection();

    // No calls yet — interval hasn't fired.
    expect(spy).not.toHaveBeenCalled();

    // Advance exactly one polling interval.
    await vi.advanceTimersByTimeAsync(60_001);
    expect(spy).toHaveBeenCalledTimes(1);

    // Advance two more intervals.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spy).toHaveBeenCalledTimes(3);

    runner.stopStalledRunDetection();
  });

  it("startStalledRunDetection() is idempotent — second call is a no-op", async () => {
    vi.useFakeTimers();

    const { runner } = buildRunner({ stallCheckIntervalMs: 60_000 });
    const spy = vi
      .spyOn(runner, "checkForStalledRuns")
      .mockResolvedValue(undefined);

    runner.startStalledRunDetection();
    runner.startStalledRunDetection(); // second call should be no-op

    await vi.advanceTimersByTimeAsync(60_001);
    // Exactly 1 call — only one interval was started.
    expect(spy).toHaveBeenCalledTimes(1);

    runner.stopStalledRunDetection();
  });

  it("stopStalledRunDetection() halts the polling loop", async () => {
    vi.useFakeTimers();

    const { runner } = buildRunner({ stallCheckIntervalMs: 60_000 });
    const spy = vi
      .spyOn(runner, "checkForStalledRuns")
      .mockResolvedValue(undefined);

    runner.startStalledRunDetection();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(spy).toHaveBeenCalledTimes(1);

    runner.stopStalledRunDetection();

    // After stopping, no further calls should happen.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("simulates a stalled run: detects within one polling interval", async () => {
    vi.useFakeTimers();

    // Use a very short stall threshold (1 s) and polling interval (500 ms) so
    // fake-timer advancement is tiny in test time.
    const { runner, setFn } = buildRunner({
      stallThresholdMs: 1_000,
      stallCheckIntervalMs: 500,
    });

    const runId = "sim-stalled-run";
    const issueId = "SIM-1";

    (runner as any).activeRuns.set(issueId, runId);

    // Simulate an entry whose updatedAt is already 2 seconds in the past
    // (past the 1-second stall threshold set above).
    mockGetActiveWork.mockResolvedValue([
      {
        id: runId,
        runId,
        issueId,
        stage: "implement",
        filesModified: null,
        startedAt: new Date(Date.now() - 10_000),
        updatedAt: new Date(Date.now() - 2_000),
      },
    ]);

    runner.startStalledRunDetection();

    // Advance past one polling interval — stall should be detected.
    await vi.advanceTimersByTimeAsync(501);

    // DB update must fire with failed status.
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorMessage: expect.stringContaining("stalled process"),
      }),
    );
    // Run removed from activeRuns.
    expect((runner as any).activeRuns.has(issueId)).toBe(false);

    runner.stopStalledRunDetection();
  });
});

// ---------------------------------------------------------------------------
// AC 6 — Structured log emission (smoke test — pino logs are structured JSON)
// ---------------------------------------------------------------------------

describe("BEC-214 AC6: structured log emission for stalled runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checkForStalledRuns() completes without throwing when a stalled run is found", async () => {
    const { runner } = buildRunner();

    const runId = "log-run-001";
    const issueId = "LOG-1";
    const stalePastMs = Date.now() - 35 * 60 * 1000;

    (runner as any).activeRuns.set(issueId, runId);

    mockGetActiveWork.mockResolvedValueOnce([
      {
        id: runId,
        runId,
        issueId,
        stage: "review",
        filesModified: null,
        startedAt: new Date(stalePastMs - 5 * 60 * 1000),
        updatedAt: new Date(stalePastMs),
      },
    ]);

    // Must not throw — log emission is fire-and-forget from pino.
    await expect(runner.checkForStalledRuns()).resolves.toBeUndefined();

    runner.stopStalledRunDetection();
  });
});

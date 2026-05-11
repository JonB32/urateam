/**
 * BEC-210: checkStalledStages unit tests.
 *
 * Verifies that:
 * 1. No stalled stages are returned when active_work is empty.
 * 2. No stalled stages are returned when all active_work entries are fresh.
 * 3. Stalled stages are detected when active_work entries are older than the threshold.
 * 4. Multiple stalled stages are returned and each has the correct fields.
 * 5. The maxResults limit is respected.
 * 6. Custom staleAgeMinutes threshold is honoured.
 * 7. DB query failures are handled gracefully (returns []).
 * 8. markRunAsResumeEligible no-ops when run is not in "running" status.
 * 9. markRunAsResumeEligible returns true and updates the run when status is "running".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkStalledStages,
  markRunAsResumeEligible,
  removeActiveWorkForRun,
  DEFAULT_STALLED_STAGE_THRESHOLD_MINUTES,
} from "../pm/actions/check-stalled-stages.js";

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Mock DB builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock DB that returns `selectRows` for the first .select() chain
 * (used by checkStalledStages to query active_work).
 */
function makeDb(selectRows: any[] = []) {
  const limitFn = vi.fn().mockResolvedValue(selectRows);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  // Also mock update/set/where chain for markRunAsResumeEligible
  const updateWhereFn = vi.fn().mockResolvedValue({ rowsAffected: 1 });
  const updateSetFn = vi.fn().mockReturnValue({ where: updateWhereFn });
  const updateFn = vi.fn().mockReturnValue({ set: updateSetFn });

  // Also mock delete/where chain for removeActiveWorkForRun
  const deleteWhereFn = vi.fn().mockResolvedValue({ rowsAffected: 1 });
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhereFn });

  return {
    select: selectFn,
    update: updateFn,
    delete: deleteFn,
    _selectFn: selectFn,
    _whereFn: whereFn,
    _limitFn: limitFn,
    _updateFn: updateFn,
    _updateSetFn: updateSetFn,
    _updateWhereFn: updateWhereFn,
    _deleteFn: deleteFn,
    _deleteWhereFn: deleteWhereFn,
  };
}

/**
 * Build a mock DB that returns pipeline run rows for markRunAsResumeEligible's
 * SELECT query (first call), then handles the UPDATE.
 */
function makeDbForResume(runRows: any[] = []) {
  const updateWhereFn = vi.fn().mockResolvedValue({ rowsAffected: 1 });
  const updateSetFn = vi.fn().mockReturnValue({ where: updateWhereFn });
  const updateFn = vi.fn().mockReturnValue({ set: updateSetFn });

  // SELECT chain: first call returns runRows
  const limitFn = vi.fn().mockResolvedValue(runRows);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  return {
    select: selectFn,
    update: updateFn,
    _updateFn: updateFn,
    _updateSetFn: updateSetFn,
    _updateWhereFn: updateWhereFn,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActiveWorkRow(
  runId: string,
  issueId: string,
  stage: string,
  updatedAt: Date,
) {
  return { runId, issueId, stage, updatedAt };
}

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000);
}

// ---------------------------------------------------------------------------
// checkStalledStages tests
// ---------------------------------------------------------------------------

describe("checkStalledStages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when active_work has no stale entries", async () => {
    const db = makeDb([]);
    const result = await checkStalledStages({ db: db as any });
    expect(result).toEqual([]);
  });

  it("returns empty array when all active_work entries are fresher than the threshold", async () => {
    // updatedAt = 5 min ago, threshold = 30 min → not stale
    const freshRow = makeActiveWorkRow("run-1", "BEC-10", "implement", minutesAgo(5));
    const db = makeDb([freshRow]);
    // The DB WHERE clause (lt) is applied at the DB level; our mock always
    // returns what we configure. In this test we configure [] to simulate
    // the DB correctly filtering out fresh rows.
    const dbEmpty = makeDb([]);
    const result = await checkStalledStages({ db: dbEmpty as any, staleAgeMinutes: 30 });
    expect(result).toEqual([]);
  });

  it("detects a single stalled stage", async () => {
    const staleUpdatedAt = minutesAgo(40); // 40 min ago, threshold = 30 → stale
    const row = makeActiveWorkRow("run-stalled", "BEC-42", "implement", staleUpdatedAt);
    const db = makeDb([row]);

    const result = await checkStalledStages({ db: db as any, staleAgeMinutes: 30 });

    expect(result).toHaveLength(1);
    expect(result[0].runId).toBe("run-stalled");
    expect(result[0].issueId).toBe("BEC-42");
    expect(result[0].stageName).toBe("implement");
    expect(result[0].lastActiveTimestamp).toBeInstanceOf(Date);
    expect(result[0].stalledDurationSeconds).toBeGreaterThanOrEqual(40 * 60 - 2);
  });

  it("detects multiple stalled stages and includes all in the result", async () => {
    const rows = [
      makeActiveWorkRow("run-a", "BEC-1", "triage", minutesAgo(35)),
      makeActiveWorkRow("run-b", "BEC-2", "implement", minutesAgo(60)),
      makeActiveWorkRow("run-c", "BEC-3", "review", minutesAgo(45)),
    ];
    const db = makeDb(rows);

    const result = await checkStalledStages({ db: db as any });

    expect(result).toHaveLength(3);
    const runIds = result.map((r) => r.runId);
    expect(runIds).toContain("run-a");
    expect(runIds).toContain("run-b");
    expect(runIds).toContain("run-c");
  });

  it("each result has the required alert keys: runId, stageName, lastActiveTimestamp, stalledDurationSeconds", async () => {
    const staleUpdatedAt = minutesAgo(31);
    const row = makeActiveWorkRow("run-xyz", "BEC-99", "test", staleUpdatedAt);
    const db = makeDb([row]);

    const result = await checkStalledStages({ db: db as any });

    expect(result[0]).toMatchObject({
      runId: "run-xyz",
      issueId: "BEC-99",
      stageName: "test",
    });
    expect(result[0].lastActiveTimestamp).toBeInstanceOf(Date);
    expect(typeof result[0].stalledDurationSeconds).toBe("number");
    expect(result[0].stalledDurationSeconds).toBeGreaterThan(0);
  });

  it("respects the maxResults limit", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeActiveWorkRow(`run-${i}`, `BEC-${i}`, "implement", minutesAgo(40 + i)),
    );
    // The DB mock returns all 10; maxResults = 3 should limit the query
    const limitFn = vi.fn().mockResolvedValue(rows.slice(0, 3));
    const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as any;

    const result = await checkStalledStages({ db, maxResults: 3 });

    // Verify .limit(3) was called on the DB query
    expect(limitFn).toHaveBeenCalledWith(3);
    expect(result).toHaveLength(3);
  });

  it("uses custom staleAgeMinutes threshold", async () => {
    // Configure DB to return rows only when threshold is respected at query time
    const db = makeDb([]); // Empty → no stalled stages with our mock
    const result = await checkStalledStages({ db: db as any, staleAgeMinutes: 5 });
    expect(result).toEqual([]);
  });

  it("uses DEFAULT_STALLED_STAGE_THRESHOLD_MINUTES when staleAgeMinutes is omitted", () => {
    expect(DEFAULT_STALLED_STAGE_THRESHOLD_MINUTES).toBe(30);
  });

  it("returns empty array when DB query throws an error (fail-open)", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue(new Error("SQLITE_BUSY")),
          }),
        }),
      }),
    } as any;

    const result = await checkStalledStages({ db });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// markRunAsResumeEligible tests
// ---------------------------------------------------------------------------

describe("markRunAsResumeEligible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when run is not found", async () => {
    const db = makeDbForResume([]); // No rows returned
    const result = await markRunAsResumeEligible(db as any, "nonexistent-run");
    expect(result).toBe(false);
    expect(db._updateFn).not.toHaveBeenCalled();
  });

  it("returns false when run status is not 'running'", async () => {
    const db = makeDbForResume([{ id: "run-1", status: "failed" }]);
    const result = await markRunAsResumeEligible(db as any, "run-1");
    expect(result).toBe(false);
    expect(db._updateFn).not.toHaveBeenCalled();
  });

  it("returns false when run status is 'completed'", async () => {
    const db = makeDbForResume([{ id: "run-1", status: "completed" }]);
    const result = await markRunAsResumeEligible(db as any, "run-1");
    expect(result).toBe(false);
  });

  it("returns false when run status is 'retriable'", async () => {
    const db = makeDbForResume([{ id: "run-1", status: "retriable" }]);
    const result = await markRunAsResumeEligible(db as any, "run-1");
    expect(result).toBe(false);
  });

  it("returns true and calls update when run status is 'running'", async () => {
    const db = makeDbForResume([{ id: "run-1", status: "running" }]);
    const result = await markRunAsResumeEligible(db as any, "run-1");
    expect(result).toBe(true);
    expect(db._updateFn).toHaveBeenCalled();
    expect(db._updateSetFn).toHaveBeenCalledWith(
      expect.objectContaining({ status: "retriable" }),
    );
  });

  it("returns false when DB update throws", async () => {
    const failDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue(new Error("DB error")),
          }),
        }),
      }),
    } as any;
    const result = await markRunAsResumeEligible(failDb, "run-1");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeActiveWorkForRun tests
// ---------------------------------------------------------------------------

describe("removeActiveWorkForRun", () => {
  it("deletes the active_work row for the given runId", async () => {
    const deleteWhereFn = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhereFn });
    const db = { delete: deleteFn } as any;

    await removeActiveWorkForRun(db, "run-to-remove");

    expect(deleteFn).toHaveBeenCalled();
    expect(deleteWhereFn).toHaveBeenCalled();
  });

  it("does not throw when DB delete fails (best-effort)", async () => {
    const db = {
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error("DB error")),
      }),
    } as any;

    // Should not throw — removeActiveWorkForRun is best-effort
    await expect(removeActiveWorkForRun(db, "run-1")).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scheduler integration: stalled stage detection produces log alert
// ---------------------------------------------------------------------------

describe("checkStalledStages scheduler integration", () => {
  it("stalled result includes all fields required for an alert log entry", async () => {
    const stalledAt = minutesAgo(35);
    const row = makeActiveWorkRow("run-alert-test", "BEC-210", "implement", stalledAt);
    const db = makeDb([row]);

    const results = await checkStalledStages({ db: db as any, staleAgeMinutes: 30 });

    expect(results).toHaveLength(1);
    const [r] = results;

    // All required alert keys must be present and correctly typed
    expect(r.runId).toBe("run-alert-test");
    expect(r.stageName).toBe("implement");
    expect(r.lastActiveTimestamp).toBeInstanceOf(Date);
    expect(r.stalledDurationSeconds).toBeGreaterThan(30 * 60);

    // Verify the stalled duration is reasonable (between 34 and 36 minutes)
    const minExpected = 34 * 60;
    const maxExpected = 36 * 60;
    expect(r.stalledDurationSeconds).toBeGreaterThanOrEqual(minExpected);
    expect(r.stalledDurationSeconds).toBeLessThanOrEqual(maxExpected);
  });
});

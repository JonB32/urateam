import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDb, type AnyDb } from "../db/client.js";
import { pipelineRuns, circuitBreakerState } from "../db/schema.js";
import { selectProbeCandidates } from "../pm/actions/select-probe-candidates.js";
import { sweepRecoveredCircuitBreakers } from "../pm/actions/sweep-recovered-circuit-breakers.js";

const COOLDOWN_MS = 120 * 60 * 1000; // 120 min — production default

async function seedFailedRuns(
  db: AnyDb,
  issueId: string,
  count: number,
  startMs: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db.insert(pipelineRuns).values({
      id: `${issueId}-fail-${i}`,
      issueId,
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "failed",
      startedAt: new Date(startMs + i * 1000),
    });
  }
}

describe("BEC-236 circuit-breaker recovery — integration", () => {
  let db: AnyDb;
  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
  });

  it("drains a 5-issue frozen backlog at rate `cap` per tick across cooldowns", async () => {
    // Seed 5 escalated, circuit-broken issues.
    for (let i = 1; i <= 5; i++) {
      const id = `BEC-${i}`;
      await seedFailedRuns(db, id, 3, 1_000_000_000_000 + i);
      await db.insert(circuitBreakerState).values({
        issueId: id,
        escalatedAt: new Date(1_000_000_000_000 + i),
        probeAttempts: 0,
      });
    }

    // Tick 1 (no prior probes): cap=2 → picks 2 issues.
    const t1 = 2_000_000_000_000;
    const set1 = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: COOLDOWN_MS,
      maxConsecutiveFailures: 3,
      now: t1,
    });
    expect(set1.size).toBe(2);

    // Tick 2, 1 second later (cooldown not elapsed for tick-1's picks):
    // selects only from the 3 never-probed issues → cap=2.
    const t2 = t1 + 1_000;
    const set2 = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: COOLDOWN_MS,
      maxConsecutiveFailures: 3,
      now: t2,
    });
    expect(set2.size).toBe(2);
    // No overlap with tick 1 — round-robin.
    for (const id of set2) expect(set1.has(id)).toBe(false);

    // Tick 3, 1 second later: only 1 never-probed issue remains.
    const t3 = t2 + 1_000;
    const set3 = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: COOLDOWN_MS,
      maxConsecutiveFailures: 3,
      now: t3,
    });
    expect(set3.size).toBe(1);
    // Doesn't overlap either prior tick.
    for (const id of set3) {
      expect(set1.has(id)).toBe(false);
      expect(set2.has(id)).toBe(false);
    }

    // Tick 4, 1 second later: all probed once, cooldown not elapsed for any.
    const t4 = t3 + 1_000;
    const set4 = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: COOLDOWN_MS,
      maxConsecutiveFailures: 3,
      now: t4,
    });
    expect(set4.size).toBe(0);

    // Tick 5, AFTER cooldown elapses on tick-1's picks: re-elects them.
    const t5 = t1 + COOLDOWN_MS + 1;
    const set5 = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: COOLDOWN_MS,
      maxConsecutiveFailures: 3,
      now: t5,
    });
    expect(set5.size).toBe(2);
    // Tick-1's picks are the oldest probed, so they come back first.
    for (const id of set5) expect(set1.has(id)).toBe(true);
  });

  it("sweep recovers issues whose latest run is `completed` (probe-success path)", async () => {
    // BEC-1 was Tier-5-escalated (state row + 3 failed runs).
    await seedFailedRuns(db, "BEC-1", 3, 1_000_000_000_000);
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(1_000_000_000_000),
      probeAttempts: 2,
    });

    // Probe ran and the resulting pipeline reached `completed` — simulate
    // that by inserting a completed run AFTER the failed runs.
    await db.insert(pipelineRuns).values({
      id: "BEC-1-probe-ok",
      issueId: "BEC-1",
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "completed",
      startedAt: new Date(1_000_000_999_999),
    });

    // Next PM tick sweeps recovered issues.
    const linearClient = {
      issue: vi.fn().mockResolvedValue({
        id: "BEC-1-uuid",
        labels: vi.fn().mockResolvedValue({
          nodes: [
            { id: "lbl-bug", name: "bug" },
            { id: "lbl-nd", name: "needs-design" },
          ],
        }),
      }),
      updateIssue: vi.fn().mockResolvedValue({}),
    };

    const result = await sweepRecoveredCircuitBreakers(db, linearClient as any, {
      maxConsecutiveFailures: 3,
    });

    expect(result.recovered).toEqual(["BEC-1"]);
    expect((await db.select().from(circuitBreakerState)).length).toBe(0);
    expect(linearClient.updateIssue).toHaveBeenCalledOnce();
    const [, payload] = linearClient.updateIssue.mock.calls[0];
    expect(payload.labelIds).toEqual(["lbl-bug"]); // needs-design stripped
  });

  it("probe + sweep interact correctly across a 3-tick window", async () => {
    // Two broken issues. After probe, simulate one completing successfully.
    for (const id of ["BEC-1", "BEC-2"]) {
      await seedFailedRuns(db, id, 3, 1_000_000_000_000);
      await db.insert(circuitBreakerState).values({
        issueId: id,
        escalatedAt: new Date(1_000_000_000_000),
        probeAttempts: 0,
      });
    }

    const linearClient = {
      issue: vi.fn().mockImplementation(async (id: string) => ({
        id: `${id}-uuid`,
        labels: vi.fn().mockResolvedValue({
          nodes: [{ id: "lbl-nd", name: "needs-design" }],
        }),
      })),
      updateIssue: vi.fn().mockResolvedValue({}),
    };

    // Tick 1: probe picks both (cap=2), state rows updated.
    const t1 = 2_000_000_000_000;
    const probeSet = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: COOLDOWN_MS,
      maxConsecutiveFailures: 3,
      now: t1,
    });
    expect(probeSet.size).toBe(2);

    // BEC-1's probe run completes successfully (simulated).
    await db.insert(pipelineRuns).values({
      id: "BEC-1-probe-ok",
      issueId: "BEC-1",
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "completed",
      startedAt: new Date(t1 + 60_000),
    });
    // BEC-2's probe run also failed (now 4 consecutive failures).
    await db.insert(pipelineRuns).values({
      id: "BEC-2-probe-fail",
      issueId: "BEC-2",
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "failed",
      startedAt: new Date(t1 + 60_000),
    });

    // Tick 2 (next PM tick): sweep recovers BEC-1, leaves BEC-2.
    const sweepResult = await sweepRecoveredCircuitBreakers(db, linearClient as any, {
      maxConsecutiveFailures: 3,
    });
    expect(sweepResult.recovered).toEqual(["BEC-1"]);
    const stateAfter = await db.select().from(circuitBreakerState);
    expect(stateAfter.map((s: { issueId: string }) => s.issueId)).toEqual(["BEC-2"]);
  });
});

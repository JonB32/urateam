import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type AnyDb } from "../db/client.js";
import { pipelineRuns, circuitBreakerState } from "../db/schema.js";
import { selectProbeCandidates } from "../pm/actions/select-probe-candidates.js";

async function seedFailedRuns(db: AnyDb, issueId: string, count: number, startMs: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db.insert(pipelineRuns).values({
      id: `${issueId}-run-${i}`,
      issueId,
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "failed",
      startedAt: new Date(startMs + i * 1000),
    });
  }
}

async function seedState(db: AnyDb, issueId: string, lastProbeAt: number | null, probeAttempts = 0): Promise<void> {
  await db.insert(circuitBreakerState).values({
    issueId,
    escalatedAt: new Date(1_000_000_000_000),
    lastProbeAt: lastProbeAt === null ? null : new Date(lastProbeAt),
    probeAttempts,
  });
}

describe("selectProbeCandidates", () => {
  let db: AnyDb;
  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
  });

  it("returns empty Set when no state rows exist", async () => {
    const set = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 60_000,
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
    });
    expect(set.size).toBe(0);
  });

  it("returns issues with null last_probe_at (never probed)", async () => {
    await seedFailedRuns(db, "BEC-1", 3, 1_999_000_000_000);
    await seedState(db, "BEC-1", null);
    const set = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 60_000,
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
    });
    expect([...set]).toEqual(["BEC-1"]);
  });

  it("respects cooldown — recently-probed issues are skipped", async () => {
    await seedFailedRuns(db, "BEC-1", 3, 1_999_000_000_000);
    await seedState(db, "BEC-1", 1_999_999_900_000); // 100s ago
    const set = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 200_000, // 200s cooldown — not yet elapsed
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
    });
    expect(set.size).toBe(0);
  });

  it("returns at most `cap` candidates, oldest last_probe_at first", async () => {
    await seedFailedRuns(db, "BEC-1", 3, 1_999_000_000_000);
    await seedFailedRuns(db, "BEC-2", 3, 1_999_000_000_000);
    await seedFailedRuns(db, "BEC-3", 3, 1_999_000_000_000);
    await seedState(db, "BEC-1", 1_999_000_000_000); // oldest
    await seedState(db, "BEC-2", 1_999_500_000_000);
    await seedState(db, "BEC-3", 1_999_800_000_000); // newest
    const set = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 60_000,
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
    });
    expect([...set].sort()).toEqual(["BEC-1", "BEC-2"]);
  });

  it("skips issues whose failure count has dropped below the threshold", async () => {
    // Issue has a state row but its most recent run completed → count is 0
    await seedFailedRuns(db, "BEC-1", 2, 1_999_000_000_000);
    await db.insert(pipelineRuns).values({
      id: "BEC-1-recovered",
      issueId: "BEC-1",
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "completed",
      startedAt: new Date(1_999_999_999_999),
    });
    await seedState(db, "BEC-1", null);
    const set = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 60_000,
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
    });
    expect(set.size).toBe(0);
  });

  it("updates last_probe_at and probe_attempts for returned issues", async () => {
    await seedFailedRuns(db, "BEC-1", 3, 1_999_000_000_000);
    await seedState(db, "BEC-1", null, 0);
    await selectProbeCandidates(db, {
      cap: 1,
      cooldownMs: 60_000,
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
    });
    const row = (await db.select().from(circuitBreakerState))[0] as any;
    expect(row.probeAttempts).toBe(1);
    expect(new Date(row.lastProbeAt).getTime()).toBe(2_000_000_000_000);
  });

  it("returns empty Set when config.disabled is true (escape hatch)", async () => {
    await seedFailedRuns(db, "BEC-1", 3, 1_999_000_000_000);
    await seedState(db, "BEC-1", null);
    const set = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 60_000,
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
      disabled: true,
    });
    expect(set.size).toBe(0);
  });
});

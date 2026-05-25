import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../db/client.js";
import { pipelineRuns, stageRuns, costRollupsDaily } from "../db/schema.js";
import { recomputeCostRollups, backfillCostRollups } from "../cost/rollup.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

const config = {
  costs: {
    modelPricing: {
      "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
    },
    hourlyEngRate: 50,
    timeSavedPerPrDefault: 4,
  },
  pipelineConfigs: {
    "quick-fix": { profile: { model: "claude-sonnet-4-6" } } as any,
  },
} as any;

function daysAgoNoon(n: number): Date {
  const now = new Date();
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - n, 12, 0, 0,
  ));
}

async function seedRunOnDay(db: any, id: string, completedAt: Date) {
  const startedAt = new Date(completedAt.getTime() - 60_000);
  await db.insert(pipelineRuns).values({
    id,
    issueId: `ISSUE-${id}`,
    issueTitle: "test",
    pipelineKey: "quick-fix",
    repoUrl: "https://github.com/acme/api",
    status: "completed",
    runType: "standard",
    startedAt,
    completedAt,
    linearTeamId: "T1",
  });
  await db.insert(stageRuns).values({
    id: `s-${id}`,
    pipelineRunId: id,
    stage: "implement",
    status: "completed",
    startedAt,
    completedAt,
    inputTokens: 100_000,
    outputTokens: 50_000,
  });
}

describe("backfillCostRollups", () => {
  let db: any;

  beforeEach(async () => {
    await installTestProLicense("enterprise");
    db = await createDb({ connectionString: ":memory:" });
  });

  afterEach(async () => {
    await restoreLicense();
  });

  it("backfills N days of history regardless of the MAX_BACKFILL_DAYS cap", async () => {
    // Seed runs on day-45, day-35, and yesterday
    await seedRunOnDay(db, "r-45", daysAgoNoon(45));
    await seedRunOnDay(db, "r-35", daysAgoNoon(35));
    await seedRunOnDay(db, "r-1", daysAgoNoon(1));

    const result = await backfillCostRollups(db, config, 60);

    expect(result.daysProcessed).toBe(60);
    // At minimum the 3 seeded days should have been rolled up
    expect(result.rowsWritten).toBeGreaterThanOrEqual(3);

    const rollups = await db.select().from(costRollupsDaily);
    expect(rollups.length).toBeGreaterThanOrEqual(3);
  });

  it("throws on non-positive days argument", async () => {
    await expect(backfillCostRollups(db, config, 0)).rejects.toThrow("positive integer");
    await expect(backfillCostRollups(db, config, -5)).rejects.toThrow("positive integer");
  });

  it("is idempotent — re-running produces the same rollup rows", async () => {
    await seedRunOnDay(db, "r-1", daysAgoNoon(1));
    await backfillCostRollups(db, config, 3);
    const afterFirst = await db.select().from(costRollupsDaily);
    await backfillCostRollups(db, config, 3);
    const afterSecond = await db.select().from(costRollupsDaily);
    expect(afterSecond.length).toBe(afterFirst.length);
  });
});

describe("recomputeCostRollups env var override", () => {
  let db: any;
  const originalEnv = process.env.COST_ROLLUP_MAX_BACKFILL_DAYS;

  beforeEach(async () => {
    await installTestProLicense("enterprise");
    db = await createDb({ connectionString: ":memory:" });
  });

  afterEach(async () => {
    await restoreLicense();
    if (originalEnv === undefined) {
      delete process.env.COST_ROLLUP_MAX_BACKFILL_DAYS;
    } else {
      process.env.COST_ROLLUP_MAX_BACKFILL_DAYS = originalEnv;
    }
  });

  it("respects COST_ROLLUP_MAX_BACKFILL_DAYS to backfill beyond the 30-day default", async () => {
    // Seed a run 45 days ago — outside the default 30-day cap
    await seedRunOnDay(db, "r-45", daysAgoNoon(45));

    // Without override: 30-day cap means day-45 won't be included
    const withoutOverride = await recomputeCostRollups(db, config);
    const rollupsWithout = await db.select().from(costRollupsDaily);

    // With override to 60 days: day-45 should be picked up
    // Clear existing rollups first to simulate a fresh-table scenario
    await db.delete(costRollupsDaily);
    process.env.COST_ROLLUP_MAX_BACKFILL_DAYS = "60";
    await recomputeCostRollups(db, config);
    const rollupsWithOverride = await db.select().from(costRollupsDaily);

    // The 60-day window includes day-45; the 30-day window does not
    const withOverrideHasOldRun = rollupsWithOverride.some((r: any) => r.runs > 0);
    expect(withOverrideHasOldRun).toBe(true);
    // The extended window should cover more days than the default
    expect(rollupsWithOverride.length).toBeGreaterThanOrEqual(rollupsWithout.length);
  });

  it("falls back to 30-day default when COST_ROLLUP_MAX_BACKFILL_DAYS is invalid", async () => {
    process.env.COST_ROLLUP_MAX_BACKFILL_DAYS = "not-a-number";
    // Should not throw — falls back to default
    const result = await recomputeCostRollups(db, config);
    expect(result).toBeDefined();
  });
});

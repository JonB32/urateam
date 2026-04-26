import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../../db/client.js";
import { pipelineRuns, stageRuns, costRollupsDaily } from "../../db/schema.js";
import { recomputeCostRollups } from "../../cost/rollup.js";
import { installTestProLicense, restoreLicense } from "../helpers/license.js";

// recomputeCostRollups short-circuits without an enterprise license
// (defensive gate). All tests assume the gate has passed.
beforeEach(async () => {
  await installTestProLicense("enterprise");
});
afterEach(async () => {
  await restoreLicense();
});

let db: any;

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

async function seedCompletedRun(id: string, completedAt: Date) {
  await db.insert(pipelineRuns).values({
    id,
    issueId: `BEC-${id}`,
    issueTitle: "t",
    pipelineKey: "quick-fix",
    repoUrl: "https://github.com/acme/api",
    status: "completed",
    startedAt: new Date(completedAt.getTime() - 60000),
    completedAt,
    linearTeamId: "T1",
  });
  await db.insert(stageRuns).values({
    id: `s_${id}`,
    pipelineRunId: id,
    stage: "implement",
    status: "completed",
    startedAt: new Date(completedAt.getTime() - 60000),
    completedAt,
    inputTokens: 100_000,
    outputTokens: 50_000,
  });
}

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
});

describe("recomputeCostRollups", () => {
  it("writes one row per (date, pipeline, team, repo) for yesterday", async () => {
    const yesterday = new Date(Date.now() - 86400_000);
    await seedCompletedRun("r1", yesterday);
    await seedCompletedRun("r2", yesterday);
    const result = await recomputeCostRollups(db, config);
    expect(result.rowsWritten).toBeGreaterThan(0);
    const rows = await db.select().from(costRollupsDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0].runs).toBe(2);
    expect(rows[0].prsMerged).toBe(2);
    expect(rows[0].inputTokens).toBe(200_000);
    expect(rows[0].outputTokens).toBe(100_000);
    // sonnet: 0.2M × $3 + 0.1M × $15 = $0.60 + $1.50 = $2.10
    expect(rows[0].dollars).toBeCloseTo(2.10, 2);
    expect(rows[0].timeSavedHours).toBe(8);
  });

  it("is idempotent — re-running on the same day doesn't double-count", async () => {
    const yesterday = new Date(Date.now() - 86400_000);
    await seedCompletedRun("r1", yesterday);
    await recomputeCostRollups(db, config);
    await recomputeCostRollups(db, config);
    const rows = await db.select().from(costRollupsDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0].runs).toBe(1);
  });

  it("dedupes rollup rows when linearTeamId is null (empty-string sentinel)", async () => {
    const yesterday = new Date(Date.now() - 86400_000);
    // Seed two completed runs with no team assigned, same pipeline + repo.
    await db.insert(pipelineRuns).values({
      id: "u1",
      issueId: "BEC-u1",
      issueTitle: "t",
      pipelineKey: "quick-fix",
      repoUrl: "https://github.com/acme/api",
      status: "completed",
      startedAt: new Date(yesterday.getTime() - 60000),
      completedAt: yesterday,
      linearTeamId: null,
    });
    await db.insert(stageRuns).values({
      id: "s_u1",
      pipelineRunId: "u1",
      stage: "implement",
      status: "completed",
      startedAt: new Date(yesterday.getTime() - 60000),
      completedAt: yesterday,
      inputTokens: 100_000,
      outputTokens: 50_000,
    });
    await db.insert(pipelineRuns).values({
      id: "u2",
      issueId: "BEC-u2",
      issueTitle: "t",
      pipelineKey: "quick-fix",
      repoUrl: "https://github.com/acme/api",
      status: "completed",
      startedAt: new Date(yesterday.getTime() - 60000),
      completedAt: yesterday,
      linearTeamId: null,
    });
    await db.insert(stageRuns).values({
      id: "s_u2",
      pipelineRunId: "u2",
      stage: "implement",
      status: "completed",
      startedAt: new Date(yesterday.getTime() - 60000),
      completedAt: yesterday,
      inputTokens: 100_000,
      outputTokens: 50_000,
    });

    // Running twice must not produce duplicate rows for the unassigned bucket.
    await recomputeCostRollups(db, config);
    await recomputeCostRollups(db, config);
    const rows = await db.select().from(costRollupsDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0].linearTeamId).toBe("");
    expect(rows[0].runs).toBe(2);
  });

  it("backfills up to 30 days on first run when rollup table is empty", async () => {
    // Seed runs on 3 different past days: 5, 10, and 20 days ago.
    const days = [5, 10, 20];
    for (const d of days) {
      // Place completedAt at noon UTC on that day to ensure it falls in the day boundary.
      const t = new Date(Date.now() - d * 86400_000);
      t.setUTCHours(12, 0, 0, 0);
      await seedCompletedRun(`r_back_${d}`, t);
    }

    const result = await recomputeCostRollups(db, config);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const rows = await db.select().from(costRollupsDaily);
    // There should be a rollup row for each of the 3 seeded days.
    const dates = rows.map((r: any) => r.date);
    for (const d of days) {
      const t = new Date(Date.now() - d * 86400_000);
      const expected = t.toISOString().slice(0, 10);
      expect(dates).toContain(expected);
    }
  });

  it("backfills only missing days when rollup table has some entries", async () => {
    const now = new Date();
    // Pre-seed a rollup row for 3 days ago (the "already rolled" base).
    const day3 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3));
    const day3Str = day3.toISOString().slice(0, 10);

    await db.insert(costRollupsDaily).values({
      id: "cr_pre",
      date: day3Str,
      pipelineKey: "quick-fix",
      linearTeamId: "T1",
      repoUrl: "https://github.com/acme/api",
      runs: 99, // sentinel value — this row pre-exists from a prior run
      prsMerged: 99,
      inputTokens: 0, outputTokens: 0, dollars: 0, timeSavedHours: 0,
      computedAt: new Date(),
    });

    // Seed actual pipeline runs for the 2 missing days (2 days ago and yesterday).
    const day2 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2, 12));
    const day1 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 12));
    await seedCompletedRun("r_n2", day2);
    await seedCompletedRun("r_n1", day1);

    await recomputeCostRollups(db, config);

    const rows = await db.select().from(costRollupsDaily);
    const dates = rows.map((r: any) => r.date);

    const day2Str = day2.toISOString().slice(0, 10);
    const day1Str = day1.toISOString().slice(0, 10);

    // Rows for the two new days should have been backfilled.
    expect(dates).toContain(day2Str);
    expect(dates).toContain(day1Str);

    // The pre-seeded day3 row should still exist (untouched, since latest+1 = day2).
    expect(dates).toContain(day3Str);
    const day3Row = rows.find((r: any) => r.date === day3Str);
    expect(day3Row?.runs).toBe(99); // sentinel value preserved — not re-rolled
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../../db/client.js";
import { pipelineRuns, stageRuns, costRollupsDaily } from "../../db/schema.js";
import { recomputeCostRollups, readRollupWindow } from "../../cost/rollup.js";

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

  it("readRollupWindow returns rows inside the window", async () => {
    const yesterday = new Date(Date.now() - 86400_000);
    await seedCompletedRun("r1", yesterday);
    await recomputeCostRollups(db, config);
    const from = new Date(Date.now() - 7 * 86400_000);
    const to = new Date();
    const rows = await readRollupWindow(db, from, to);
    expect(rows.length).toBeGreaterThan(0);
  });
});

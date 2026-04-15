import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../db/client.js";
import { aggregateAll } from "../cost/aggregate.js";
import { recomputeCostRollups } from "../cost/rollup.js";
import { pipelineRuns, stageRuns, costRollupsDaily } from "../db/schema.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

function yesterdayNoonUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 12, 0, 0,
  ));
}

describe("cost e2e", () => {
  beforeEach(async () => {
    await installTestProLicense("enterprise");
  });

  afterEach(async () => {
    await restoreLicense();
  });

  it("aggregate matches expected totals and rollup matches live aggregation", async () => {
    const db = await createDb({ connectionString: ":memory:" }) as any;

    const config = {
      costs: {
        modelPricing: {
          "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
        },
        hourlyEngRate: 50,
        timeSavedPerPrDefault: 4,
      },
      pipelineConfigs: {
        "auto-implement": { timeSavedPerPr: 6, profile: { model: "claude-sonnet-4-6" } },
        "quick-fix":      { profile: { model: "claude-sonnet-4-6" } },
        "bug":            { profile: { model: "claude-sonnet-4-6" } },
      },
    } as any;

    // Seed at yesterday-noon UTC so the completed runs land squarely inside
    // both the aggregate window (from=2 days ago, to=now) and the rollup's
    // yesterday-UTC day boundary, regardless of what time the test runs.
    const completedAt = yesterdayNoonUtc();
    const startedAt = new Date(completedAt.getTime() - 60_000);

    for (let i = 0; i < 20; i++) {
      const pipelineKey = ["auto-implement", "quick-fix", "bug"][i % 3];
      await db.insert(pipelineRuns).values({
        id: `r${i}`,
        issueId: `BEC-${i}`,
        issueTitle: "t",
        pipelineKey,
        repoUrl: i % 2 === 0 ? "https://github.com/acme/api" : "https://github.com/acme/web",
        status: "completed",
        startedAt,
        completedAt,
        linearTeamId: i % 2 === 0 ? "T1" : "T2",
      });
      await db.insert(stageRuns).values({
        id: `s${i}`,
        pipelineRunId: `r${i}`,
        stage: "implement",
        status: "completed",
        startedAt,
        completedAt,
        inputTokens: 100_000,
        outputTokens: 50_000,
      });
    }

    const live = await aggregateAll(db, {
      from: new Date(completedAt.getTime() - 86400_000),
      to: new Date(),
    }, config);

    expect(live.summary.runs).toBe(20);
    expect(live.summary.prsMerged).toBe(20);
    expect(live.byTeam).toHaveLength(2);
    expect(live.byRepo).toHaveLength(2);
    expect(live.byPipeline).toHaveLength(3);

    // Rollup should produce the same dollar total across all rows
    await recomputeCostRollups(db, config);
    const rollups = await db.select().from(costRollupsDaily);
    expect(rollups.length).toBeGreaterThan(0);
    const rollupTotal = rollups.reduce((acc: number, r: any) => acc + r.dollars, 0);
    expect(rollupTotal).toBeCloseTo(live.summary.dollars, 2);
  });
});

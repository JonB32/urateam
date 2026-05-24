import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../db/client.js";
import { pipelineRuns, stageRuns } from "../db/schema.js";
import { computeRunCost } from "../cost/per-run.js";
import { aggregateHybrid } from "../cost/aggregate.js";
import { recomputeCostRollups } from "../cost/rollup.js";
import { streamCostCsv } from "../cost/csv.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

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

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
});

afterEach(async () => {
  await restoreLicense();
});

async function seedOneRun(): Promise<string> {
  const runId = "pr_test";
  const completedAt = new Date();
  await db.insert(pipelineRuns).values({
    id: runId,
    issueId: "ISSUE-1",
    issueTitle: "test",
    pipelineKey: "quick-fix",
    repoUrl: "https://example.com/repo",
    status: "completed",
    runType: "standard",
    startedAt: new Date(completedAt.getTime() - 60_000),
    completedAt,
    linearTeamId: null,
  } as any);
  await db.insert(stageRuns).values({
    id: "sr_test",
    pipelineRunId: runId,
    stage: "implement",
    status: "completed",
    startedAt: new Date(completedAt.getTime() - 60_000),
    completedAt,
    inputTokens: 1000,
    outputTokens: 500,
  } as any);
  return runId;
}

async function collect(iter: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of iter) out += chunk;
  return out;
}

describe("cost-roi defensive license gate", () => {
  describe("OSS mode (no license)", () => {
    it("computeRunCost returns zero", () => {
      const cost = computeRunCost(
        { pipelineKey: "quick-fix", status: "completed", runType: null },
        [{ stage: "implement", inputTokens: 1000, outputTokens: 500 }],
        config,
      );
      expect(cost).toEqual({ inputTokens: 0, outputTokens: 0, dollars: 0, timeSavedHours: 0 });
    });

    it("aggregateHybrid returns empty result (exercises aggregateAll internally)", async () => {
      await seedOneRun();
      const filters = { from: new Date("2026-01-01"), to: new Date("2027-01-01") };
      const result = await aggregateHybrid(db, filters, config);
      expect(result.summary.runs).toBe(0);
      expect(result.summary.dollars).toBe(0);
      expect(result.byTeam).toEqual([]);
      expect(result.byRepo).toEqual([]);
      expect(result.byPipeline).toEqual([]);
      expect(result.byDay).toEqual([]);
    });

    it("aggregateHybrid returns empty result", async () => {
      await seedOneRun();
      const filters = { from: new Date("2026-01-01"), to: new Date("2027-01-01") };
      const result = await aggregateHybrid(db, filters, config);
      expect(result.summary.runs).toBe(0);
      expect(result.byTeam).toEqual([]);
    });

    it("recomputeCostRollups returns rowsWritten=0 without writing", async () => {
      await seedOneRun();
      const result = await recomputeCostRollups(db, config);
      expect(result).toEqual({ rowsWritten: 0 });
    });

    it("streamCostCsv yields nothing (empty stream)", async () => {
      await seedOneRun();
      const filters = { from: new Date("2026-01-01"), to: new Date("2027-01-01") };
      const out = await collect(streamCostCsv(db, filters, config));
      expect(out).toBe("");
    });
  });

  describe("pro tier (cost-roi is enterprise-only)", () => {
    beforeEach(async () => {
      await installTestProLicense("pro");
    });

    it("computeRunCost still returns zero", () => {
      const cost = computeRunCost(
        { pipelineKey: "quick-fix", status: "completed", runType: null },
        [{ stage: "implement", inputTokens: 1000, outputTokens: 500 }],
        config,
      );
      expect(cost.dollars).toBe(0);
    });

    it("aggregateHybrid still returns empty (exercises aggregateAll internally)", async () => {
      await seedOneRun();
      const filters = { from: new Date("2026-01-01"), to: new Date("2027-01-01") };
      const result = await aggregateHybrid(db, filters, config);
      expect(result.summary.runs).toBe(0);
    });
  });

  describe("enterprise tier (sanity — gate falls through)", () => {
    beforeEach(async () => {
      await installTestProLicense("enterprise");
    });

    it("computeRunCost returns non-zero dollars for non-trivial input", () => {
      const cost = computeRunCost(
        { pipelineKey: "quick-fix", status: "completed", runType: null },
        [{ stage: "implement", inputTokens: 1_000_000, outputTokens: 1_000_000 }],
        config,
      );
      expect(cost.dollars).toBeGreaterThan(0);
      expect(cost.timeSavedHours).toBeGreaterThan(0);
    });
  });
});

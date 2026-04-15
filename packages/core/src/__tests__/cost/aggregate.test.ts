import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../../db/client.js";
import { pipelineRuns, stageRuns } from "../../db/schema.js";
import { aggregateAll } from "../../cost/aggregate.js";

let db: any;

const config = {
  costs: {
    modelPricing: {
      "claude-opus-4-6":   { inputPerMillion: 15, outputPerMillion: 75 },
      "claude-sonnet-4-6": { inputPerMillion:  3, outputPerMillion: 15 },
    },
    hourlyEngRate: 50,
    timeSavedPerPrDefault: 4,
  },
  pipelineConfigs: {
    "auto-implement": {
      stageModels: { implement: "claude-opus-4-6" },
      profile: { model: "claude-sonnet-4-6" },
      timeSavedPerPr: 6,
    } as any,
    "quick-fix": {
      profile: { model: "claude-sonnet-4-6" },
    } as any,
  },
} as any;

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
});

async function seedRun(id: string, opts: {
  pipelineKey: string; teamId?: string; repoUrl: string;
  status?: string; implementInputTokens?: number; implementOutputTokens?: number;
  completedAt: Date;
}) {
  await db.insert(pipelineRuns).values({
    id, issueId: `BEC-${id}`, issueTitle: "t",
    pipelineKey: opts.pipelineKey,
    repoUrl: opts.repoUrl,
    status: opts.status ?? "completed",
    startedAt: new Date(opts.completedAt.getTime() - 60000),
    completedAt: opts.completedAt,
    linearTeamId: opts.teamId,
  });
  if (opts.implementInputTokens || opts.implementOutputTokens) {
    await db.insert(stageRuns).values({
      id: `s_${id}_imp`, pipelineRunId: id, stage: "implement",
      status: "completed",
      startedAt: new Date(opts.completedAt.getTime() - 60000),
      completedAt: opts.completedAt,
      inputTokens: opts.implementInputTokens ?? 0,
      outputTokens: opts.implementOutputTokens ?? 0,
    });
  }
}

describe("aggregateAll", () => {
  it("returns zero totals for an empty db", async () => {
    const r = await aggregateAll(db, { from: new Date("2026-01-01"), to: new Date("2026-12-31") }, config);
    expect(r.summary.runs).toBe(0);
    expect(r.summary.dollars).toBe(0);
    expect(r.summary.timeSavedHours).toBe(0);
    expect(r.byTeam).toEqual([]);
    expect(r.byRepo).toEqual([]);
    expect(r.byPipeline).toEqual([]);
  });

  it("aggregates across pipelines with correct dollar math", async () => {
    await seedRun("1", {
      pipelineKey: "auto-implement", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 1_000_000, implementOutputTokens: 500_000,
      completedAt: new Date("2026-04-01T10:00:00Z"),
    });
    await seedRun("2", {
      pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-04-02T10:00:00Z"),
    });

    const r = await aggregateAll(db, {
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date("2026-04-30T23:59:59Z"),
    }, config);

    // run 1 (opus implement): 1M × $15 + 0.5M × $75 = $52.50
    // run 2 (sonnet implement): 0.1M × $3 + 0.05M × $15 = $1.05
    expect(r.summary.runs).toBe(2);
    expect(r.summary.prsMerged).toBe(2);
    expect(r.summary.dollars).toBeCloseTo(53.55, 2);
    // time saved: run 1 (auto-implement override = 6h) + run 2 (quick-fix default = 4h) = 10h
    expect(r.summary.timeSavedHours).toBe(10);

    // byTeam: one row (T1) with summed totals
    expect(r.byTeam).toHaveLength(1);
    expect(r.byTeam[0].key).toBe("team:T1");
    expect(r.byTeam[0].dollars).toBeCloseTo(53.55, 2);

    // byPipeline: two rows (auto-implement, quick-fix)
    expect(r.byPipeline).toHaveLength(2);
    const auto = r.byPipeline.find((b: any) => b.key === "pipeline:auto-implement")!;
    expect(auto.dollars).toBeCloseTo(52.50, 2);
    expect(auto.timeSavedHours).toBe(6);

    // ROI = (timeSavedHours × hourlyEngRate) / dollars = (10 × 50) / 53.55 ≈ 9.34
    expect(r.summary.roiMultiplier).toBeCloseTo(500 / 53.55, 2);
  });

  it("excludes runs outside the window", async () => {
    await seedRun("1", {
      pipelineKey: "quick-fix",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-01-01T10:00:00Z"),
    });
    const r = await aggregateAll(db, {
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date("2026-04-30T23:59:59Z"),
    }, config);
    expect(r.summary.runs).toBe(0);
  });

  it("counts failed runs in cost but not in prsMerged / timeSaved", async () => {
    await seedRun("1", {
      pipelineKey: "quick-fix", status: "failed",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-04-01T10:00:00Z"),
    });
    const r = await aggregateAll(db, {
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date("2026-04-30T23:59:59Z"),
    }, config);
    expect(r.summary.runs).toBe(1);
    expect(r.summary.prsMerged).toBe(0);
    expect(r.summary.timeSavedHours).toBe(0);
    expect(r.summary.dollars).toBeCloseTo(1.05, 2);
  });
});

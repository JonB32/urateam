import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../../db/client.js";
import { pipelineRuns, stageRuns } from "../../db/schema.js";
import { randomUUID } from "node:crypto";
import { aggregateAll, aggregateHybrid, normalizeTeamId, snapToUtcDayStart } from "../../cost/aggregate.js";
import { costRollupsDaily } from "../../db/schema.js";

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
  status?: string; runType?: string;
  implementInputTokens?: number; implementOutputTokens?: number;
  completedAt: Date;
}) {
  await db.insert(pipelineRuns).values({
    id, issueId: `BEC-${id}`, issueTitle: "t",
    pipelineKey: opts.pipelineKey,
    repoUrl: opts.repoUrl,
    status: opts.status ?? "completed",
    runType: opts.runType ?? "standard",
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
      // half-open upper bound: to is strictly after all seeded runs
      to: new Date("2026-05-01T00:00:00Z"),
    }, config);
    expect(r.summary.runs).toBe(0);
  });

  it("truncates to maxRuns most recent and flags summary.truncated", async () => {
    // Seed 15 runs spread across April 2026.
    for (let i = 0; i < 15; i++) {
      await seedRun(String(i), {
        pipelineKey: "quick-fix",
        repoUrl: "https://github.com/acme/api",
        implementInputTokens: 100_000,
        implementOutputTokens: 50_000,
        completedAt: new Date(`2026-04-${String(i + 1).padStart(2, "0")}T10:00:00Z`),
      });
    }
    const r = await aggregateAll(
      db,
      {
        from: new Date("2026-04-01T00:00:00Z"),
        to: new Date("2026-04-30T23:59:59Z"),
      },
      config,
      { maxRuns: 5 },
    );
    expect(r.summary.truncated).toBe(true);
    expect(r.summary.runs).toBe(5);
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
      to: new Date("2026-05-01T00:00:00Z"),
    }, config);
    expect(r.summary.runs).toBe(1);
    expect(r.summary.prsMerged).toBe(0);
    expect(r.summary.timeSavedHours).toBe(0);
    expect(r.summary.dollars).toBeCloseTo(1.05, 2);
  });

  it("excludes review-feedback runs from prsMerged and timeSavedHours", async () => {
    // Standard completed run
    await seedRun("1", {
      pipelineKey: "quick-fix", runType: "standard",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-04-01T10:00:00Z"),
    });
    // Review-feedback completed run (tokens cost money but not a new PR)
    await seedRun("2", {
      pipelineKey: "quick-fix", runType: "review-feedback",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 50_000, implementOutputTokens: 20_000,
      completedAt: new Date("2026-04-01T11:00:00Z"),
    });

    const r = await aggregateAll(db, {
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date("2026-05-01T00:00:00Z"),
    }, config);

    // Only the standard run counts as a merged PR
    expect(r.summary.runs).toBe(2);
    expect(r.summary.prsMerged).toBe(1);
    // Only the standard run contributes time saved (4h default for quick-fix)
    expect(r.summary.timeSavedHours).toBe(4);
    // Both runs contribute to token cost: run1 = $1.05, run2 = 0.05M×$3 + 0.02M×$15 = $0.15+$0.30 = $0.45
    expect(r.summary.dollars).toBeCloseTo(1.50, 2);
  });

  it("populates byDay with one entry per UTC completion date", async () => {
    await seedRun("1", {
      pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-04-01T10:00:00Z"),
    });
    await seedRun("2", {
      pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-04-01T14:00:00Z"), // same UTC day as run 1
    });
    await seedRun("3", {
      pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-04-03T10:00:00Z"),
    });
    const r = await aggregateAll(db, {
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date("2026-04-30T23:59:59Z"),
    }, config);
    // Two distinct UTC dates; sorted ascending
    expect(r.byDay.map((d) => d.date)).toEqual(["2026-04-01", "2026-04-03"]);
    expect(r.byDay[0].runs).toBe(2);
    expect(r.byDay[1].runs).toBe(1);
  });

  it("normalizeTeamId collapses null, undefined, and empty string to the same bucket", () => {
    expect(normalizeTeamId(null)).toEqual({ key: "team:unassigned", label: "(unassigned)" });
    expect(normalizeTeamId(undefined)).toEqual({ key: "team:unassigned", label: "(unassigned)" });
    expect(normalizeTeamId("")).toEqual({ key: "team:unassigned", label: "(unassigned)" });
    expect(normalizeTeamId("T1")).toEqual({ key: "team:T1", label: "T1" });
  });
});

async function seedRollup(opts: {
  date: string; pipelineKey: string; teamId: string; repoUrl: string;
  runs: number; prsMerged: number; inputTokens: number; outputTokens: number;
  dollars: number; timeSavedHours: number;
}) {
  await db.insert(costRollupsDaily).values({
    id: `cr_${randomUUID()}`,
    date: opts.date,
    pipelineKey: opts.pipelineKey,
    linearTeamId: opts.teamId,
    repoUrl: opts.repoUrl,
    runs: opts.runs,
    prsMerged: opts.prsMerged,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    dollars: opts.dollars,
    timeSavedHours: opts.timeSavedHours,
    computedAt: new Date(),
  });
}

describe("snapToUtcDayStart", () => {
  it("snaps mid-day UTC to start-of-day UTC", () => {
    const d = new Date("2026-04-15T14:30:45.123Z");
    expect(snapToUtcDayStart(d).toISOString()).toBe("2026-04-15T00:00:00.000Z");
  });
  it("is idempotent on midnight UTC", () => {
    const d = new Date("2026-04-15T00:00:00.000Z");
    expect(snapToUtcDayStart(d).toISOString()).toBe("2026-04-15T00:00:00.000Z");
  });
});

describe("aggregateHybrid", () => {
  it("falls back to pure live when enableRollups is false", async () => {
    await seedRun("r1", {
      pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-04-10T10:00:00Z"),
    });
    // Also seed a rollup that should NOT be read because enableRollups is false.
    await seedRollup({
      date: "2026-04-10", pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      runs: 999, prsMerged: 999, inputTokens: 0, outputTokens: 0,
      dollars: 0, timeSavedHours: 0,
    });
    const r = await aggregateHybrid(
      db,
      { from: new Date("2026-04-01T00:00:00Z"), to: new Date("2026-04-30T23:59:59Z") },
      config,
      { enableRollups: false, now: new Date("2026-04-15T12:00:00Z") },
    );
    // Should see only the live run, not the poisoned rollup row
    expect(r.summary.runs).toBe(1);
  });

  it("uses rollups for historical days + live for today", async () => {
    // Historical rollup: 2 runs, 2 PRs, $10, 8h
    await seedRollup({
      date: "2026-04-14", pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      runs: 2, prsMerged: 2, inputTokens: 200_000, outputTokens: 100_000,
      dollars: 10, timeSavedHours: 8,
    });
    // Today's live run: 1 run at T+10h
    await seedRun("r-today", {
      pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-04-15T10:00:00Z"),
    });
    const r = await aggregateHybrid(
      db,
      { from: new Date("2026-04-10T00:00:00Z"), to: new Date("2026-04-15T23:59:59Z") },
      config,
      { enableRollups: true, now: new Date("2026-04-15T12:00:00Z") },
    );
    // rollup contributes 2 runs; live contributes 1 run
    expect(r.summary.runs).toBe(3);
    expect(r.summary.prsMerged).toBe(3);
    // rollup dollars + live dollars (run2 = 0.1M×$3 + 0.05M×$15 = $1.05)
    expect(r.summary.dollars).toBeCloseTo(10 + 1.05, 2);
    // ROI re-computed post-merge: timeSaved = 8 (rollup) + 4 (live quick-fix default) = 12h
    // ROI = (12 × $50) / $11.05 ≈ 54.3×
    expect(r.summary.timeSavedHours).toBe(12);
    expect(r.summary.roiMultiplier).toBeCloseTo((12 * 50) / (10 + 1.05), 1);
    // Single team, single repo, single pipeline — breakdowns should have 1 row each
    expect(r.byTeam).toHaveLength(1);
    expect(r.byRepo).toHaveLength(1);
    expect(r.byPipeline).toHaveLength(1);
  });

  it("populates byDay from rollup rows + live for today", async () => {
    await seedRollup({
      date: "2026-04-13", pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      runs: 2, prsMerged: 2, inputTokens: 0, outputTokens: 0,
      dollars: 5, timeSavedHours: 4,
    });
    await seedRollup({
      date: "2026-04-14", pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      runs: 3, prsMerged: 3, inputTokens: 0, outputTokens: 0,
      dollars: 10, timeSavedHours: 6,
    });
    await seedRun("r-today", {
      pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-04-15T10:00:00Z"),
    });
    const r = await aggregateHybrid(
      db,
      { from: new Date("2026-04-13T00:00:00Z"), to: new Date("2026-04-15T23:59:59Z") },
      config,
      { enableRollups: true, now: new Date("2026-04-15T12:00:00Z") },
    );
    expect(r.byDay).toHaveLength(3);
    expect(r.byDay.map((d) => d.date)).toEqual(["2026-04-13", "2026-04-14", "2026-04-15"]);
    expect(r.byDay[0].dollars).toBeCloseTo(5, 2);
    expect(r.byDay[1].dollars).toBeCloseTo(10, 2);
    // today's live cost = 0.1M × $3 + 0.05M × $15 = $1.05
    expect(r.byDay[2].dollars).toBeCloseTo(1.05, 2);
  });

  it("uses rollups only when window ends before today's UTC midnight", async () => {
    await seedRollup({
      date: "2026-04-13", pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      runs: 5, prsMerged: 5, inputTokens: 0, outputTokens: 0,
      dollars: 20, timeSavedHours: 20,
    });
    // Also a live run from today that should NOT be included (window ends before today)
    await seedRun("r-today", {
      pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-04-15T10:00:00Z"),
    });
    const r = await aggregateHybrid(
      db,
      // Window: 2026-04-13 00:00Z to 2026-04-14 00:00Z — entirely historical
      { from: new Date("2026-04-13T00:00:00Z"), to: new Date("2026-04-14T00:00:00Z") },
      config,
      { enableRollups: true, now: new Date("2026-04-15T12:00:00Z") },
    );
    expect(r.summary.runs).toBe(5);
    expect(r.summary.dollars).toBeCloseTo(20, 2);
  });

  it("routes to live-only when window is entirely today", async () => {
    await seedRun("r-today", {
      pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-04-15T10:00:00Z"),
    });
    // Stale rollup for yesterday — should NOT be read when window is today-only.
    await seedRollup({
      date: "2026-04-14", pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      runs: 999, prsMerged: 999, inputTokens: 0, outputTokens: 0,
      dollars: 0, timeSavedHours: 0,
    });
    const r = await aggregateHybrid(
      db,
      { from: new Date("2026-04-15T00:00:00Z"), to: new Date("2026-04-15T23:59:59Z") },
      config,
      { enableRollups: true, now: new Date("2026-04-15T12:00:00Z") },
    );
    expect(r.summary.runs).toBe(1);
  });
});

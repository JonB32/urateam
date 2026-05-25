import { randomUUID } from "node:crypto";
import { and, gte, lt, inArray, max } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { pipelineRuns, stageRuns, costRollupsDaily, reviewModelRuns } from "../db/schema.js";
import { computeRunCost } from "./per-run.js";
import { createLogger } from "../logger.js";
import { isFeatureLicensed } from "../license.js";

const log = createLogger({ component: "cost.rollup" });

const MAX_BACKFILL_DAYS = 30;

/** Read `COST_ROLLUP_MAX_BACKFILL_DAYS` from env. Returns the module default when unset or invalid. */
function resolveMaxBackfillDays(): number {
  const raw = process.env.COST_ROLLUP_MAX_BACKFILL_DAYS;
  if (!raw) return MAX_BACKFILL_DAYS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    log.warn({ raw }, "COST_ROLLUP_MAX_BACKFILL_DAYS is not a positive integer — using default");
    return MAX_BACKFILL_DAYS;
  }
  return n;
}

interface CostConfig {
  costs?: {
    modelPricing?: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
    timeSavedPerPrDefault?: number;
    hourlyEngRate?: number;
  };
  pipelineConfigs?: Record<string, any>;
}

function dayBounds(dateStr: string): { start: Date; end: Date } {
  const start = new Date(dateStr + "T00:00:00.000Z");
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add `days` UTC days to a date string (YYYY-MM-DD) and return a new date string. */
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + days);
  return utcDateStr(d);
}

/** Returns yesterday's date as a YYYY-MM-DD UTC string. */
function getYesterdayUtcStr(): string {
  const now = new Date();
  return utcDateStr(new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1,
  )));
}

/** Build an inclusive date range [firstDate, endDate] as YYYY-MM-DD strings. */
function generateDateRange(firstDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let d = firstDate;
  while (d <= endDate) {
    dates.push(d);
    d = addDays(d, 1);
  }
  return dates;
}

/**
 * Roll up cost data for a single UTC day into cost_rollups_daily.
 * Idempotent — uses onConflictDoUpdate.
 */
async function rollOneDay(
  db: AnyDb,
  dateStr: string,
  config: CostConfig,
): Promise<number> {
  const { start, end } = dayBounds(dateStr);

  const runs = await db.select().from(pipelineRuns).where(
    and(
      gte(pipelineRuns.completedAt, start),
      lt(pipelineRuns.completedAt, end),
    ),
  );

  if (runs.length === 0) {
    log.info({ date: dateStr, rowsWritten: 0 }, "no runs to roll up");
    return 0;
  }

  const runIds = runs.map((r: any) => r.id);
  const stages = await db.select().from(stageRuns).where(
    inArray(stageRuns.pipelineRunId, runIds),
  );

  // BEC-134: fetch per-model rows and attach them to their parent stage_run.
  const stageIds = stages.map((s: any) => s.id);
  const modelRunRows = stageIds.length > 0
    ? await db.select().from(reviewModelRuns).where(
        inArray(reviewModelRuns.stageRunId, stageIds),
      )
    : [];
  const modelRunsByStage = new Map<string, any[]>();
  for (const mr of modelRunRows) {
    const arr = modelRunsByStage.get(mr.stageRunId) ?? [];
    arr.push(mr);
    modelRunsByStage.set(mr.stageRunId, arr);
  }

  const stagesByRun = new Map<string, any[]>();
  for (const s of stages) {
    const enriched = { ...s, modelRuns: modelRunsByStage.get(s.id) ?? [] };
    const arr = stagesByRun.get(s.pipelineRunId) ?? [];
    arr.push(enriched);
    stagesByRun.set(s.pipelineRunId, arr);
  }

  const buckets = new Map<string, {
    pipelineKey: string; linearTeamId: string; repoUrl: string;
    runs: number; prsMerged: number; inputTokens: number; outputTokens: number;
    dollars: number; timeSavedHours: number;
  }>();

  for (const run of runs) {
    const runStages = stagesByRun.get(run.id) ?? [];
    const cost = computeRunCost(run as any, runStages as any, config);
    // Sentinel "" (empty string) instead of NULL for linearTeamId so that
    // the composite UNIQUE (date, pipeline_key, linear_team_id, repo_url)
    // fires onConflictDoUpdate for unassigned runs. Both SQLite and Postgres
    // treat NULL ≠ NULL in composite uniques, which would otherwise cause
    // duplicate rollup rows for the "(unassigned)" bucket on every PM tick.
    const key = `${run.pipelineKey}|${run.linearTeamId ?? ""}|${run.repoUrl}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        pipelineKey: run.pipelineKey,
        linearTeamId: run.linearTeamId ?? "",
        repoUrl: run.repoUrl,
        runs: 0, prsMerged: 0,
        inputTokens: 0, outputTokens: 0,
        dollars: 0, timeSavedHours: 0,
      };
      buckets.set(key, b);
    }
    b.runs += 1;
    b.inputTokens += cost.inputTokens;
    b.outputTokens += cost.outputTokens;
    b.dollars += cost.dollars;
    b.timeSavedHours += cost.timeSavedHours;
    if (run.status === "completed" && run.runType !== "review-feedback") b.prsMerged += 1;
  }

  const now = new Date();
  await Promise.all(
    Array.from(buckets.values()).map((b) =>
      db.insert(costRollupsDaily).values({
        id: `cr_${randomUUID()}`,
        date: dateStr,
        pipelineKey: b.pipelineKey,
        linearTeamId: b.linearTeamId,
        repoUrl: b.repoUrl,
        runs: b.runs,
        prsMerged: b.prsMerged,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        dollars: b.dollars,
        timeSavedHours: b.timeSavedHours,
        computedAt: now,
      }).onConflictDoUpdate({
        target: [
          costRollupsDaily.date,
          costRollupsDaily.pipelineKey,
          costRollupsDaily.linearTeamId,
          costRollupsDaily.repoUrl,
        ],
        set: {
          runs: b.runs,
          prsMerged: b.prsMerged,
          inputTokens: b.inputTokens,
          outputTokens: b.outputTokens,
          dollars: b.dollars,
          timeSavedHours: b.timeSavedHours,
          computedAt: now,
        },
      })
    ),
  );
  const rowsWritten = buckets.size;

  log.info({ date: dateStr, rowsWritten }, "cost rollup complete");
  return rowsWritten;
}

export async function recomputeCostRollups(
  db: AnyDb,
  config: CostConfig,
): Promise<{ rowsWritten: number }> {
  if (!isFeatureLicensed("cost-roi")) {
    log.warn(
      { feature: "cost-roi" },
      "recomputeCostRollups called without an enterprise license — skipping",
    );
    return { rowsWritten: 0 };
  }
  // Rollups only cover completed UTC days.
  const yesterdayStr = getYesterdayUtcStr();
  const maxBackfillDays = resolveMaxBackfillDays();

  // Find the latest date already in the rollup table.
  const [latestRow] = await db.select({ latestDate: max(costRollupsDaily.date) }).from(costRollupsDaily);
  const latestDate: string | null = latestRow?.latestDate ?? null;

  // Determine the set of dates to roll.
  let datesToRoll: string[];

  if (latestDate === null) {
    // First run: backfill up to maxBackfillDays before yesterday, inclusive.
    const firstDate = addDays(yesterdayStr, -(maxBackfillDays - 1));
    datesToRoll = generateDateRange(firstDate, yesterdayStr);
    log.info({ firstDate, yesterdayStr, days: datesToRoll.length }, "cost rollup: first run, backfilling");
  } else if (latestDate < yesterdayStr) {
    // Some entries exist but there's a gap. Fill from latest+1 through yesterday.
    // Cap at maxBackfillDays to avoid runaway on pathological stale dates.
    const rawFirstDate = addDays(latestDate, 1);
    const cappedFirstDate = addDays(yesterdayStr, -(maxBackfillDays - 1));
    const firstDate = rawFirstDate > cappedFirstDate ? rawFirstDate : cappedFirstDate;
    datesToRoll = generateDateRange(firstDate, yesterdayStr);
    log.info({ latestDate, firstDate, yesterdayStr, days: datesToRoll.length }, "cost rollup: backfilling missing days");
  } else if (latestDate === yesterdayStr) {
    // Already up to date — re-roll yesterday for idempotency (tick runs multiple times/day).
    datesToRoll = [yesterdayStr];
  } else {
    // latestDate > yesterdayStr — shouldn't happen but be defensive.
    log.warn({ latestDate, yesterdayStr }, "cost rollup: latest date is in the future, skipping");
    return { rowsWritten: 0 };
  }

  let totalRowsWritten = 0;
  for (const dateStr of datesToRoll) {
    totalRowsWritten += await rollOneDay(db, dateStr, config);
  }

  return { rowsWritten: totalRowsWritten };
}

/**
 * Explicitly backfill `days` UTC days ending yesterday — no cap applied.
 * Intended for the `ura cost backfill --days N` CLI command.
 * Idempotent: re-rolling an existing day overwrites with current data.
 */
export async function backfillCostRollups(
  db: AnyDb,
  config: CostConfig,
  days: number,
): Promise<{ rowsWritten: number; daysProcessed: number }> {
  if (!isFeatureLicensed("cost-roi")) {
    log.warn(
      { feature: "cost-roi" },
      "backfillCostRollups called without an enterprise license — skipping",
    );
    return { rowsWritten: 0, daysProcessed: 0 };
  }
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`backfillCostRollups: days must be a positive integer, got ${days}`);
  }
  const clampedDays = Math.ceil(days);

  const yesterdayStr = getYesterdayUtcStr();
  const firstDate = addDays(yesterdayStr, -(clampedDays - 1));
  const datesToRoll = generateDateRange(firstDate, yesterdayStr);

  log.info({ firstDate, yesterdayStr, days: datesToRoll.length }, "cost rollup: explicit backfill");

  let totalRowsWritten = 0;
  for (const dateStr of datesToRoll) {
    totalRowsWritten += await rollOneDay(db, dateStr, config);
  }

  return { rowsWritten: totalRowsWritten, daysProcessed: datesToRoll.length };
}


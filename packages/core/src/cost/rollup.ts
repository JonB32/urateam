import { randomUUID } from "node:crypto";
import { and, gte, lt, lte, inArray, max } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { pipelineRuns, stageRuns, costRollupsDaily } from "../db/schema.js";
import { computeRunCost } from "./per-run.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "cost.rollup" });

const MAX_BACKFILL_DAYS = 30;

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

  const stagesByRun = new Map<string, any[]>();
  for (const s of stages) {
    const arr = stagesByRun.get(s.pipelineRunId) ?? [];
    arr.push(s);
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

  let rowsWritten = 0;
  for (const b of buckets.values()) {
    await db.insert(costRollupsDaily).values({
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
      computedAt: new Date(),
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
        computedAt: new Date(),
      },
    });
    rowsWritten += 1;
  }

  log.info({ date: dateStr, rowsWritten }, "cost rollup complete");
  return rowsWritten;
}

export async function recomputeCostRollups(
  db: AnyDb,
  config: CostConfig,
): Promise<{ rowsWritten: number }> {
  // Determine yesterday (UTC). Rollups only cover completed UTC days.
  const now = new Date();
  const yesterdayUtc = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1,
  ));
  const yesterdayStr = utcDateStr(yesterdayUtc);

  // Find the latest date already in the rollup table.
  const [latestRow] = await db.select({ latestDate: max(costRollupsDaily.date) }).from(costRollupsDaily);
  const latestDate: string | null = latestRow?.latestDate ?? null;

  // Determine the set of dates to roll.
  let datesToRoll: string[];

  if (latestDate === null) {
    // First run: backfill up to MAX_BACKFILL_DAYS before yesterday, inclusive.
    const firstDate = addDays(yesterdayStr, -(MAX_BACKFILL_DAYS - 1));
    datesToRoll = [];
    let d = firstDate;
    while (d <= yesterdayStr) {
      datesToRoll.push(d);
      d = addDays(d, 1);
    }
    log.info({ firstDate, yesterdayStr, days: datesToRoll.length }, "cost rollup: first run, backfilling");
  } else if (latestDate < yesterdayStr) {
    // Some entries exist but there's a gap. Fill from latest+1 through yesterday.
    // Cap at MAX_BACKFILL_DAYS to avoid runaway on pathological stale dates.
    const rawFirstDate = addDays(latestDate, 1);
    const cappedFirstDate = addDays(yesterdayStr, -(MAX_BACKFILL_DAYS - 1));
    const firstDate = rawFirstDate > cappedFirstDate ? rawFirstDate : cappedFirstDate;
    datesToRoll = [];
    let d = firstDate;
    while (d <= yesterdayStr) {
      datesToRoll.push(d);
      d = addDays(d, 1);
    }
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

export async function readRollupWindow(
  db: AnyDb,
  from: Date,
  to: Date,
): Promise<any[]> {
  const fromDate = utcDateStr(from);
  const toDate = utcDateStr(to);
  return await db.select().from(costRollupsDaily).where(
    and(
      gte(costRollupsDaily.date, fromDate),
      lte(costRollupsDaily.date, toDate),
    ),
  );
}

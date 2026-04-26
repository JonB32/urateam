import { and, gte, lt, inArray } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { pipelineRuns, stageRuns, costRollupsDaily } from "../db/schema.js";
import { computeRunCost } from "./per-run.js";
import { createLogger } from "../logger.js";
import { isFeatureLicensed } from "../license.js";
import type { AggregateResult, BreakdownRow, CostSummary, DailyRow } from "./types.js";

const log = createLogger({ component: "cost.aggregate" });

function emptyAggregateResult(filters: AggregateFilters): AggregateResult {
  return {
    summary: {
      window: { from: filters.from, to: filters.to },
      runs: 0, prsMerged: 0, inputTokens: 0, outputTokens: 0,
      dollars: 0, timeSavedHours: 0, roiMultiplier: 0,
    },
    byTeam: [], byRepo: [], byPipeline: [], byDay: [],
  };
}

const DEFAULT_MAX_RUNS = 10_000;

const UNASSIGNED_TEAM = "(unassigned)";

export function normalizeTeamId(id: string | null | undefined): { key: string; label: string } {
  if (id === null || id === undefined || id === "") {
    return { key: "team:unassigned", label: UNASSIGNED_TEAM };
  }
  return { key: `team:${id}`, label: id };
}

export interface AggregateFilters {
  from: Date;
  to: Date;
}

interface CostConfig {
  costs?: {
    hourlyEngRate?: number;
    modelPricing?: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
    timeSavedPerPrDefault?: number;
  };
  pipelineConfigs?: Record<string, any>;
}

function emptyBucket(key: string, label: string): BreakdownRow {
  return {
    key, label, runs: 0, prsMerged: 0,
    inputTokens: 0, outputTokens: 0,
    dollars: 0, timeSavedHours: 0, roiMultiplier: 0,
  };
}

function finalizeRoi(row: { dollars: number; timeSavedHours: number }, hourlyRate: number): number {
  if (row.dollars === 0) return row.timeSavedHours > 0 ? Infinity : 0;
  return (row.timeSavedHours * hourlyRate) / row.dollars;
}

export async function aggregateAll(
  db: AnyDb,
  filters: AggregateFilters,
  config: CostConfig,
  opts: { maxRuns?: number } = {},
): Promise<AggregateResult> {
  if (!isFeatureLicensed("cost-roi")) {
    log.warn(
      { feature: "cost-roi" },
      "aggregateAll called without an enterprise license — returning empty result",
    );
    return emptyAggregateResult(filters);
  }
  const hourlyRate = config.costs?.hourlyEngRate ?? 50;
  const maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS;

  const runs = await db.select().from(pipelineRuns).where(
    and(
      gte(pipelineRuns.completedAt, filters.from),
      // half-open [from, to) — matches rollup.ts convention and avoids double-counting at the boundary
      lt(pipelineRuns.completedAt, filters.to),
    ),
  );

  let truncated = false;
  if (runs.length > maxRuns) {
    log.warn(
      { runs: runs.length, maxRuns, from: filters.from, to: filters.to },
      "aggregateAll: runs exceed cap, truncating to most recent",
    );
    // Sort by completedAt DESC (nulls last) and keep only the most recent `maxRuns`.
    runs.sort((a: any, b: any) => {
      const ta = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const tb = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return tb - ta;
    });
    runs.splice(maxRuns);
    truncated = true;
  }

  if (runs.length === 0) {
    return {
      summary: {
        window: { from: filters.from, to: filters.to },
        runs: 0, prsMerged: 0, inputTokens: 0, outputTokens: 0,
        dollars: 0, timeSavedHours: 0, roiMultiplier: 0,
      },
      byTeam: [], byRepo: [], byPipeline: [], byDay: [],
    };
  }

  const runIds = runs.map((r: any) => r.id);
  const stages = await db.select().from(stageRuns).where(inArray(stageRuns.pipelineRunId, runIds));

  const stagesByRun = new Map<string, any[]>();
  for (const s of stages) {
    const arr = stagesByRun.get(s.pipelineRunId) ?? [];
    arr.push(s);
    stagesByRun.set(s.pipelineRunId, arr);
  }

  const summary: CostSummary = {
    window: { from: filters.from, to: filters.to },
    runs: 0, prsMerged: 0, inputTokens: 0, outputTokens: 0,
    dollars: 0, timeSavedHours: 0, roiMultiplier: 0,
    ...(truncated ? { truncated: true } : {}),
  };
  const byTeam = new Map<string, BreakdownRow>();
  const byRepo = new Map<string, BreakdownRow>();
  const byPipeline = new Map<string, BreakdownRow>();
  const byDay = new Map<string, DailyRow>();

  for (const run of runs) {
    const runStages = stagesByRun.get(run.id) ?? [];
    const cost = computeRunCost(run as any, runStages as any, config);

    const isMergedPr = run.status === "completed" && run.runType !== "review-feedback";
    summary.runs += 1;
    summary.inputTokens += cost.inputTokens;
    summary.outputTokens += cost.outputTokens;
    summary.dollars += cost.dollars;
    summary.timeSavedHours += cost.timeSavedHours;
    if (isMergedPr) summary.prsMerged += 1;

    // completedAt is guaranteed non-null here — the WHERE clause above filters
    // on `gte(completedAt, from)` and `lt(completedAt, to)`, which excludes
    // rows where completedAt IS NULL (SQL NULL comparisons are falsy).
    const dateStr = new Date(run.completedAt!).toISOString().slice(0, 10);
    let dr = byDay.get(dateStr);
    if (!dr) {
      dr = { date: dateStr, runs: 0, prsMerged: 0, dollars: 0, timeSavedHours: 0 };
      byDay.set(dateStr, dr);
    }
    dr.runs += 1;
    dr.dollars += cost.dollars;
    dr.timeSavedHours += cost.timeSavedHours;
    if (isMergedPr) dr.prsMerged += 1;

    const { key: teamKey, label: teamLabel } = normalizeTeamId(run.linearTeamId);
    if (!byTeam.has(teamKey)) byTeam.set(teamKey, emptyBucket(teamKey, teamLabel));
    const tb = byTeam.get(teamKey)!;
    tb.runs += 1; tb.inputTokens += cost.inputTokens; tb.outputTokens += cost.outputTokens;
    tb.dollars += cost.dollars; tb.timeSavedHours += cost.timeSavedHours;
    if (isMergedPr) tb.prsMerged += 1;

    const repoKey = `repo:${run.repoUrl}`;
    if (!byRepo.has(repoKey)) byRepo.set(repoKey, emptyBucket(repoKey, run.repoUrl));
    const rb = byRepo.get(repoKey)!;
    rb.runs += 1; rb.inputTokens += cost.inputTokens; rb.outputTokens += cost.outputTokens;
    rb.dollars += cost.dollars; rb.timeSavedHours += cost.timeSavedHours;
    if (isMergedPr) rb.prsMerged += 1;

    const pipelineKey = `pipeline:${run.pipelineKey}`;
    if (!byPipeline.has(pipelineKey)) byPipeline.set(pipelineKey, emptyBucket(pipelineKey, run.pipelineKey));
    const pb = byPipeline.get(pipelineKey)!;
    pb.runs += 1; pb.inputTokens += cost.inputTokens; pb.outputTokens += cost.outputTokens;
    pb.dollars += cost.dollars; pb.timeSavedHours += cost.timeSavedHours;
    if (isMergedPr) pb.prsMerged += 1;
  }

  summary.roiMultiplier = finalizeRoi(summary, hourlyRate);
  const sort = (a: BreakdownRow, b: BreakdownRow) => b.dollars - a.dollars;
  const finalize = (rows: BreakdownRow[]) => {
    for (const r of rows) r.roiMultiplier = finalizeRoi(r, hourlyRate);
    return rows.sort(sort);
  };

  return {
    summary,
    byTeam: finalize(Array.from(byTeam.values())),
    byRepo: finalize(Array.from(byRepo.values())),
    byPipeline: finalize(Array.from(byPipeline.values())),
    byDay: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** Snap a Date down to the start of its UTC day (00:00:00.000 UTC). */
export function snapToUtcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Aggregate pre-computed rollup rows for UTC dates in [fromDate, toDate).
 * Both bounds are YYYY-MM-DD strings. Returns an AggregateResult whose
 * window.from/to reflect the caller-supplied Date objects (not the date
 * strings), so the summary is consistent with the caller's framing.
 */
async function aggregateFromRollups(
  db: AnyDb,
  fromDate: string,
  toDate: string,
  window: { from: Date; to: Date },
  hourlyRate: number,
): Promise<AggregateResult> {
  // Half-open [fromDate, toDate) — use gte(date) + lt(date) on the date string.
  const rows: any[] = await db.select().from(costRollupsDaily).where(
    and(
      gte(costRollupsDaily.date, fromDate),
      lt(costRollupsDaily.date, toDate),
    ),
  );

  const summary: CostSummary = {
    window,
    runs: 0, prsMerged: 0, inputTokens: 0, outputTokens: 0,
    dollars: 0, timeSavedHours: 0, roiMultiplier: 0,
  };
  const byTeam = new Map<string, BreakdownRow>();
  const byRepo = new Map<string, BreakdownRow>();
  const byPipeline = new Map<string, BreakdownRow>();
  const byDay = new Map<string, DailyRow>();

  for (const r of rows) {
    summary.runs += r.runs;
    summary.prsMerged += r.prsMerged;
    summary.inputTokens += r.inputTokens;
    summary.outputTokens += r.outputTokens;
    summary.dollars += r.dollars;
    summary.timeSavedHours += r.timeSavedHours;

    // Rollup rows are already bucketed by date × pipeline × team × repo,
    // so multiple rollup rows can share the same date.
    let dr = byDay.get(r.date);
    if (!dr) {
      dr = { date: r.date, runs: 0, prsMerged: 0, dollars: 0, timeSavedHours: 0 };
      byDay.set(r.date, dr);
    }
    dr.runs += r.runs;
    dr.prsMerged += r.prsMerged;
    dr.dollars += r.dollars;
    dr.timeSavedHours += r.timeSavedHours;

    // rollup stores linearTeamId as "" sentinel for unassigned (see rollup.ts)
    const teamId = r.linearTeamId === "" ? null : r.linearTeamId;
    const { key: teamKey, label: teamLabel } = normalizeTeamId(teamId);
    if (!byTeam.has(teamKey)) byTeam.set(teamKey, emptyBucket(teamKey, teamLabel));
    const tb = byTeam.get(teamKey)!;
    tb.runs += r.runs; tb.prsMerged += r.prsMerged;
    tb.inputTokens += r.inputTokens; tb.outputTokens += r.outputTokens;
    tb.dollars += r.dollars; tb.timeSavedHours += r.timeSavedHours;

    const repoKey = `repo:${r.repoUrl}`;
    if (!byRepo.has(repoKey)) byRepo.set(repoKey, emptyBucket(repoKey, r.repoUrl));
    const rb = byRepo.get(repoKey)!;
    rb.runs += r.runs; rb.prsMerged += r.prsMerged;
    rb.inputTokens += r.inputTokens; rb.outputTokens += r.outputTokens;
    rb.dollars += r.dollars; rb.timeSavedHours += r.timeSavedHours;

    const pipelineKey = `pipeline:${r.pipelineKey}`;
    if (!byPipeline.has(pipelineKey)) byPipeline.set(pipelineKey, emptyBucket(pipelineKey, r.pipelineKey));
    const pb = byPipeline.get(pipelineKey)!;
    pb.runs += r.runs; pb.prsMerged += r.prsMerged;
    pb.inputTokens += r.inputTokens; pb.outputTokens += r.outputTokens;
    pb.dollars += r.dollars; pb.timeSavedHours += r.timeSavedHours;
  }

  summary.roiMultiplier = finalizeRoi(summary, hourlyRate);
  const sort = (a: BreakdownRow, b: BreakdownRow) => b.dollars - a.dollars;
  const finalize = (rows: BreakdownRow[]) => {
    for (const r of rows) r.roiMultiplier = finalizeRoi(r, hourlyRate);
    return rows.sort(sort);
  };

  return {
    summary,
    byTeam: finalize(Array.from(byTeam.values())),
    byRepo: finalize(Array.from(byRepo.values())),
    byPipeline: finalize(Array.from(byPipeline.values())),
    byDay: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function mergeDailyRows(a: DailyRow[], b: DailyRow[]): DailyRow[] {
  const byDate = new Map<string, DailyRow>();
  for (const row of [...a, ...b]) {
    const existing = byDate.get(row.date);
    if (!existing) {
      byDate.set(row.date, { ...row });
    } else {
      existing.runs += row.runs;
      existing.prsMerged += row.prsMerged;
      existing.dollars += row.dollars;
      existing.timeSavedHours += row.timeSavedHours;
    }
  }
  return Array.from(byDate.values()).sort((x, y) => x.date.localeCompare(y.date));
}

function mergeBreakdowns(
  a: BreakdownRow[],
  b: BreakdownRow[],
  hourlyRate: number,
): BreakdownRow[] {
  const byKey = new Map<string, BreakdownRow>();
  for (const row of [...a, ...b]) {
    const existing = byKey.get(row.key);
    if (!existing) {
      byKey.set(row.key, { ...row });
    } else {
      existing.runs += row.runs;
      existing.prsMerged += row.prsMerged;
      existing.inputTokens += row.inputTokens;
      existing.outputTokens += row.outputTokens;
      existing.dollars += row.dollars;
      existing.timeSavedHours += row.timeSavedHours;
    }
  }
  const merged = Array.from(byKey.values());
  for (const r of merged) r.roiMultiplier = finalizeRoi(r, hourlyRate);
  return merged.sort((x, y) => y.dollars - x.dollars);
}

/**
 * Hybrid aggregate: uses pre-computed rollup rows for whole UTC days before
 * today, and live `aggregateAll` for today's partial data. The two halves are
 * summed into a single `AggregateResult`.
 *
 * When `opts.enableRollups` is false (the default for arbitrary custom
 * windows), falls back to pure live aggregation.
 *
 * IMPORTANT: `filters.from` must be at a UTC day boundary (00:00 UTC) for
 * rollup-backed reads to be exact — the rollup table stores per-day totals.
 * For preset windows (7d/30d/90d/365d) the caller is expected to snap `from`
 * via `snapToUtcDayStart`. For non-aligned `from`, this function still routes
 * through rollups but will slightly over-count by including the full first
 * UTC day — acceptable for preset usage, unsuitable for arbitrary windows
 * (hence the opt-in `enableRollups` flag).
 */
export async function aggregateHybrid(
  db: AnyDb,
  filters: AggregateFilters,
  config: CostConfig,
  opts: { maxRuns?: number; now?: Date; enableRollups?: boolean } = {},
): Promise<AggregateResult> {
  if (!isFeatureLicensed("cost-roi")) {
    log.warn(
      { feature: "cost-roi" },
      "aggregateHybrid called without an enterprise license — returning empty result",
    );
    return emptyAggregateResult(filters);
  }
  const enableRollups = opts.enableRollups ?? false;
  if (!enableRollups) {
    return aggregateAll(db, filters, config, opts);
  }

  const hourlyRate = config.costs?.hourlyEngRate ?? 50;
  const now = opts.now ?? new Date();
  const todayUtcStart = snapToUtcDayStart(now);

  // If the window doesn't span any completed UTC days, fall through to pure live.
  if (filters.from >= todayUtcStart) {
    return aggregateAll(db, filters, config, opts);
  }

  // Compute the rollup window (whole UTC days) and the live remainder (today).
  const rollupEndDateStr = utcDateStr(todayUtcStart);
  const rollupFromDateStr = utcDateStr(filters.from);
  // If the user's window ends before today's UTC midnight, rollup covers the
  // full window and there's no live component.
  const rollupOnlyCutoff = filters.to <= todayUtcStart ? filters.to : todayUtcStart;
  const rollupToDateStr = utcDateStr(rollupOnlyCutoff);

  const rollupPart = await aggregateFromRollups(
    db,
    rollupFromDateStr,
    // Upper bound is exclusive (lt on date string). `rollupEndDateStr` is
    // today's date, so lt excludes today and includes through yesterday.
    // When the window ends before today (rollup-only path), the upper bound
    // is the window's `to` date so lt(date, windowTo) includes everything
    // strictly before windowTo's UTC date.
    rollupOnlyCutoff < todayUtcStart ? rollupToDateStr : rollupEndDateStr,
    { from: filters.from, to: filters.to },
    hourlyRate,
  );

  // If the window ends before today's midnight, we're done.
  if (filters.to <= todayUtcStart) {
    log.debug({ from: rollupFromDateStr, to: rollupToDateStr }, "aggregateHybrid: rollup-only path");
    return rollupPart;
  }

  // Live query for today's partial data [todayUtcStart, filters.to).
  const livePart = await aggregateAll(
    db,
    { from: todayUtcStart, to: filters.to },
    config,
    opts,
  );

  log.debug(
    { rollupDays: rollupFromDateStr + "..." + rollupEndDateStr, liveFrom: todayUtcStart.toISOString() },
    "aggregateHybrid: rollup + live merge",
  );

  // Merge summary
  const mergedSummary: CostSummary = {
    window: { from: filters.from, to: filters.to },
    runs: rollupPart.summary.runs + livePart.summary.runs,
    prsMerged: rollupPart.summary.prsMerged + livePart.summary.prsMerged,
    inputTokens: rollupPart.summary.inputTokens + livePart.summary.inputTokens,
    outputTokens: rollupPart.summary.outputTokens + livePart.summary.outputTokens,
    dollars: rollupPart.summary.dollars + livePart.summary.dollars,
    timeSavedHours: rollupPart.summary.timeSavedHours + livePart.summary.timeSavedHours,
    roiMultiplier: 0,
    ...(livePart.summary.truncated ? { truncated: true } : {}),
  };
  mergedSummary.roiMultiplier = finalizeRoi(mergedSummary, hourlyRate);

  return {
    summary: mergedSummary,
    byTeam: mergeBreakdowns(rollupPart.byTeam, livePart.byTeam, hourlyRate),
    byRepo: mergeBreakdowns(rollupPart.byRepo, livePart.byRepo, hourlyRate),
    byPipeline: mergeBreakdowns(rollupPart.byPipeline, livePart.byPipeline, hourlyRate),
    byDay: mergeDailyRows(rollupPart.byDay, livePart.byDay),
  };
}


import { and, gte, lte, inArray } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { pipelineRuns, stageRuns } from "../db/schema.js";
import { computeRunCost } from "./per-run.js";
import type { AggregateResult, BreakdownRow, CostSummary } from "./types.js";

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
): Promise<AggregateResult> {
  const hourlyRate = config.costs?.hourlyEngRate ?? 50;

  const runs = await db.select().from(pipelineRuns).where(
    and(
      gte(pipelineRuns.completedAt, filters.from),
      lte(pipelineRuns.completedAt, filters.to),
    ),
  );

  if (runs.length === 0) {
    return {
      summary: {
        window: { from: filters.from, to: filters.to },
        runs: 0, prsMerged: 0, inputTokens: 0, outputTokens: 0,
        dollars: 0, timeSavedHours: 0, roiMultiplier: 0,
      },
      byTeam: [], byRepo: [], byPipeline: [],
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
  };
  const byTeam = new Map<string, BreakdownRow>();
  const byRepo = new Map<string, BreakdownRow>();
  const byPipeline = new Map<string, BreakdownRow>();

  for (const run of runs) {
    const runStages = stagesByRun.get(run.id) ?? [];
    const cost = computeRunCost(run as any, runStages as any, config);

    summary.runs += 1;
    summary.inputTokens += cost.inputTokens;
    summary.outputTokens += cost.outputTokens;
    summary.dollars += cost.dollars;
    summary.timeSavedHours += cost.timeSavedHours;
    if (run.status === "completed") summary.prsMerged += 1;

    const teamKey = `team:${run.linearTeamId ?? "unassigned"}`;
    const teamLabel = run.linearTeamId ?? "(unassigned)";
    if (!byTeam.has(teamKey)) byTeam.set(teamKey, emptyBucket(teamKey, teamLabel));
    const tb = byTeam.get(teamKey)!;
    tb.runs += 1; tb.inputTokens += cost.inputTokens; tb.outputTokens += cost.outputTokens;
    tb.dollars += cost.dollars; tb.timeSavedHours += cost.timeSavedHours;
    if (run.status === "completed") tb.prsMerged += 1;

    const repoKey = `repo:${run.repoUrl}`;
    if (!byRepo.has(repoKey)) byRepo.set(repoKey, emptyBucket(repoKey, run.repoUrl));
    const rb = byRepo.get(repoKey)!;
    rb.runs += 1; rb.inputTokens += cost.inputTokens; rb.outputTokens += cost.outputTokens;
    rb.dollars += cost.dollars; rb.timeSavedHours += cost.timeSavedHours;
    if (run.status === "completed") rb.prsMerged += 1;

    const pipelineKey = `pipeline:${run.pipelineKey}`;
    if (!byPipeline.has(pipelineKey)) byPipeline.set(pipelineKey, emptyBucket(pipelineKey, run.pipelineKey));
    const pb = byPipeline.get(pipelineKey)!;
    pb.runs += 1; pb.inputTokens += cost.inputTokens; pb.outputTokens += cost.outputTokens;
    pb.dollars += cost.dollars; pb.timeSavedHours += cost.timeSavedHours;
    if (run.status === "completed") pb.prsMerged += 1;
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
  };
}

import { randomUUID } from "node:crypto";
import { and, gte, lt, lte, inArray } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { pipelineRuns, stageRuns, costRollupsDaily } from "../db/schema.js";
import { computeRunCost } from "./per-run.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "cost.rollup" });

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

export async function recomputeCostRollups(
  db: AnyDb,
  config: CostConfig,
): Promise<{ rowsWritten: number }> {
  // Determine yesterday (UTC). Rollups only cover completed UTC days.
  const now = new Date();
  const yesterdayUtc = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1,
  ));
  const dateStr = utcDateStr(yesterdayUtc);
  const { start, end } = dayBounds(dateStr);

  const runs = await db.select().from(pipelineRuns).where(
    and(
      gte(pipelineRuns.completedAt, start),
      lt(pipelineRuns.completedAt, end),
    ),
  );

  if (runs.length === 0) {
    log.info({ date: dateStr, rowsWritten: 0 }, "no runs to roll up");
    return { rowsWritten: 0 };
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
    if (run.status === "completed") b.prsMerged += 1;
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
  return { rowsWritten };
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

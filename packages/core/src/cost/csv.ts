import type { AnyDb } from "../db/client.js";
import { and, gte, lte, inArray } from "drizzle-orm";
import { pipelineRuns, stageRuns } from "../db/schema.js";
import { computeRunCost } from "./per-run.js";

const HEADER =
  "completed_at,run_id,issue_id,pipeline_key,linear_team_id,repo_url,input_tokens,output_tokens,dollars,time_saved_hours";

const FORMULA_PREFIX = /^[=+\-@\t]/;

function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (FORMULA_PREFIX.test(s)) s = "'" + s;
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export interface CsvFilters {
  from: Date;
  to: Date;
}

interface CostConfig {
  costs?: any;
  pipelineConfigs?: Record<string, any>;
}

export async function* streamCostCsv(
  db: AnyDb,
  filters: CsvFilters,
  config: CostConfig,
): AsyncIterable<string> {
  yield HEADER + "\n";

  const runs = await db
    .select()
    .from(pipelineRuns)
    .where(
      and(
        gte(pipelineRuns.completedAt, filters.from),
        lte(pipelineRuns.completedAt, filters.to),
      ),
    );
  if (runs.length === 0) return;

  const runIds = runs.map((r: any) => r.id);
  const stages = await db
    .select()
    .from(stageRuns)
    .where(inArray(stageRuns.pipelineRunId, runIds));
  const stagesByRun = new Map<string, any[]>();
  for (const s of stages) {
    const arr = stagesByRun.get(s.pipelineRunId) ?? [];
    arr.push(s);
    stagesByRun.set(s.pipelineRunId, arr);
  }

  for (const run of runs) {
    const runStages = stagesByRun.get(run.id) ?? [];
    const cost = computeRunCost(run as any, runStages as any, config);
    const fields = [
      run.completedAt?.toISOString() ?? "",
      run.id,
      run.issueId,
      run.pipelineKey,
      run.linearTeamId ?? "",
      run.repoUrl,
      cost.inputTokens,
      cost.outputTokens,
      cost.dollars.toFixed(4),
      cost.timeSavedHours,
    ].map(escapeCsvField);
    yield fields.join(",") + "\n";
  }
}

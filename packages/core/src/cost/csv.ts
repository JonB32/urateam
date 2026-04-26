import type { AnyDb } from "../db/client.js";
import { and, gte, lt, inArray } from "drizzle-orm";
import { pipelineRuns, stageRuns } from "../db/schema.js";
import { computeRunCost } from "./per-run.js";
import { isFeatureLicensed } from "../license.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "cost.csv" });

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

const DEFAULT_CSV_MAX_RUNS = 10_000;

export async function* streamCostCsv(
  db: AnyDb,
  filters: CsvFilters,
  config: CostConfig,
  maxRuns: number = DEFAULT_CSV_MAX_RUNS,
): AsyncIterable<string> {
  if (!isFeatureLicensed("cost-roi")) {
    log.warn(
      { feature: "cost-roi" },
      "streamCostCsv called without an enterprise license — returning empty stream",
    );
    return;
  }
  yield HEADER + "\n";

  const runs = await db
    .select()
    .from(pipelineRuns)
    .where(
      and(
        gte(pipelineRuns.completedAt, filters.from),
        // half-open [from, to) — matches rollup.ts convention and avoids double-counting at the boundary
        lt(pipelineRuns.completedAt, filters.to),
      ),
    );
  if (runs.length === 0) return;

  const totalRuns = runs.length;
  let truncated = false;
  if (runs.length > maxRuns) {
    // Sort by completedAt DESC (nulls last) and keep only the most recent maxRuns.
    runs.sort((a: any, b: any) => {
      const ta = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const tb = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return tb - ta;
    });
    runs.splice(maxRuns);
    truncated = true;
  }

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

  if (truncated) {
    yield `# truncated: ${totalRuns} runs in window, exported most recent ${maxRuns}. Narrow date range for complete export.\n`;
  }
}

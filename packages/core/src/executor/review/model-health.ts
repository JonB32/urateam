import { gte } from "drizzle-orm";
import type { AnyDb } from "../../db/client.js";
import { reviewModelRuns } from "../../db/schema.js";

export interface ModelHealthScore {
  runs: number;
  outputRatio: number;
  lastSeen: Date;
}

export interface HealthOptions {
  lookbackHours: number;
  minRuns: number;
}

export interface FlagOptions {
  threshold: number;
  minRuns: number;
}

/**
 * Aggregate per-model health stats from review_model_runs over a rolling
 * window. Only `status = 'completed'` runs contribute to the output-ratio
 * computation — failed runs typically have zero in/out tokens and would
 * dilute the signal.
 */
export async function getModelHealthScores(
  db: AnyDb,
  opts: HealthOptions,
): Promise<Map<string, ModelHealthScore>> {
  const cutoff = new Date(Date.now() - opts.lookbackHours * 3600_000);
  const rows = await db
    .select({
      modelId: reviewModelRuns.modelId,
      inputTokens: reviewModelRuns.inputTokens,
      outputTokens: reviewModelRuns.outputTokens,
      startedAt: reviewModelRuns.startedAt,
      status: reviewModelRuns.status,
    })
    .from(reviewModelRuns)
    .where(gte(reviewModelRuns.startedAt, cutoff));

  const acc = new Map<
    string,
    { runs: number; sumIn: number; sumOut: number; lastSeen: Date }
  >();
  for (const r of rows) {
    if (r.status !== "completed") continue;
    const cur = acc.get(r.modelId) ?? {
      runs: 0,
      sumIn: 0,
      sumOut: 0,
      lastSeen: new Date(0),
    };
    cur.runs += 1;
    cur.sumIn += r.inputTokens;
    cur.sumOut += r.outputTokens;
    if (r.startedAt && r.startedAt > cur.lastSeen) cur.lastSeen = r.startedAt;
    acc.set(r.modelId, cur);
  }

  const result = new Map<string, ModelHealthScore>();
  for (const [modelId, v] of acc) {
    const denom = v.sumIn + v.sumOut;
    const outputRatio = denom > 0 ? v.sumOut / denom : 0;
    result.set(modelId, { runs: v.runs, outputRatio, lastSeen: v.lastSeen });
  }
  return result;
}

/**
 * Filter a list of model IDs down to those that look low-yield given the
 * health scores. Models with insufficient data (`runs < minRuns`) are NOT
 * flagged — we don't want a single bad-luck call to suspend a model.
 */
export function flagLowYieldModels(
  scores: Map<string, ModelHealthScore>,
  models: string[],
  opts: FlagOptions,
): string[] {
  const flagged: string[] = [];
  for (const modelId of models) {
    const s = scores.get(modelId);
    if (!s) continue;
    if (s.runs < opts.minRuns) continue;
    if (s.outputRatio < opts.threshold) flagged.push(modelId);
  }
  return flagged;
}

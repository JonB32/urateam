import { resolveModelRate, resolveTimeSavedPerPr } from "./rates.js";
import type { RunCost } from "./types.js";
import { isFeatureLicensed } from "../license.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "cost.per-run" });

const ZERO_COST: RunCost = {
  inputTokens: 0,
  outputTokens: 0,
  dollars: 0,
  timeSavedHours: 0,
};

interface PipelineRunRow {
  pipelineKey: string;
  status: string;
  runType?: string | null;
}

/** Per-model token row from review_model_runs. */
export interface ModelRunRow {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

interface StageRunRow {
  stage: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * When present (BEC-134), cost is computed per model instead of using the
   * stage-level token totals against a single configured model.
   */
  modelRuns?: ModelRunRow[];
}

interface CostConfig {
  costs?: {
    modelPricing?: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
    hourlyEngRate?: number;
    timeSavedPerPrDefault?: number;
  };
  pipelineConfigs?: Record<string, {
    stageModels?: Record<string, string>;
    profile?: { model?: string };
    timeSavedPerPr?: number;
  }>;
}

export function computeRunCost(
  run: PipelineRunRow,
  stages: StageRunRow[],
  config: CostConfig,
): RunCost {
  if (!isFeatureLicensed("cost-roi")) {
    log.warn(
      { feature: "cost-roi", pipelineKey: run.pipelineKey },
      "computeRunCost called without an enterprise license — returning zero cost",
    );
    return { ...ZERO_COST };
  }
  const pc = config.pipelineConfigs?.[run.pipelineKey];
  let dollars = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const s of stages) {
    if (s.modelRuns && s.modelRuns.length > 0) {
      // BEC-134: per-model pricing using review_model_runs rows.
      for (const mr of s.modelRuns) {
        const rate = resolveModelRate(mr.modelId, config);
        dollars += (mr.inputTokens * rate.inputPerMillion) / 1_000_000;
        dollars += (mr.outputTokens * rate.outputPerMillion) / 1_000_000;
        inputTokens += mr.inputTokens;
        outputTokens += mr.outputTokens;
      }
    } else {
      // Fallback: stage-level tokens against the configured model for this stage.
      const modelName =
        pc?.stageModels?.[s.stage] ??
        pc?.profile?.model ??
        "claude-sonnet-4-6";
      const rate = resolveModelRate(modelName, config);
      dollars += (s.inputTokens * rate.inputPerMillion) / 1_000_000;
      dollars += (s.outputTokens * rate.outputPerMillion) / 1_000_000;
      inputTokens += s.inputTokens;
      outputTokens += s.outputTokens;
    }
  }
  const timeSavedHours =
    run.status === "completed" && run.runType !== "review-feedback"
      ? resolveTimeSavedPerPr(run.pipelineKey, config)
      : 0;
  return { inputTokens, outputTokens, dollars, timeSavedHours };
}

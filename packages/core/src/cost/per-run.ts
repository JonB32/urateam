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

interface StageRunRow {
  stage: string;
  inputTokens: number;
  outputTokens: number;
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
  const timeSavedHours =
    run.status === "completed" && run.runType !== "review-feedback"
      ? resolveTimeSavedPerPr(run.pipelineKey, config)
      : 0;
  return { inputTokens, outputTokens, dollars, timeSavedHours };
}

import { resolveModelRate, resolveTimeSavedPerPr } from "./rates.js";
import type { RunCost } from "./types.js";

interface PipelineRunRow {
  pipelineKey: string;
  status: string;
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
    run.status === "completed" ? resolveTimeSavedPerPr(run.pipelineKey, config) : 0;
  return { inputTokens, outputTokens, dollars, timeSavedHours };
}

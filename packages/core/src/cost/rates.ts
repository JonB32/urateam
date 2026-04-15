import type { ModelRate } from "./types.js";

const BUILTIN_SONNET: ModelRate = { inputPerMillion: 3, outputPerMillion: 15 };

/**
 * Resolve the $/M-token rate for a given model. Lookup order:
 * 1. config.costs.modelPricing[modelName] — configured explicit rate
 * 2. config.costs.modelPricing["claude-sonnet-4-6"] — fallback to sonnet
 * 3. Built-in sonnet default ($3/$15 per M) — for deployments with no costs config
 */
export function resolveModelRate(
  modelName: string,
  config: { costs?: { modelPricing?: Record<string, ModelRate> } },
): ModelRate {
  const table = config.costs?.modelPricing;
  if (!table) return BUILTIN_SONNET;
  return table[modelName] ?? table["claude-sonnet-4-6"] ?? BUILTIN_SONNET;
}

/**
 * Resolve the `timeSavedPerPr` hours for a given pipeline. Lookup order:
 * 1. pipelineConfigs[pipelineKey].timeSavedPerPr
 * 2. config.costs.timeSavedPerPrDefault
 * 3. Built-in default (4h)
 */
export function resolveTimeSavedPerPr(
  pipelineKey: string,
  config: {
    costs?: { timeSavedPerPrDefault?: number };
    pipelineConfigs?: Record<string, { timeSavedPerPr?: number }>;
  },
): number {
  const override = config.pipelineConfigs?.[pipelineKey]?.timeSavedPerPr;
  if (override !== undefined) return override;
  return config.costs?.timeSavedPerPrDefault ?? 4;
}

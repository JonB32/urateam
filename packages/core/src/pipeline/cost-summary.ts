import { resolveModelRate } from "../cost/rates.js";
import type { ModelRunRow } from "../cost/per-run.js";

export interface StageCostBreakdown {
  stage: string;
  inputTokens: number;
  outputTokens: number;
  /** When present, per-model rows from the fanout review stage. */
  modelRuns?: ModelRunRow[];
}

export interface CostSummaryConfig {
  costs?: {
    modelPricing?: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
  };
  pipelineConfigs?: Record<
    string,
    {
      stageModels?: Record<string, string>;
      profile?: { model?: string };
    }
  >;
}

interface RenderedStage {
  label: string;
  inputTokens: number;
  outputTokens: number;
  dollars: number;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function dollarsForStage(
  stage: StageCostBreakdown,
  pipelineKey: string,
  config: CostSummaryConfig,
): number {
  if (stage.modelRuns && stage.modelRuns.length > 0) {
    let dollars = 0;
    for (const mr of stage.modelRuns) {
      const rate = resolveModelRate(mr.modelId, config);
      dollars += (mr.inputTokens * rate.inputPerMillion) / 1_000_000;
      dollars += (mr.outputTokens * rate.outputPerMillion) / 1_000_000;
    }
    return dollars;
  }
  const pc = config.pipelineConfigs?.[pipelineKey];
  const modelName =
    pc?.stageModels?.[stage.stage] ?? pc?.profile?.model ?? "claude-sonnet-4-6";
  const rate = resolveModelRate(modelName, config);
  return (
    (stage.inputTokens * rate.inputPerMillion) / 1_000_000 +
    (stage.outputTokens * rate.outputPerMillion) / 1_000_000
  );
}

function renderStage(
  stage: StageCostBreakdown,
  pipelineKey: string,
  config: CostSummaryConfig,
): RenderedStage {
  if (stage.modelRuns && stage.modelRuns.length > 0) {
    const totalIn = stage.modelRuns.reduce((a, m) => a + m.inputTokens, 0);
    const totalOut = stage.modelRuns.reduce((a, m) => a + m.outputTokens, 0);
    return {
      label: `fanout (${stage.modelRuns.length} models)`,
      inputTokens: totalIn,
      outputTokens: totalOut,
      dollars: dollarsForStage(stage, pipelineKey, config),
    };
  }
  return {
    label: stage.stage,
    inputTokens: stage.inputTokens,
    outputTokens: stage.outputTokens,
    dollars: dollarsForStage(stage, pipelineKey, config),
  };
}

/**
 * BEC-175: render a markdown summary of per-stage token spend + total dollar
 * cost for posting as a PR comment. Returns "" when there is no usage to
 * report (caller should suppress the comment).
 */
export function formatPRCostSummary(
  stages: StageCostBreakdown[],
  pipelineKey: string,
  config: CostSummaryConfig,
): string {
  const rendered = stages
    .map((s) => renderStage(s, pipelineKey, config))
    .filter((r) => r.inputTokens > 0 || r.outputTokens > 0);
  if (rendered.length === 0) return "";

  const labelWidth = Math.max(...rendered.map((r) => r.label.length));
  const inWidth = Math.max(...rendered.map((r) => fmt(r.inputTokens).length));
  const outWidth = Math.max(...rendered.map((r) => fmt(r.outputTokens).length));

  const lines = rendered.map((r) => {
    const labelPad = `${r.label}:`.padEnd(labelWidth + 1);
    const inPad = fmt(r.inputTokens).padStart(inWidth);
    const outPad = fmt(r.outputTokens).padStart(outWidth);
    return `- ${labelPad} ${inPad} in / ${outPad} out tokens — $${r.dollars.toFixed(4)}`;
  });

  const totalDollars = rendered.reduce((a, r) => a + r.dollars, 0);
  return [
    "🤖 **Pipeline cost summary**",
    ...lines,
    `**Total: ~$${totalDollars.toFixed(2)}**  _(rates from \`packages/core/src/cost/rates.ts\`)_`,
  ].join("\n");
}

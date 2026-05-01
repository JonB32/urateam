import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeRunCost } from "../../cost/per-run.js";
import { installTestProLicense, restoreLicense } from "../helpers/license.js";

// computeRunCost short-circuits to zero without an enterprise license.
beforeEach(async () => {
  await installTestProLicense("enterprise");
});
afterEach(async () => {
  await restoreLicense();
});

const config = {
  costs: {
    modelPricing: {
      "claude-haiku-4-5-20251001": { inputPerMillion: 1, outputPerMillion: 5 },
      "anthropic/claude-3.5-sonnet": { inputPerMillion: 3, outputPerMillion: 15 },
      "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
    },
    hourlyEngRate: 50,
    timeSavedPerPrDefault: 4,
  },
  pipelineConfigs: {
    "auto-implement": {
      stageModels: { implement: "claude-sonnet-4-6" },
      profile: { model: "claude-sonnet-4-6" },
      timeSavedPerPr: 6,
    } as any,
  },
} as any;

describe("computeRunCost — multi-model rollup (BEC-134)", () => {
  it("uses modelRuns per-model pricing when present", () => {
    const run = { pipelineKey: "auto-implement", status: "completed" } as any;
    const stages = [
      {
        stage: "review",
        inputTokens: 1000,  // stage-level totals (ignored when modelRuns present)
        outputTokens: 500,
        modelRuns: [
          // 600/1_000_000 * 1 + 300/1_000_000 * 5 = 0.0006 + 0.0015 = 0.0021
          { modelId: "claude-haiku-4-5-20251001", inputTokens: 600, outputTokens: 300 },
          // 400/1_000_000 * 3 + 200/1_000_000 * 15 = 0.0012 + 0.003 = 0.0042
          { modelId: "anthropic/claude-3.5-sonnet", inputTokens: 400, outputTokens: 200 },
        ],
      },
    ] as any;
    const cost = computeRunCost(run, stages, config);
    // total: 0.0021 + 0.0042 = 0.0063
    expect(cost.dollars).toBeCloseTo(0.0063, 5);
    // token totals come from model rows, not stage-level
    expect(cost.inputTokens).toBe(1000);   // 600 + 400
    expect(cost.outputTokens).toBe(500);   // 300 + 200
  });

  it("falls back to stage-level rollup when modelRuns is empty", () => {
    const run = { pipelineKey: "auto-implement", status: "completed" } as any;
    const stages = [
      {
        stage: "review",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        modelRuns: [],  // empty → use stage-level fallback
      },
    ] as any;
    const cost = computeRunCost(run, stages, config);
    // review stage uses pipeline profile model: claude-sonnet-4-6 ($3/$15 per M)
    // 1M * $3 + 0.5M * $15 = $3 + $7.5 = $10.5
    expect(cost.dollars).toBeCloseTo(10.5, 2);
    expect(cost.inputTokens).toBe(1_000_000);
    expect(cost.outputTokens).toBe(500_000);
  });

  it("falls back to stage-level rollup when modelRuns is absent", () => {
    const run = { pipelineKey: "auto-implement", status: "completed" } as any;
    const stages = [
      // no modelRuns field at all — backward-compat for pre-BEC-134 rows
      { stage: "implement", inputTokens: 1_000_000, outputTokens: 1_000_000 },
    ] as any;
    const cost = computeRunCost(run, stages, config);
    // implement stage model: claude-sonnet-4-6 ($3/$15 per M)
    // 1M * $3 + 1M * $15 = $18
    expect(cost.dollars).toBeCloseTo(18, 2);
  });

  it("mixes model-run and stage-level stages correctly", () => {
    const run = { pipelineKey: "auto-implement", status: "completed" } as any;
    const stages = [
      // implement: no modelRuns → stage-level fallback (claude-sonnet-4-6)
      { stage: "implement", inputTokens: 1_000_000, outputTokens: 0, modelRuns: [] },
      // review: per-model pricing
      {
        stage: "review",
        inputTokens: 0,
        outputTokens: 0,
        modelRuns: [
          { modelId: "claude-haiku-4-5-20251001", inputTokens: 1_000_000, outputTokens: 0 },
        ],
      },
    ] as any;
    const cost = computeRunCost(run, stages, config);
    // implement: 1M * $3 = $3
    // review haiku: 1M * $1 = $1
    // total: $4
    expect(cost.dollars).toBeCloseTo(4, 5);
  });
});

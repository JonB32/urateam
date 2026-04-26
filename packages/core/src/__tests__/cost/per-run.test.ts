import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeRunCost } from "../../cost/per-run.js";
import { installTestProLicense, restoreLicense } from "../helpers/license.js";

// computeRunCost short-circuits to zero without an enterprise license
// (defensive gate). The cost-shape tests below assume the gate has passed.
beforeEach(async () => {
  await installTestProLicense("enterprise");
});
afterEach(async () => {
  await restoreLicense();
});

const config = {
  costs: {
    modelPricing: {
      "claude-opus-4-6":   { inputPerMillion: 15, outputPerMillion: 75 },
      "claude-sonnet-4-6": { inputPerMillion:  3, outputPerMillion: 15 },
    },
    hourlyEngRate: 50,
    timeSavedPerPrDefault: 4,
  },
  pipelineConfigs: {
    "auto-implement": {
      stageModels: { implement: "claude-opus-4-6" },
      profile: { model: "claude-sonnet-4-6" },
      timeSavedPerPr: 6,
    } as any,
    "quick-fix": {
      profile: { model: "claude-sonnet-4-6" },
    } as any,
  },
} as any;

describe("computeRunCost", () => {
  it("prices stages at their configured model rates", () => {
    const run = { pipelineKey: "auto-implement", status: "completed" } as any;
    const stages = [
      { stage: "implement", inputTokens: 1_000_000, outputTokens: 500_000 },
      { stage: "review", inputTokens: 100_000, outputTokens: 20_000 },
    ] as any;
    const cost = computeRunCost(run, stages, config);
    // implement: 1M × $15 + 0.5M × $75 = $15 + $37.5 = $52.5
    // review (sonnet default): 0.1M × $3 + 0.02M × $15 = $0.30 + $0.30 = $0.60
    expect(cost.dollars).toBeCloseTo(53.1, 2);
    expect(cost.inputTokens).toBe(1_100_000);
    expect(cost.outputTokens).toBe(520_000);
  });

  it("assigns timeSavedHours only when run.status === 'completed'", () => {
    const run = { pipelineKey: "auto-implement", status: "completed" } as any;
    const stages = [{ stage: "implement", inputTokens: 0, outputTokens: 0 }] as any;
    expect(computeRunCost(run, stages, config).timeSavedHours).toBe(6);
  });

  it("zero timeSavedHours on failed runs", () => {
    const run = { pipelineKey: "auto-implement", status: "failed" } as any;
    const stages = [{ stage: "implement", inputTokens: 1_000_000, outputTokens: 500_000 }] as any;
    expect(computeRunCost(run, stages, config).timeSavedHours).toBe(0);
  });

  it("uses pipeline profile model when stageModels is empty", () => {
    const run = { pipelineKey: "quick-fix", status: "completed" } as any;
    const stages = [{ stage: "implement", inputTokens: 1_000_000, outputTokens: 1_000_000 }] as any;
    const cost = computeRunCost(run, stages, config);
    // sonnet: 1M × $3 + 1M × $15 = $18
    expect(cost.dollars).toBeCloseTo(18, 2);
  });
});

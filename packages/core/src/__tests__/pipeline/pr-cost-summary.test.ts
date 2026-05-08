import { describe, it, expect } from "vitest";
import {
  formatPRCostSummary,
  type StageCostBreakdown,
} from "../../pipeline/cost-summary.js";

const ratesConfig = {
  costs: {
    modelPricing: {
      "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
      "claude-opus-4-7": { inputPerMillion: 15, outputPerMillion: 75 },
    },
  },
  pipelineConfigs: {
    "auto-implement": { profile: { model: "claude-sonnet-4-6" } },
  },
};

describe("formatPRCostSummary", () => {
  it("renders one line per stage with token counts and dollar cost", () => {
    const stages: StageCostBreakdown[] = [
      { stage: "implement", inputTokens: 12_345, outputTokens: 8_765 },
      { stage: "test", inputTokens: 1_234, outputTokens: 567 },
      { stage: "review", inputTokens: 5_678, outputTokens: 2_345 },
    ];
    const out = formatPRCostSummary(stages, "auto-implement", ratesConfig);

    expect(out).toContain("🤖 **Pipeline cost summary**");
    expect(out).toContain("implement:");
    expect(out).toContain("12,345 in");
    expect(out).toContain("8,765 out");
    expect(out).toContain("test:");
    expect(out).toContain("review:");
    // Sonnet rates: input $3/M, output $15/M
    // implement: 12345*3 + 8765*15 = 37,035 + 131,475 = 168,510 µ$ = $0.168510
    // test:      1234*3 + 567*15  = 3,702 + 8,505    = 12,207 µ$  = $0.012207
    // review:    5678*3 + 2345*15 = 17,034 + 35,175  = 52,209 µ$  = $0.052209
    // Total ≈ $0.232926
    expect(out).toContain("**Total: ~$0.23**");
  });

  it("collapses fanout stages with model runs into a single 'fanout (N models)' line", () => {
    const stages: StageCostBreakdown[] = [
      { stage: "implement", inputTokens: 1_000, outputTokens: 500 },
      {
        stage: "review",
        inputTokens: 0,
        outputTokens: 0,
        modelRuns: [
          { modelId: "claude-sonnet-4-6", inputTokens: 10_000, outputTokens: 1_500 },
          { modelId: "claude-sonnet-4-6", inputTokens: 8_000, outputTokens: 2_000 },
          { modelId: "claude-opus-4-7", inputTokens: 5_456, outputTokens: 1_067 },
        ],
      },
    ];
    const out = formatPRCostSummary(stages, "auto-implement", ratesConfig);

    expect(out).toContain("implement:");
    expect(out).toMatch(/fanout \(3 models\):/);
    expect(out).toContain("23,456 in");
    expect(out).toContain("4,567 out");
  });

  it("returns empty string when there are no stages with token usage", () => {
    expect(formatPRCostSummary([], "auto-implement", ratesConfig)).toBe("");
    expect(
      formatPRCostSummary(
        [{ stage: "implement", inputTokens: 0, outputTokens: 0 }],
        "auto-implement",
        ratesConfig,
      ),
    ).toBe("");
  });

  it("falls back to the default sonnet rate when no costs config is provided", () => {
    const stages: StageCostBreakdown[] = [
      { stage: "implement", inputTokens: 1_000_000, outputTokens: 1_000_000 },
    ];
    const out = formatPRCostSummary(stages, "auto-implement", {});
    // 1M * $3 + 1M * $15 = $18.00
    expect(out).toContain("**Total: ~$18.00**");
  });
});

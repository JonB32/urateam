import { describe, it, expect } from "vitest";
import { resolveModelRate, resolveTimeSavedPerPr } from "../../cost/rates.js";

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
    "auto-implement": { timeSavedPerPr: 6 } as any,
    "quick-fix": {} as any,
  },
} as any;

describe("resolveModelRate", () => {
  it("returns configured rate", () => {
    const r = resolveModelRate("claude-opus-4-6", config);
    expect(r).toEqual({ inputPerMillion: 15, outputPerMillion: 75 });
  });

  it("falls back to sonnet when model is unknown", () => {
    const r = resolveModelRate("nonexistent-model", config);
    expect(r).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
  });

  it("uses built-in sonnet default when config has no sonnet", () => {
    const r = resolveModelRate("unknown", { costs: { modelPricing: {}, hourlyEngRate: 50, timeSavedPerPrDefault: 4 } } as any);
    expect(r).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
  });

  it("uses built-in default when config has no costs", () => {
    const r = resolveModelRate("claude-opus-4-6", {} as any);
    // Falls through to built-in sonnet default since no modelPricing provided at all
    expect(r).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
  });
});

describe("resolveTimeSavedPerPr", () => {
  it("uses pipeline override when set", () => {
    expect(resolveTimeSavedPerPr("auto-implement", config)).toBe(6);
  });

  it("uses costs default when pipeline has no override", () => {
    expect(resolveTimeSavedPerPr("quick-fix", config)).toBe(4);
  });

  it("uses built-in default (4h) when neither pipeline nor costs config set", () => {
    expect(resolveTimeSavedPerPr("unknown", {} as any)).toBe(4);
  });
});

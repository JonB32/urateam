import { describe, it, expect } from "vitest";
import {
  CostsConfigSchema, ModelPricingSchema, PipelineConfigSchema, AppConfigSchema,
} from "../types.js";

describe("CostsConfigSchema", () => {
  it("parses an empty object and applies defaults", () => {
    const parsed = CostsConfigSchema.parse({});
    expect(parsed.hourlyEngRate).toBe(50);
    expect(parsed.timeSavedPerPrDefault).toBe(4);
    expect(parsed.modelPricing["claude-opus-4-6"]).toEqual({ inputPerMillion: 15, outputPerMillion: 75 });
    expect(parsed.modelPricing["claude-sonnet-4-6"]).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
    expect(parsed.modelPricing["claude-haiku-4-5"]).toEqual({ inputPerMillion: 1, outputPerMillion: 5 });
  });

  it("accepts an override", () => {
    const parsed = CostsConfigSchema.parse({
      hourlyEngRate: 75,
      timeSavedPerPrDefault: 6,
      modelPricing: {
        "claude-opus-4-6": { inputPerMillion: 10, outputPerMillion: 50 },
      },
    });
    expect(parsed.hourlyEngRate).toBe(75);
    expect(parsed.timeSavedPerPrDefault).toBe(6);
    expect(parsed.modelPricing["claude-opus-4-6"].inputPerMillion).toBe(10);
  });

  it("rejects non-positive rates", () => {
    expect(() => CostsConfigSchema.parse({ hourlyEngRate: 0 })).toThrow();
    expect(() => CostsConfigSchema.parse({ hourlyEngRate: -1 })).toThrow();
    expect(() => CostsConfigSchema.parse({
      modelPricing: { foo: { inputPerMillion: -1, outputPerMillion: 1 } },
    })).toThrow();
  });
});

describe("PipelineConfigSchema.timeSavedPerPr", () => {
  it("accepts optional timeSavedPerPr", () => {
    const cfg = PipelineConfigSchema.parse({
      name: "auto-implement",
      stages: ["implement"],
      retry: { maxAttempts: 1, strategy: "fail-fast" },
      review: { requiredApprovals: 1 },
      prStrategy: "draft",
      timeSavedPerPr: 6,
    } as any);
    expect(cfg.timeSavedPerPr).toBe(6);
  });

  it("accepts config without timeSavedPerPr", () => {
    const cfg = PipelineConfigSchema.parse({
      name: "quick-fix",
      stages: ["implement"],
      retry: { maxAttempts: 1, strategy: "fail-fast" },
      review: { requiredApprovals: 1 },
      prStrategy: "draft",
    } as any);
    expect(cfg.timeSavedPerPr).toBeUndefined();
  });
});

describe("AppConfigSchema.costs", () => {
  it("accepts optional costs field", () => {
    const parsed = AppConfigSchema.parse({ costs: { hourlyEngRate: 100 } });
    expect(parsed.costs?.hourlyEngRate).toBe(100);
  });

  it("accepts omitted costs", () => {
    const parsed = AppConfigSchema.parse({});
    expect(parsed.costs).toBeUndefined();
  });
});

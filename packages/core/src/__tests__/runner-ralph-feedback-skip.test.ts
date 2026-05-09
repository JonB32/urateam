import { describe, it, expect } from "vitest";

// Pure-function refactor: extract the ralph-iteration computation so we can test it
import { computeEffectiveRalphIterations } from "../pipeline/runner-ralph-helpers.js";

describe("computeEffectiveRalphIterations (BEC-182)", () => {
  it("returns 0 for review-feedback runs regardless of config or license", () => {
    expect(computeEffectiveRalphIterations({ runType: "review-feedback" }, 2, true)).toBe(0);
    expect(computeEffectiveRalphIterations({ runType: "review-feedback" }, 5, true)).toBe(0);
    expect(computeEffectiveRalphIterations({ runType: "review-feedback" }, 2, false)).toBe(0);
  });

  it("uses config.ralphIterations when license unlocks deep-review on standard runs", () => {
    expect(computeEffectiveRalphIterations({ runType: undefined as any }, 2, true)).toBe(2);
    expect(computeEffectiveRalphIterations({ runType: undefined as any }, 3, true)).toBe(3);
  });

  it("clamps to max 1 iteration without deep-review license on standard runs", () => {
    expect(computeEffectiveRalphIterations({ runType: undefined as any }, 5, false)).toBe(1);
    expect(computeEffectiveRalphIterations({ runType: undefined as any }, 0, false)).toBe(0);
  });

  it("falls back to 2 (with license) / 1 (without) when ralphIterations is undefined", () => {
    expect(computeEffectiveRalphIterations({ runType: undefined as any }, undefined, true)).toBe(2);
    expect(computeEffectiveRalphIterations({ runType: undefined as any }, undefined, false)).toBe(1);
  });
});

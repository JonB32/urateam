import { describe, it, expect } from "vitest";
import { computeAffectedFilesPredictionQuality } from "../pm/triage-prediction-quality.js";

describe("computeAffectedFilesPredictionQuality", () => {
  it("returns hasV2Prediction:false when predicted is undefined (v1 triage)", () => {
    const result = computeAffectedFilesPredictionQuality(undefined, ["a.ts"]);
    expect(result).toEqual({
      hasV2Prediction: false,
      predicted: 0,
      actual: 1,
      intersection: 0,
      missed: [],
      unexpected: ["a.ts"],
    });
  });

  it("returns hasV2Prediction:true when predicted is an empty array", () => {
    const result = computeAffectedFilesPredictionQuality([], ["a.ts"]);
    expect(result.hasV2Prediction).toBe(true);
    expect(result.predicted).toBe(0);
    expect(result.unexpected).toEqual(["a.ts"]);
  });

  it("computes intersection / missed / unexpected for partial prediction", () => {
    const result = computeAffectedFilesPredictionQuality(
      ["a.ts", "b.ts"],
      ["a.ts", "c.ts"],
    );
    expect(result).toEqual({
      hasV2Prediction: true,
      predicted: 2,
      actual: 2,
      intersection: 1,
      missed: ["b.ts"],
      unexpected: ["c.ts"],
    });
  });

  it("returns intersection equal to length when prediction is perfect", () => {
    const result = computeAffectedFilesPredictionQuality(
      ["a.ts", "b.ts"],
      ["a.ts", "b.ts"],
    );
    expect(result.intersection).toBe(2);
    expect(result.missed).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });

  it("returns zero intersection when prediction is a complete miss", () => {
    const result = computeAffectedFilesPredictionQuality(
      ["a.ts", "b.ts"],
      ["x.ts", "y.ts"],
    );
    expect(result.intersection).toBe(0);
    expect(result.missed.sort()).toEqual(["a.ts", "b.ts"]);
    expect(result.unexpected.sort()).toEqual(["x.ts", "y.ts"]);
  });

  it("handles both inputs empty", () => {
    const result = computeAffectedFilesPredictionQuality([], []);
    expect(result).toEqual({
      hasV2Prediction: true,
      predicted: 0,
      actual: 0,
      intersection: 0,
      missed: [],
      unexpected: [],
    });
  });

  it("deduplicates within each input (paths repeated count once)", () => {
    const result = computeAffectedFilesPredictionQuality(
      ["a.ts", "a.ts", "b.ts"],
      ["a.ts", "c.ts", "c.ts"],
    );
    expect(result.predicted).toBe(2);
    expect(result.actual).toBe(2);
    expect(result.intersection).toBe(1);
    expect(result.missed).toEqual(["b.ts"]);
    expect(result.unexpected).toEqual(["c.ts"]);
  });

  it("returns the missed/unexpected arrays in deterministic order", () => {
    const r1 = computeAffectedFilesPredictionQuality(
      ["b.ts", "a.ts"],
      ["c.ts", "d.ts"],
    );
    const r2 = computeAffectedFilesPredictionQuality(
      ["a.ts", "b.ts"],
      ["d.ts", "c.ts"],
    );
    expect(r1.missed).toEqual(r2.missed);
    expect(r1.unexpected).toEqual(r2.unexpected);
  });
});

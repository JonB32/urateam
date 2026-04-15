import { describe, it, expect } from "vitest";
import { evaluateCostGate } from "../../policy/cost-gate.js";

describe("evaluateCostGate", () => {
  it("returns null when no limit configured", () => {
    expect(evaluateCostGate(999999, undefined, "implement")).toBeNull();
  });

  it("returns null when tokens under limit", () => {
    expect(evaluateCostGate(50, 100, "implement")).toBeNull();
  });

  it("returns null when tokens equal limit", () => {
    expect(evaluateCostGate(100, 100, "implement")).toBeNull();
  });

  it("returns violation when tokens exceed limit", () => {
    const v = evaluateCostGate(101, 100, "implement");
    expect(v).not.toBeNull();
    expect(v!.gate).toBe("cost");
    expect(v!.detail).toContain("101");
    expect(v!.detail).toContain("100");
    expect(v!.detail).toContain("implement");
    expect(v!.payload).toMatchObject({ tokensUsed: 101, limit: 100, stage: "implement" });
  });

  it("includes stage in violation payload", () => {
    const v = evaluateCostGate(500, 100, "review");
    expect(v!.payload.stage).toBe("review");
  });
});

import { describe, it, expect } from "vitest";
import {
  getEnabledProviders,
  type ReviewProvider,
  type ReviewModelRun,
  type ReviewContext,
} from "../executor/review/review-provider.js";

describe("review-provider registry", () => {
  it("exports the ReviewProvider interface and ReviewModelRun type", () => {
    // Compile-time existence check via type assignment
    const _checkRun: ReviewModelRun = {
      modelId: "x",
      providerId: "agentic",
      status: "completed",
      findings: [],
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    };
    expect(_checkRun.modelId).toBe("x");
  });

  it("returns at least the agentic provider when env is empty", () => {
    const providers = getEnabledProviders({});
    expect(providers.length).toBeGreaterThanOrEqual(1);
    expect(providers.some((p) => p.id === "agentic")).toBe(true);
  });

  it("ReviewProvider has runReview signature", () => {
    const providers = getEnabledProviders({});
    const p: ReviewProvider = providers[0];
    expect(typeof p.runReview).toBe("function");
  });
});

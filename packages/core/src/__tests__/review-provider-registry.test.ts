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

describe("review-provider registry — fanout selection", () => {
  it("returns only agentic when REVIEW_MODELS unset", () => {
    const ps = getEnabledProviders({});
    expect(ps.map((p) => p.id)).toEqual(["agentic"]);
  });

  it("adds openrouter when both vars set", () => {
    const ps = getEnabledProviders({
      REVIEW_MODELS: "anthropic/claude-3.5-sonnet,openai/gpt-4o",
      OPENROUTER_API_KEY: "sk-or-x",
    });
    expect(ps.map((p) => p.id).sort()).toEqual(["agentic", "openrouter"]);
  });

  it("throws when REVIEW_MODELS set but OPENROUTER_API_KEY missing", () => {
    expect(() => getEnabledProviders({ REVIEW_MODELS: "x/y" })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it("throws when OPENROUTER_API_KEY set but REVIEW_MODELS missing", () => {
    expect(() => getEnabledProviders({ OPENROUTER_API_KEY: "sk" })).toThrow(
      /REVIEW_MODELS/,
    );
  });

  it("treats whitespace-only REVIEW_MODELS as unset (and throws since OPENROUTER_API_KEY is set without effective models)", () => {
    expect(() =>
      getEnabledProviders({ REVIEW_MODELS: " , , ", OPENROUTER_API_KEY: "sk" }),
    ).toThrow(/REVIEW_MODELS/);
  });

  it("trims whitespace and drops empty entries from REVIEW_MODELS", () => {
    const ps = getEnabledProviders({
      REVIEW_MODELS: " m1 , , m2 ,",
      OPENROUTER_API_KEY: "sk",
    });
    const fanout = ps.find((p) => p.id === "openrouter");
    expect(fanout).toBeDefined();
    // White-box: read the configured models off the provider.
    const models = (fanout as unknown as { cfg: { models: string[] } }).cfg.models;
    expect(models).toEqual(["m1", "m2"]);
  });

  describe("BEC-164 REVIEW_MODELS_MAX_OUTPUT_TOKENS env parsing", () => {
    function fanoutCfg(env: NodeJS.ProcessEnv) {
      const ps = getEnabledProviders(env);
      const fanout = ps.find((p) => p.id === "openrouter");
      return (fanout as unknown as { cfg: { maxOutputTokens?: number } }).cfg;
    }

    it("when env unset, maxOutputTokens is undefined (preserves model default)", () => {
      const cfg = fanoutCfg({ REVIEW_MODELS: "m1", OPENROUTER_API_KEY: "sk" });
      expect(cfg.maxOutputTokens).toBeUndefined();
    });

    it("when set to a positive integer, parses as number", () => {
      const cfg = fanoutCfg({
        REVIEW_MODELS: "m1",
        OPENROUTER_API_KEY: "sk",
        REVIEW_MODELS_MAX_OUTPUT_TOKENS: "4000",
      });
      expect(cfg.maxOutputTokens).toBe(4000);
    });

    it("invalid input (zero / negative / non-numeric) → undefined (caller's chatCompletion gets no maxTokens)", () => {
      expect(
        fanoutCfg({ REVIEW_MODELS: "m1", OPENROUTER_API_KEY: "sk", REVIEW_MODELS_MAX_OUTPUT_TOKENS: "0" }).maxOutputTokens,
      ).toBeUndefined();
      expect(
        fanoutCfg({ REVIEW_MODELS: "m1", OPENROUTER_API_KEY: "sk", REVIEW_MODELS_MAX_OUTPUT_TOKENS: "-1" }).maxOutputTokens,
      ).toBeUndefined();
      expect(
        fanoutCfg({ REVIEW_MODELS: "m1", OPENROUTER_API_KEY: "sk", REVIEW_MODELS_MAX_OUTPUT_TOKENS: "lots" }).maxOutputTokens,
      ).toBeUndefined();
    });
  });
});

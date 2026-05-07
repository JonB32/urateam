import { describe, it, expect, vi } from "vitest";
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

    describe("floor warn (BEC-164 follow-up — surface misconfigurations loudly)", () => {
      // Captures pino stdout writes so we can assert a warn fires when the
      // configured cap is suspiciously small. The original BEC-164 fix made
      // `=1` parse correctly, but a typo would silently produce truncated
      // garbage on every model — the same zero-findings symptom BEC-164 was
      // meant to fix, just from a different cause. Sonnet review on PR #174.
      function captureFanoutCfgWithStdout(env: NodeJS.ProcessEnv): { cfg: { maxOutputTokens?: number }; logs: string[] } {
        const writes: string[] = [];
        const orig = process.stdout.write.bind(process.stdout);
        const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
          writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
          return true;
        });
        try {
          const ps = getEnabledProviders(env);
          const fanout = ps.find((p) => p.id === "openrouter");
          const cfg = (fanout as unknown as { cfg: { maxOutputTokens?: number } }).cfg;
          return { cfg, logs: writes };
        } finally {
          spy.mockRestore();
          writes.forEach((w) => orig(w));
        }
      }

      it("emits a warn when value is set but below the sane floor (256)", () => {
        const { cfg, logs } = captureFanoutCfgWithStdout({
          REVIEW_MODELS: "m1",
          OPENROUTER_API_KEY: "sk",
          REVIEW_MODELS_MAX_OUTPUT_TOKENS: "10",
        });
        // Behavior preserved — operator's intent is honored, cap is set to 10.
        expect(cfg.maxOutputTokens).toBe(10);
        // Visibility: a warn line surfaces the misconfiguration.
        const warnLine = logs.find((l) =>
          /maxOutputTokens|REVIEW_MODELS_MAX_OUTPUT_TOKENS/.test(l) && /floor|too.small|below/i.test(l),
        );
        expect(warnLine, `expected a floor-warn line; got ${JSON.stringify(logs)}`).toBeDefined();
      });

      it("does NOT warn when value is at or above the floor", () => {
        const { cfg, logs } = captureFanoutCfgWithStdout({
          REVIEW_MODELS: "m1",
          OPENROUTER_API_KEY: "sk",
          REVIEW_MODELS_MAX_OUTPUT_TOKENS: "256",
        });
        expect(cfg.maxOutputTokens).toBe(256);
        expect(logs.find((l) => /maxOutputTokens.*floor|too.small/i.test(l))).toBeUndefined();
      });

      it("does NOT warn when value is unset", () => {
        const { logs } = captureFanoutCfgWithStdout({
          REVIEW_MODELS: "m1",
          OPENROUTER_API_KEY: "sk",
        });
        expect(logs.find((l) => /maxOutputTokens.*floor|too.small/i.test(l))).toBeUndefined();
      });
    });
  });
});

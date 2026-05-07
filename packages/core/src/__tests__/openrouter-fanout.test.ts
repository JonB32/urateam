import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HandoffArtifact } from "../types.js";

const chatCompletion = vi.fn();
vi.mock("../executor/review/openrouter-client.js", () => ({
  OpenRouterClient: class {
    chatCompletion = chatCompletion;
  },
}));
// Stub git diff + file collection so test does not need a real workdir
vi.mock("../executor/review/workdir-snapshot.js", () => ({
  collectWorkdirSnapshot: async () => ({
    diff: "diff --git a/x b/x\n+y",
    files: [{ path: "x", body: "y" }],
  }),
}));

const handoff: HandoffArtifact = {
  runId: "r1",
  issueId: "i1",
  stage: "review",
  timestamp: "2026-04-30T00:00:00Z",
  summary: "",
  filesChanged: ["x"],
  approach: "",
  context: { issueIntent: "do x", constraints: [], assumptions: [] },
  tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 },
};

const ctx = () => ({
  runId: "r1",
  stageRunId: "s1",
  workdir: "/tmp/wd",
  handoff,
  baseRef: "main",
  prNumber: 42,
});

describe("OpenRouterFanoutProvider", () => {
  beforeEach(() => { chatCompletion.mockReset(); });

  const validJson = `{"findings":[{"severity":"warning","file":"a","line":1,"category":"quality","description":"d","fix":"f"}]}`;

  it("runs N parallel calls and returns one ReviewModelRun per model", async () => {
    chatCompletion.mockResolvedValue({ content: validJson, inputTokens: 10, outputTokens: 5 });
    const { OpenRouterFanoutProvider } = await import(
      "../executor/review/openrouter-fanout.js"
    );
    const p = new OpenRouterFanoutProvider({
      apiKey: "k",
      baseUrl: "https://x/api/v1",
      models: ["m1", "m2", "m3"],
      timeoutMs: 1000,
      maxInputTokens: 100_000,
    });
    const runs = await p.runReview(ctx());
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.modelId).sort()).toEqual(["m1", "m2", "m3"]);
    expect(runs.every((r) => r.status === "completed")).toBe(true);
    expect(chatCompletion).toHaveBeenCalledTimes(3);
  });

  it("partial failure: one model rejects, others complete", async () => {
    chatCompletion
      .mockResolvedValueOnce({ content: validJson, inputTokens: 1, outputTokens: 1 })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ content: validJson, inputTokens: 1, outputTokens: 1 });
    const { OpenRouterFanoutProvider } = await import(
      "../executor/review/openrouter-fanout.js"
    );
    const p = new OpenRouterFanoutProvider({
      apiKey: "k", baseUrl: "https://x/api/v1",
      models: ["m1", "m2", "m3"], timeoutMs: 1000, maxInputTokens: 100_000,
    });
    const runs = await p.runReview(ctx());
    const failed = runs.filter((r) => r.status === "failed");
    const ok = runs.filter((r) => r.status === "completed");
    expect(failed).toHaveLength(1);
    expect(failed[0].errorMessage).toContain("boom");
    expect(ok).toHaveLength(2);
  });

  it("malformed JSON output → run completed with raw output preserved (BEC-158 fallback)", async () => {
    // BEC-158 contract: when the model emits prose that doesn't parse as
    // structured findings, the run should NOT be marked failed. Instead, the
    // raw content is preserved on `rawOutput` so post-fanout-comments can
    // post it as a fallback advisory comment. A parser exception ≠ provider
    // failure; the API call succeeded and we paid for it.
    chatCompletion.mockResolvedValue({ content: "not json", inputTokens: 1, outputTokens: 1 });
    const { OpenRouterFanoutProvider } = await import(
      "../executor/review/openrouter-fanout.js"
    );
    const p = new OpenRouterFanoutProvider({
      apiKey: "k", baseUrl: "https://x/api/v1",
      models: ["m1"], timeoutMs: 1000, maxInputTokens: 100_000,
    });
    const runs = await p.runReview(ctx());
    expect(runs[0].status).toBe("completed");
    expect(runs[0].findings).toEqual([]);
    expect(runs[0].rawOutput).toBe("not json");
    expect(runs[0].errorMessage).toBeUndefined();
  });

  it("all models fail → returns N failed runs (does not throw)", async () => {
    chatCompletion.mockRejectedValue(new Error("dead"));
    const { OpenRouterFanoutProvider } = await import(
      "../executor/review/openrouter-fanout.js"
    );
    const p = new OpenRouterFanoutProvider({
      apiKey: "k", baseUrl: "https://x/api/v1",
      models: ["m1", "m2"], timeoutMs: 1000, maxInputTokens: 100_000,
    });
    const runs = await p.runReview(ctx());
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "failed")).toBe(true);
  });

  describe("BEC-164 maxOutputTokens config", () => {
    it("when unset, no max_tokens is forwarded to chatCompletion (preserves model default)", async () => {
      chatCompletion.mockResolvedValue({ content: validJson, inputTokens: 1, outputTokens: 1 });
      const { OpenRouterFanoutProvider } = await import(
        "../executor/review/openrouter-fanout.js"
      );
      const p = new OpenRouterFanoutProvider({
        apiKey: "k", baseUrl: "https://x/api/v1",
        models: ["m1"], timeoutMs: 1000, maxInputTokens: 100_000,
        // maxOutputTokens intentionally omitted
      });
      await p.runReview(ctx());
      const opts = chatCompletion.mock.calls[0][2];
      expect(opts.maxTokens).toBeUndefined();
    });

    it("when set, maxTokens is forwarded so OpenRouter sends max_tokens in the request body", async () => {
      chatCompletion.mockResolvedValue({ content: validJson, inputTokens: 1, outputTokens: 1 });
      const { OpenRouterFanoutProvider } = await import(
        "../executor/review/openrouter-fanout.js"
      );
      const p = new OpenRouterFanoutProvider({
        apiKey: "k", baseUrl: "https://x/api/v1",
        models: ["m1", "m2"], timeoutMs: 1000, maxInputTokens: 100_000,
        maxOutputTokens: 4000,
      });
      await p.runReview(ctx());
      // Both parallel calls receive the cap.
      expect(chatCompletion.mock.calls[0][2].maxTokens).toBe(4000);
      expect(chatCompletion.mock.calls[1][2].maxTokens).toBe(4000);
    });
  });
});

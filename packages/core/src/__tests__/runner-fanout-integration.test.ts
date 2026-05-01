import { describe, it, expect, vi, beforeEach } from "vitest";

const { fanoutRunReview, agenticRunReview, insertReviewModelRunsMock, postFanoutCommentsToPRMock } = vi.hoisted(() => ({
  fanoutRunReview: vi.fn(),
  agenticRunReview: vi.fn(),
  insertReviewModelRunsMock: vi.fn(),
  postFanoutCommentsToPRMock: vi.fn(),
}));

vi.mock("../executor/review/review-provider.js", async (orig) => {
  const real = await orig<typeof import("../executor/review/review-provider.js")>();
  return {
    ...real,
    getEnabledProviders: () => [
      { id: "agentic", runReview: agenticRunReview },
      { id: "openrouter", runReview: fanoutRunReview },
    ],
  };
});
vi.mock("../db/review-model-runs.js", () => ({
  insertReviewModelRuns: insertReviewModelRunsMock,
}));
vi.mock("../executor/review/post-fanout-comments.js", () => ({
  postFanoutCommentsToPR: postFanoutCommentsToPRMock,
}));

describe("runner fanout integration", () => {
  beforeEach(() => {
    fanoutRunReview.mockReset();
    agenticRunReview.mockReset();
    insertReviewModelRunsMock.mockReset();
    postFanoutCommentsToPRMock.mockReset();
  });

  it("runs fanout once per stage execution and posts comments", async () => {
    fanoutRunReview.mockResolvedValue([
      {
        modelId: "anthropic/claude-3.5-sonnet",
        providerId: "openrouter",
        status: "completed",
        findings: [],
        inputTokens: 1, outputTokens: 1, durationMs: 1,
      },
    ]);
    agenticRunReview.mockResolvedValue([
      {
        modelId: "claude-haiku-4-5-20251001",
        providerId: "agentic",
        status: "completed",
        findings: [],
        inputTokens: 1, outputTokens: 1, durationMs: 1,
      },
    ]);

    const { runReviewProviders } = await import("../pipeline/review-providers-runner.js");
    const ctx = {
      runId: "r1", stageRunId: "s1", workdir: "/tmp/x",
      handoff: { runId: "r1", issueId: "i1", stage: "review", timestamp: "",
        summary: "", filesChanged: [], approach: "",
        context: { issueIntent: "x", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 } },
      baseRef: "main", prNumber: 42,
    };
    const result = await runReviewProviders(ctx, {
      env: { REVIEW_MODELS: "anthropic/claude-3.5-sonnet", OPENROUTER_API_KEY: "sk-or" },
      db: {} as never,
      octokit: {} as never,
      owner: "o",
      repo: "r",
    });

    expect(agenticRunReview).toHaveBeenCalledOnce();
    expect(fanoutRunReview).toHaveBeenCalledOnce();
    expect(insertReviewModelRunsMock).toHaveBeenCalledOnce();
    const persisted = insertReviewModelRunsMock.mock.calls[0][2] as Array<{ providerId: string }>;
    expect(persisted).toHaveLength(2);
    expect(postFanoutCommentsToPRMock).toHaveBeenCalledOnce();
    const postedRuns = postFanoutCommentsToPRMock.mock.calls[0][4] as Array<{ providerId: string }>;
    expect(postedRuns.every((r) => r.providerId === "openrouter")).toBe(true);
    expect(result.agenticFindings).toHaveLength(0);
    expect(result.totalInputTokens).toBe(2);
    expect(result.totalOutputTokens).toBe(2);
  });

  it("does not post comments when prNumber is null", async () => {
    fanoutRunReview.mockResolvedValue([]);
    agenticRunReview.mockResolvedValue([]);
    const { runReviewProviders } = await import("../pipeline/review-providers-runner.js");
    await runReviewProviders(
      { runId: "r1", stageRunId: "s1", workdir: "/tmp/x",
        handoff: { runId: "r1", issueId: "i1", stage: "review", timestamp: "",
          summary: "", filesChanged: [], approach: "",
          context: { issueIntent: "x", constraints: [], assumptions: [] },
          tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 } },
        baseRef: "main", prNumber: null },
      { env: {}, db: {} as never, octokit: {} as never, owner: "o", repo: "r" },
    );
    expect(postFanoutCommentsToPRMock).not.toHaveBeenCalled();
  });

  it("does not throw if fanout provider rejects (best-effort)", async () => {
    agenticRunReview.mockResolvedValue([
      { modelId: "claude-haiku-4-5-20251001", providerId: "agentic", status: "completed",
        findings: [], inputTokens: 0, outputTokens: 0, durationMs: 0 },
    ]);
    fanoutRunReview.mockRejectedValue(new Error("network gone"));
    const { runReviewProviders } = await import("../pipeline/review-providers-runner.js");
    const result = await runReviewProviders(
      { runId: "r1", stageRunId: "s1", workdir: "/tmp/x",
        handoff: { runId: "r1", issueId: "i1", stage: "review", timestamp: "",
          summary: "", filesChanged: [], approach: "",
          context: { issueIntent: "x", constraints: [], assumptions: [] },
          tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 } },
        baseRef: "main", prNumber: 1 },
      { env: { REVIEW_MODELS: "x", OPENROUTER_API_KEY: "k" },
        db: {} as never, octokit: {} as never, owner: "o", repo: "r" },
    );
    expect(result.agenticFindings).toEqual([]);
  });
});

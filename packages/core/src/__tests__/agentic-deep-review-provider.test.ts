import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HandoffArtifact } from "../types.js";

const runDeepReviewMock = vi.fn();
vi.mock("../executor/deep-review.js", () => ({
  runDeepReview: (...args: unknown[]) => runDeepReviewMock(...args),
  deepFindingsToReviewFindings: (findings: unknown[]) => findings,
}));

const makeHandoff = (): HandoffArtifact => ({
  runId: "r1",
  issueId: "i1",
  stage: "review",
  timestamp: new Date().toISOString(),
  summary: "",
  filesChanged: [],
  approach: "",
  context: { issueIntent: "do x", constraints: [], assumptions: [] },
  tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 },
});

describe("AgenticDeepReviewProvider", () => {
  beforeEach(() => { runDeepReviewMock.mockReset(); });

  it("returns a single ReviewModelRun with completed status on success", async () => {
    runDeepReviewMock.mockResolvedValue({
      findings: [
        { severity: "warning", file: "a.ts", line: 1, category: "x", description: "d", fix: "f" },
      ],
      inputTokens: 100,
      outputTokens: 50,
    });

    const { AgenticDeepReviewProvider } = await import(
      "../executor/review/agentic-deep-review.js"
    );
    const provider = new AgenticDeepReviewProvider();

    const runs = await provider.runReview({
      runId: "r1",
      stageRunId: "s1",
      workdir: "/tmp/x",
      handoff: makeHandoff(),
      baseRef: "main",
      prNumber: null,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0].providerId).toBe("agentic");
    expect(runs[0].status).toBe("completed");
    expect(runs[0].modelId).toBe("claude-haiku-4-5-20251001");
    expect(runs[0].findings).toHaveLength(1);
    expect(runs[0].inputTokens).toBe(100);
    expect(runs[0].outputTokens).toBe(50);
    expect(runDeepReviewMock).toHaveBeenCalledOnce();
  });

  it("returns failed run with errorMessage when runDeepReview throws", async () => {
    runDeepReviewMock.mockRejectedValue(new Error("agent sdk down"));
    const { AgenticDeepReviewProvider } = await import(
      "../executor/review/agentic-deep-review.js"
    );
    const provider = new AgenticDeepReviewProvider();

    const runs = await provider.runReview({
      runId: "r1",
      stageRunId: "s1",
      workdir: "/tmp/x",
      handoff: makeHandoff(),
      baseRef: "main",
      prNumber: null,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].errorMessage).toContain("agent sdk down");
    expect(runs[0].findings).toHaveLength(0);
  });
});

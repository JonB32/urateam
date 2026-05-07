import { describe, it, expect, vi } from "vitest";
import { CompositeNotifier } from "../notifier/composite.js";
import { LinearNotifier } from "../notifier/linear.js";
import type { Notifier, PipelineRun, StageResult, PipelineResult, PipelineError } from "../types.js";

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "run-12345678-abcd",
    issueId: "TEAM-123",
    issueTitle: "Fix login bug",
    pipelineKey: "auto-implement",
    repoUrl: "https://github.com/org/repo",
    branch: "fix/login-bug",
    status: "running",
    startedAt: new Date("2026-01-01"),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ...overrides,
  };
}

function makeStageResult(overrides: Partial<StageResult> = {}): StageResult {
  return {
    status: "completed",
    inputTokens: 1000,
    outputTokens: 500,
    turns: 5,
    stageRunId: "test-stage-run-id",
    ...overrides,
  };
}

function makePipelineResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    prUrl: "https://github.com/org/repo/pull/42",
    totalInputTokens: 5000,
    totalOutputTokens: 2500,
    stagesCompleted: 3,
    ...overrides,
  };
}

function makePipelineError(overrides: Partial<PipelineError> = {}): PipelineError {
  return {
    stage: "test",
    message: "Tests failed after retries",
    retriesExhausted: true,
    ...overrides,
  };
}

function createMockNotifier(): Notifier {
  return {
    onPipelineStart: vi.fn().mockResolvedValue(undefined),
    onStageComplete: vi.fn().mockResolvedValue(undefined),
    onPipelineComplete: vi.fn().mockResolvedValue(undefined),
    onPipelineFailed: vi.fn().mockResolvedValue(undefined),
  };
}

describe("CompositeNotifier", () => {
  it("calls all notifiers on each event", async () => {
    const n1 = createMockNotifier();
    const n2 = createMockNotifier();
    const composite = new CompositeNotifier([n1, n2]);
    const run = makeRun();
    const stageResult = makeStageResult();
    const pipelineResult = makePipelineResult();
    const pipelineError = makePipelineError();

    await composite.onPipelineStart(run);
    expect(n1.onPipelineStart).toHaveBeenCalledWith(run);
    expect(n2.onPipelineStart).toHaveBeenCalledWith(run);

    await composite.onStageComplete(run, "implement", stageResult);
    expect(n1.onStageComplete).toHaveBeenCalledWith(run, "implement", stageResult);
    expect(n2.onStageComplete).toHaveBeenCalledWith(run, "implement", stageResult);

    await composite.onPipelineComplete(run, pipelineResult);
    expect(n1.onPipelineComplete).toHaveBeenCalledWith(run, pipelineResult);
    expect(n2.onPipelineComplete).toHaveBeenCalledWith(run, pipelineResult);

    await composite.onPipelineFailed(run, pipelineError);
    expect(n1.onPipelineFailed).toHaveBeenCalledWith(run, pipelineError);
    expect(n2.onPipelineFailed).toHaveBeenCalledWith(run, pipelineError);
  });

  it("does not throw when one notifier fails (Promise.allSettled)", async () => {
    const failing: Notifier = {
      onPipelineStart: vi.fn().mockRejectedValue(new Error("boom")),
      onStageComplete: vi.fn().mockRejectedValue(new Error("boom")),
      onPipelineComplete: vi.fn().mockRejectedValue(new Error("boom")),
      onPipelineFailed: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const passing = createMockNotifier();
    const composite = new CompositeNotifier([failing, passing]);
    const run = makeRun();

    await expect(composite.onPipelineStart(run)).resolves.toBeUndefined();
    expect(passing.onPipelineStart).toHaveBeenCalledWith(run);

    await expect(composite.onStageComplete(run, "test", makeStageResult())).resolves.toBeUndefined();
    await expect(composite.onPipelineComplete(run, makePipelineResult())).resolves.toBeUndefined();
    await expect(composite.onPipelineFailed(run, makePipelineError())).resolves.toBeUndefined();
  });

  it("handles empty notifier list", async () => {
    const composite = new CompositeNotifier([]);
    const run = makeRun();

    await expect(composite.onPipelineStart(run)).resolves.toBeUndefined();
    await expect(composite.onStageComplete(run, "test", makeStageResult())).resolves.toBeUndefined();
    await expect(composite.onPipelineComplete(run, makePipelineResult())).resolves.toBeUndefined();
    await expect(composite.onPipelineFailed(run, makePipelineError())).resolves.toBeUndefined();
  });
});

describe("LinearNotifier", () => {
  // We test formatting by subclassing and capturing calls to postComment/transitionState
  class TestableLinearNotifier extends LinearNotifier {
    public comments: { issueId: string; body: string }[] = [];
    public transitions: { issueId: string; stateName: string }[] = [];

    // Override private methods via prototype trick — use any cast
    constructor() {
      super({ apiKey: "test-key" });
      // Patch private methods
      (this as any).postComment = async (issueId: string, body: string) => {
        this.comments.push({ issueId, body });
      };
      (this as any).transitionState = async (issueId: string, stateName: string) => {
        this.transitions.push({ issueId, stateName });
      };
    }
  }

  it("formats start comment correctly", async () => {
    const notifier = new TestableLinearNotifier();
    const run = makeRun();

    await notifier.onPipelineStart(run);

    expect(notifier.comments).toHaveLength(1);
    const body = notifier.comments[0].body;
    expect(body).toContain("Agent Run #run-1234");
    expect(body).toContain("auto-implement");
    expect(body).toContain("fix/login-bug");
    expect(body).toContain("https://github.com/org/repo");
    expect(body).toContain("Starting pipeline...");
    expect(notifier.comments[0].issueId).toBe("TEAM-123");
    expect(notifier.transitions).toEqual([{ issueId: "TEAM-123", stateName: "In Progress" }]);
  });

  it("formats stage complete comment correctly", async () => {
    const notifier = new TestableLinearNotifier();
    const run = makeRun();
    const result = makeStageResult({
      handoffArtifact: {
        runId: "run-123",
        issueId: "TEAM-123",
        stage: "implement",
        timestamp: "2026-01-01T00:00:00Z",
        summary: "Implemented fix",
        filesChanged: ["src/auth.ts", "src/login.ts"],
        approach: "Direct fix",
        context: {
          issueIntent: "Fix login",
          constraints: [],
          assumptions: [],
          testResults: { passed: 10, failed: 2 },
        },
        tokenBudget: { contextTokensUsed: 500, recommendedMaxTurns: 10 },
      },
    });

    await notifier.onStageComplete(run, "implement", result);

    expect(notifier.comments).toHaveLength(1);
    const body = notifier.comments[0].body;
    expect(body).toContain("Stage: implement");
    expect(body).toContain("src/auth.ts, src/login.ts");
    expect(body).toContain("10 passed, 2 failed");
    expect(body).toContain("1,000 input");
    expect(body).toContain("500 output");
  });

  it("formats pipeline complete comment correctly (no auto-merge) and transitions to In Review", async () => {
    const notifier = new TestableLinearNotifier();
    const run = makeRun();
    const result = makePipelineResult();

    await notifier.onPipelineComplete(run, result);

    expect(notifier.comments).toHaveLength(1);
    const body = notifier.comments[0].body;
    expect(body).toContain("Pipeline Complete");
    expect(body).toContain("https://github.com/org/repo/pull/42");
    expect(body).toContain("3");
    // BEC-165: any pipeline that ends with a PR but isn't auto-merged must
    // transition to "In Review". Previously this responsibility was delegated
    // to onHumanReviewNeeded — but not every PR-creating runner path calls it
    // (auto-implement with autoMerge:false skips both onHumanReviewNeeded and
    // any state-transition path), leaving Linear stuck on "In Progress" → the
    // recover-stuck → re-run loop documented in BEC-165.
    expect(notifier.transitions).toEqual([{ issueId: "TEAM-123", stateName: "In Review" }]);
  });

  it("BEC-165: pipeline complete without PR (rare) does not transition state", async () => {
    const notifier = new TestableLinearNotifier();
    const run = makeRun();
    // The PipelineResult type declares prUrl as required string; runner.ts
    // passes "" or a real URL. Empty string is the "no PR opened" signal that
    // the production callsite uses (`if (result.prUrl)` falsy check).
    const result = { ...makePipelineResult(), prUrl: "" };

    await notifier.onPipelineComplete(run, result);

    // No PR opened (e.g. no-op run, hard failure earlier) — leave state alone
    // so a separate failure-handler path can decide.
    expect(notifier.transitions).toEqual([]);
  });

  it("transitions to Done when auto-merged", async () => {
    const notifier = new TestableLinearNotifier();
    const run = makeRun();
    const result = { ...makePipelineResult(), autoMerged: true };

    await notifier.onPipelineComplete(run, result);

    expect(notifier.transitions).toEqual([{ issueId: "TEAM-123", stateName: "Done" }]);
    expect(notifier.comments[0].body).toContain("Auto-merged");
  });

  it("onHumanReviewNeeded transitions to In Review", async () => {
    const notifier = new TestableLinearNotifier();
    const run = makeRun();

    await notifier.onHumanReviewNeeded(run, "https://github.com/pr/1", "Diff too large");

    expect(notifier.transitions).toEqual([{ issueId: "TEAM-123", stateName: "In Review" }]);
    expect(notifier.comments[0].body).toContain("Human Review Needed");
    expect(notifier.comments[0].body).toContain("Diff too large");
  });

  it("formats pipeline failed comment correctly", async () => {
    const notifier = new TestableLinearNotifier();
    const run = makeRun();
    const error = makePipelineError();

    await notifier.onPipelineFailed(run, error);

    expect(notifier.comments).toHaveLength(1);
    const body = notifier.comments[0].body;
    expect(body).toContain("Pipeline Failed");
    expect(body).toContain("test");
    expect(body).toContain("Tests failed after retries");
    expect(body).toContain("Yes");
    expect(notifier.transitions).toEqual([{ issueId: "TEAM-123", stateName: "Blocked" }]);
  });

  it("constructs without throwing", () => {
    expect(() => new LinearNotifier({ apiKey: "test-key" })).not.toThrow();
  });
});

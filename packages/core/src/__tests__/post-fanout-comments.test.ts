import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReviewModelRun } from "../executor/review/review-provider.js";

const { addPRComment } = vi.hoisted(() => ({ addPRComment: vi.fn() }));
vi.mock("../repo/github.js", () => ({ addPRComment }));

const completedRun: ReviewModelRun = {
  modelId: "anthropic/claude-3.5-sonnet",
  providerId: "openrouter",
  status: "completed",
  findings: [
    { severity: "warning", file: "a.ts", line: 1, category: "quality", description: "d", fix: "f" },
  ],
  inputTokens: 100,
  outputTokens: 50,
  durationMs: 1000,
};

const failedRun: ReviewModelRun = {
  modelId: "openai/gpt-4o",
  providerId: "openrouter",
  status: "failed",
  findings: [],
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 200,
  errorMessage: "rate limited",
};

const rawOutputRun: ReviewModelRun = {
  modelId: "google/gemini-2.5-pro",
  providerId: "openrouter",
  status: "completed",
  findings: [],
  rawOutput: "This is plain prose from the model. It looks good overall, but watch out for the N+1 query in service.ts.",
  inputTokens: 80,
  outputTokens: 40,
  durationMs: 800,
};

describe("postFanoutCommentsToPR", () => {
  beforeEach(() => {
    addPRComment.mockReset();
  });

  it("posts one comment per run with model id and findings table", async () => {
    addPRComment.mockResolvedValue(undefined);
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );
    await postFanoutCommentsToPR({} as never, "owner", "repo", 42, [completedRun]);
    expect(addPRComment).toHaveBeenCalledOnce();
    const body = (addPRComment.mock.calls[0][4] as string);
    expect(body).toContain("anthropic/claude-3.5-sonnet");
    expect(body).toContain("Status: completed");
    expect(body).toContain("warning");
    expect(body).toContain("a.ts");
    expect(body).toContain("Advisory only");
  });

  it("posts a 'failed' comment with errorMessage", async () => {
    addPRComment.mockResolvedValue(undefined);
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );
    await postFanoutCommentsToPR({} as never, "o", "r", 1, [failedRun]);
    const body = (addPRComment.mock.calls[0][4] as string);
    expect(body).toContain("Status: failed");
    expect(body).toContain("rate limited");
  });

  it("notes truncated input when truncatedFiles > 0", async () => {
    addPRComment.mockResolvedValue(undefined);
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );
    await postFanoutCommentsToPR({} as never, "o", "r", 1, [
      { ...completedRun, truncatedFiles: 3 },
    ]);
    const body = (addPRComment.mock.calls[0][4] as string);
    expect(body).toContain("input truncated");
    expect(body).toContain("3");
  });

  it("escapes newlines and pipes in description cells", async () => {
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );
    const runWithNewline: ReviewModelRun = {
      ...completedRun,
      findings: [
        { severity: "warning", file: "a.ts", line: 1, category: "quality",
          description: "first line\nsecond line | with pipe", fix: "f" },
      ],
    };
    await postFanoutCommentsToPR({} as never, "o", "r", 1, [runWithNewline]);
    const body = (addPRComment.mock.calls[0][4] as string);
    expect(body).not.toMatch(/first line\nsecond line/);  // newline must be replaced
    expect(body).toContain("first line second line \\| with pipe");
  });

  it("continues posting remaining runs when one addPRComment rejects", async () => {
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );
    addPRComment
      .mockRejectedValueOnce(new Error("rate limit"))
      .mockResolvedValueOnce(undefined);

    // Should not throw
    await expect(
      postFanoutCommentsToPR({} as never, "o", "r", 1, [completedRun, failedRun]),
    ).resolves.toBeDefined();
    // Both addPRComment calls were attempted
    expect(addPRComment).toHaveBeenCalledTimes(2);
  });

  // BEC-158: fallback advisory comment when structured parse failed
  it("posts raw output as fallback advisory comment when structured parse failed", async () => {
    addPRComment.mockResolvedValue(undefined);
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );
    const result = await postFanoutCommentsToPR({} as never, "o", "r", 1, [rawOutputRun]);
    expect(addPRComment).toHaveBeenCalledOnce();
    const body = (addPRComment.mock.calls[0][4] as string);
    expect(body).toContain("google/gemini-2.5-pro");
    expect(body).toContain("raw output, structured parse failed");
    expect(body).toContain("plain prose from the model");
    expect(body).toContain("Advisory only");
    expect(result.fallbackCount).toBe(1);
  });

  it("returns fallbackCount=0 when all runs have structured findings", async () => {
    addPRComment.mockResolvedValue(undefined);
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );
    const result = await postFanoutCommentsToPR({} as never, "o", "r", 1, [completedRun]);
    expect(result.fallbackCount).toBe(0);
  });

  it("returns fallbackCount matching runs with rawOutput", async () => {
    addPRComment.mockResolvedValue(undefined);
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );
    const result = await postFanoutCommentsToPR({} as never, "o", "r", 1, [
      completedRun,
      rawOutputRun,
      failedRun,
    ]);
    expect(result.fallbackCount).toBe(1);
  });

  // BEC-168: suppress per-model PR comments when findings are empty AND no rawOutput
  it("suppresses empty-findings comments when findings=[] and no rawOutput; posts others", async () => {
    addPRComment.mockResolvedValue(undefined);
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );

    // Run 1: has findings → should post
    const runWithFindings: ReviewModelRun = {
      ...completedRun,
      modelId: "anthropic/claude-3.5-sonnet",
    };
    // Run 2: empty findings + rawOutput (BEC-158 fallback) → should post
    const runWithRawOutput: ReviewModelRun = {
      ...rawOutputRun,
      modelId: "google/gemini-2.5-pro",
    };
    // Run 3: empty findings, no rawOutput, completed → should be suppressed
    const emptyRun: ReviewModelRun = {
      modelId: "tencent/hy3-preview:free",
      providerId: "openrouter",
      status: "completed",
      findings: [],
      inputTokens: 2296,
      outputTokens: 1252,
      durationMs: 20500,
    };

    const result = await postFanoutCommentsToPR({} as never, "o", "r", 99, [
      runWithFindings,
      runWithRawOutput,
      emptyRun,
    ]);

    // Only 2 comments posted (findings run + rawOutput run); empty run suppressed
    expect(addPRComment).toHaveBeenCalledTimes(2);
    expect(result.suppressedEmptyCount).toBe(1);
    expect(result.fallbackCount).toBe(1);

    // Verify the two posted comments are for the right models
    const postedBodies = addPRComment.mock.calls.map((c) => c[4] as string);
    expect(postedBodies.some((b) => b.includes("anthropic/claude-3.5-sonnet"))).toBe(true);
    expect(postedBodies.some((b) => b.includes("google/gemini-2.5-pro"))).toBe(true);
    expect(postedBodies.some((b) => b.includes("tencent/hy3-preview:free"))).toBe(false);
  });

  it("does NOT suppress a failed run even when findings are empty", async () => {
    addPRComment.mockResolvedValue(undefined);
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );
    const result = await postFanoutCommentsToPR({} as never, "o", "r", 1, [failedRun]);
    expect(addPRComment).toHaveBeenCalledTimes(1);
    expect(result.suppressedEmptyCount).toBe(0);
  });

  it("returns suppressedEmptyCount=0 when all runs have findings or rawOutput", async () => {
    addPRComment.mockResolvedValue(undefined);
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );
    const result = await postFanoutCommentsToPR({} as never, "o", "r", 1, [completedRun, rawOutputRun]);
    expect(result.suppressedEmptyCount).toBe(0);
  });
});

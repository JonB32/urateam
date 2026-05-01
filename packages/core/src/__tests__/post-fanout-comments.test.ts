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
    ).resolves.toBeUndefined();
    // Both addPRComment calls were attempted
    expect(addPRComment).toHaveBeenCalledTimes(2);
  });
});

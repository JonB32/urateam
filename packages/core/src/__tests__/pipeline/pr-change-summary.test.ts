import { describe, it, expect } from "vitest";
import {
  renderChangeSummary,
  type ChangeSummaryInput,
} from "../../pipeline/pr-change-summary.js";
import type { HandoffArtifact } from "../../types.js";
import type { ReviewFeedbackComment } from "../../webhook/github-handler.js";

// Task 4 will add htmlUrl to ReviewFeedbackComment. Until then, extend locally.
type Cmt = ReviewFeedbackComment & { htmlUrl?: string };

const handoff: HandoffArtifact = {
  runId: "run_abc",
  issueId: "BEC-100",
  stage: "implement",
  timestamp: "2026-05-10T12:00:00Z",
  summary: "Addressed null-check + rename feedback.",
  filesChanged: ["src/foo.ts", "src/bar.ts", "src/__tests__/foo.test.ts"],
  approach: "Minimal changes to address the two reviewer comments.",
  context: {
    issueIntent: "Address PR review feedback",
    constraints: [],
    assumptions: [],
    // Task 3 will add addressedComments to the Zod schema; cast for now
    ...(({ addressedComments: [
      { commentId: "c-101", response: "Added null check before destructuring." },
      { commentId: "c-102", response: "Renamed `flag` → `isEnabled` per request." },
    ] }) as Record<string, unknown>),
  } as HandoffArtifact["context"] & { addressedComments?: { commentId: string; response: string }[] },
  tokenBudget: { contextTokensUsed: 5000, recommendedMaxTurns: 10 },
};

const triggeringComments: Cmt[] = [
  {
    commentId: "c-101",
    author: "alice",
    body: "Need a null check here.",
    filePath: "src/foo.ts",
    lineNumber: 42,
    htmlUrl: "https://github.com/o/r/pull/1#discussion_r101",
  },
  {
    commentId: "c-102",
    author: "bob",
    body: "Rename for clarity.",
    htmlUrl: "https://github.com/o/r/pull/1#issuecomment-102",
  },
];

const baseInput: ChangeSummaryInput = {
  handoff,
  run: { id: "run_abc", totalInputTokens: 1000, totalOutputTokens: 200 },
  triggeringComments: triggeringComments as ReviewFeedbackComment[],
  dashboardBaseUrl: "https://dogfood.urateams.com:8443",
};

describe("renderChangeSummary", () => {
  it("renders header + summary + per-comment responses + files + run link", () => {
    const out = renderChangeSummary(baseInput);
    expect(out).toContain("## 🤖 Addressed PR feedback");
    expect(out).toContain("Addressed null-check + rename feedback.");
    expect(out).toContain("**In response to:**");
    expect(out).toContain(
      "[@alice's comment on `src/foo.ts:42`](https://github.com/o/r/pull/1#discussion_r101)",
    );
    expect(out).toContain("Added null check before destructuring.");
    expect(out).toContain(
      "[@bob's general comment](https://github.com/o/r/pull/1#issuecomment-102)",
    );
    expect(out).toContain("Renamed `flag` → `isEnabled` per request.");
    expect(out).toContain("**Files changed:**");
    expect(out).toContain("- `src/foo.ts`");
    expect(out).toContain("- `src/bar.ts`");
    expect(out).toContain("- `src/__tests__/foo.test.ts`");
    expect(out).toContain(
      "[run_abc](https://dogfood.urateams.com:8443/runs/run_abc)",
    );
  });

  it("collapses multi-line summaries to a single line (newlines → spaces)", () => {
    const out = renderChangeSummary({
      ...baseInput,
      handoff: {
        ...handoff,
        summary: "Line one.\nLine two.\n\nLine three.",
      },
    });
    expect(out).toContain("Line one. Line two. Line three.");
    expect(out).not.toContain("Line one.\nLine two");
  });

  it("falls back gracefully when addressedComments is missing", () => {
    const out = renderChangeSummary({
      ...baseInput,
      handoff: {
        ...handoff,
        context: { ...handoff.context, addressedComments: undefined } as HandoffArtifact["context"] & { addressedComments?: { commentId: string; response: string }[] },
      },
    });
    expect(out).toContain("**In response to:**");
    expect(out).toContain(
      "[@alice's comment on `src/foo.ts:42`](https://github.com/o/r/pull/1#discussion_r101)",
    );
    // No response text follows the link
    expect(out).not.toContain("Added null check before destructuring.");
    expect(out).toContain("_(per-comment responses unavailable; see diff)_");
  });

  it("falls back gracefully when addressedComments is empty", () => {
    const out = renderChangeSummary({
      ...baseInput,
      handoff: {
        ...handoff,
        context: { ...handoff.context, addressedComments: [] } as HandoffArtifact["context"] & { addressedComments?: { commentId: string; response: string }[] },
      },
    });
    expect(out).toContain("_(per-comment responses unavailable; see diff)_");
  });

  it("drops addressedComments entries whose commentId is not in triggeringComments", () => {
    const out = renderChangeSummary({
      ...baseInput,
      handoff: {
        ...handoff,
        context: {
          ...handoff.context,
          addressedComments: [
            { commentId: "c-101", response: "Added null check." },
            { commentId: "c-FAKE", response: "This should not render." },
          ],
        } as HandoffArtifact["context"] & { addressedComments?: { commentId: string; response: string }[] },
      },
    });
    expect(out).toContain("Added null check.");
    expect(out).not.toContain("This should not render.");
  });

  it("renders triggering comments without responses when addressedComments has only a partial match", () => {
    const out = renderChangeSummary({
      ...baseInput,
      handoff: {
        ...handoff,
        context: {
          ...handoff.context,
          addressedComments: [
            { commentId: "c-101", response: "Did the thing." },
            // c-102 has no response
          ],
        } as HandoffArtifact["context"] & { addressedComments?: { commentId: string; response: string }[] },
      },
    });
    expect(out).toContain("Did the thing.");
    // c-102 link still present, but no response after it
    expect(out).toContain(
      "[@bob's general comment](https://github.com/o/r/pull/1#issuecomment-102)",
    );
    // The disclaimer line should NOT appear when at least one response is present
    expect(out).not.toContain(
      "_(per-comment responses unavailable; see diff)_",
    );
  });

  it("escapes markdown-special chars in author names and file paths", () => {
    const out = renderChangeSummary({
      ...baseInput,
      triggeringComments: [
        {
          commentId: "c-101",
          author: "evil*user[link](x)",
          body: "x",
          filePath: "src/[weird]_*name.ts",
          lineNumber: 5,
          htmlUrl: "https://github.com/o/r/pull/1#discussion_r101",
        } as ReviewFeedbackComment,
      ],
    });
    // Escaped: each markdown-special char is preceded by a backslash
    expect(out).toContain("evil\\*user\\[link\\]\\(x\\)");
    expect(out).toContain("src/\\[weird\\]\\_\\*name.ts");
  });

  it("renders an empty 'In response to' section when triggeringComments is empty", () => {
    const out = renderChangeSummary({
      ...baseInput,
      triggeringComments: [],
    });
    expect(out).toContain("## 🤖 Addressed PR feedback");
    expect(out).toContain("**Files changed:**");
    // No "In response to" section should appear
    expect(out).not.toContain("**In response to:**");
  });

  it("renders a plain run id with no link when dashboardBaseUrl is empty", () => {
    const out = renderChangeSummary({ ...baseInput, dashboardBaseUrl: "" });
    expect(out).toContain("Run run_abc");
    expect(out).not.toContain("](/runs/run_abc)");
  });

  it("constructs an htmlUrl when ReviewFeedbackComment.htmlUrl is missing (fallback)", () => {
    const out = renderChangeSummary({
      ...baseInput,
      prUrl: "https://github.com/o/r/pull/1",
      handoff: {
        ...handoff,
        context: { ...handoff.context, addressedComments: undefined } as HandoffArtifact["context"] & { addressedComments?: { commentId: string; response: string }[] },
      },
      triggeringComments: [
        {
          commentId: "999",
          author: "alice",
          body: "x",
          filePath: "src/foo.ts",
          lineNumber: 7,
          // htmlUrl absent
        },
        {
          commentId: "888",
          author: "bob",
          body: "y",
          // no filePath, htmlUrl absent
        },
      ],
    });
    expect(out).toContain("https://github.com/o/r/pull/1#discussion_r999");
    expect(out).toContain("https://github.com/o/r/pull/1#issuecomment-888");
  });
});

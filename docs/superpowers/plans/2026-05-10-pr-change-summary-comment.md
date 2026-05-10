# PR change-summary comment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After every successful `review-feedback` pipeline run, post a "🤖 Addressed PR feedback" comment on the PR with per-comment responses linking each triggering review comment to what was changed for it.

**Architecture:** Pure renderer (`pipeline/pr-change-summary.ts`) + thin dispatcher (`maybePostChangeSummary`) called from `runner.onPipelineComplete`. Reuses the existing `pipeline_runs.feedback_context` column (no DB migration). Adds an optional `addressedComments` field to the `HandoffArtifact.context` Zod schema; review-feedback prompt instructs the agent to populate it.

**Tech Stack:** TypeScript, Zod, Vitest, Octokit, SQLite (Drizzle ORM)

**Spec:** `docs/superpowers/specs/2026-05-10-pr-change-summary-comment-design.md`

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Create | `packages/core/src/pipeline/pr-change-summary.ts` | Pure renderer + thin dispatcher (`renderChangeSummary`, `maybePostChangeSummary`) |
| Create | `packages/core/src/__tests__/pipeline/pr-change-summary.test.ts` | Unit tests for both |
| Modify | `packages/core/src/types.ts` | Add `addressedComments` optional field to HandoffArtifact zod schema |
| Modify | `packages/core/src/webhook/github-handler.ts` | Add `htmlUrl` optional field to `ReviewFeedbackComment` interface; populate it from the webhook payload's `comment.html_url` |
| Modify | `packages/core/src/executor/prompt/templates.ts` | Append addressedComments instructions to the review-feedback implement-stage prompt |
| Modify | `packages/core/src/pipeline/runner.ts` | Call `maybePostChangeSummary` from the existing `onPipelineComplete` callsite, alongside the BEC-175 cost-summary block |
| Modify | `CHANGELOG.md` | Entry under `### Added (OSS+)` in `[Unreleased]` |

All work is on a feature branch off `main` (or off the spec branch — branching strategy noted at the end of the plan).

---

## Task 1: Renderer — `renderChangeSummary` (pure function, TDD)

**Files:**
- Create: `packages/core/src/pipeline/pr-change-summary.ts`
- Test: `packages/core/src/__tests__/pipeline/pr-change-summary.test.ts`

The renderer takes structured input and returns a markdown string. No I/O. No GitHub calls. No DB.

- [ ] **Step 1: Write the failing test file** (renderer-only tests)

Create `packages/core/src/__tests__/pipeline/pr-change-summary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  renderChangeSummary,
  type ChangeSummaryInput,
} from "../../pipeline/pr-change-summary.js";
import type { HandoffArtifact } from "../../types.js";
import type { ReviewFeedbackComment } from "../../webhook/github-handler.js";

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
    addressedComments: [
      { commentId: "c-101", response: "Added null check before destructuring." },
      { commentId: "c-102", response: "Renamed `flag` → `isEnabled` per request." },
    ],
  },
  tokenBudget: { contextTokensUsed: 5000, recommendedMaxTurns: 10 },
};

const triggeringComments: ReviewFeedbackComment[] = [
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
  triggeringComments,
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
        context: { ...handoff.context, addressedComments: undefined },
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
        context: { ...handoff.context, addressedComments: [] },
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
        },
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
        },
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
        },
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
        context: { ...handoff.context, addressedComments: undefined },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test src/__tests__/pipeline/pr-change-summary.test.ts`
Expected: FAIL — module `pr-change-summary.js` does not exist.

- [ ] **Step 3: Implement the renderer**

Create `packages/core/src/pipeline/pr-change-summary.ts`:

```ts
import type { HandoffArtifact } from "../types.js";
import type { ReviewFeedbackComment } from "../webhook/github-handler.js";
import type { addPRComment } from "../repo/github.js";
import type { Logger } from "pino";

/**
 * Markdown-special characters escaped before rendering user-controlled
 * strings (author names, file paths, comment bodies). Conservative — escapes
 * anything that could affect markdown rendering.
 */
function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}\[\]()<>#+\-.!|]/g, (ch) => `\\${ch}`);
}

/** Collapse all newlines (and runs of whitespace) into single spaces. */
function singleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Build a comment-URL fallback when ReviewFeedbackComment.htmlUrl is missing.
 * Inline review comments (have filePath) are anchored to the Files Changed
 * tab via #discussion_rNNN; general PR comments use #issuecomment-NNN.
 *
 * The base PR URL must be supplied via input.prUrl. If absent, returns "".
 */
function buildCommentUrl(
  prUrl: string | undefined,
  comment: ReviewFeedbackComment,
): string {
  if (comment.htmlUrl) return comment.htmlUrl;
  if (!prUrl) return "";
  const anchor = comment.filePath
    ? `#discussion_r${comment.commentId}`
    : `#issuecomment-${comment.commentId}`;
  return `${prUrl}${anchor}`;
}

export interface ChangeSummaryInput {
  handoff: HandoffArtifact;
  run: { id: string; totalInputTokens: number; totalOutputTokens: number };
  triggeringComments: ReviewFeedbackComment[];
  dashboardBaseUrl: string;
  /** PR URL — used as the base for fallback comment URL construction. */
  prUrl?: string;
}

/**
 * Render the markdown body of the per-PR change-summary comment. Pure
 * function — no I/O, no GitHub calls.
 *
 * Renderer responsibilities (see spec):
 * - Match handoff.context.addressedComments[i].commentId to
 *   triggeringComments[j].commentId.
 * - If a triggering comment has no matching addressedComments entry, render
 *   its link without a response.
 * - Drop addressedComments entries whose commentId is not in the triggering
 *   set.
 * - Escape markdown-special chars in user-controlled fields.
 * - Collapse newlines in handoff.summary to single spaces.
 * - If addressedComments is missing or empty, append a "responses
 *   unavailable" disclaimer line.
 */
export function renderChangeSummary(input: ChangeSummaryInput): string {
  const { handoff, run, triggeringComments, dashboardBaseUrl, prUrl } = input;

  const summary = singleLine(handoff.summary);
  const addressedById = new Map<string, string>();
  for (const ac of handoff.context.addressedComments ?? []) {
    addressedById.set(ac.commentId, ac.response);
  }
  const validTriggeringIds = new Set(triggeringComments.map((c) => c.commentId));
  // Note: addressedComments referencing IDs not in triggeringComments are
  // implicitly dropped because we only iterate triggeringComments below.
  void validTriggeringIds;

  const responseLines = triggeringComments.map((c) => {
    const url = buildCommentUrl(prUrl, c);
    const linkText = c.filePath
      ? `@${escapeMd(c.author)}'s comment on \`${escapeMd(c.filePath)}${
          c.lineNumber !== undefined ? `:${c.lineNumber}` : ""
        }\``
      : `@${escapeMd(c.author)}'s general comment`;
    const link = url ? `[${linkText}](${url})` : linkText;
    const response = addressedById.get(c.commentId);
    return response ? `- ${link} — ${response}` : `- ${link}`;
  });

  const addressedNonEmpty =
    Array.isArray(handoff.context.addressedComments) &&
    handoff.context.addressedComments.length > 0 &&
    triggeringComments.some((c) => addressedById.has(c.commentId));
  const fallbackLine =
    triggeringComments.length > 0 && !addressedNonEmpty
      ? "\n_(per-comment responses unavailable; see diff)_"
      : "";

  const inResponseSection =
    triggeringComments.length > 0
      ? `\n**In response to:**\n${responseLines.join("\n")}${fallbackLine}\n`
      : "";

  const filesSection =
    handoff.filesChanged.length > 0
      ? `\n**Files changed:**\n${handoff.filesChanged.map((f) => `- \`${escapeMd(f)}\``).join("\n")}\n`
      : "";

  const runLink = dashboardBaseUrl
    ? `[${run.id}](${dashboardBaseUrl}/runs/${run.id})`
    : `Run ${run.id}`;
  const footer = `\n<sub>Run ${runLink} · auto-generated</sub>`;

  return `## 🤖 Addressed PR feedback\n\n${summary}\n${inResponseSection}${filesSection}${footer}`;
}

/**
 * Thin dispatcher called from runner.onPipelineComplete. Decides whether to
 * post the change summary, builds the input, calls renderChangeSummary, and
 * posts via addPRComment. Best-effort: any failure is logged at level: 40
 * and the function returns (no throw).
 *
 * Behavior:
 * - returns early if run.runType !== "review-feedback"
 * - returns early if run.prUrl is missing
 * - returns early if handoff is missing
 * - parses run.feedbackContext as JSON (logs at level: 50 on parse failure
 *   and posts a degraded comment without the "In response to" section)
 */
export interface MaybePostChangeSummaryDeps {
  run: {
    id: string;
    runType?: string | null;
    prUrl?: string | null;
    feedbackContext?: string | null;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
  handoff: HandoffArtifact | null | undefined;
  prNumber: number | null;
  owner: string;
  repo: string;
  octokit: Parameters<typeof addPRComment>[0];
  postPRComment: typeof addPRComment;
  dashboardBaseUrl: string;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

export async function maybePostChangeSummary(
  deps: MaybePostChangeSummaryDeps,
): Promise<void> {
  const { run, handoff, prNumber, owner, repo, octokit, postPRComment, dashboardBaseUrl, logger } = deps;
  if (run.runType !== "review-feedback") return;
  if (!run.prUrl || prNumber === null) {
    logger.info(
      { runId: run.id },
      "skipped change summary: no PR URL on run",
    );
    return;
  }
  if (!handoff) {
    logger.info(
      { runId: run.id },
      "skipped change summary: no handoff persisted",
    );
    return;
  }

  let triggeringComments: ReviewFeedbackComment[] = [];
  if (run.feedbackContext) {
    try {
      const parsed = JSON.parse(run.feedbackContext);
      if (Array.isArray(parsed)) triggeringComments = parsed;
    } catch (err) {
      logger.error(
        { runId: run.id, err: err instanceof Error ? err.message : String(err) },
        "failed to parse feedback_context — posting degraded change summary",
      );
      // continue with empty triggeringComments — comment still posts with
      // summary + files but no "In response to" section
    }
  }

  const body = renderChangeSummary({
    handoff,
    run: {
      id: run.id,
      totalInputTokens: run.totalInputTokens,
      totalOutputTokens: run.totalOutputTokens,
    },
    triggeringComments,
    dashboardBaseUrl,
    prUrl: run.prUrl,
  });

  try {
    await postPRComment(octokit, owner, repo, prNumber, body);
    logger.info(
      { runId: run.id, prNumber },
      "posted PR change summary for review-feedback run",
    );
  } catch (err) {
    logger.warn(
      { runId: run.id, prNumber, err: err instanceof Error ? err.message : String(err) },
      "PR change summary post failed (non-fatal)",
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @urateam/core test src/__tests__/pipeline/pr-change-summary.test.ts`
Expected: PASS — all 9 renderer tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pipeline/pr-change-summary.ts \
        packages/core/src/__tests__/pipeline/pr-change-summary.test.ts
git commit -m "feat(pr-change-summary): pure renderer + dispatcher (renderer tests)"
```

---

## Task 2: Dispatcher tests (TDD)

**Files:**
- Test: `packages/core/src/__tests__/pipeline/pr-change-summary.test.ts` (extend the same file)

The dispatcher is testable in isolation because we passed `octokit` and `postPRComment` as injected deps.

- [ ] **Step 1: Append the dispatcher test suite**

Append to the existing test file:

```ts
import { vi } from "vitest";
import {
  maybePostChangeSummary,
  type MaybePostChangeSummaryDeps,
} from "../../pipeline/pr-change-summary.js";

function makeDeps(over: Partial<MaybePostChangeSummaryDeps> = {}): MaybePostChangeSummaryDeps {
  const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    run: {
      id: "run_abc",
      runType: "review-feedback",
      prUrl: "https://github.com/o/r/pull/1",
      feedbackContext: JSON.stringify(triggeringComments),
      totalInputTokens: 1000,
      totalOutputTokens: 200,
    },
    handoff,
    prNumber: 1,
    owner: "o",
    repo: "r",
    octokit: {} as never,
    postPRComment: vi.fn().mockResolvedValue(undefined),
    dashboardBaseUrl: "https://dogfood.urateams.com:8443",
    logger: noopLogger,
    ...over,
  };
}

describe("maybePostChangeSummary", () => {
  it("posts exactly once for a review-feedback run with a prUrl", async () => {
    const deps = makeDeps();
    await maybePostChangeSummary(deps);
    expect(deps.postPRComment).toHaveBeenCalledTimes(1);
    const [, owner, repo, prNumber, body] = (
      deps.postPRComment as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(owner).toBe("o");
    expect(repo).toBe("r");
    expect(prNumber).toBe(1);
    expect(body).toContain("## 🤖 Addressed PR feedback");
  });

  it("does NOT post for runType=standard", async () => {
    const deps = makeDeps({
      run: { ...makeDeps().run, runType: "standard" },
    });
    await maybePostChangeSummary(deps);
    expect(deps.postPRComment).not.toHaveBeenCalled();
  });

  it("does NOT post when prUrl is null", async () => {
    const deps = makeDeps({
      run: { ...makeDeps().run, prUrl: null },
      prNumber: null,
    });
    await maybePostChangeSummary(deps);
    expect(deps.postPRComment).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run_abc" }),
      "skipped change summary: no PR URL on run",
    );
  });

  it("does NOT post when handoff is missing", async () => {
    const deps = makeDeps({ handoff: null });
    await maybePostChangeSummary(deps);
    expect(deps.postPRComment).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run_abc" }),
      "skipped change summary: no handoff persisted",
    );
  });

  it("posts a degraded comment when feedback_context JSON is malformed", async () => {
    const deps = makeDeps({
      run: { ...makeDeps().run, feedbackContext: "{not json" },
    });
    await maybePostChangeSummary(deps);
    expect(deps.postPRComment).toHaveBeenCalledTimes(1);
    const body = (deps.postPRComment as ReturnType<typeof vi.fn>).mock.calls[0][4];
    expect(body).toContain("## 🤖 Addressed PR feedback");
    // Degraded body has no "In response to" section
    expect(body).not.toContain("**In response to:**");
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it("does not throw when postPRComment rejects (logs at warn level)", async () => {
    const deps = makeDeps({
      postPRComment: vi.fn().mockRejectedValue(new Error("rate limit")),
    });
    await expect(maybePostChangeSummary(deps)).resolves.toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run_abc", prNumber: 1 }),
      "PR change summary post failed (non-fatal)",
    );
  });

  it("treats null/missing feedback_context as empty triggering comments (no In response to section)", async () => {
    const deps = makeDeps({
      run: { ...makeDeps().run, feedbackContext: null },
    });
    await maybePostChangeSummary(deps);
    expect(deps.postPRComment).toHaveBeenCalledTimes(1);
    const body = (deps.postPRComment as ReturnType<typeof vi.fn>).mock.calls[0][4];
    expect(body).toContain("## 🤖 Addressed PR feedback");
    expect(body).not.toContain("**In response to:**");
  });
});
```

- [ ] **Step 2: Run test to verify all pass**

Run: `pnpm --filter @urateam/core test src/__tests__/pipeline/pr-change-summary.test.ts`
Expected: PASS — all renderer + dispatcher tests green (~16 total).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/__tests__/pipeline/pr-change-summary.test.ts
git commit -m "test(pr-change-summary): dispatcher tests (gating, malformed JSON, posting failure)"
```

---

## Task 3: HandoffArtifact schema extension

**Files:**
- Modify: `packages/core/src/types.ts:247-267` (HandoffArtifactSchema)

Add an optional `addressedComments` field to the `context` zod schema. Additive only — existing handoffs without the field continue to parse.

- [ ] **Step 1: Add a failing test asserting the schema accepts the new field**

Append to `packages/core/src/__tests__/types.test.ts` (create if it doesn't exist; check the file first with `ls packages/core/src/__tests__/types*` and use the existing path):

```ts
import { describe, it, expect } from "vitest";
import { HandoffArtifactSchema } from "../types.js";

describe("HandoffArtifactSchema addressedComments", () => {
  const base = {
    runId: "r1",
    issueId: "i1",
    stage: "implement",
    timestamp: "2026-05-10T00:00:00Z",
    summary: "x",
    filesChanged: ["a.ts"],
    approach: "y",
    tokenBudget: { contextTokensUsed: 1, recommendedMaxTurns: 1 },
  };

  it("preserves context.addressedComments when populated (not stripped)", () => {
    const result = HandoffArtifactSchema.safeParse({
      ...base,
      context: {
        issueIntent: "x",
        constraints: [],
        assumptions: [],
        addressedComments: [
          { commentId: "c1", response: "Did the thing." },
        ],
      },
    });
    expect(result.success).toBe(true);
    // Without the schema change, zod's default .strip mode silently drops
    // the unknown key — success: true but addressedComments: undefined. This
    // assertion is what makes the test fail before the schema change lands.
    if (result.success) {
      expect(result.data.context.addressedComments).toEqual([
        { commentId: "c1", response: "Did the thing." },
      ]);
    }
  });

  it("accepts a handoff with addressedComments absent (backwards compat)", () => {
    const result = HandoffArtifactSchema.safeParse({
      ...base,
      context: {
        issueIntent: "x",
        constraints: [],
        assumptions: [],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects when addressedComments[i].response is missing", () => {
    const result = HandoffArtifactSchema.safeParse({
      ...base,
      context: {
        issueIntent: "x",
        constraints: [],
        assumptions: [],
        addressedComments: [{ commentId: "c1" }],
      },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test src/__tests__/types.test.ts -t "addressedComments"`
Expected: FAIL on the first test — without the schema change, zod's default `.strip` mode drops the unknown `addressedComments` key, so `result.data.context.addressedComments` is `undefined`. The assertion `expect(result.data.context.addressedComments).toEqual([...])` fails.

- [ ] **Step 3: Add the field to the schema**

Edit `packages/core/src/types.ts:255-261`:

```ts
context: z.object({
  issueIntent: z.string(),
  constraints: z.array(z.string()),
  assumptions: z.array(z.string()),
  testResults: TestResultSchema.optional(),
  reviewFindings: z.array(ReviewFindingSchema).optional(),
  addressedComments: z
    .array(
      z.object({
        commentId: z.string(),
        response: z.string(),
      }),
    )
    .optional(),
}),
```

- [ ] **Step 4: Run test to verify all pass**

Run: `pnpm --filter @urateam/core test src/__tests__/types.test.ts -t "addressedComments"`
Expected: PASS — all 3 schema tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/__tests__/types.test.ts
git commit -m "feat(types): HandoffArtifact.context.addressedComments optional field"
```

---

## Task 4: Add `htmlUrl` to ReviewFeedbackComment + plumb through webhook

**Files:**
- Modify: `packages/core/src/webhook/github-handler.ts:20-28` (interface)
- Modify: `packages/core/src/webhook/github-handler.ts:498-504` (population)

The current `ReviewFeedbackComment` does not carry the comment URL. We add an optional `htmlUrl` field and populate it from the GitHub webhook payload. Optional — older code that constructs `ReviewFeedbackComment` without it keeps working.

- [ ] **Step 1: Add a failing test asserting webhook handler populates htmlUrl**

Find the existing test for the github-handler webhook path. Run:

```bash
grep -rln "github-handler\|GitHubWebhookHandler\|review_comment" packages/core/src/__tests__/
```

Pick the test file that exercises the comment-extraction code path (likely `webhook-github-handler.test.ts` or similar). Add a test that sends a synthetic webhook payload with a `comment.html_url` field and asserts the resulting `ReviewFeedbackComment` carries `htmlUrl`.

(Exact code depends on existing test scaffolding — reuse the closest existing test as a template. If no test exists for this code path, skip the test step here and rely on Task 1's renderer fallback test for `htmlUrl` absent.)

- [ ] **Step 2: Add the field to the interface**

Edit `packages/core/src/webhook/github-handler.ts:20-28`:

```ts
/** A single piece of review feedback from a GitHub PR comment or review. */
export interface ReviewFeedbackComment {
  commentId: string;
  author: string;
  body: string;
  /** File path for inline review comments. */
  filePath?: string;
  /** Line number for inline review comments. */
  lineNumber?: number;
  /** GitHub html_url for the comment — used to link back from change-summary. */
  htmlUrl?: string;
}
```

- [ ] **Step 3: Populate `htmlUrl` at the construction site**

Edit `packages/core/src/webhook/github-handler.ts:498-504`. Locate the surrounding handler — the comment payload should be in scope. The shape varies by event type (`pull_request_review`, `pull_request_review_comment`, `issue_comment`). For each path, the comment object has `html_url`.

Example modification (the actual variable holding the comment object will differ — read context lines 480-505):

```ts
const feedbackComment: ReviewFeedbackComment = {
  commentId,
  author: commentAuthor,
  body: sanitizedBody,
  filePath: sanitizedFilePath,
  lineNumber,
  htmlUrl: commentHtmlUrl,  // populated from payload.comment.html_url
};
```

If `commentHtmlUrl` isn't already extracted earlier in the handler, add the extraction. Look for the existing line that pulls the comment object from the payload (around lines 470-490 — inspect to find it).

- [ ] **Step 4: Run all webhook handler tests**

Run: `pnpm --filter @urateam/core test src/__tests__ -t "webhook" -t "github-handler"`
Expected: existing tests still pass; new test (if added) passes.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/webhook/github-handler.ts \
        packages/core/src/__tests__/  # whatever test file you touched
git commit -m "feat(webhook): propagate comment html_url onto ReviewFeedbackComment"
```

---

## Task 5: Review-feedback prompt instructs agent to emit `addressedComments`

**Files:**
- Modify: `packages/core/src/executor/prompt/templates.ts:258-279` (the `if (reviewFeedback) { … }` branch)

Append a new instruction to the review-feedback implement-stage prompt requiring the agent to populate `context.addressedComments` in the HandoffArtifact.

- [ ] **Step 1: Skim the existing prompt structure**

Read `packages/core/src/executor/prompt/templates.ts:258-279` and confirm the prompt already mentions HandoffArtifact emission (it should — BEC-167's fix instructed every implement-stage prompt to emit a HandoffArtifact). The new instruction goes alongside the existing structured-output requirements.

- [ ] **Step 2: Add a test exercising the prompt builder**

Find the existing prompt tests:

```bash
grep -rln "buildImplementPrompt\|buildReviewFeedbackPrompt\|review-feedback\b" packages/core/src/__tests__/
```

Append a test that asserts the prompt text contains the new addressedComments instruction. Example sketch (adapt to existing test scaffolding):

```ts
it("review-feedback implement prompt instructs agent to emit context.addressedComments", () => {
  const prompt = buildImplementPrompt({
    issue: makeIssue(),
    repo: makeRepo(),
    handoff: makeHandoff(),
    reviewFeedback: makeReviewFeedback(),
  });
  expect(prompt).toContain("context.addressedComments");
  expect(prompt).toContain("commentId");
  expect(prompt).toContain("response");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test -t "addressedComments"`
Expected: FAIL — current prompt doesn't mention addressedComments.

- [ ] **Step 4: Append the instruction to the prompt**

Edit `packages/core/src/executor/prompt/templates.ts` inside the `if (reviewFeedback) { … }` branch (line 258 onwards). Add to the `Instructions:` bullet list (or before the closing template):

```
- After making your changes, populate `context.addressedComments` in your HandoffArtifact: one entry per PR comment listed above. Each entry MUST have:
    - `commentId`: the comment ID exactly as given in the <review-feedback> block
    - `response`: ONE sentence (≤ 12 words) describing what you changed in response to this comment
  If a comment was not actionable (e.g. a question or a duplicate), set `response` to a one-line explanation rather than skipping the entry.
```

(Place it after the existing instruction bullets but before the trailing `\`.trim();`. Use the literal backslash-n / template-literal wrapping that matches the surrounding lines.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @urateam/core test -t "addressedComments"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/executor/prompt/templates.ts \
        packages/core/src/__tests__/  # whichever test file you touched
git commit -m "feat(prompt): require addressedComments in review-feedback handoff"
```

---

## Task 6: Wire `maybePostChangeSummary` into `runner.onPipelineComplete`

**Files:**
- Modify: `packages/core/src/pipeline/runner.ts` (after the BEC-175 cost-summary block, around line 2326)

Call the dispatcher right after the cost-summary integration. Both branches share the `prUrl`, `repoConfig`, `this.githubConfig`, and `handoff` already in scope at this point in the runner method.

- [ ] **Step 1: Inspect the surrounding runner method**

Read `packages/core/src/pipeline/runner.ts:2200-2330` to locate:
- Where `handoff` is in scope as a local variable (it is — see line 2084 reference in spec context).
- Where `prUrl`, `repoConfig`, `this.githubConfig` are available.
- The exact line after the BEC-175 catch block where the new code goes.

- [ ] **Step 2: Add the import**

In the imports block at the top of `runner.ts` (where `addPRComment` and `prHasCommentStartingWith` are already imported), add:

```ts
import { maybePostChangeSummary } from "./pr-change-summary.js";
```

- [ ] **Step 3: Add the dispatcher call**

After the BEC-175 cost-summary `try/catch` block ends (around line 2327), before the outer `} catch (error) {` for the pipeline-failed handler, insert:

```ts
// PR change-summary comment for review-feedback runs. Always-on (no env
// flag) — a review-feedback run only exists because a human asked for
// changes, so silent shipping is a bug.
if (
  run.runType === "review-feedback" &&
  prUrl &&
  repoConfig.provider !== "gitlab" &&
  this.githubConfig
) {
  try {
    const summaryPrMatch = prUrl.match(/\/pull\/(\d+)/);
    const summaryPrNumber = summaryPrMatch
      ? parseInt(summaryPrMatch[1]!, 10)
      : null;
    const { owner: csOwner, repo: csRepo } = parseRepoUrl(repoConfig.url);
    const csOctokit = await createGitHubClient(this.githubConfig);
    await maybePostChangeSummary({
      run: {
        id: run.id,
        runType: run.runType,
        prUrl: run.prUrl,
        feedbackContext: run.feedbackContext ?? null,
        totalInputTokens: run.totalInputTokens,
        totalOutputTokens: run.totalOutputTokens,
      },
      handoff: handoff ?? null,
      prNumber: summaryPrNumber,
      owner: csOwner,
      repo: csRepo,
      octokit: csOctokit,
      postPRComment: addPRComment,
      dashboardBaseUrl: process.env.URATEAM_DASHBOARD_URL ?? "",
      logger: runLog,
    });
  } catch (err) {
    runLog.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "PR change summary post failed (non-fatal)",
    );
  }
}
```

> **Note:** the dispatcher already swallows `postPRComment` failures internally; the outer try/catch is a belt-and-suspenders for the synchronous setup (parseRepoUrl, createGitHubClient) which can theoretically throw on misconfigured inputs.

- [ ] **Step 4: Build to verify the import + types compile**

Run: `pnpm --filter @urateam/core build`
Expected: clean tsc compile.

- [ ] **Step 5: Run the full core test suite to verify nothing regressed**

Run: `pnpm --filter @urateam/core test`
Expected: PASS — all existing tests + the new pr-change-summary tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pipeline/runner.ts
git commit -m "feat(runner): post change summary for review-feedback runs at onPipelineComplete"
```

---

## Task 7: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md` (append entry under `[Unreleased]` → `### Added (OSS+)`)

- [ ] **Step 1: Add the entry**

Open `CHANGELOG.md`. Under the `## [Unreleased]` heading (line 18), add (or extend) an `### Added (OSS+)` section:

```markdown
### Added (OSS+)
- **PR change-summary comment for review-feedback runs** — after a successful PR-trigger pipeline run (review-feedback `runType`), the bot posts a "🤖 Addressed PR feedback" comment with the HandoffArtifact summary, per-comment responses linking each triggering PR review comment to what was changed for it, files modified, and a run-link footer. Always-on. Render falls back gracefully when the agent does not populate `context.addressedComments`. Best-effort posting — `addPRComment` failures log at level: 40 and never fail pipeline completion.
```

If a `### Added (OSS+)` section already exists in `[Unreleased]`, append the bullet to that existing section instead of creating a duplicate.

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): pr-change-summary comment for review-feedback runs"
```

---

## Final verification

- [ ] **Run the full test suite**

```bash
pnpm --filter @urateam/core test
pnpm --filter @urateam/core build
```

Expected: all green.

- [ ] **Open the PR**

```bash
gh pr create --title "feat: PR change-summary comment for review-feedback runs" \
  --body "$(spec link + summary of decisions + test plan)"
```

- [ ] **Wait for CI green, then merge**

```bash
gh pr checks <PR#>
gh pr merge <PR#> --squash --delete-branch --admin
```

- [ ] **Cut a patch release** following the established workflow (`pnpm cut-release patch --push`, fill in CHANGELOG, merge release PR, tag, GitHub release page, dogfood deploy via SSH).

---

## Branching strategy

This plan can be implemented either:

**A) Atop the spec branch** (`docs/pr-change-summary-spec`) — keeps the spec doc and implementation in one PR train. Merge sequentially: spec PR (#242) first, then the implementation PR off the same branch's tip.

**B) New branch off main** — implementation PR is independent of the spec PR. Allows the spec PR to merge without waiting for implementation, and vice versa.

Recommend **B** — the spec is reviewable on its own and shouldn't be gated on implementation completing.

---

## Spec coverage check (self-review)

| Spec requirement | Task |
|---|---|
| `renderChangeSummary` pure function with documented signature | 1 |
| Renderer behaviors (commentId matching, dropping stray IDs, escaping, newline collapsing, fallback line) | 1 (tests) |
| `maybePostChangeSummary` dispatcher with always-on gating + skip conditions | 1 (impl) + 2 (tests) |
| `HandoffArtifact.context.addressedComments` optional field | 3 |
| `ReviewFeedbackComment.htmlUrl` field + webhook plumbing | 4 |
| Review-feedback prompt requires agent to emit `addressedComments` | 5 |
| Runner integration at onPipelineComplete | 6 |
| Best-effort posting (try/catch, level: 40 log on failure) | 1 (impl) + 2 (test "does not throw when postPRComment rejects") |
| `feedback_context` reused (no DB migration) | 6 (uses `run.feedbackContext` directly) |
| CHANGELOG entry under `### Added (OSS+)` | 7 |
| Tests: pr-change-summary.test.ts | 1, 2 |
| No runner-pr-change-summary.test.ts (replaced by dispatcher tests in pr-change-summary.test.ts) — acknowledged deviation from spec test table | 2 |

The spec's separate `runner-pr-change-summary.test.ts` integration test is folded into the dispatcher tests in Task 2 because the dispatcher is the integration seam. The runner code added in Task 6 is ~30 lines of straightforward plumbing covered by the build/typecheck and the existing runner-level tests; a separate full-runner integration test would add cost without proportional confidence.

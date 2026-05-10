# PR change-summary comment for review-feedback runs

**Status:** design (pre-implementation)
**Author:** Claude (sweep-session sidecar, 2026-05-10)
**Linear ticket:** _(file before implementation)_

## Problem

When a GitHub PR review or inline comment kicks off a `review-feedback` pipeline run, the bot pushes commits to the PR but says nothing. The reviewer sees the diff appear silently and has to read the diff to figure out which of their comments were addressed and how. This breaks the conversational loop reviewers expect ("I asked for X — did you do X?").

The PR already gets a "🤖 Pipeline cost summary" comment from BEC-175 when `URATEAM_PR_COST_SUMMARY=true`, but that's about token spend, not change response. There is no closing-the-loop comment that ties the bot's diff back to the specific reviewer comments that triggered it.

## Goal

After every successful `review-feedback` pipeline run, post a single new GitHub PR comment that:

1. States in one line what the bot changed at a high level (HandoffArtifact summary).
2. Lists each PR review comment that triggered the run, with a per-comment one-line response describing what the bot changed for it.
3. Lists files modified.
4. Links back to the dashboard run.

Out of scope:

- Standard (non-review-feedback) runs. The first PR-creating run is well-served by the PR description and BEC-175's cost summary.
- Updating an existing rolling comment. Each run posts a fresh comment; reviewers can see history at a glance.
- Comment threading / inline review replies. Top-level PR comment only.

## Decisions taken in brainstorming

| # | Decision | Rationale |
|---|---|---|
| 1 | Trigger only on `runType: "review-feedback"` | Maps cleanly to "PR-trigger" semantics; the BEC-175 cost summary already covers per-PR-run posting for new PRs. |
| 2 | Add a new comment per run (not update one rolling comment) | Each round of feedback is a discrete event the reviewer reads once; per-run comments preserve history without ambiguity. |
| 3 | "Standard" content shape (summary + per-comment responses + files changed + run link) | Per-comment responses are the load-bearing part — without them the comment collapses into noise. |
| 4 | Always-on, no env flag | A `review-feedback` run only exists because a human asked for changes; silently shipping changes is a bug, not a feature. |
| 5 | Per-comment responses come from agent-emitted `context.addressedComments` (with renderer fallback) | Mirrors how every other review-side output is sourced (`reviewFindings`, summary). Optional schema field keeps existing flows untouched. |

## Architecture

### New module: `packages/core/src/pipeline/pr-change-summary.ts`

Pure renderer. No I/O, no GitHub API, no DB. Takes a structured input and returns a markdown string.

```ts
export interface ChangeSummaryInput {
  handoff: HandoffArtifact;                  // final implement-stage handoff
  run: Pick<PipelineRun, "id" | "totalInputTokens" | "totalOutputTokens">;
  triggeringComments: ReviewFeedbackComment[];  // comments that kicked off the run
  dashboardBaseUrl: string;                  // e.g. "https://dogfood.urateams.com:8443"
}

export function renderChangeSummary(input: ChangeSummaryInput): string;
```

Renderer responsibilities:
- Match `handoff.context.addressedComments[i].commentId` against `triggeringComments[j].commentId`.
- If a triggering comment has no matching `addressedComments` entry, render its link without a response.
- If `addressedComments` references a commentId not in the triggering set, silently drop it.
- HTML-escape user-controlled fields (author names, comment bodies in any inline preview, file paths).
- Collapse newlines in `handoff.summary` to spaces (single-line rendering — multi-line summaries from the agent are rendered as one line).
- If `addressedComments` is empty or absent: render a single trailing line `_(per-comment responses unavailable; see diff)_` and continue.

### Runner integration: `packages/core/src/pipeline/runner.ts`

At the existing `onPipelineComplete` callsite (the same one BEC-175 hooks), after the cost-summary branch:

```ts
if (run.runType === "review-feedback" && run.prUrl) {
  try {
    const triggeringComments = JSON.parse(run.triggeringComments ?? "[]");
    const body = renderChangeSummary({
      handoff: lastImplementHandoff,
      run,
      triggeringComments,
      dashboardBaseUrl: this.config.dashboardBaseUrl ?? "",
    });
    await addPRComment(this.github, owner, repo, prNumber, body);
  } catch (err) {
    log.warn({ runId: run.id, prUrl: run.prUrl, err }, "failed to post change summary");
  }
}
```

No env flag — always-on for review-feedback runs.

### Schema extension: `packages/core/src/types.ts`

Add an optional field to the `HandoffArtifact.context` shape:

```ts
addressedComments?: Array<{
  commentId: string;
  response: string;  // one-sentence, ≤ 12 words
}>;
```

Additive only — existing handoffs without the field continue to parse.

### DB migration: `pipeline_runs.triggering_comments`

Add a nullable JSON column to persist the `ReviewFeedbackComment[]` that kicked off a `review-feedback` run, so `onPipelineComplete` can read them. `startReviewFeedback()` writes the column at run-create time. Older rows are NULL; renderer treats NULL as empty array.

```sql
ALTER TABLE pipeline_runs ADD COLUMN triggering_comments TEXT;  -- JSON, nullable
```

(SQLite TEXT — same encoding as other JSON columns in the schema.)

### Prompt change: `packages/core/src/executor/prompt/templates.ts`

The review-feedback implement-stage prompt template adds a section instructing the agent to emit `context.addressedComments`. Rough text (final wording polished during implementation):

> For each PR comment listed in the triggering-feedback section, include an entry in `context.addressedComments` of the HandoffArtifact with:
> - `commentId`: the comment ID exactly as given to you
> - `response`: ONE sentence (≤ 12 words) describing what you changed in response to this comment
>
> If a comment was not actionable (e.g., a question), set `response` to a one-line explanation rather than skipping the entry.

Mirrors BEC-167's "always emit a HandoffArtifact envelope" prompt pattern.

## Data flow

```
PR review comment arrives
        │
        ▼
webhook/github-handler.ts builds ReviewFeedbackComment[]
        │
        ▼
runner.startReviewFeedback({ comments, ... })
   • inserts pipeline_runs row with runType="review-feedback"
   • NEW: writes JSON.stringify(comments) to triggering_comments column
        │
        ▼
implement stage runs with the BEC-167 review-feedback prompt
   • prompt now also requires context.addressedComments
   • agent emits HandoffArtifact { summary, filesChanged, context: { addressedComments, reviewFindings } }
        │
        ▼
test stage, review stage (unchanged) — pipeline completes
        │
        ▼
runner.onPipelineComplete():
   • existing: BEC-175 cost summary (gated)
   • NEW: if runType="review-feedback" && prUrl, render + addPRComment
        │
        ▼
GitHub PR shows new "🤖 Addressed PR feedback" comment
```

## Comment shape

```markdown
## 🤖 Addressed PR feedback

<HandoffArtifact.summary verbatim — single line>

**In response to:**
- [@alice's comment on `src/foo.ts:42`](<htmlUrl>) — Added null check before destructuring.
- [@bob's general comment](<htmlUrl>) — Renamed `flag` → `isEnabled`.

**Files changed:**
- `src/foo.ts`
- `src/bar.ts`
- `src/__tests__/foo.test.ts`

<sub>Run [<run-id>](<dashboardBaseUrl>/runs/<run-id>) · auto-generated</sub>
```

Anchor types:
- Inline review comments use `filePath:lineNumber` in the link text and the comment's `htmlUrl` as the href (which is a `#discussion_rNNN` anchor on the PR Files Changed tab).
- General PR comments use "general comment" in the link text and the comment's `htmlUrl` as the href.

## Error handling

Comment posting is best-effort; pipeline completion never fails because of it.

| Failure mode | Behavior |
|---|---|
| `addPRComment` rejects (rate-limit, transient GH outage, deleted PR) | Wrap in try/catch; log at `level: 40` with `{ runId, prUrl, err }`. No retry. |
| `run.prUrl` missing (review-feedback gave up without a PR) | `level: 30` `"skipped change summary: no PR URL on run"`, return. |
| `triggering_comments` JSON parse fails (corrupted column, drift) | `level: 50` (real bug worth seeing). Still post a degraded comment: summary + files changed, no "In response to" section. |
| `lastImplementHandoff` missing (run completed but no handoff persisted) | `level: 30` skip, same as `prUrl` missing. Nothing to summarize. |
| `context.addressedComments` missing or empty | Renderer fallback: list triggering comments without per-comment responses, append `_(per-comment responses unavailable; see diff)_`. Still posts. |

## Tests

| Test file | Coverage |
|---|---|
| `packages/core/src/__tests__/pr-change-summary.test.ts` | All-fields-present case renders the documented markdown shape exactly. Missing `addressedComments` falls back to no-response rendering with the disclaimer line. Extra commentIds in `addressedComments` not in `triggeringComments` are dropped silently. HTML/markdown injection in author names + file paths is escaped. Empty `triggeringComments` produces a comment with no "In response to" section but still has summary + files changed. |
| `packages/core/src/__tests__/runner-pr-change-summary.test.ts` | `onPipelineComplete` posts exactly once for a `review-feedback` run with `prUrl`. Does NOT post for `runType: "standard"`. Does NOT post when `prUrl` is null. Survives an `addPRComment` rejection without throwing (assert pipeline completion still succeeds). Reads `triggering_comments` from the persisted row. |
| Migration test in existing migration test file | New `triggering_comments` column round-trips JSON correctly; older rows with NULL load as empty array on read. |

## Out of scope (explicitly)

- Editing the comment after the run (e.g., on follow-up runs to the same PR) — each run posts a new comment.
- Reply-to-comment threading. Top-level PR comments only; the inline-discussion thread on each review comment is unchanged.
- Operator-level configuration of comment template, dashboard URL inclusion, etc. Hardcoded shape; can be revisited if multiple operators want different formats.
- Standard (non-review-feedback) runs. Out of scope by question 1 of brainstorming.
- Coupling with BEC-175 cost summary. Independent comment, independent posting; cost summary still gated by its own flag.

## Open questions / follow-ups

- Should the `dashboardBaseUrl` come from config or env? BEC-175's run links use the same value; we should reuse whatever it does. (Spec defers to implementation discovery.)
- If a reviewer leaves N+1 new comments while a review-feedback run is in flight, the new comments aren't part of `triggeringComments` for the running pipeline. The runner already has rate-limit gating (`PR URL -> runId`); the new comments will trigger a follow-up run after the current one completes, which posts its own change summary. Acceptable.
- Migration rollout: fresh installs get the new column from the create-table SQL; existing dogfood deploy needs the ALTER TABLE applied. The repo already runs migrations on boot; this one is additive and safe to apply at any time.

## Acceptance criteria

- [ ] `renderChangeSummary` is a pure function in `packages/core/src/pipeline/pr-change-summary.ts` with the documented signature.
- [ ] `runner.onPipelineComplete` calls the renderer and `addPRComment` exactly once for a successful `review-feedback` run with a `prUrl`.
- [ ] No comment is posted for runs with `runType !== "review-feedback"`.
- [ ] No comment is posted when `prUrl` is null/missing.
- [ ] `pipeline_runs` schema has a nullable `triggering_comments` JSON column; `startReviewFeedback` populates it; older rows continue to load as NULL.
- [ ] `HandoffArtifact.context` schema accepts an optional `addressedComments: Array<{ commentId: string; response: string }>` field; absence does not break parsing.
- [ ] Review-feedback implement-stage prompt instructs the agent to emit `addressedComments` with one entry per triggering comment, response ≤ 12 words.
- [ ] Renderer renders the documented markdown shape when all fields are present; falls back gracefully when `addressedComments` is empty/missing.
- [ ] Comment posting is wrapped in try/catch; `addPRComment` failures log at `level: 40` and do not fail pipeline completion.
- [ ] CHANGELOG entry under `### Added (OSS+)`.
- [ ] Test coverage matches the table above.

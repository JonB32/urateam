# BEC-134 — OpenRouter multi-model fanout on review stage

**Issue:** [BEC-134](https://linear.app/beckerspace/issue/BEC-134/v10-26-openrouter-multi-model-fanout-on-review-stage)
**Tier:** OSS
**Estimate:** 2–3 weeks
**v1.0 gate:** 2 of 6 (sequence after BEC-133)
**Date:** 2026-04-30

---

## 1. Goal

Send the review stage to N models in parallel via OpenRouter and emit each model's findings as a labeled PR comment. Existing 3-sub-agent agentic deep-review (Claude Agent SDK) keeps running and remains the sole merge-blocking authority; OpenRouter findings are advisory only in v1.

The provider abstraction is designed so direct-key providers (Anthropic, OpenAI, etc.) can plug in post-v1 without touching the review stage caller.

## 2. Decisions (locked 2026-04-30)

| # | Decision | Reason |
|---|---|---|
| D1 | Single-shot chat-completion per model | OpenRouter does not host the Claude Agent SDK; matches claude-octopus pattern. |
| D2 | Default behavior unchanged when env unset | Zero-regression upgrade for existing OSS installs. |
| D3 | Fanout runs IN ADDITION to agentic deep-review when env set | Agentic stays the merge gate; fanout is broad-coverage advice. |
| D4 | Fanout findings are advisory in v1 (do not gate merge) | Avoids one rogue model vetoing the PR before consensus-vote (v2). |
| D5 | `ReviewProvider` interface + registry | Smallest seam to add direct-key providers later. |
| D6 | New `review_model_runs` table | Per-model cost rollup needs 1:N rows; existing `stage_runs` can't carry it. |
| D7 | One PR comment per fanout model | Preserves "model X said Y" diagnostic; aggregation/synthesis is v2. |

## 3. Architecture

```
packages/core/src/executor/
  deep-review.ts                 (UNCHANGED)
  review/
    review-provider.ts           NEW — interface + registry
    agentic-deep-review.ts       NEW — thin wrapper around runDeepReview()
    openrouter-fanout.ts         NEW — N parallel single-shot reviews
    openrouter-client.ts         NEW — HTTP client for OpenRouter chat-completions
    review-prompt.ts             NEW — single-shot prompt builder + findings parser
    post-fanout-comments.ts      NEW — renders ReviewModelRun → markdown, calls addPRComment

packages/core/src/db/
  schema.ts                      ADD reviewModelRuns table
  migrations/sqlite/008_review_model_runs.sql   NEW
  migrations/postgres/009_review_model_runs.sql NEW

packages/core/src/pipeline/
  runner.ts                      MODIFY — call providers via registry, persist runs, post comments

packages/create-urateam/
  src/index.ts                   MODIFY — optional ScaffoldOptions fields
  template/.urateam/.env.example MODIFY — document new env vars
```

## 4. Interfaces

### 4.1 `ReviewProvider`

```ts
export interface ReviewProvider {
  readonly id: "agentic" | "openrouter"
  runReview(ctx: ReviewContext): Promise<ReviewModelRun[]>
}

export interface ReviewContext {
  runId: string
  stageRunId: string
  workdir: string
  handoff: HandoffArtifact
  baseRef: string                  // git ref to diff against; runner sets to PR base branch, or repo default branch when running outside PR context
  prNumber: number | null          // null when running outside PR context
}

export interface ReviewModelRun {
  modelId: string                  // "claude-haiku-4-5-20251001" | "anthropic/claude-3.5-sonnet"
  providerId: "agentic" | "openrouter"
  status: "completed" | "failed"
  findings: ReviewFinding[]        // existing schema, reused as-is
  inputTokens: number
  outputTokens: number
  durationMs: number
  errorMessage?: string
  truncatedFiles?: number          // populated when input was capped
}
```

### 4.2 Registry

```ts
export function getEnabledProviders(env: NodeJS.ProcessEnv): ReviewProvider[]
```

Always returns `[AgenticDeepReviewProvider]`. Appends `OpenRouterFanoutProvider` iff:

- `REVIEW_MODELS` is set and non-empty after trimming
- `OPENROUTER_API_KEY` is set

If exactly one is set, throw `Error("REVIEW_MODELS and OPENROUTER_API_KEY must both be set or both be unset")`. The runner catches at startup so users see the message before any pipeline work.

### 4.3 OpenRouter client

```ts
interface OpenRouterClient {
  chatCompletion(
    modelId: string,
    messages: ChatMessage[],
    opts: { signal: AbortSignal; maxTokens?: number },
  ): Promise<{ content: string; inputTokens: number; outputTokens: number }>
}
```

Endpoint: `${OPENROUTER_BASE_URL}/chat/completions` (default `https://openrouter.ai/api/v1`).
Headers: `Authorization: Bearer ${OPENROUTER_API_KEY}`, `HTTP-Referer: https://urateams.com`, `X-Title: urateam`.
Streaming: not used in v1; single response per call.

## 5. Data flow

```
runner.ts (review stage call site, ~line 1500)
  ├─ providers = getEnabledProviders(process.env)
  ├─ for p of providers:
  │     runs = await p.runReview(ctx)        // each provider returns N runs (agentic = 1, openrouter = REVIEW_MODELS.length)
  │     allRuns.push(...runs)
  ├─ agenticFindings = allRuns.filter(r => r.providerId === "agentic").flatMap(r => r.findings)
  ├─ handoff.context.reviewFindings = [...existing, ...agenticFindings]   // merge gate unchanged
  ├─ fanoutRuns = allRuns.filter(r => r.providerId !== "agentic")
  ├─ if (prNumber && fanoutRuns.length) await postFanoutCommentsToPR(prNumber, fanoutRuns)   // calls addPRComment from repo/github.ts once per run
  └─ await persistReviewModelRuns(stageRunId, allRuns)
```

### 5.1 Single-shot prompt input

`review-prompt.ts` builds a deterministic prompt from `ReviewContext`:

1. **Intent block**: `handoff.context.issueIntent`, `constraints`, `assumptions`
2. **Diff block**: `git diff <baseRef>...HEAD` from `workdir`
3. **Changed-file bodies**: full content of files in the diff, in repo path order
4. **Instruction**: review for reuse, quality, efficiency; emit a JSON object matching `{"findings": ReviewFinding[]}`

Token budget enforced before send: if estimated input exceeds `REVIEW_MODELS_MAX_INPUT_TOKENS`, drop file bodies tail-first (keep diff hunks always). Record dropped count in `ReviewModelRun.truncatedFiles`.

Output parsing: extract first balanced `{...}` from response, JSON.parse, validate against `ReviewFindingSchema`. Parse failure → run.status = "failed", errorMessage = "model output not parseable as ReviewFinding[]".

### 5.2 PR comment shape

One comment per fanout `ReviewModelRun`, posted via the existing `addPRComment(octokit, owner, repo, prNumber, body)` helper in `packages/core/src/repo/github.ts:96`:

```markdown
🔎 Review by `anthropic/claude-3.5-sonnet` (via OpenRouter)

Status: completed · 12,431 in / 1,802 out tokens · 18.4s

| Severity | File | Line | Category | Description |
|---|---|---|---|---|
| warning | src/foo.ts | 42 | reuse | Duplicates logic from `bar.ts:88`. |

_Advisory only — does not block merge. See deep-review for blocking findings._
```

Failed run:
```markdown
🔎 Review by `openai/gpt-4o` (via OpenRouter)

Status: failed · <error message> · 32.1s

_Advisory only — does not block merge._
```

Truncated input adds: `_Note: input truncated; <N> file bodies dropped to fit context window._`

## 6. Configuration

| Env var | Required when | Default | Notes |
|---|---|---|---|
| `OPENROUTER_API_KEY` | fanout enabled | — | `sk-or-...` |
| `REVIEW_MODELS` | fanout enabled | — | comma-separated; whitespace trimmed; empty entries dropped |
| `REVIEW_MODELS_TIMEOUT_MS` | optional | `300000` | per-model AbortController deadline |
| `REVIEW_MODELS_MAX_INPUT_TOKENS` | optional | `150000` | input cap before truncation |
| `OPENROUTER_BASE_URL` | optional | `https://openrouter.ai/api/v1` | testing override only |

Read directly via `process.env` (matches existing convention in `entrypoint.ts`).

### 6.1 `.env.example` additions

```bash
# OpenRouter multi-model review fanout (BEC-134, OSS, optional)
# When both are set, each comma-separated model produces a single-shot review
# in addition to the default Claude Agent SDK deep-review.
# OPENROUTER_API_KEY=sk-or-...
# REVIEW_MODELS=anthropic/claude-3.5-sonnet,openai/gpt-4o,google/gemini-2.5-pro
```

### 6.2 `create-urateam` scaffolder

Add to `ScaffoldOptions`:

```ts
openrouterApiKey?: string
reviewModels?: string[]
```

`buildEnv()` writes the two lines uncommented when both options are present, otherwise leaves the example block commented. No interactive wizard prompts in v1 — scaffolder is options-driven.

## 7. Schema migration

New table:

```ts
export const reviewModelRuns = sqliteTable("review_model_runs", {
  id: text("id").primaryKey(),
  stageRunId: text("stage_run_id").notNull().references(() => stageRuns.id),
  providerId: text("provider_id").notNull(),     // "agentic" | "openrouter"
  modelId: text("model_id").notNull(),
  status: text("status").notNull(),              // "completed" | "failed"
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  errorMessage: text("error_message"),
  truncatedFiles: integer("truncated_files").notNull().default(0),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
})
```

Index on `stageRunId` for run-detail queries.

`stage_runs.input_tokens` / `output_tokens` continue to be populated as the SUM across all `review_model_runs` rows for that stage (so dashboards showing stage totals do not break).

Cost rollup updated to JOIN `review_model_runs` with `modelPricing` for accurate per-model cost; falls back to existing stage-level rollup when no rows exist (older runs).

## 8. Error handling

| Failure | Behavior |
|---|---|
| One fanout model rejects | `Promise.allSettled` captures it. That run's `status = "failed"`. Other models proceed. Stage continues. |
| All N fanout models fail | Stage does not fail (agentic still ran). `logger.warn` with model count. PR comments still posted with "failed" status so user sees the cost of misconfigured key. |
| `REVIEW_MODELS` set, `OPENROUTER_API_KEY` unset (or vice versa) | Runner throws at startup with explicit message before any pipeline work. |
| Per-model timeout | `AbortController` fires at `REVIEW_MODELS_TIMEOUT_MS`. Treated as failed run with `errorMessage = "timed out after Nms"`. |
| Input over token cap | Truncate file bodies tail-first; record `truncatedFiles` count; never silently drop diff hunks. |
| Malformed model JSON | Run fails with `errorMessage = "model output not parseable as ReviewFinding[]"`. |
| OpenRouter HTTP 4xx/5xx | Run fails with `errorMessage = "openrouter <status> <body-snippet>"`. No retry in v1 (best-effort). |
| `REVIEW_MODELS=" , ,"` (all empty after trim) | Treated as unset → fanout disabled, no error. |
| Agentic deep-review fails | Existing behavior unchanged: stage fails. (Fanout's outcome is irrelevant when agentic itself crashes.) |

## 9. Testing

| File | Coverage |
|---|---|
| `__tests__/openrouter-client.test.ts` | Happy path, 4xx, 5xx, timeout (AbortController), `fetch` mocked via vitest. |
| `__tests__/openrouter-fanout.test.ts` | N=3 parallel, partial failure (1/3 rejects), all-fail, malformed JSON, token-cap truncation, empty `REVIEW_MODELS`. |
| `__tests__/review-provider-registry.test.ts` | Env permutations: neither set, both set, one set (validation throws), whitespace-only, single empty entry. |
| `__tests__/agentic-deep-review-provider.test.ts` | Wrapper preserves existing behavior — assert `runDeepReview` called with same args; output shape matches `ReviewModelRun`. |
| `__tests__/review-prompt.test.ts` | Prompt construction with intent + diff + files; truncation drops file bodies, never diff hunks; parser extracts first balanced `{...}` and validates against schema. |
| `__tests__/db-review-model-runs.test.ts` | Schema migration up; insert + read; index exists. |
| `__tests__/cost/per-run-multi-model.test.ts` | Cost rollup JOINs `review_model_runs`; falls back to stage-level when no rows. |
| `__tests__/e2e-pipeline.test.ts` (extend) | With `REVIEW_MODELS` set in env, both providers ran; `review_model_runs` rows exist; agentic findings still in `reviewFindings`; fanout findings NOT in `reviewFindings`. |

No new mocks for the Claude Agent SDK (existing tests cover `runDeepReview`).

## 10. Out of scope (deferred to v2 or post-v1)

- Consensus-vote synthesis across models (BEC-134 v2)
- Direct-key providers (Anthropic / OpenAI without OpenRouter) — abstraction ready
- Pooled / managed OpenRouter key (parked per BEC-132)
- Dashboard UI surfacing per-model findings (v1 surface = PR comments + `review_model_runs` table)
- Treating fanout findings as a merge gate (advisory in v1)
- Streaming responses
- Per-model retries on transient HTTP errors

## 11. Acceptance criteria mapping (from BEC-134)

| Acceptance criterion | Where covered |
|---|---|
| `REVIEW_MODELS` parsed; review fans out N parallel calls | §4.2 registry, §5 data flow |
| Each model's findings posted as a labeled PR comment | §5.2 PR comment shape |
| Failure of one model doesn't block others | §8 error handling, §9 partial-failure test |
| Cost / token usage logged per model in run record | §7 schema, §9 cost-rollup test |
| Provider abstraction allows direct-key providers later without changing review stage code | §4.1 interface, §10 out-of-scope |
| Tests cover aggregation + partial-failure paths | §9 testing |

## 12. Release & cascade

- Bump `@urateam/core` (this is core code) → next sequential version after `0.1.15`
- Cascade `@urateam/cli` and `@urateam/dashboard` patch versions even though dashboard does not surface fanout in v1 (consistent monorepo cadence per Phase 2 hardening playbook)
- Tag follows urateam-bump convention (next sequential after `v0.1.29`)
- No license-tier check (OSS feature)

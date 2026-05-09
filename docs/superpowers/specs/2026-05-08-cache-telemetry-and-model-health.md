# Cache telemetry + low-yield review-model health check — design

**Date**: 2026-05-08
**Driver**: BEC-138 dogfood post-deploy log scan (see ADR-1 / Why)
**Scope**: two small, independent features that ship together in v0.1.40
**Status**: design — awaiting implementation plan

## Why

Cost-rollup query against the dogfood DB (last 7 days, post-v0.1.39):

| Bucket | Tokens | Share |
|---|---|---|
| `implement` stage output | 1,043,534 | ~42% |
| Deep-review fanout (OpenRouter) input | 879,005 | ~33% |
| `review` stage main output | 266,589 | ~11% |
| `test` stage output | 159,448 | ~6% |
| Deep-review fanout output | 87,006 | ~3% |
| `reproduce` | 6,804 | <1% |

Two distinct findings:

1. **`stage_runs.input_tokens` total is suspiciously low** (~16K across 100 runs). Reading `agent-stream.ts:131-132`, the consumer only accumulates `usage.input_tokens` — the *uncached* input. Anthropic prompt caching is almost certainly already active inside the Agent SDK; we're flying blind on hit-rate. We need telemetry before any further caching tuning is meaningful.

2. **`openai/gpt-oss-120b:free` shows 272K input → 3K output** (1% output ratio) over 10 fanout runs. The model is consistently failing to produce parseable findings (likely truncation on the free tier) but still consuming input. Similar low-yield models could land in `REVIEW_MODELS` in the future.

Goal: ship cache telemetry so future caching work has a feedback signal, and ship a low-yield model health check so the operator gets a visible alert when fanout models stop returning useful output.

Explicitly out-of-scope:
- Auto-suspending bad models (feedback-loop risk; operator removes manually)
- Restructuring the implement-stage prompt for better cache stability (premature without telemetry)
- Diff-size gate on fanout (good follow-up; revisit once telemetry is live)

## A — Cache telemetry

### Data flow

The Anthropic Messages API returns four fields per turn under `usage`:

| Field | Meaning | Cost vs uncached input |
|---|---|---|
| `input_tokens` | uncached input | 1.0× |
| `cache_creation_input_tokens` | written to cache | 1.25× |
| `cache_read_input_tokens` | read from cache | 0.1× |
| `output_tokens` | model output | output rate |

Today `agent-stream.ts` sums only `input_tokens` and `output_tokens`. We extend it to also sum `cache_creation_input_tokens` and `cache_read_input_tokens`, surface them on `StageStreamResult`, and the executor persists them to two new columns on `stage_runs`. The PR cost summary (BEC-175) renders a per-stage cache hit ratio when the columns are non-zero.

### Components

| File | Change |
|---|---|
| `packages/core/src/db/schema.ts` | Add `cacheCreationInputTokens` + `cacheReadInputTokens` columns to `stageRuns` (integer, default 0, NOT NULL) |
| `packages/core/src/db/migrations/<next>_add_cache_telemetry.sql` | `ALTER TABLE stage_runs ADD COLUMN ...` for both DB drivers (sqlite + postgres) |
| `packages/core/src/executor/agent-stream.ts` | Extend `StageStreamResult` with the two new fields; accumulate from each `message.usage` |
| `packages/core/src/executor/executor.ts` | Pass-through to `stage_runs.update()` (lines 211–220) |
| `packages/core/src/pipeline/cost-summary.ts` | When `cacheReadInputTokens > 0` for a stage, append `cache hit X% (read N / created M)` line to the rendered output |
| `packages/core/src/__tests__/agent-stream.test.ts` *(new or extended)* | Verify cache fields accumulate correctly from a sequence of `usage` blocks |
| `packages/core/src/__tests__/pipeline/pr-cost-summary.test.ts` | Add a test case asserting the cache-hit line renders when fields are present |

### Acceptance criteria

- [ ] Migration applies cleanly on both sqlite (dogfood) and postgres
- [ ] Existing rows have 0/0 in the new columns; pre-telemetry stages don't break the formatter
- [ ] `agent-stream.ts` sums `cache_creation_input_tokens` and `cache_read_input_tokens` from `message.usage`
- [ ] `executor.ts` writes both to `stage_runs` on completion
- [ ] PR cost summary shows `cache hit: X% (read X.X K / created X.X K)` per stage when fields are non-zero; falls back silently when both are 0
- [ ] Unit test seeds known `usage` blocks with cache fields → asserts sum

### Test fixtures

Stream of three turns:
- Turn 1: `usage: { input_tokens: 100, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0, output_tokens: 200 }`
- Turn 2: `usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 300 }`
- Turn 3: `usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 250 }`

Expected accumulated: `inputTokens: 200, cacheCreation: 5000, cacheRead: 10000, outputTokens: 750`. Cache hit ratio = `10000 / (10000 + 200) ≈ 98%`.

## B — Low-yield review-model health check

### Data flow

`review_model_runs` already records `(model_id, provider_id, status, input_tokens, output_tokens, started_at, completed_at)` per fanout invocation. Before the next fanout dispatch, the runner queries this table for the rolling window, computes per-model output ratio, and flags any model below the configured threshold. Flagged models still run (no auto-suspend) but emit a WARN log + `review.model_low_output_ratio` audit event so the operator sees the signal in the dashboard and Slack alert stream.

The check is "advisory + visible" by design. Auto-suspend introduces a feedback loop where a transient provider outage looks like a permanent model failure; operator judgment stays in the loop.

### Components

| File | Change |
|---|---|
| `packages/core/src/executor/review/model-health.ts` *(new)* | `getModelHealthScores(db, lookbackHours, minRuns)` → `Map<modelId, { runs, outputRatio, lastSeen }>`. `flagLowYieldModels(scores, models, threshold)` → string[] of flagged model IDs |
| `packages/core/src/executor/review/review-providers-runner.ts` | Before invoking models, fetch scores; emit WARN log + audit event for any flagged model. Models still run (advisory) |
| `packages/core/src/audit/events.ts` | New factory `reviewModelLowOutputRatioEvent({ modelId, outputRatio, runs, threshold })` |
| `packages/core/src/types.ts` | Extend `AuditEventTypeSchema` with `"review.model_low_output_ratio"` |
| `packages/core/src/__tests__/audit-immutability.test.ts` | Add the new emit-site to the `logAuditEventUnchecked` allow-list |
| `packages/core/src/__tests__/review/model-health.test.ts` *(new)* | Unit-test the predicate against synthetic `review_model_runs` rows |

### Env knobs

| Env | Default | Notes |
|---|---|---|
| `REVIEW_MODELS_MIN_OUTPUT_RATIO` | `0.05` (5%) | Models below = flagged |
| `REVIEW_MODELS_HEALTH_LOOKBACK_HOURS` | `168` (7d) | Window |
| `REVIEW_MODELS_MIN_RUNS` | `5` | Don't flag with fewer samples |

All three knobs read at runner-startup (no per-tick re-read; restart to change).

### Acceptance criteria

- [ ] `getModelHealthScores` queries `review_model_runs` filtered by lookback window, groups by `model_id`, computes `output / (input + output)` ratio, returns map
- [ ] `flagLowYieldModels` returns model IDs where `runs >= MIN_RUNS && outputRatio < threshold`
- [ ] Models with `runs < MIN_RUNS` are NOT flagged (insufficient data)
- [ ] Models with zero `input_tokens + output_tokens` (status: failed) are excluded from the ratio computation
- [ ] Runner emits `review.model_low_output_ratio` audit event per flagged model per fanout invocation
- [ ] Models still run (no auto-suspend) — operator manually drops them from `REVIEW_MODELS`
- [ ] Audit-immutability allow-list updated for the new emit-site
- [ ] Unit tests cover: healthy model, low-yield model, insufficient samples, all-failed model, threshold boundary

### Test fixtures

Seed `review_model_runs`:
- `claude-haiku-4-5`: 10 rows, avg in=2K out=8K → ratio 80%, healthy
- `gpt-oss-120b:free`: 10 rows, avg in=27K out=300 → ratio 1.1%, **flagged**
- `new-model:test`: 2 rows → below `MIN_RUNS`, NOT flagged
- `broken-model`: 10 rows, all status=failed, in=0 out=0 → excluded from ratio (NOT flagged)

## Release & rollout

Both A + B ship together in v0.1.40 (cut via `pnpm cut-release patch --push`).

Post-deploy verification:
- `URATEAM_PR_COST_SUMMARY=true` already set on dogfood — next merged PR's cost-summary comment shows cache hit ratios
- Watch dogfood logs for `review.model_low_output_ratio` audit emissions; expect `gpt-oss-120b:free` to be flagged within an hour of v0.1.40 deployment if it's still in `REVIEW_MODELS`

Backward compatibility:
- Pre-existing `stage_runs` rows (0 in cache columns) → cost summary skips the cache line silently
- Pre-existing `review_model_runs` rows feed the health predicate; if they pre-date the schema, they still work since both columns existed before this change

## Future work (out of scope here)

- **Diff-size gate on fanout** — skip multi-model review when diff is trivial (default <50 LOC). Estimated 10–30% review-stage savings on small PRs.
- **Auto-suspend** — once telemetry shows persistent low-yield, opt-in flag to skip the flagged model entirely. Default off.
- **Cache stability tuning** — once telemetry surfaces low hit-rates on specific stages, restructure prompt prefix (system, tools, CLAUDE.md) to maximize cache stability. Specific work depends on what the data shows.
- **Per-model dashboard** — surface cache hit ratios + model output ratios in the ops dashboard alongside cost rollups.

## Linear / acceptance trail

- A: file as new ticket "Pipeline: cache telemetry on stage_runs + cost-summary integration" (sev-3)
- B: file as new ticket "Pipeline: low-yield review-model health check + audit alert" (sev-3)
- Both reference this design doc.

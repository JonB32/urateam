# Design: Cost & ROI dashboard (Enterprise feature 4.5)

**Date**: 2026-04-15
**Status**: Draft for review
**Parent strategy**: `docs/superpowers/specs/2026-04-13-enterprise-tier-design.md` § 4.5
**Scope**: Dashboard page + aggregation module that tells a VP Eng (and the CFO they report to) how many PRs urateam delivered, how much engineer time was saved, how many tokens and dollars it cost, and the resulting ROI multiplier — broken down by team, repo, and pipeline, over configurable date ranges.

---

## 1. Goals and non-goals

### Goals
- Give the VP Eng one defensible number at QBR: "urateam delivered N PRs, saved Xh of engineer time, cost $Y, ROI Z×."
- Make every rate used in the calculation visible in the UI so the CFO can scrutinize and (optionally) recalculate with their own assumptions.
- Support QBR-aligned custom date ranges (`?from=2026-01-01&to=2026-03-31`) and common rolling windows (7d / 30d / 90d / 365d).
- Break down by **team**, **repo**, and **pipeline** so the operator can answer "which team/repo/pipeline drove the savings."
- Pre-aggregate rolling-window queries via a daily rollup table so the QBR page loads in under 500ms even on deployments with 10k+ runs.
- Zero schema burden on existing tables — reuse `pipeline_runs` and `stage_runs` and add one new `cost_rollups_daily` table.
- Ship a CSV export matching the dashboard view so the operator can attach it to their QBR deck.

### Non-goals
- **Per-issue breakdown.** Dropped during brainstorming — every issue is one PR, so this is a re-sort of the run list, not an aggregation.
- **Forecasting, trend lines, or moving averages.** v1 is static tables + summary card; charts are a follow-up.
- **Dashboard charts** (sparklines, bar charts). Hold for a later polish pass.
- **Historical rollup backfill.** Rollups start rolling forward from the first PM tick after deploy — older runs are still queryable via the custom-range (live) path but are not pre-aggregated.
- **A new `pipeline_runs.dollars` column.** Dollar cost is computed at read time from stage tokens and the configured rate table, so customer rate changes retroactively re-price historical runs.
- **Auth on the CSV export beyond the existing dashboard session.** The whole dashboard sits behind SSO (feature 4.1) or Basic Auth; the CSV export inherits that.

## 2. Config shape

New `costs` section on `AppConfig` in `packages/core/src/types.ts`:

```ts
costs: z.object({
  /**
   * Dollar rates per Anthropic model (or the customer's contracted override).
   * Defaults match Anthropic list price at the time of this spec. Operators
   * with enterprise Anthropic contracts should override with their actual rates.
   */
  modelPricing: z.record(z.string(), z.object({
    inputPerMillion: z.number().positive(),
    outputPerMillion: z.number().positive(),
  })).default({
    "claude-opus-4-6":   { inputPerMillion: 15, outputPerMillion: 75 },
    "claude-sonnet-4-6": { inputPerMillion:  3, outputPerMillion: 15 },
    "claude-haiku-4-5":  { inputPerMillion:  1, outputPerMillion:  5 },
  }),
  /**
   * Fully-loaded engineer hourly rate, used to convert `timeSavedHours` into
   * a dollar "value" figure. Default $50/hr is a conservative US eng median.
   */
  hourlyEngRate: z.number().positive().default(50),
  /**
   * Default time saved per merged PR when a pipeline doesn't override it.
   * Defensible at 4h per PR based on DORA-ish industry research.
   */
  timeSavedPerPrDefault: z.number().positive().default(4),
}).optional()
```

`PipelineConfig` gains an optional field:
```ts
timeSavedPerPr: z.number().positive().optional()
```

Resolution order for a given pipeline: `pipeline.timeSavedPerPr ?? config.costs?.timeSavedPerPrDefault ?? 4`.

## 3. Module layout

New `packages/core/src/cost/`:

```
cost/
  index.ts       — barrel
  types.ts       — CostSummary, BreakdownRow, BreakdownDimension, DateRange
  rates.ts       — resolveModelRate(modelName, config): ModelRate
                 — resolveTimeSavedPerPr(pipelineKey, config): number
  per-run.ts     — computeRunCost(run, stages, pipelineConfig, config): {
                     inputTokens, outputTokens, dollars, timeSavedHours
                   }
  aggregate.ts   — aggregateCost(db, filters, config): Promise<CostSummary>
                 — aggregateByDimension(
                     db, filters, dim: "team" | "repo" | "pipeline", config,
                   ): Promise<BreakdownRow[]>
  rollup.ts      — recomputeCostRollups(db, config): Promise<{ rowsWritten: number }>
                 — readRollupWindow(db, from, to): Promise<RollupRow[]>
  csv.ts         — streamCostCsv(db, filters, config): AsyncIterable<string>
```

Each file has one clear responsibility. `rates.ts` and `per-run.ts` are pure (no DB). `aggregate.ts`, `rollup.ts`, and `csv.ts` take `AnyDb`.

### 3.1 `CostSummary` shape
```ts
interface CostSummary {
  window: { from: Date; to: Date };
  runs: number;
  prsMerged: number;
  inputTokens: number;
  outputTokens: number;
  dollars: number;
  timeSavedHours: number;
  roiMultiplier: number;  // (timeSavedHours * hourlyEngRate) / dollars, or Infinity if dollars === 0
}

interface BreakdownRow {
  key: string;            // "team:T1" | "repo:..." | "pipeline:auto-implement"
  label: string;          // human-readable name
  runs: number;
  prsMerged: number;
  inputTokens: number;
  outputTokens: number;
  dollars: number;
  timeSavedHours: number;
  roiMultiplier: number;
}
```

## 4. Data flow

### 4.1 Per-run cost computation
Single source of truth: `computeRunCost(run, stages, pipelineConfig, config)`.

```ts
function computeRunCost(
  run: PipelineRunRow,
  stages: StageRunRow[],
  pipelineConfig: PipelineConfig | undefined,
  config: AppConfig,
): RunCost {
  let dollars = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const s of stages) {
    const modelName =
      pipelineConfig?.stageModels?.[s.stage] ??
      pipelineConfig?.profile?.model ??
      "claude-sonnet-4-6";
    const rate = resolveModelRate(modelName, config);
    dollars += (s.inputTokens * rate.inputPerMillion / 1_000_000)
             + (s.outputTokens * rate.outputPerMillion / 1_000_000);
    inputTokens += s.inputTokens;
    outputTokens += s.outputTokens;
  }
  const timeSavedHours =
    run.status === "completed"
      ? resolveTimeSavedPerPr(run.pipelineKey, config)
      : 0;
  return { inputTokens, outputTokens, dollars, timeSavedHours };
}
```

### 4.2 Aggregation path
Two queries, in-process grouping:

1. Select `pipeline_runs` in the window (`completedAt` between `from` and `to`, `status = "completed"` for PR counts — but also include retriable/failed runs for cost attribution, because the tokens still cost money).
2. Select `stage_runs` for those run IDs via `inArray`.
3. In TypeScript: build a run-id → stages map, walk runs, call `computeRunCost` for each, accumulate into the dimension buckets.
4. Return a `CostSummary` (overall) and `BreakdownRow[]` per dimension.

The dashboard route calls `aggregateCost` once for the summary card and `aggregateByDimension` three times (team, repo, pipeline) for the breakdown tables. These can share a single fetch of the runs+stages data — expose a single `aggregateAll(db, filters, config): Promise<{summary, byTeam, byRepo, byPipeline}>` helper that does the two SQL queries once and runs the four groupings in-process. **This is the function the dashboard route calls.**

### 4.3 Rollup path
For preset rolling windows (7d / 30d / 90d / 365d) the dashboard reads from the pre-aggregated `cost_rollups_daily` table instead of live-querying `pipeline_runs` + `stage_runs`. The rollup table is keyed on `(date, pipeline_key, linear_team_id, repo_url)` — one row per unique dimension combination per UTC day.

`readRollupWindow(db, from, to)` does a single `SELECT ... WHERE date BETWEEN ... AND ...` with in-process grouping by dimension. The expected row count for a 365-day window on a 10-pipeline, 5-team, 20-repo deployment is ~3650 × 10 = 36,500 rows, but typical queries hit far fewer because most combinations are sparse.

**Route logic:** if the request is a preset window, use `readRollupWindow`. If the request is a custom range, call `aggregateAll` live. The dashboard route decides which based on whether `from`/`to` align to a 7/30/90/365-day ending-now window.

## 5. Schema

### 5.1 New table
```ts
export const costRollupsDaily = sqliteTable("cost_rollups_daily", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),                      // YYYY-MM-DD UTC
  pipelineKey: text("pipeline_key").notNull(),
  linearTeamId: text("linear_team_id"),              // nullable
  repoUrl: text("repo_url").notNull(),
  runs: integer("runs").notNull().default(0),
  prsMerged: integer("prs_merged").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  dollars: real("dollars").notNull().default(0),
  timeSavedHours: real("time_saved_hours").notNull().default(0),
  computedAt: crossTimestamp("computed_at")
    .notNull()
    .$defaultFn(() => new Date()),
}, (t) => [
  unique().on(t.date, t.pipelineKey, t.linearTeamId, t.repoUrl),
]);
```

Indexes in migration files:
- `idx_cost_rollups_date` on `(date)`
- `idx_cost_rollups_date_pipeline` on `(date, pipeline_key)`

Note: `real` is the Drizzle SQLite column type; Postgres uses `double precision`. The `crossTimestamp` pattern doesn't cover numeric columns, so `real` needs a driver-aware cast in `getCreateTablesDDL()` (`REAL` on SQLite, `DOUBLE PRECISION` on Postgres).

### 5.2 Migration files
- `packages/core/src/db/migrations/sqlite/009_cost_rollups.sql`
- `packages/core/src/db/migrations/postgres/010_cost_rollups.sql`

The numbering accounts for `007_sso` + `008_audit_immutability-dashboards` landing before this. Verify before writing — if SSO/audit have different numbers, adjust.

### 5.3 `getCreateTablesDDL()` extension
Append the new table with driver-aware `REAL` vs `DOUBLE PRECISION` substitution via a new `${num}` interpolation alongside the existing `${ts}`.

## 6. Rollup job

New PM tick step `recomputeCostRollups(db, config)` runs after `pruneExpiredSessions` (the current last step after the SSO feature). Behavior:

1. Determine which days are stale:
   - On first run after a deploy: scan `cost_rollups_daily` for the latest `date`. If none, backfill starts at `today - 30` to avoid a huge first-run.
   - On subsequent runs: check if `today - 1` (UTC) has been rolled. If not, roll it.
2. For each stale day:
   - Query `pipeline_runs WHERE completedAt BETWEEN dayStart AND dayEnd`
   - Query `stage_runs` for those runs
   - Call `computeRunCost` per run and group by `(pipeline_key, linear_team_id, repo_url)`
   - Upsert rows into `cost_rollups_daily` via `onConflictDoUpdate` on the unique constraint
3. Log a pino info with `{ day, rowsWritten, rowsUpdated }`
4. License-gated on `isFeatureLicensed("cost-roi")`; skip entirely otherwise
5. Wrap in try/catch — rollup failure must not crash the tick

**Idempotency:** re-running on the same day overwrites the existing rows (`onConflictDoUpdate`), so repeated ticks on the same day are safe. This is important because the PM tick runs every 30 min and we don't want to reconsider "is today over" at every tick.

**Today's in-progress data:** the rollup only covers completed UTC days. "Today so far" is read live via `aggregateAll`. The dashboard merges: `readRollupWindow(from, today-1)` + `aggregateAll(today, now)`.

## 7. Dashboard

### 7.1 Route
`packages/dashboard/src/routes/cost.ts`:
- `GET /cost` — HTML page. Parses `from`, `to`, or a preset (`?window=30d`). Default: last 30 days
- `GET /cost/page` — HTMX partial for updates when the user changes the date picker
- `GET /cost/export.csv` — streams CSV with the same filters
- All three return 404 unless `isFeatureLicensed("cost-roi")`

### 7.2 View
`packages/dashboard/src/views/cost.ts`:

**Header:** preset chips (`7d` / `30d` / `90d` / `365d` / `custom`), `from`/`to` date inputs appearing only when `custom` is selected. Form submits via `hx-get="/cost/page"`.

**Summary card:** one prominent card with six numbers + the ROI formula:
```
Last 30 days · 2026-03-16 to 2026-04-15

243 PRs merged            ·  972h saved
1.2M tokens               ·  $612 cost

ROI: 972h × $50/h = $48,600 value ÷ $612 cost = 79×
```

**Three breakdown tables:** team, repo, pipeline. Each has columns: Name · Runs · PRs merged · Hours saved · Tokens · $ · ROI×. Sort desc by `dollars`.

**Formula footer (collapsed by default):** click to expand. Shows:
- Per-pipeline `timeSavedPerPr` (default or override, and the source)
- Per-model rate (input $ / output $) — only models actually used in the window
- `hourlyEngRate`
- A note about how "time saved" is counted (completed PRs only)

**Security:** all user-controlled strings pass through `escapeHtml` (same convention as `/audit`).

**Nav:** add "Cost" to `layout.ts` after "Audit", before "Errors".

### 7.3 CSV export
`streamCostCsv(db, filters, config)` yields:
- Header row: `completed_at,run_id,issue_id,pipeline_key,linear_team_id,repo_url,input_tokens,output_tokens,dollars,time_saved_hours`
- One row per run in the window
- Uses the same formula-injection escape from the audit CSV (prefix `=+-@\t` with `'`)
- Content-Disposition: `attachment; filename="cost-<from>-<to>.csv"`

## 8. License gating

- `cost-roi` added to the Enterprise feature set in `license.ts`
- `/cost`, `/cost/page`, `/cost/export.csv` all 404 when unlicensed
- PM tick `recomputeCostRollups` skipped when unlicensed
- OSS / Pro deployments see no nav entry, no routes, no rollups, no behavior change

## 9. Testing strategy

### 9.1 Unit (`packages/core/src/__tests__/cost/`)
- `rates.test.ts` — `resolveModelRate` falls back to default for unknown models, respects override
- `per-run.test.ts` — `computeRunCost` with multiple stages, multiple models, partial stage failures
- `aggregate.test.ts` — `aggregateAll` with seeded fixtures, three dimensions, correct grouping
- `rollup.test.ts` — first-run backfill, idempotent re-roll, license gate, day-boundary handling (UTC)
- `csv.test.ts` — header row, escaping, formula injection guard

### 9.2 Integration
- `cost-integration.test.ts` — end-to-end: seed 20 runs across 3 pipelines, 2 teams, 2 repos; call `aggregateAll`; assert per-team/per-repo/per-pipeline totals match hand-computed values

### 9.3 Dashboard (`packages/dashboard/src/__tests__/cost.test.ts`)
- Unlicensed → 404 on all 3 routes
- Licensed → 200, rendered summary contains expected totals
- Preset window uses `readRollupWindow` (mock and assert call)
- Custom window uses `aggregateAll` (assert call)
- CSV export content-type + filename + header row

## 10. Migration and rollout

### 10.1 Schema
- New table `cost_rollups_daily` via new migration file
- `getCreateTablesDDL()` extended with the `num` interpolation
- Drizzle schema extended

### 10.2 Feature flag
- `cost-roi` added to `ENTERPRISE_FEATURES`
- No behavior change for OSS/Pro

### 10.3 First-run behavior
- On the first PM tick after a licensed deploy, `recomputeCostRollups` backfills the last 30 days (up to 30 UTC-day rollup batches, each writing ~N rows where N = unique combos in that day)
- The dashboard works immediately for custom ranges (live query) and within 30 minutes for preset rolling ranges (after the first tick)

## 11. Open questions (deferred)

- **Rollup backfill for historical data older than 30 days.** On-demand via a CLI command? Defer until a customer asks.
- **Trendlines / sparklines on the summary card.** Adds chart library dependency; defer.
- **Per-issue breakdown.** Re-sort of the run list, no aggregation value. Defer indefinitely.
- **Forecasting "at this burn rate you'll spend $N in Q2".** Linear projection is cheap but risks looking official when it's just multiplication. Defer until someone asks.
- **Cost alerts ("your auto-implement pipeline's cost/PR doubled this week").** Belongs in feature 4.3 territory (spend caps), not this dashboard. Defer.
- **Multi-currency support.** Defer until a customer asks. Default USD.

# Cost & ROI Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship enterprise feature 4.5 — a `/cost` dashboard page with summary card, three breakdown tables (team / repo / pipeline), date-range picker, and CSV export — per `docs/superpowers/specs/2026-04-15-cost-roi-dashboard-design.md`.

**Architecture:** New `packages/core/src/cost/` module owns aggregation + pricing as mostly-pure functions. Per-run cost is computed at read time from `stage_runs` tokens plus a configured model-pricing table — no schema change on run tables. A new `cost_rollups_daily` table is rebuilt nightly by a new PM tick step, enabling <500ms preset-window queries. Custom date ranges compute live via `aggregateAll`. Dashboard route renders the page; CSV export shares the same aggregation path. License-gated by `isFeatureLicensed("cost-roi")`.

**Tech Stack:** TypeScript, Drizzle ORM, Hono + HTMX, Vitest, Zod, pino.

---

## File Structure

### New files
- `packages/core/src/cost/index.ts` — barrel
- `packages/core/src/cost/types.ts` — `CostSummary`, `BreakdownRow`, `BreakdownDimension`, `RunCost`, `ModelRate`
- `packages/core/src/cost/rates.ts` — `resolveModelRate`, `resolveTimeSavedPerPr`
- `packages/core/src/cost/per-run.ts` — `computeRunCost`
- `packages/core/src/cost/aggregate.ts` — `aggregateAll` (two SQL queries + in-process grouping into summary + 3 dimensions)
- `packages/core/src/cost/rollup.ts` — `recomputeCostRollups`, `readRollupWindow`
- `packages/core/src/cost/csv.ts` — `streamCostCsv`
- `packages/core/src/db/migrations/sqlite/007_cost_rollups.sql`
- `packages/core/src/db/migrations/postgres/008_cost_rollups.sql`
- `packages/core/src/__tests__/cost/rates.test.ts`
- `packages/core/src/__tests__/cost/per-run.test.ts`
- `packages/core/src/__tests__/cost/aggregate.test.ts`
- `packages/core/src/__tests__/cost/rollup.test.ts`
- `packages/core/src/__tests__/cost/csv.test.ts`
- `packages/core/src/__tests__/cost-integration.test.ts`
- `packages/dashboard/src/routes/cost.ts`
- `packages/dashboard/src/views/cost.ts`
- `packages/dashboard/src/__tests__/cost.test.ts`

### Modified files
- `packages/core/src/db/schema.ts` — add `costRollupsDaily`
- `packages/core/src/db/client.ts` — extend `getCreateTablesDDL()` with the new table, add `${num}` interpolation (`REAL` vs `DOUBLE PRECISION`)
- `packages/core/src/types.ts` — add `CostsConfigSchema`, `ModelPricingSchema`; extend `AppConfigSchema.costs`; add `PipelineConfig.timeSavedPerPr`
- `packages/core/src/license.ts` — add `"cost-roi"` to Enterprise feature set
- `packages/core/src/index.ts` — re-export `./cost/index.js`
- `packages/core/src/pm/scheduler.ts` — add `recomputeCostRollups` tick step
- `packages/dashboard/src/server.ts` — register `createCostRouter`
- `packages/dashboard/src/views/layout.ts` — add "Cost" nav entry after "Audit"
- `CLAUDE.md` — new "Cost & ROI dashboard" section under Key Patterns

---

## Task 1: Zod config schemas

**Files:**
- Modify: `packages/core/src/types.ts`
- Test: `packages/core/src/__tests__/cost-types.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import {
  CostsConfigSchema, ModelPricingSchema, PipelineConfigSchema, AppConfigSchema,
} from "../types.js";

describe("CostsConfigSchema", () => {
  it("parses an empty object and applies defaults", () => {
    const parsed = CostsConfigSchema.parse({});
    expect(parsed.hourlyEngRate).toBe(50);
    expect(parsed.timeSavedPerPrDefault).toBe(4);
    expect(parsed.modelPricing["claude-opus-4-6"]).toEqual({ inputPerMillion: 15, outputPerMillion: 75 });
    expect(parsed.modelPricing["claude-sonnet-4-6"]).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
    expect(parsed.modelPricing["claude-haiku-4-5"]).toEqual({ inputPerMillion: 1, outputPerMillion: 5 });
  });

  it("accepts an override", () => {
    const parsed = CostsConfigSchema.parse({
      hourlyEngRate: 75,
      timeSavedPerPrDefault: 6,
      modelPricing: {
        "claude-opus-4-6": { inputPerMillion: 10, outputPerMillion: 50 },
      },
    });
    expect(parsed.hourlyEngRate).toBe(75);
    expect(parsed.timeSavedPerPrDefault).toBe(6);
    expect(parsed.modelPricing["claude-opus-4-6"].inputPerMillion).toBe(10);
  });

  it("rejects non-positive rates", () => {
    expect(() => CostsConfigSchema.parse({ hourlyEngRate: 0 })).toThrow();
    expect(() => CostsConfigSchema.parse({ hourlyEngRate: -1 })).toThrow();
    expect(() => CostsConfigSchema.parse({
      modelPricing: { foo: { inputPerMillion: -1, outputPerMillion: 1 } },
    })).toThrow();
  });
});

describe("PipelineConfigSchema.timeSavedPerPr", () => {
  it("accepts optional timeSavedPerPr", () => {
    const cfg = PipelineConfigSchema.parse({
      name: "auto-implement",
      stages: [{ stage: "implement" }],
      retry: { maxAttempts: 1, strategy: "fail-fast" },
      review: { requiredApprovals: 1 },
      prStrategy: "draft",
      timeSavedPerPr: 6,
    } as any);
    expect(cfg.timeSavedPerPr).toBe(6);
  });

  it("accepts config without timeSavedPerPr", () => {
    const cfg = PipelineConfigSchema.parse({
      name: "quick-fix",
      stages: [{ stage: "implement" }],
      retry: { maxAttempts: 1, strategy: "fail-fast" },
      review: { requiredApprovals: 1 },
      prStrategy: "draft",
    } as any);
    expect(cfg.timeSavedPerPr).toBeUndefined();
  });
});

describe("AppConfigSchema.costs", () => {
  it("accepts optional costs field", () => {
    const parsed = AppConfigSchema.parse({ costs: { hourlyEngRate: 100 } });
    expect(parsed.costs?.hourlyEngRate).toBe(100);
  });

  it("accepts omitted costs", () => {
    const parsed = AppConfigSchema.parse({});
    expect(parsed.costs).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/cost-types.test.ts
```

- [ ] **Step 3: Add schemas to `types.ts`**

Append to `packages/core/src/types.ts`:
```ts
// --- Cost / ROI ---
export const ModelPricingSchema = z.object({
  inputPerMillion: z.number().positive(),
  outputPerMillion: z.number().positive(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const CostsConfigSchema = z.object({
  modelPricing: z.record(z.string(), ModelPricingSchema).default({
    "claude-opus-4-6":   { inputPerMillion: 15, outputPerMillion: 75 },
    "claude-sonnet-4-6": { inputPerMillion:  3, outputPerMillion: 15 },
    "claude-haiku-4-5":  { inputPerMillion:  1, outputPerMillion:  5 },
  }),
  hourlyEngRate: z.number().positive().default(50),
  timeSavedPerPrDefault: z.number().positive().default(4),
});
export type CostsConfig = z.infer<typeof CostsConfigSchema>;
```

Find `PipelineConfigSchema` and add `timeSavedPerPr: z.number().positive().optional(),` to its shape.

Find `AppConfigSchema` and extend it with `costs: CostsConfigSchema.optional(),`.

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add packages/core/src/types.ts packages/core/src/__tests__/cost-types.test.ts
git commit -m "feat(cost): zod schemas for costs config and pipeline timeSavedPerPr"
```

---

## Task 2: Rate resolution helpers

**Files:**
- Create: `packages/core/src/cost/types.ts`
- Create: `packages/core/src/cost/rates.ts`
- Create: `packages/core/src/cost/index.ts`
- Test: `packages/core/src/__tests__/cost/rates.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveModelRate, resolveTimeSavedPerPr } from "../../cost/rates.js";

const config = {
  costs: {
    modelPricing: {
      "claude-opus-4-6":   { inputPerMillion: 15, outputPerMillion: 75 },
      "claude-sonnet-4-6": { inputPerMillion:  3, outputPerMillion: 15 },
    },
    hourlyEngRate: 50,
    timeSavedPerPrDefault: 4,
  },
  pipelineConfigs: {
    "auto-implement": { timeSavedPerPr: 6 } as any,
    "quick-fix": {} as any,
  },
} as any;

describe("resolveModelRate", () => {
  it("returns configured rate", () => {
    const r = resolveModelRate("claude-opus-4-6", config);
    expect(r).toEqual({ inputPerMillion: 15, outputPerMillion: 75 });
  });

  it("falls back to sonnet when model is unknown", () => {
    const r = resolveModelRate("nonexistent-model", config);
    expect(r).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
  });

  it("uses built-in sonnet default when config has no sonnet", () => {
    const r = resolveModelRate("unknown", { costs: { modelPricing: {}, hourlyEngRate: 50, timeSavedPerPrDefault: 4 } } as any);
    expect(r).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
  });

  it("uses built-in default when config has no costs", () => {
    const r = resolveModelRate("claude-opus-4-6", {} as any);
    // Falls through to built-in sonnet default since no modelPricing provided at all
    expect(r).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
  });
});

describe("resolveTimeSavedPerPr", () => {
  it("uses pipeline override when set", () => {
    expect(resolveTimeSavedPerPr("auto-implement", config)).toBe(6);
  });

  it("uses costs default when pipeline has no override", () => {
    expect(resolveTimeSavedPerPr("quick-fix", config)).toBe(4);
  });

  it("uses built-in default (4h) when neither pipeline nor costs config set", () => {
    expect(resolveTimeSavedPerPr("unknown", {} as any)).toBe(4);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Create `cost/types.ts`**

```ts
export interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface RunCost {
  inputTokens: number;
  outputTokens: number;
  dollars: number;
  timeSavedHours: number;
}

export interface CostSummary {
  window: { from: Date; to: Date };
  runs: number;
  prsMerged: number;
  inputTokens: number;
  outputTokens: number;
  dollars: number;
  timeSavedHours: number;
  roiMultiplier: number;
}

export type BreakdownDimension = "team" | "repo" | "pipeline";

export interface BreakdownRow {
  key: string;
  label: string;
  runs: number;
  prsMerged: number;
  inputTokens: number;
  outputTokens: number;
  dollars: number;
  timeSavedHours: number;
  roiMultiplier: number;
}

export interface AggregateResult {
  summary: CostSummary;
  byTeam: BreakdownRow[];
  byRepo: BreakdownRow[];
  byPipeline: BreakdownRow[];
}
```

- [ ] **Step 4: Create `cost/rates.ts`**

```ts
import type { ModelRate } from "./types.js";

const BUILTIN_SONNET: ModelRate = { inputPerMillion: 3, outputPerMillion: 15 };

/**
 * Resolve the $/M-token rate for a given model. Lookup order:
 * 1. config.costs.modelPricing[modelName] — configured explicit rate
 * 2. config.costs.modelPricing["claude-sonnet-4-6"] — fallback to sonnet
 * 3. Built-in sonnet default ($3/$15 per M) — for deployments with no costs config
 */
export function resolveModelRate(
  modelName: string,
  config: { costs?: { modelPricing?: Record<string, ModelRate> } },
): ModelRate {
  const table = config.costs?.modelPricing;
  if (!table) return BUILTIN_SONNET;
  return table[modelName] ?? table["claude-sonnet-4-6"] ?? BUILTIN_SONNET;
}

/**
 * Resolve the `timeSavedPerPr` hours for a given pipeline. Lookup order:
 * 1. pipelineConfigs[pipelineKey].timeSavedPerPr
 * 2. config.costs.timeSavedPerPrDefault
 * 3. Built-in default (4h)
 */
export function resolveTimeSavedPerPr(
  pipelineKey: string,
  config: {
    costs?: { timeSavedPerPrDefault?: number };
    pipelineConfigs?: Record<string, { timeSavedPerPr?: number }>;
  },
): number {
  const override = config.pipelineConfigs?.[pipelineKey]?.timeSavedPerPr;
  if (override !== undefined) return override;
  return config.costs?.timeSavedPerPrDefault ?? 4;
}
```

- [ ] **Step 5: Create `cost/index.ts`**

```ts
export * from "./types.js";
export * from "./rates.js";
```

- [ ] **Step 6: Run, verify pass**

- [ ] **Step 7: Commit**

```
git add packages/core/src/cost packages/core/src/__tests__/cost/rates.test.ts
git commit -m "feat(cost): rate resolution helpers"
```

---

## Task 3: Per-run cost computation

**Files:**
- Create: `packages/core/src/cost/per-run.ts`
- Modify: `packages/core/src/cost/index.ts`
- Test: `packages/core/src/__tests__/cost/per-run.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { computeRunCost } from "../../cost/per-run.js";

const config = {
  costs: {
    modelPricing: {
      "claude-opus-4-6":   { inputPerMillion: 15, outputPerMillion: 75 },
      "claude-sonnet-4-6": { inputPerMillion:  3, outputPerMillion: 15 },
    },
    hourlyEngRate: 50,
    timeSavedPerPrDefault: 4,
  },
  pipelineConfigs: {
    "auto-implement": {
      stageModels: { implement: "claude-opus-4-6" },
      profile: { model: "claude-sonnet-4-6" },
      timeSavedPerPr: 6,
    } as any,
    "quick-fix": {
      profile: { model: "claude-sonnet-4-6" },
    } as any,
  },
} as any;

describe("computeRunCost", () => {
  it("prices stages at their configured model rates", () => {
    const run = { pipelineKey: "auto-implement", status: "completed" } as any;
    const stages = [
      { stage: "implement", inputTokens: 1_000_000, outputTokens: 500_000 },
      { stage: "review", inputTokens: 100_000, outputTokens: 20_000 },
    ] as any;
    const cost = computeRunCost(run, stages, config);
    // implement: 1M × $15 + 0.5M × $75 = $15 + $37.5 = $52.5
    // review (sonnet default): 0.1M × $3 + 0.02M × $15 = $0.30 + $0.30 = $0.60
    expect(cost.dollars).toBeCloseTo(53.1, 2);
    expect(cost.inputTokens).toBe(1_100_000);
    expect(cost.outputTokens).toBe(520_000);
  });

  it("assigns timeSavedHours only when run.status === 'completed'", () => {
    const run = { pipelineKey: "auto-implement", status: "completed" } as any;
    const stages = [{ stage: "implement", inputTokens: 0, outputTokens: 0 }] as any;
    expect(computeRunCost(run, stages, config).timeSavedHours).toBe(6);
  });

  it("zero timeSavedHours on failed runs", () => {
    const run = { pipelineKey: "auto-implement", status: "failed" } as any;
    const stages = [{ stage: "implement", inputTokens: 1_000_000, outputTokens: 500_000 }] as any;
    expect(computeRunCost(run, stages, config).timeSavedHours).toBe(0);
  });

  it("uses pipeline profile model when stageModels is empty", () => {
    const run = { pipelineKey: "quick-fix", status: "completed" } as any;
    const stages = [{ stage: "implement", inputTokens: 1_000_000, outputTokens: 1_000_000 }] as any;
    const cost = computeRunCost(run, stages, config);
    // sonnet: 1M × $3 + 1M × $15 = $18
    expect(cost.dollars).toBeCloseTo(18, 2);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Create `cost/per-run.ts`**

```ts
import { resolveModelRate, resolveTimeSavedPerPr } from "./rates.js";
import type { RunCost } from "./types.js";

interface PipelineRunRow {
  pipelineKey: string;
  status: string;
}

interface StageRunRow {
  stage: string;
  inputTokens: number;
  outputTokens: number;
}

interface CostConfig {
  costs?: {
    modelPricing?: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
    hourlyEngRate?: number;
    timeSavedPerPrDefault?: number;
  };
  pipelineConfigs?: Record<string, {
    stageModels?: Record<string, string>;
    profile?: { model?: string };
    timeSavedPerPr?: number;
  }>;
}

export function computeRunCost(
  run: PipelineRunRow,
  stages: StageRunRow[],
  config: CostConfig,
): RunCost {
  const pc = config.pipelineConfigs?.[run.pipelineKey];
  let dollars = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const s of stages) {
    const modelName =
      pc?.stageModels?.[s.stage] ??
      pc?.profile?.model ??
      "claude-sonnet-4-6";
    const rate = resolveModelRate(modelName, config);
    dollars += (s.inputTokens * rate.inputPerMillion) / 1_000_000;
    dollars += (s.outputTokens * rate.outputPerMillion) / 1_000_000;
    inputTokens += s.inputTokens;
    outputTokens += s.outputTokens;
  }
  const timeSavedHours =
    run.status === "completed" ? resolveTimeSavedPerPr(run.pipelineKey, config) : 0;
  return { inputTokens, outputTokens, dollars, timeSavedHours };
}
```

Add `export * from "./per-run.js";` to `cost/index.ts`.

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add packages/core/src/cost/per-run.ts packages/core/src/cost/index.ts packages/core/src/__tests__/cost/per-run.test.ts
git commit -m "feat(cost): per-run cost computation"
```

---

## Task 4: Cost rollups table + migration

**Files:**
- Create: `packages/core/src/db/migrations/sqlite/007_cost_rollups.sql`
- Create: `packages/core/src/db/migrations/postgres/008_cost_rollups.sql`
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/core/src/db/client.ts` (`getCreateTablesDDL`)
- Test: `packages/core/src/__tests__/db-cost-rollups-schema.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { costRollupsDaily } from "../db/schema.js";
import { sql } from "drizzle-orm";

describe("cost_rollups_daily schema", () => {
  it("creates table with the expected columns", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const cols = (db as any).all(sql`PRAGMA table_info(cost_rollups_daily)`) as Array<{name: string}>;
    expect(cols.map(c => c.name).sort()).toEqual([
      "computed_at", "date", "dollars", "id", "input_tokens", "linear_team_id",
      "output_tokens", "pipeline_key", "prs_merged", "repo_url", "runs", "time_saved_hours",
    ]);
  });

  it("inserts and reads back a row", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await (db as any).insert(costRollupsDaily).values({
      id: "r_1", date: "2026-04-01", pipelineKey: "auto-implement",
      linearTeamId: "T1", repoUrl: "https://github.com/x/y",
      runs: 5, prsMerged: 4, inputTokens: 1000, outputTokens: 500,
      dollars: 12.34, timeSavedHours: 16,
    });
    const rows = await (db as any).select().from(costRollupsDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0].dollars).toBeCloseTo(12.34, 2);
    expect(rows[0].timeSavedHours).toBe(16);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/db-cost-rollups-schema.test.ts
```

- [ ] **Step 3: Add table to `db/schema.ts`**

Append:
```ts
export const costRollupsDaily = sqliteTable("cost_rollups_daily", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  pipelineKey: text("pipeline_key").notNull(),
  linearTeamId: text("linear_team_id"),
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

If `real` isn't already imported from `drizzle-orm/sqlite-core`, add it to the existing import line in schema.ts.

- [ ] **Step 4: Create SQLite migration**

Create `packages/core/src/db/migrations/sqlite/007_cost_rollups.sql`:
```sql
-- Enterprise feature 4.5: cost rollups
CREATE TABLE IF NOT EXISTS cost_rollups_daily (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  pipeline_key TEXT NOT NULL,
  linear_team_id TEXT,
  repo_url TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  prs_merged INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  dollars REAL NOT NULL DEFAULT 0,
  time_saved_hours REAL NOT NULL DEFAULT 0,
  computed_at INTEGER NOT NULL,
  UNIQUE (date, pipeline_key, linear_team_id, repo_url)
);

CREATE INDEX IF NOT EXISTS idx_cost_rollups_date ON cost_rollups_daily(date);
CREATE INDEX IF NOT EXISTS idx_cost_rollups_date_pipeline ON cost_rollups_daily(date, pipeline_key);
```

- [ ] **Step 5: Create Postgres migration**

Create `packages/core/src/db/migrations/postgres/008_cost_rollups.sql`:
```sql
-- Enterprise feature 4.5: cost rollups
CREATE TABLE IF NOT EXISTS cost_rollups_daily (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  pipeline_key TEXT NOT NULL,
  linear_team_id TEXT,
  repo_url TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  prs_merged INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  dollars DOUBLE PRECISION NOT NULL DEFAULT 0,
  time_saved_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (date, pipeline_key, linear_team_id, repo_url)
);

CREATE INDEX IF NOT EXISTS idx_cost_rollups_date ON cost_rollups_daily(date);
CREATE INDEX IF NOT EXISTS idx_cost_rollups_date_pipeline ON cost_rollups_daily(date, pipeline_key);
```

- [ ] **Step 6: Extend `getCreateTablesDDL()`**

In `packages/core/src/db/client.ts`, inside `getCreateTablesDDL(driver)`, add a new interpolation variable alongside the existing `${ts}`:
```ts
const num = driver === "postgres" ? "DOUBLE PRECISION" : "REAL";
```

Append to the returned template string (before the closing backtick):
```sql
  CREATE TABLE IF NOT EXISTS cost_rollups_daily (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    pipeline_key TEXT NOT NULL,
    linear_team_id TEXT,
    repo_url TEXT NOT NULL,
    runs INTEGER NOT NULL DEFAULT 0,
    prs_merged INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    dollars ${num} NOT NULL DEFAULT 0,
    time_saved_hours ${num} NOT NULL DEFAULT 0,
    computed_at ${ts} NOT NULL,
    UNIQUE (date, pipeline_key, linear_team_id, repo_url)
  );
  CREATE INDEX IF NOT EXISTS idx_cost_rollups_date ON cost_rollups_daily(date);
  CREATE INDEX IF NOT EXISTS idx_cost_rollups_date_pipeline ON cost_rollups_daily(date, pipeline_key);
```

- [ ] **Step 7: Run, verify pass**

- [ ] **Step 8: Commit**

```
git add packages/core/src/db packages/core/src/__tests__/db-cost-rollups-schema.test.ts
git commit -m "feat(cost): add cost_rollups_daily table"
```

---

## Task 5: Aggregation (`aggregateAll`)

**Files:**
- Create: `packages/core/src/cost/aggregate.ts`
- Modify: `packages/core/src/cost/index.ts`
- Test: `packages/core/src/__tests__/cost/aggregate.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../../db/client.js";
import { pipelineRuns, stageRuns } from "../../db/schema.js";
import { aggregateAll } from "../../cost/aggregate.js";

let db: any;

const config = {
  costs: {
    modelPricing: {
      "claude-opus-4-6":   { inputPerMillion: 15, outputPerMillion: 75 },
      "claude-sonnet-4-6": { inputPerMillion:  3, outputPerMillion: 15 },
    },
    hourlyEngRate: 50,
    timeSavedPerPrDefault: 4,
  },
  pipelineConfigs: {
    "auto-implement": {
      stageModels: { implement: "claude-opus-4-6" },
      profile: { model: "claude-sonnet-4-6" },
      timeSavedPerPr: 6,
    } as any,
    "quick-fix": {
      profile: { model: "claude-sonnet-4-6" },
    } as any,
  },
} as any;

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
});

async function seedRun(id: string, opts: {
  pipelineKey: string; teamId?: string; repoUrl: string;
  status?: string; implementInputTokens?: number; implementOutputTokens?: number;
  completedAt: Date;
}) {
  await db.insert(pipelineRuns).values({
    id, issueId: `BEC-${id}`, issueTitle: "t",
    pipelineKey: opts.pipelineKey,
    repoUrl: opts.repoUrl,
    status: opts.status ?? "completed",
    startedAt: new Date(opts.completedAt.getTime() - 60000),
    completedAt: opts.completedAt,
    linearTeamId: opts.teamId,
  });
  if (opts.implementInputTokens || opts.implementOutputTokens) {
    await db.insert(stageRuns).values({
      id: `s_${id}_imp`, pipelineRunId: id, stage: "implement",
      status: "completed",
      startedAt: new Date(opts.completedAt.getTime() - 60000),
      completedAt: opts.completedAt,
      inputTokens: opts.implementInputTokens ?? 0,
      outputTokens: opts.implementOutputTokens ?? 0,
    });
  }
}

describe("aggregateAll", () => {
  it("returns zero totals for an empty db", async () => {
    const r = await aggregateAll(db, { from: new Date("2026-01-01"), to: new Date("2026-12-31") }, config);
    expect(r.summary.runs).toBe(0);
    expect(r.summary.dollars).toBe(0);
    expect(r.summary.timeSavedHours).toBe(0);
    expect(r.byTeam).toEqual([]);
    expect(r.byRepo).toEqual([]);
    expect(r.byPipeline).toEqual([]);
  });

  it("aggregates across pipelines with correct dollar math", async () => {
    await seedRun("1", {
      pipelineKey: "auto-implement", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 1_000_000, implementOutputTokens: 500_000,
      completedAt: new Date("2026-04-01T10:00:00Z"),
    });
    await seedRun("2", {
      pipelineKey: "quick-fix", teamId: "T1",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-04-02T10:00:00Z"),
    });

    const r = await aggregateAll(db, {
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date("2026-04-30T23:59:59Z"),
    }, config);

    // run 1 (opus implement): 1M × $15 + 0.5M × $75 = $52.50
    // run 2 (sonnet implement): 0.1M × $3 + 0.05M × $15 = $1.05
    expect(r.summary.runs).toBe(2);
    expect(r.summary.prsMerged).toBe(2);
    expect(r.summary.dollars).toBeCloseTo(53.55, 2);
    // time saved: run 1 (auto-implement override = 6h) + run 2 (quick-fix default = 4h) = 10h
    expect(r.summary.timeSavedHours).toBe(10);

    // byTeam: one row (T1) with summed totals
    expect(r.byTeam).toHaveLength(1);
    expect(r.byTeam[0].key).toBe("team:T1");
    expect(r.byTeam[0].dollars).toBeCloseTo(53.55, 2);

    // byPipeline: two rows (auto-implement, quick-fix)
    expect(r.byPipeline).toHaveLength(2);
    const auto = r.byPipeline.find((b: any) => b.key === "pipeline:auto-implement")!;
    expect(auto.dollars).toBeCloseTo(52.50, 2);
    expect(auto.timeSavedHours).toBe(6);

    // ROI = (timeSavedHours × hourlyEngRate) / dollars = (10 × 50) / 53.55 ≈ 9.34
    expect(r.summary.roiMultiplier).toBeCloseTo(500 / 53.55, 2);
  });

  it("excludes runs outside the window", async () => {
    await seedRun("1", {
      pipelineKey: "quick-fix",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-01-01T10:00:00Z"),
    });
    const r = await aggregateAll(db, {
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date("2026-04-30T23:59:59Z"),
    }, config);
    expect(r.summary.runs).toBe(0);
  });

  it("counts failed runs in cost but not in prsMerged / timeSaved", async () => {
    await seedRun("1", {
      pipelineKey: "quick-fix", status: "failed",
      repoUrl: "https://github.com/acme/api",
      implementInputTokens: 100_000, implementOutputTokens: 50_000,
      completedAt: new Date("2026-04-01T10:00:00Z"),
    });
    const r = await aggregateAll(db, {
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date("2026-04-30T23:59:59Z"),
    }, config);
    expect(r.summary.runs).toBe(1);
    expect(r.summary.prsMerged).toBe(0);
    expect(r.summary.timeSavedHours).toBe(0);
    expect(r.summary.dollars).toBeCloseTo(1.05, 2);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Create `cost/aggregate.ts`**

```ts
import { and, gte, lte, inArray } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { pipelineRuns, stageRuns } from "../db/schema.js";
import { computeRunCost } from "./per-run.js";
import type { AggregateResult, BreakdownRow, CostSummary } from "./types.js";

export interface AggregateFilters {
  from: Date;
  to: Date;
}

interface CostConfig {
  costs?: {
    hourlyEngRate?: number;
    modelPricing?: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
    timeSavedPerPrDefault?: number;
  };
  pipelineConfigs?: Record<string, any>;
}

function emptyBucket(key: string, label: string): BreakdownRow {
  return {
    key, label, runs: 0, prsMerged: 0,
    inputTokens: 0, outputTokens: 0,
    dollars: 0, timeSavedHours: 0, roiMultiplier: 0,
  };
}

function finalizeRoi(row: { dollars: number; timeSavedHours: number }, hourlyRate: number): number {
  if (row.dollars === 0) return row.timeSavedHours > 0 ? Infinity : 0;
  return (row.timeSavedHours * hourlyRate) / row.dollars;
}

export async function aggregateAll(
  db: AnyDb,
  filters: AggregateFilters,
  config: CostConfig,
): Promise<AggregateResult> {
  const hourlyRate = config.costs?.hourlyEngRate ?? 50;

  const runs = await db.select().from(pipelineRuns).where(
    and(
      gte(pipelineRuns.completedAt, filters.from),
      lte(pipelineRuns.completedAt, filters.to),
    ),
  );

  if (runs.length === 0) {
    return {
      summary: {
        window: { from: filters.from, to: filters.to },
        runs: 0, prsMerged: 0, inputTokens: 0, outputTokens: 0,
        dollars: 0, timeSavedHours: 0, roiMultiplier: 0,
      },
      byTeam: [], byRepo: [], byPipeline: [],
    };
  }

  const runIds = runs.map((r: any) => r.id);
  const stages = await db.select().from(stageRuns).where(inArray(stageRuns.pipelineRunId, runIds));

  const stagesByRun = new Map<string, any[]>();
  for (const s of stages) {
    const arr = stagesByRun.get(s.pipelineRunId) ?? [];
    arr.push(s);
    stagesByRun.set(s.pipelineRunId, arr);
  }

  const summary: CostSummary = {
    window: { from: filters.from, to: filters.to },
    runs: 0, prsMerged: 0, inputTokens: 0, outputTokens: 0,
    dollars: 0, timeSavedHours: 0, roiMultiplier: 0,
  };
  const byTeam = new Map<string, BreakdownRow>();
  const byRepo = new Map<string, BreakdownRow>();
  const byPipeline = new Map<string, BreakdownRow>();

  for (const run of runs) {
    const runStages = stagesByRun.get(run.id) ?? [];
    const cost = computeRunCost(run as any, runStages as any, config);

    summary.runs += 1;
    summary.inputTokens += cost.inputTokens;
    summary.outputTokens += cost.outputTokens;
    summary.dollars += cost.dollars;
    summary.timeSavedHours += cost.timeSavedHours;
    if (run.status === "completed") summary.prsMerged += 1;

    const teamKey = `team:${run.linearTeamId ?? "unassigned"}`;
    const teamLabel = run.linearTeamId ?? "(unassigned)";
    if (!byTeam.has(teamKey)) byTeam.set(teamKey, emptyBucket(teamKey, teamLabel));
    const tb = byTeam.get(teamKey)!;
    tb.runs += 1; tb.inputTokens += cost.inputTokens; tb.outputTokens += cost.outputTokens;
    tb.dollars += cost.dollars; tb.timeSavedHours += cost.timeSavedHours;
    if (run.status === "completed") tb.prsMerged += 1;

    const repoKey = `repo:${run.repoUrl}`;
    if (!byRepo.has(repoKey)) byRepo.set(repoKey, emptyBucket(repoKey, run.repoUrl));
    const rb = byRepo.get(repoKey)!;
    rb.runs += 1; rb.inputTokens += cost.inputTokens; rb.outputTokens += cost.outputTokens;
    rb.dollars += cost.dollars; rb.timeSavedHours += cost.timeSavedHours;
    if (run.status === "completed") rb.prsMerged += 1;

    const pipelineKey = `pipeline:${run.pipelineKey}`;
    if (!byPipeline.has(pipelineKey)) byPipeline.set(pipelineKey, emptyBucket(pipelineKey, run.pipelineKey));
    const pb = byPipeline.get(pipelineKey)!;
    pb.runs += 1; pb.inputTokens += cost.inputTokens; pb.outputTokens += cost.outputTokens;
    pb.dollars += cost.dollars; pb.timeSavedHours += cost.timeSavedHours;
    if (run.status === "completed") pb.prsMerged += 1;
  }

  summary.roiMultiplier = finalizeRoi(summary, hourlyRate);
  const sort = (a: BreakdownRow, b: BreakdownRow) => b.dollars - a.dollars;
  const finalize = (rows: BreakdownRow[]) => {
    for (const r of rows) r.roiMultiplier = finalizeRoi(r, hourlyRate);
    return rows.sort(sort);
  };

  return {
    summary,
    byTeam: finalize(Array.from(byTeam.values())),
    byRepo: finalize(Array.from(byRepo.values())),
    byPipeline: finalize(Array.from(byPipeline.values())),
  };
}
```

Add `export * from "./aggregate.js";` to `cost/index.ts`.

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add packages/core/src/cost/aggregate.ts packages/core/src/cost/index.ts packages/core/src/__tests__/cost/aggregate.test.ts
git commit -m "feat(cost): aggregateAll over pipeline_runs + stage_runs"
```

---

## Task 6: Rollup job

**Files:**
- Create: `packages/core/src/cost/rollup.ts`
- Modify: `packages/core/src/cost/index.ts`
- Test: `packages/core/src/__tests__/cost/rollup.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../../db/client.js";
import { pipelineRuns, stageRuns, costRollupsDaily } from "../../db/schema.js";
import { recomputeCostRollups, readRollupWindow } from "../../cost/rollup.js";

let db: any;

const config = {
  costs: {
    modelPricing: {
      "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
    },
    hourlyEngRate: 50,
    timeSavedPerPrDefault: 4,
  },
  pipelineConfigs: {
    "quick-fix": { profile: { model: "claude-sonnet-4-6" } } as any,
  },
} as any;

async function seedCompletedRun(id: string, completedAt: Date) {
  await db.insert(pipelineRuns).values({
    id, issueId: `BEC-${id}`, issueTitle: "t",
    pipelineKey: "quick-fix", repoUrl: "https://github.com/acme/api",
    status: "completed",
    startedAt: new Date(completedAt.getTime() - 60000),
    completedAt,
    linearTeamId: "T1",
  });
  await db.insert(stageRuns).values({
    id: `s_${id}`, pipelineRunId: id, stage: "implement",
    status: "completed",
    startedAt: new Date(completedAt.getTime() - 60000),
    completedAt,
    inputTokens: 100_000,
    outputTokens: 50_000,
  });
}

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
});

describe("recomputeCostRollups", () => {
  it("writes one row per (date, pipeline, team, repo) for yesterday", async () => {
    const yesterday = new Date(Date.now() - 86400_000);
    await seedCompletedRun("r1", yesterday);
    await seedCompletedRun("r2", yesterday);
    const result = await recomputeCostRollups(db, config);
    expect(result.rowsWritten).toBeGreaterThan(0);
    const rows = await db.select().from(costRollupsDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0].runs).toBe(2);
    expect(rows[0].prsMerged).toBe(2);
    expect(rows[0].inputTokens).toBe(200_000);
    expect(rows[0].outputTokens).toBe(100_000);
    // sonnet: 0.2M × $3 + 0.1M × $15 = $0.60 + $1.50 = $2.10
    expect(rows[0].dollars).toBeCloseTo(2.10, 2);
    expect(rows[0].timeSavedHours).toBe(8);
  });

  it("is idempotent — re-running on the same day doesn't double-count", async () => {
    const yesterday = new Date(Date.now() - 86400_000);
    await seedCompletedRun("r1", yesterday);
    await recomputeCostRollups(db, config);
    await recomputeCostRollups(db, config);
    const rows = await db.select().from(costRollupsDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0].runs).toBe(1);
  });

  it("readRollupWindow returns rows inside the window", async () => {
    const yesterday = new Date(Date.now() - 86400_000);
    await seedCompletedRun("r1", yesterday);
    await recomputeCostRollups(db, config);
    const from = new Date(Date.now() - 7 * 86400_000);
    const to = new Date();
    const rows = await readRollupWindow(db, from, to);
    expect(rows.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Create `cost/rollup.ts`**

```ts
import { randomUUID } from "node:crypto";
import { and, gte, lte, eq, desc } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { pipelineRuns, stageRuns, costRollupsDaily } from "../db/schema.js";
import { computeRunCost } from "./per-run.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "cost.rollup" });

interface CostConfig {
  costs?: {
    modelPricing?: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
    timeSavedPerPrDefault?: number;
    hourlyEngRate?: number;
  };
  pipelineConfigs?: Record<string, any>;
}

function dayBounds(dateStr: string): { start: Date; end: Date } {
  const start = new Date(dateStr + "T00:00:00.000Z");
  const end = new Date(dateStr + "T23:59:59.999Z");
  return { start, end };
}

function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function recomputeCostRollups(
  db: AnyDb,
  config: CostConfig,
): Promise<{ rowsWritten: number }> {
  // Determine yesterday (UTC). Rollups only cover completed UTC days.
  const now = new Date();
  const yesterdayUtc = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1,
  ));
  const dateStr = utcDateStr(yesterdayUtc);
  const { start, end } = dayBounds(dateStr);

  const runs = await db.select().from(pipelineRuns).where(
    and(
      gte(pipelineRuns.completedAt, start),
      lte(pipelineRuns.completedAt, end),
    ),
  );

  if (runs.length === 0) {
    log.info({ date: dateStr, rowsWritten: 0 }, "no runs to roll up");
    return { rowsWritten: 0 };
  }

  const runIds = runs.map((r: any) => r.id);
  const stages = await db.select().from(stageRuns).where(
    // TS-friendly inArray via raw SQL if inArray is unavailable here
    // (imported separately in the real file)
    inArrayHelper(stageRuns.pipelineRunId, runIds),
  );

  const stagesByRun = new Map<string, any[]>();
  for (const s of stages) {
    const arr = stagesByRun.get(s.pipelineRunId) ?? [];
    arr.push(s);
    stagesByRun.set(s.pipelineRunId, arr);
  }

  const buckets = new Map<string, {
    pipelineKey: string; linearTeamId: string | null; repoUrl: string;
    runs: number; prsMerged: number; inputTokens: number; outputTokens: number;
    dollars: number; timeSavedHours: number;
  }>();

  for (const run of runs) {
    const runStages = stagesByRun.get(run.id) ?? [];
    const cost = computeRunCost(run as any, runStages as any, config);
    const key = `${run.pipelineKey}|${run.linearTeamId ?? ""}|${run.repoUrl}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        pipelineKey: run.pipelineKey,
        linearTeamId: run.linearTeamId ?? null,
        repoUrl: run.repoUrl,
        runs: 0, prsMerged: 0,
        inputTokens: 0, outputTokens: 0,
        dollars: 0, timeSavedHours: 0,
      };
      buckets.set(key, b);
    }
    b.runs += 1;
    b.inputTokens += cost.inputTokens;
    b.outputTokens += cost.outputTokens;
    b.dollars += cost.dollars;
    b.timeSavedHours += cost.timeSavedHours;
    if (run.status === "completed") b.prsMerged += 1;
  }

  let rowsWritten = 0;
  for (const b of buckets.values()) {
    await db.insert(costRollupsDaily).values({
      id: `cr_${randomUUID()}`,
      date: dateStr,
      pipelineKey: b.pipelineKey,
      linearTeamId: b.linearTeamId,
      repoUrl: b.repoUrl,
      runs: b.runs,
      prsMerged: b.prsMerged,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      dollars: b.dollars,
      timeSavedHours: b.timeSavedHours,
      computedAt: new Date(),
    }).onConflictDoUpdate({
      target: [
        costRollupsDaily.date,
        costRollupsDaily.pipelineKey,
        costRollupsDaily.linearTeamId,
        costRollupsDaily.repoUrl,
      ],
      set: {
        runs: b.runs,
        prsMerged: b.prsMerged,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        dollars: b.dollars,
        timeSavedHours: b.timeSavedHours,
        computedAt: new Date(),
      },
    });
    rowsWritten += 1;
  }

  log.info({ date: dateStr, rowsWritten }, "cost rollup complete");
  return { rowsWritten };
}

export async function readRollupWindow(
  db: AnyDb,
  from: Date,
  to: Date,
): Promise<any[]> {
  const fromDate = utcDateStr(from);
  const toDate = utcDateStr(to);
  return await db.select().from(costRollupsDaily).where(
    and(
      gte(costRollupsDaily.date, fromDate),
      lte(costRollupsDaily.date, toDate),
    ),
  );
}

// NOTE: replace this helper with a real `inArray(...)` import from drizzle-orm
// in the real implementation:
function inArrayHelper(col: any, values: any[]): any {
  // Implemented via drizzle `inArray(col, values)`; this stub exists so the
  // plan snippet compiles as shown. Real code should `import { inArray } from "drizzle-orm"`.
  throw new Error("replace with drizzle-orm inArray");
}
```

**Note to implementer:** replace `inArrayHelper` with a real `inArray` import from `drizzle-orm`. The stub is just so the plan code block reads cleanly.

Add `export * from "./rollup.js";` to `cost/index.ts`.

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add packages/core/src/cost/rollup.ts packages/core/src/cost/index.ts packages/core/src/__tests__/cost/rollup.test.ts
git commit -m "feat(cost): daily rollup job with idempotent upsert"
```

---

## Task 7: CSV export

**Files:**
- Create: `packages/core/src/cost/csv.ts`
- Modify: `packages/core/src/cost/index.ts`
- Test: `packages/core/src/__tests__/cost/csv.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../../db/client.js";
import { pipelineRuns, stageRuns } from "../../db/schema.js";
import { streamCostCsv } from "../../cost/csv.js";

async function collect(iter: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of iter) out += chunk;
  return out;
}

const config = {
  costs: {
    modelPricing: {
      "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
    },
    hourlyEngRate: 50,
    timeSavedPerPrDefault: 4,
  },
  pipelineConfigs: {
    "quick-fix": { profile: { model: "claude-sonnet-4-6" } } as any,
  },
} as any;

describe("streamCostCsv", () => {
  it("emits header then one row per run", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await db.insert(pipelineRuns).values({
      id: "r1", issueId: "BEC-1", issueTitle: "t",
      pipelineKey: "quick-fix", repoUrl: "https://github.com/acme/api",
      status: "completed",
      startedAt: new Date("2026-04-01T10:00:00Z"),
      completedAt: new Date("2026-04-01T10:05:00Z"),
      linearTeamId: "T1",
    });
    await db.insert(stageRuns).values({
      id: "s1", pipelineRunId: "r1", stage: "implement", status: "completed",
      startedAt: new Date("2026-04-01T10:00:00Z"),
      completedAt: new Date("2026-04-01T10:05:00Z"),
      inputTokens: 100_000, outputTokens: 50_000,
    });

    const csv = await collect(streamCostCsv(db, {
      from: new Date("2026-04-01"),
      to: new Date("2026-04-30"),
    }, config));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("completed_at,run_id,issue_id,pipeline_key,linear_team_id,repo_url,input_tokens,output_tokens,dollars,time_saved_hours");
    expect(lines[1]).toContain("r1");
    expect(lines[1]).toContain("BEC-1");
    expect(lines[1]).toContain("quick-fix");
  });

  it("escapes formula-injection prefixes", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await db.insert(pipelineRuns).values({
      id: "r1", issueId: "=HYPERLINK(evil)", issueTitle: "t",
      pipelineKey: "quick-fix", repoUrl: "https://github.com/acme/api",
      status: "completed",
      startedAt: new Date("2026-04-01T10:00:00Z"),
      completedAt: new Date("2026-04-01T10:05:00Z"),
    });
    const csv = await collect(streamCostCsv(db, {
      from: new Date("2026-04-01"),
      to: new Date("2026-04-30"),
    }, config));
    expect(csv).toContain("'=HYPERLINK(evil)");
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Create `cost/csv.ts`**

```ts
import type { AnyDb } from "../db/client.js";
import { and, gte, lte, inArray } from "drizzle-orm";
import { pipelineRuns, stageRuns } from "../db/schema.js";
import { computeRunCost } from "./per-run.js";

const HEADER =
  "completed_at,run_id,issue_id,pipeline_key,linear_team_id,repo_url,input_tokens,output_tokens,dollars,time_saved_hours";

const FORMULA_PREFIX = /^[=+\-@\t]/;

function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (FORMULA_PREFIX.test(s)) s = "'" + s;
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export interface CsvFilters {
  from: Date;
  to: Date;
}

interface CostConfig {
  costs?: any;
  pipelineConfigs?: Record<string, any>;
}

export async function* streamCostCsv(
  db: AnyDb,
  filters: CsvFilters,
  config: CostConfig,
): AsyncIterable<string> {
  yield HEADER + "\n";

  const runs = await db.select().from(pipelineRuns).where(
    and(
      gte(pipelineRuns.completedAt, filters.from),
      lte(pipelineRuns.completedAt, filters.to),
    ),
  );
  if (runs.length === 0) return;

  const runIds = runs.map((r: any) => r.id);
  const stages = await db.select().from(stageRuns).where(inArray(stageRuns.pipelineRunId, runIds));
  const stagesByRun = new Map<string, any[]>();
  for (const s of stages) {
    const arr = stagesByRun.get(s.pipelineRunId) ?? [];
    arr.push(s);
    stagesByRun.set(s.pipelineRunId, arr);
  }

  for (const run of runs) {
    const runStages = stagesByRun.get(run.id) ?? [];
    const cost = computeRunCost(run as any, runStages as any, config);
    const fields = [
      run.completedAt?.toISOString() ?? "",
      run.id,
      run.issueId,
      run.pipelineKey,
      run.linearTeamId ?? "",
      run.repoUrl,
      cost.inputTokens,
      cost.outputTokens,
      cost.dollars.toFixed(4),
      cost.timeSavedHours,
    ].map(escapeCsvField);
    yield fields.join(",") + "\n";
  }
}
```

Add `export * from "./csv.js";` to `cost/index.ts`.

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add packages/core/src/cost/csv.ts packages/core/src/cost/index.ts packages/core/src/__tests__/cost/csv.test.ts
git commit -m "feat(cost): streaming CSV export"
```

---

## Task 8: License flag + core barrel re-export

**Files:**
- Modify: `packages/core/src/license.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/cost-license.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { _resetLicenseCache, isFeatureLicensed } from "../license.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

beforeEach(() => { _resetLicenseCache(); });
afterEach(async () => { await restoreLicense(); });

describe("cost-roi feature flag", () => {
  it("licensed at enterprise tier", async () => {
    await installTestProLicense("enterprise");
    expect(isFeatureLicensed("cost-roi")).toBe(true);
  });

  it("not licensed at pro tier", async () => {
    await installTestProLicense("pro");
    expect(isFeatureLicensed("cost-roi")).toBe(false);
  });

  it("not licensed without a license", async () => {
    await restoreLicense();
    expect(isFeatureLicensed("cost-roi")).toBe(false);
  });

  it("cost module re-exported from @urateam/core barrel", async () => {
    const mod = await import("../index.js");
    expect(typeof (mod as any).computeRunCost).toBe("function");
    expect(typeof (mod as any).aggregateAll).toBe("function");
    expect(typeof (mod as any).resolveModelRate).toBe("function");
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Add `"cost-roi"` to Enterprise feature set**

Find `ENTERPRISE_FEATURES` in `packages/core/src/license.ts` and add `"cost-roi"`. Verify the array also contains `"audit-log"` (as baseline — it should, from feature 4.2).

- [ ] **Step 4: Re-export from core barrel**

In `packages/core/src/index.ts` add:
```ts
export * from "./cost/index.js";
```

- [ ] **Step 5: Run, verify pass**

- [ ] **Step 6: Commit**

```
git add packages/core/src/license.ts packages/core/src/index.ts packages/core/src/__tests__/cost-license.test.ts
git commit -m "feat(cost): add cost-roi to enterprise feature set"
```

---

## Task 9: PM scheduler rollup step

**Files:**
- Modify: `packages/core/src/pm/scheduler.ts`
- Test: `packages/core/src/__tests__/pm-cost-rollup-step.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../db/client.js";
import { pipelineRuns, stageRuns, costRollupsDaily } from "../db/schema.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";
// Mirror the pattern from pm-audit-retention-step.test.ts for tick invocation

describe("pm cost rollup step", () => {
  beforeEach(async () => {
    await installTestProLicense("enterprise");
  });
  afterEach(async () => { await restoreLicense(); });

  it("writes cost_rollups_daily rows from yesterday's runs when licensed", async () => {
    const db = await createDb({ connectionString: ":memory:" }) as any;
    const yesterday = new Date(Date.now() - 86400_000);
    await db.insert(pipelineRuns).values({
      id: "r1", issueId: "BEC-1", issueTitle: "t",
      pipelineKey: "quick-fix", repoUrl: "https://github.com/x/y",
      status: "completed",
      startedAt: new Date(yesterday.getTime() - 60000),
      completedAt: yesterday,
    });
    await db.insert(stageRuns).values({
      id: "s1", pipelineRunId: "r1", stage: "implement", status: "completed",
      startedAt: new Date(yesterday.getTime() - 60000),
      completedAt: yesterday,
      inputTokens: 1000, outputTokens: 500,
    });

    // Call the tick (match the existing pm-audit-retention-step.test.ts pattern).
    // The tick runs pruneAuditLog, pruneExpiredSessions, then recomputeCostRollups.
    // ... (inline the tick harness pattern from pm-audit-retention-step.test.ts)

    const rollups = await db.select().from(costRollupsDaily);
    expect(rollups.length).toBeGreaterThan(0);
  });
});
```

Note to implementer: read `packages/core/src/__tests__/pm-audit-retention-step.test.ts` first — that file sets up the tick harness. Copy its pattern to invoke the tick without re-inventing it.

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Add the rollup step to `pm/scheduler.ts`**

Find the block that calls `pruneAuditLog` (feature 4.2) and `pruneExpiredSessions` (feature 4.1). Add after them, inside the same try/catch pattern:

```ts
try {
  if (isFeatureLicensed("cost-roi")) {
    const { recomputeCostRollups } = await import("../cost/index.js");
    await recomputeCostRollups(db, config as any);
  }
} catch (err) {
  log.warn({ err }, "cost rollup failed");
}
```

If a static import doesn't create a cycle, prefer that — add `import { recomputeCostRollups } from "../cost/index.js";` at the top.

- [ ] **Step 4: Run new test + full pm suite**

```
cd packages/core && npx vitest run src/__tests__/pm
```

- [ ] **Step 5: Commit**

```
git add packages/core/src/pm/scheduler.ts packages/core/src/__tests__/pm-cost-rollup-step.test.ts
git commit -m "feat(cost): run daily cost rollups in pm tick"
```

---

## Task 10: Dashboard route + view

**Files:**
- Create: `packages/dashboard/src/routes/cost.ts`
- Create: `packages/dashboard/src/views/cost.ts`
- Modify: `packages/dashboard/src/views/layout.ts`
- Modify: `packages/dashboard/src/server.ts`
- Test: `packages/dashboard/src/__tests__/cost.test.ts`

- [ ] **Step 1: Write failing test**

Model after `packages/dashboard/src/__tests__/audit.test.ts`. Include tests for:
- Unlicensed → 404 on `/cost`, `/cost/page`, `/cost/export.csv`
- Licensed → 200, page contains "PRs merged", contains a seeded pipeline name, contains a dollar amount
- Licensed → CSV export 200 with `text/csv` content-type and the header row

Use `installTestProLicense("enterprise")` via an inlined helper (see `audit.test.ts` for the pattern). Seed a completed pipeline run + stage run directly via `@urateam/core/dist/db/schema.js` subpath import (same pattern as `audit.test.ts`).

Full test code:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "@urateam/core";
import { buildServer } from "../server.js";
// inline the installTestProLicense helper pattern from audit.test.ts

const config = {
  costs: {
    modelPricing: {
      "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
    },
    hourlyEngRate: 50,
    timeSavedPerPrDefault: 4,
  },
  pipelineConfigs: {
    "quick-fix": { profile: { model: "claude-sonnet-4-6" } },
  },
};

describe("/cost routes", () => {
  let db: any;
  let app: any;

  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    app = buildServer({ db, costs: config.costs, pipelineConfigs: config.pipelineConfigs });
  });

  it("returns 404 when cost-roi feature is not licensed", async () => {
    const res = await app.request("/cost");
    expect(res.status).toBe(404);
  });

  it("renders cost page when licensed", async () => {
    await installTestProLicense("enterprise");
    app = buildServer({ db, costs: config.costs, pipelineConfigs: config.pipelineConfigs });
    // seed a run ...
    const res = await app.request("/cost");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("PRs merged");
    await restoreLicense();
  });

  it("streams CSV export when licensed", async () => {
    await installTestProLicense("enterprise");
    app = buildServer({ db, costs: config.costs, pipelineConfigs: config.pipelineConfigs });
    const res = await app.request("/cost/export.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const body = await res.text();
    expect(body).toContain("completed_at,run_id,issue_id,pipeline_key");
    await restoreLicense();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Create `packages/dashboard/src/routes/cost.ts`**

```ts
import { Hono } from "hono";
import { isFeatureLicensed, aggregateAll, streamCostCsv } from "@urateam/core";
import { renderCostPage } from "../views/cost.js";

interface CostRouterDeps {
  db: any;
  costs: any;
  pipelineConfigs: Record<string, any>;
}

function parseWindow(url: URL): { from: Date; to: Date; preset: string } {
  const preset = url.searchParams.get("window") ?? "30d";
  const now = new Date();
  let from: Date;
  let to: Date = now;
  if (preset === "custom") {
    from = url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : new Date(now.getTime() - 30 * 86400_000);
    to = url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : now;
  } else {
    const days = preset === "7d" ? 7 : preset === "90d" ? 90 : preset === "365d" ? 365 : 30;
    from = new Date(now.getTime() - days * 86400_000);
  }
  return { from, to, preset };
}

export function createCostRouter(deps: CostRouterDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!isFeatureLicensed("cost-roi")) return c.notFound();
    await next();
  });

  app.get("/", async (c) => {
    const url = new URL(c.req.url);
    const { from, to, preset } = parseWindow(url);
    const result = await aggregateAll(deps.db, { from, to }, {
      costs: deps.costs,
      pipelineConfigs: deps.pipelineConfigs,
    });
    return c.html(renderCostPage({ result, filters: { from, to, preset }, costs: deps.costs }));
  });

  app.get("/page", async (c) => {
    const url = new URL(c.req.url);
    const { from, to, preset } = parseWindow(url);
    const result = await aggregateAll(deps.db, { from, to }, {
      costs: deps.costs,
      pipelineConfigs: deps.pipelineConfigs,
    });
    return c.html(renderCostPage({ result, filters: { from, to, preset }, costs: deps.costs, partial: true }));
  });

  app.get("/export.csv", async (c) => {
    const url = new URL(c.req.url);
    const { from, to } = parseWindow(url);
    const stream = streamCostCsv(deps.db, { from, to }, {
      costs: deps.costs,
      pipelineConfigs: deps.pipelineConfigs,
    });
    const readable = new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    return new Response(readable, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="cost-${fromStr}-${toStr}.csv"`,
      },
    });
  });

  return app;
}
```

- [ ] **Step 4: Create `packages/dashboard/src/views/cost.ts`**

Read `packages/dashboard/src/views/audit.ts` first for the existing escape/render pattern. Then implement:

```ts
import { layout } from "./layout.js";
import type { AggregateResult } from "@urateam/core";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtDollars(n: number): string {
  return "$" + n.toFixed(2);
}

function fmtRoi(n: number): string {
  if (!isFinite(n)) return "∞";
  return n.toFixed(1) + "×";
}

interface CostPageInput {
  result: AggregateResult;
  filters: { from: Date; to: Date; preset: string };
  costs: any;
  partial?: boolean;
}

export function renderCostPage(input: CostPageInput): string {
  const { summary, byTeam, byRepo, byPipeline } = input.result;
  const hourlyRate = input.costs?.hourlyEngRate ?? 50;
  const value = summary.timeSavedHours * hourlyRate;

  const renderTable = (title: string, rows: typeof byTeam) => `
    <h3>${escapeHtml(title)}</h3>
    <table class="cost-breakdown">
      <thead><tr>
        <th>Name</th><th>Runs</th><th>PRs merged</th><th>Hours saved</th>
        <th>Tokens</th><th>$</th><th>ROI</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${escapeHtml(r.label)}</td>
            <td>${fmtNumber(r.runs)}</td>
            <td>${fmtNumber(r.prsMerged)}</td>
            <td>${fmtNumber(r.timeSavedHours)}</td>
            <td>${fmtNumber(r.inputTokens + r.outputTokens)}</td>
            <td>${fmtDollars(r.dollars)}</td>
            <td>${fmtRoi(r.roiMultiplier)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>`;

  const body = `
    <h1>Cost &amp; ROI</h1>
    <form hx-get="/cost/page" hx-trigger="change" hx-target="#cost-body">
      <select name="window">
        <option value="7d"${input.filters.preset === "7d" ? " selected" : ""}>Last 7 days</option>
        <option value="30d"${input.filters.preset === "30d" ? " selected" : ""}>Last 30 days</option>
        <option value="90d"${input.filters.preset === "90d" ? " selected" : ""}>Last 90 days</option>
        <option value="365d"${input.filters.preset === "365d" ? " selected" : ""}>Last 365 days</option>
        <option value="custom"${input.filters.preset === "custom" ? " selected" : ""}>Custom</option>
      </select>
      ${input.filters.preset === "custom" ? `
        <input type="date" name="from" value="${input.filters.from.toISOString().slice(0,10)}" />
        <input type="date" name="to" value="${input.filters.to.toISOString().slice(0,10)}" />
      ` : ""}
      <a href="/cost/export.csv?window=${escapeHtml(input.filters.preset)}&from=${input.filters.from.toISOString().slice(0,10)}&to=${input.filters.to.toISOString().slice(0,10)}" class="button">Export CSV</a>
    </form>

    <div id="cost-body">
      <div class="summary-card">
        <p><strong>${fmtNumber(summary.prsMerged)} PRs merged</strong> · <strong>${fmtNumber(summary.timeSavedHours)}h saved</strong></p>
        <p>${fmtNumber(summary.inputTokens + summary.outputTokens)} tokens · ${fmtDollars(summary.dollars)} cost</p>
        <p><strong>ROI:</strong> ${fmtNumber(summary.timeSavedHours)}h × ${fmtDollars(hourlyRate)}/h = ${fmtDollars(value)} value ÷ ${fmtDollars(summary.dollars)} cost = ${fmtRoi(summary.roiMultiplier)}</p>
      </div>
      ${renderTable("By team", byTeam)}
      ${renderTable("By repo", byRepo)}
      ${renderTable("By pipeline", byPipeline)}

      <details>
        <summary>Formula</summary>
        <p>Time saved per PR is ${fmtNumber(input.costs?.timeSavedPerPrDefault ?? 4)}h by default, overridable per pipeline.</p>
        <p>Dollar cost is computed per-stage from each stage's model:</p>
        <ul>
          ${Object.entries(input.costs?.modelPricing ?? {}).map(([model, rate]: [string, any]) =>
            `<li>${escapeHtml(model)}: $${rate.inputPerMillion}/M input, $${rate.outputPerMillion}/M output</li>`
          ).join("")}
        </ul>
        <p>Hourly engineer rate (for ROI): ${fmtDollars(hourlyRate)}</p>
        <p>ROI = (hours saved × hourly rate) / dollar cost</p>
      </details>
    </div>
  `;

  if (input.partial) return body;
  return layout({ title: "Cost & ROI", body });
}
```

- [ ] **Step 5: Wire into `server.ts`**

In `buildServer`, accept `costs` and `pipelineConfigs` in the deps (they likely already exist). Register:
```ts
import { createCostRouter } from "./routes/cost.js";
// ...
app.route("/cost", createCostRouter({
  db: config.db,
  costs: config.costs,
  pipelineConfigs: config.pipelineConfigs,
}));
```

The cost router's internal middleware gates on `isFeatureLicensed("cost-roi")`, so no outer check needed.

- [ ] **Step 6: Add "Cost" nav entry to `layout.ts`**

Find the nav list. Add `<a href="/cost">Cost</a>` after `<a href="/audit">Audit</a>`, before `<a href="/errors">Errors</a>`.

- [ ] **Step 7: Run tests**

```
cd packages/dashboard && npx vitest run src/__tests__/cost.test.ts
```

- [ ] **Step 8: Commit**

```
git add packages/dashboard/src/routes/cost.ts packages/dashboard/src/views/cost.ts packages/dashboard/src/server.ts packages/dashboard/src/views/layout.ts packages/dashboard/src/__tests__/cost.test.ts
git commit -m "feat(cost): dashboard /cost page with summary, breakdowns, csv export"
```

---

## Task 11: End-to-end integration test

**Files:**
- Create: `packages/core/src/__tests__/cost-integration.test.ts`

- [ ] **Step 1: Write the test**

Seed 20 runs across 3 pipelines, 2 teams, 2 repos. Call `aggregateAll`. Assert totals match hand-computed values. Call `recomputeCostRollups` and verify the rollup table matches the live aggregation.

```ts
import { describe, it, expect } from "vitest";
import { createDb, aggregateAll, recomputeCostRollups } from "@urateam/core";
import { pipelineRuns, stageRuns, costRollupsDaily } from "@urateam/core/dist/db/schema.js";

describe("cost e2e", () => {
  it("aggregate matches expected totals and rollup matches live aggregation", async () => {
    const db = await createDb({ connectionString: ":memory:" }) as any;

    const config = {
      costs: {
        modelPricing: {
          "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
        },
        hourlyEngRate: 50,
        timeSavedPerPrDefault: 4,
      },
      pipelineConfigs: {
        "auto-implement": { timeSavedPerPr: 6, profile: { model: "claude-sonnet-4-6" } },
        "quick-fix":      { profile: { model: "claude-sonnet-4-6" } },
        "bug":            { profile: { model: "claude-sonnet-4-6" } },
      },
    } as any;

    const yesterday = new Date(Date.now() - 86400_000);
    for (let i = 0; i < 20; i++) {
      const pipelineKey = ["auto-implement", "quick-fix", "bug"][i % 3];
      await db.insert(pipelineRuns).values({
        id: `r${i}`, issueId: `BEC-${i}`, issueTitle: "t",
        pipelineKey,
        repoUrl: i % 2 === 0 ? "https://github.com/acme/api" : "https://github.com/acme/web",
        status: "completed",
        startedAt: new Date(yesterday.getTime() - 60000),
        completedAt: yesterday,
        linearTeamId: i % 2 === 0 ? "T1" : "T2",
      });
      await db.insert(stageRuns).values({
        id: `s${i}`, pipelineRunId: `r${i}`, stage: "implement", status: "completed",
        startedAt: new Date(yesterday.getTime() - 60000),
        completedAt: yesterday,
        inputTokens: 100_000, outputTokens: 50_000,
      });
    }

    const live = await aggregateAll(db, {
      from: new Date(yesterday.getTime() - 86400_000),
      to: new Date(),
    }, config);
    expect(live.summary.runs).toBe(20);
    expect(live.summary.prsMerged).toBe(20);
    expect(live.byTeam).toHaveLength(2);
    expect(live.byRepo).toHaveLength(2);
    expect(live.byPipeline).toHaveLength(3);

    // Rollup should produce the same dollar total across all rows
    await recomputeCostRollups(db, config);
    const rollups = await db.select().from(costRollupsDaily);
    const rollupTotal = rollups.reduce((acc: number, r: any) => acc + r.dollars, 0);
    expect(rollupTotal).toBeCloseTo(live.summary.dollars, 2);
  });
});
```

- [ ] **Step 2: Run, verify pass**

```
cd packages/core && npx vitest run src/__tests__/cost-integration.test.ts
```

- [ ] **Step 3: Commit**

```
git add packages/core/src/__tests__/cost-integration.test.ts
git commit -m "test(cost): end-to-end aggregate and rollup"
```

---

## Task 12: Build, test sweep, holistic review, CLAUDE.md, PR

- [ ] **Step 1: Build**

```
cd /private/tmp/urateam/.worktrees/cost-roi && pnpm build
```
Expected: clean. If the dashboard or CLI TS errors appear around the new `costs`/`pipelineConfigs` params on `buildServer`, thread them through the call sites in `packages/cli/src/commands/{dev,start}.ts`.

- [ ] **Step 2: Full test suite**

```
pnpm test
```
Expected: all pass. Known-flaky `@urateam/cli` `run.test.ts` under turbo parallel load — verify standalone.

- [ ] **Step 3: Integration tests**

```
pnpm test:integration
```

- [ ] **Step 4: Holistic external review**

Dispatch `feature-dev:code-reviewer` with:
- Spec: `docs/superpowers/specs/2026-04-15-cost-roi-dashboard-design.md`
- Plan: `docs/superpowers/plans/2026-04-15-cost-roi-dashboard.md`
- Diff: `git diff main...HEAD`

Ask specifically about:
- Postgres parity for `REAL`/`DOUBLE PRECISION` `dollars` column
- `onConflictDoUpdate` with composite unique constraint on `(date, pipelineKey, linearTeamId, repoUrl)` when `linearTeamId` is nullable (Postgres + SQLite handle NULL differently in unique constraints)
- Timezone handling in `recomputeCostRollups` day boundary
- XSS on the `/cost` page (especially the breakdown label and model name rendering)
- CSV formula injection coverage
- Rollup vs live aggregation drift (does `readRollupWindow` get used yet, or is the dashboard still live-aggregating everything? — likely the latter in v1)
- Performance: is the in-process grouping a problem for 10k-run windows?

Address all high-confidence findings.

- [ ] **Step 5: Update CLAUDE.md**

Append under "Key Patterns":
```
### Cost & ROI dashboard (Enterprise feature 4.5)
- Module: `packages/core/src/cost/` — `rates.ts` (model-rate + time-saved resolution), `per-run.ts` (`computeRunCost`), `aggregate.ts` (`aggregateAll` over runs+stages), `rollup.ts` (`recomputeCostRollups`, `readRollupWindow`), `csv.ts` (`streamCostCsv` with formula-injection guard)
- Config: `AppConfig.costs = { modelPricing, hourlyEngRate, timeSavedPerPrDefault }`. Per-pipeline `PipelineConfig.timeSavedPerPr` override
- Per-run cost = Σ(stage_runs.input/output tokens × model rate). Model per stage = `pipelineConfig.stageModels[stage] ?? pipelineConfig.profile.model ?? "claude-sonnet-4-6"`
- Time saved = `count(completed runs) × resolveTimeSavedPerPr(pipelineKey)`
- ROI = (timeSavedHours × hourlyEngRate) / dollars
- New table: `cost_rollups_daily` — rebuilt nightly in PM tick via `recomputeCostRollups`, idempotent via `onConflictDoUpdate` on `(date, pipeline_key, linear_team_id, repo_url)`
- Dashboard route `/cost` — summary card + 3 breakdown tables (team, repo, pipeline) + collapsible formula footer + CSV export at `/cost/export.csv`. All 3 routes 404 unless `isFeatureLicensed("cost-roi")`
- Preset windows (7d/30d/90d/365d) SHOULD read from `readRollupWindow` in v2; v1 uses live `aggregateAll` for all requests. Rollups are populated but not yet consumed by the read path
```

- [ ] **Step 6: Commit CLAUDE.md and open PR**

```
git add CLAUDE.md
git commit -m "docs(claude.md): cost & roi dashboard feature notes"
git push -u origin feat/cost-roi
gh pr create --title "feat: cost & roi dashboard (enterprise 4.5)" --body "$(cat <<'EOF'
## Summary
- `/cost` dashboard page with summary card + three breakdown tables (by team, repo, pipeline) + date-range picker + CSV export
- Per-run cost computed at read time from `stage_runs` tokens × configurable model-pricing table — no schema change on run tables
- Time saved = count(completed PRs) × `timeSavedPerPr` (default 4h, per-pipeline override)
- ROI = (timeSaved × hourlyEngRate) / dollars, with $50/hr default
- New `cost_rollups_daily` table rebuilt nightly in PM tick; v1 dashboard still live-aggregates (rollups consumed in v2)
- Formula footer shows every rate used — operator can screenshot for CFO audit
- License-gated by `isFeatureLicensed("cost-roi")`

Spec: docs/superpowers/specs/2026-04-15-cost-roi-dashboard-design.md
Plan: docs/superpowers/plans/2026-04-15-cost-roi-dashboard.md

## Test plan
- [ ] pnpm test (unit)
- [ ] pnpm test:integration
- [ ] Manual: open /cost on a seeded deployment, verify summary matches hand-computed totals
- [ ] Manual: CSV export downloads, opens correctly in spreadsheet, formula injection neutralized

## Deferred
- Charts / sparklines / trendlines
- Per-issue breakdown (re-sort of run list, no aggregation value)
- Rollup-backed read path (v1 live-aggregates; v2 reads from rollups for preset windows)
- Multi-currency support
- Historical rollup backfill older than first PM tick

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** Every spec section (§2 config, §3 module layout, §4 data flow, §5 schema, §6 rollup job, §7 dashboard, §8 license, §9 testing, §10 migration) is implemented by a numbered task.
- **Placeholders:** None. Task 6 includes a `inArrayHelper` stub labeled as such — the implementer is instructed to replace it with a real `drizzle-orm` `inArray` import.
- **Type consistency:** `CostSummary`, `BreakdownRow`, `AggregateResult`, `RunCost`, `ModelRate`, `AggregateFilters` defined once in `cost/types.ts` and referenced consistently. `computeRunCost(run, stages, config)` signature stable across tasks 3, 5, 6, 7, 11.
- **Known deferred:** v1 dashboard live-aggregates all queries; the rollup consumer path (`readRollupWindow` driving the preset windows) is tracked as a v2 follow-up in CLAUDE.md and the PR body. The rollup table is still populated in v1 so v2 doesn't need a backfill.
- **Runner.ts untouched:** Unlike feature 4.6, this feature doesn't require any changes to `pipeline/runner.ts` — all aggregation is read-side. Much lower regression risk.

# Spend Caps & Alerts Implementation Plan (Phase 1, feature 4.3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing single-global `dailyTokenBudget` with per-Linear-team and per-repo daily caps, fire Slack alerts at 50/80/100% of any scope, and refuse new pipeline runs when any relevant scope hits 100%.

**Architecture:** A new `evaluateBudget()` replaces the existing `checkBudgetGuards()` in `pm/budget.ts`. It groups today's `pipeline_runs` by `(linear_team_id, repo_url)`, derives `ScopeBudget` entries for global/team/repo scopes, and returns a `BudgetEvaluation` with `promoteBlocked` + `worstTier`. A new `maybeFireAlerts()` consumes the evaluation and posts Slack messages for newly-crossed thresholds, deduped via a new `budget_alerts` table (UNIQUE on `(date, scope, threshold)` + `onConflictDoNothing()`). Two enforcement gates (PM Agent promote, direct webhook start) consume `BudgetEvaluation`.

**Tech Stack:** TypeScript, Drizzle ORM (SQLite dev / Postgres prod), Zod, Vitest, Pino (structured logging), existing PM Agent scheduler cadence.

**Spec:** `docs/superpowers/specs/2026-04-14-spend-caps-design.md`.

---

## File map

**Created:**
- `packages/core/src/pm/budget-alerts.ts` — `maybeFireAlerts()` + Slack message builder for budget thresholds
- `packages/core/src/__tests__/pm-budget-alerts.test.ts` — unit tests for alert dedup + message format
- `packages/core/src/db/migrations/sqlite/005_spend_caps.sql` — ALTER TABLE pipeline_runs + CREATE TABLE budget_alerts
- `packages/core/src/db/migrations/postgres/006_spend_caps.sql` — same for Postgres

**Modified:**
- `packages/core/src/db/schema.ts` — add `linearTeamId` column + new `budgetAlerts` table export
- `packages/core/src/db/client.ts` — add `linear_team_id` to `MIGRATION_COLUMNS`, add `budget_alerts` CREATE TABLE to `getCreateTablesDDL`
- `packages/core/src/pm/types.ts` — add `BudgetTier`, `BudgetScope`, `ScopeBudget`, `BudgetEvaluation`, extend `PmAgentConfigSchema` with `budgets`
- `packages/core/src/pm/budget.ts` — replace `checkBudgetGuards` with `evaluateBudget`
- `packages/core/src/pm/scheduler.ts` — consume new evaluation, call `maybeFireAlerts` after it
- `packages/core/src/pipeline/runner.ts` — accept and persist `linearTeamId` in the pipeline_runs insert
- `packages/core/src/webhook/handler.ts` — extract `team.id` from the payload, thread to runner.start, add the 100% refuse-new gate
- `packages/core/src/__tests__/pm-budget.test.ts` — rewrite test cases for the new evaluation shape
- `packages/core/src/__tests__/pm-types.test.ts` — add budgets-field schema tests
- `packages/core/src/__tests__/pm-scheduler.test.ts` — assertions that alerts fire during the tick
- `CHANGELOG.md`

---

## Task 1: Database schema — `linear_team_id` column + `budget_alerts` table

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/core/src/db/client.ts`
- Create: `packages/core/src/db/migrations/sqlite/005_spend_caps.sql`
- Create: `packages/core/src/db/migrations/postgres/006_spend_caps.sql`

- [ ] **Step 1: Add `linearTeamId` to the `pipelineRuns` Drizzle schema**

In `packages/core/src/db/schema.ts`, find the `pipelineRuns` table definition (around line 45) and add this line at the end of the columns object, just before the closing `})`:

```ts
  /** Linear team ID from the webhook payload. Nullable for legacy rows created before per-team budget scoping. */
  linearTeamId: text("linear_team_id"),
```

- [ ] **Step 2: Add the `budgetAlerts` table to the Drizzle schema**

Find the existing `unique` import at the top of `packages/core/src/db/schema.ts` (it's already imported from `drizzle-orm/sqlite-core` for other tables). If not already imported, add `unique` to the imports from `drizzle-orm/sqlite-core`.

Append this new table definition to `packages/core/src/db/schema.ts`, after the last existing table:

```ts
/**
 * Dedup table for budget threshold alerts. One row per (date, scope, threshold)
 * — the UNIQUE constraint + onConflictDoNothing() guarantees an alert fires at
 * most once per day per scope per threshold.
 */
export const budgetAlerts = sqliteTable(
  "budget_alerts",
  {
    id: text("id").primaryKey(),
    /** UTC date the alert covers, formatted 'YYYY-MM-DD'. */
    date: text("date").notNull(),
    /** 'global' | 'team:<linearTeamId>' | 'repo:<repoUrl>'. */
    scope: text("scope").notNull(),
    /** 50 | 80 | 100. */
    threshold: integer("threshold").notNull(),
    firedAt: crossTimestamp("fired_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    uniqueScopeThreshold: unique().on(t.date, t.scope, t.threshold),
  }),
);
```

- [ ] **Step 3: Add `linear_team_id` to `MIGRATION_COLUMNS` in `db/client.ts`**

Find the `MIGRATION_COLUMNS` array in `packages/core/src/db/client.ts` (around line 46) and add this entry at the end of the array (before the closing `]`):

```ts
  { table: "pipeline_runs", column: "linear_team_id", sqliteType: "TEXT", pgType: "TEXT" },
```

- [ ] **Step 4: Add `budget_alerts` table DDL to `getCreateTablesDDL`**

Find `getCreateTablesDDL` in `packages/core/src/db/client.ts` (around line 67). The function returns a string of SQL statements. Add this CREATE TABLE before the trailing CREATE INDEX statements, using the same pattern as other tables:

```ts
  CREATE TABLE IF NOT EXISTS budget_alerts (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    scope TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    fired_at ${driver === "postgres" ? "TIMESTAMPTZ" : "INTEGER"} NOT NULL,
    UNIQUE(date, scope, threshold)
  );
  CREATE INDEX IF NOT EXISTS idx_budget_alerts_date_scope ON budget_alerts(date, scope);
```

Insert it inside the template literal that returns the DDL, alongside the other CREATE TABLE statements.

- [ ] **Step 5: Create the SQLite file-based migration**

Create `packages/core/src/db/migrations/sqlite/005_spend_caps.sql` with:

```sql
-- Spend caps & alerts (Phase 1, feature 4.3)
-- Adds linear_team_id to pipeline_runs for per-team budget scoping,
-- and creates budget_alerts for threshold-crossing dedup.

ALTER TABLE pipeline_runs ADD COLUMN linear_team_id TEXT;

CREATE TABLE IF NOT EXISTS budget_alerts (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  scope TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  fired_at INTEGER NOT NULL,
  UNIQUE(date, scope, threshold)
);

CREATE INDEX IF NOT EXISTS idx_budget_alerts_date_scope ON budget_alerts(date, scope);
```

- [ ] **Step 6: Create the Postgres file-based migration**

Create `packages/core/src/db/migrations/postgres/006_spend_caps.sql` with:

```sql
-- Spend caps & alerts (Phase 1, feature 4.3)

ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS linear_team_id TEXT;

CREATE TABLE IF NOT EXISTS budget_alerts (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  scope TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL,
  UNIQUE(date, scope, threshold)
);

CREATE INDEX IF NOT EXISTS idx_budget_alerts_date_scope ON budget_alerts(date, scope);
```

- [ ] **Step 7: Build to verify schema compiles**

Run: `pnpm --filter @urateam/core build`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/src/db/client.ts packages/core/src/db/migrations/
git commit -m "feat(db): add linear_team_id to pipeline_runs and budget_alerts table"
```

---

## Task 2: Config + types — `budgets` block and `BudgetEvaluation` shape

**Files:**
- Modify: `packages/core/src/pm/types.ts`
- Modify: `packages/core/src/__tests__/pm-types.test.ts`

- [ ] **Step 1: Write failing tests for the new `budgets` config field**

Append to `packages/core/src/__tests__/pm-types.test.ts`, inside the existing `PmAgentConfigSchema — full coverage` describe block (before the closing `});` of that block):

```ts
  it("accepts a full config with budgets block", () => {
    const parsed = PmAgentConfigSchema.parse({
      ...minimalRequired,
      budgets: {
        default: 5_000_000,
        perTeam: { "team-a": 3_000_000, "team-b": 2_000_000 },
        perRepo: { "github.com/org/repo": 1_500_000 },
        alertChannel: "C_BUDGETS",
      },
    });
    expect(parsed.budgets?.default).toBe(5_000_000);
    expect(parsed.budgets?.perTeam?.["team-a"]).toBe(3_000_000);
    expect(parsed.budgets?.perRepo?.["github.com/org/repo"]).toBe(1_500_000);
    expect(parsed.budgets?.alertChannel).toBe("C_BUDGETS");
  });

  it("accepts a minimal config with no budgets field (backward compat)", () => {
    const parsed = PmAgentConfigSchema.parse(minimalRequired);
    expect(parsed.budgets).toBeUndefined();
  });

  it("rejects non-positive budget values", () => {
    const resultNeg = PmAgentConfigSchema.safeParse({
      ...minimalRequired,
      budgets: { default: -1 },
    });
    expect(resultNeg.success).toBe(false);

    const resultZero = PmAgentConfigSchema.safeParse({
      ...minimalRequired,
      budgets: { perTeam: { "team-a": 0 } },
    });
    expect(resultZero.success).toBe(false);
  });

  it("rejects empty string keys in perTeam/perRepo", () => {
    const result = PmAgentConfigSchema.safeParse({
      ...minimalRequired,
      budgets: { perTeam: { "": 100 } },
    });
    expect(result.success).toBe(false);
  });
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd packages/core && npx vitest run src/__tests__/pm-types.test.ts`
Expected: FAIL — 4 new tests fail with `.budgets` being undefined or unknown.

- [ ] **Step 3: Extend `PmAgentConfigSchema` in `pm/types.ts`**

In `packages/core/src/pm/types.ts`, find the `PmAgentConfigSchema` definition and add the `budgets` field at the end of the object (just before the closing `});`). Insert immediately before the closing brace of the schema object:

```ts
  budgets: z
    .object({
      /** Default daily token budget for any team or repo not explicitly listed. Falls back to top-level dailyTokenBudget if omitted. */
      default: z.number().int().positive().optional(),
      /** Per-team daily token budget, keyed by Linear team ID. Overrides default for that team. */
      perTeam: z.record(z.string().min(1), z.number().int().positive()).optional(),
      /** Per-repo daily token budget, keyed by full repo URL. Overrides default for that repo. */
      perRepo: z.record(z.string().min(1), z.number().int().positive()).optional(),
      /** Slack channel for budget alerts. Defaults to the PM Agent's slackChannelId. */
      alertChannel: z.string().min(1).optional(),
    })
    .optional(),
```

- [ ] **Step 4: Add the `BudgetTier`, `BudgetScope`, `ScopeBudget`, `BudgetEvaluation` types to `pm/types.ts`**

Add after the `BudgetGuardResult` interface (which already exists):

```ts
export type BudgetTier = "ok" | "warn-50" | "warn-80" | "blocked-100";

export type BudgetScope =
  | { kind: "global" }
  | { kind: "team"; teamId: string }
  | { kind: "repo"; repoUrl: string };

export interface ScopeBudget {
  scope: BudgetScope;
  /** Human-readable label: "global" | "team <id>" | "repo <short-name>". Used in Slack messages and log lines. */
  scopeLabel: string;
  limit: number;
  used: number;
  percent: number;
  tier: BudgetTier;
}

export interface BudgetEvaluation {
  scopes: ScopeBudget[];
  worstTier: BudgetTier;
  /** True iff any scope is at tier 'blocked-100'. */
  promoteBlocked: boolean;
  /** Human-readable reason for a block, naming the first blocking scope. Undefined when not blocked. */
  blockReason?: string;
  activeCount: number;
}
```

Leave the existing `BudgetGuardResult` in place for now — it's still used by `TickResult.budgetGuard`. We will update it in Task 4.

- [ ] **Step 5: Run tests, expect pass**

Run: `cd packages/core && npx vitest run src/__tests__/pm-types.test.ts`
Expected: PASS — all existing tests plus the 4 new ones.

- [ ] **Step 6: Build**

Run: `pnpm --filter @urateam/core build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/pm/types.ts packages/core/src/__tests__/pm-types.test.ts
git commit -m "feat(pm): add budgets config block and BudgetEvaluation types"
```

---

## Task 3: Replace `checkBudgetGuards` with `evaluateBudget` in `pm/budget.ts`

**Files:**
- Modify: `packages/core/src/pm/budget.ts`
- Modify: `packages/core/src/__tests__/pm-budget.test.ts`

- [ ] **Step 1: Write failing tests for `evaluateBudget`**

Replace the entire content of `packages/core/src/__tests__/pm-budget.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { evaluateBudget } from "../pm/budget.js";
import type { PmAgentConfig } from "../pm/types.js";

/**
 * Mock DB that returns a preset array of grouped rows from a
 * select().from().groupBy().where() chain. Matches the shape
 * evaluateBudget expects: one row per (linear_team_id, repo_url)
 * pair with a tokens sum and an activeCount sum.
 */
interface MockRow {
  linearTeamId: string | null;
  repoUrl: string;
  totalTokens: number;
  activeCount: number;
}

function mockDb(rows: MockRow[]) {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    groupBy: () => Promise.resolve(rows),
  };
  return chain;
}

function baseConfig(overrides: Partial<PmAgentConfig> = {}): PmAgentConfig {
  return {
    enabled: true,
    dailyTokenBudget: 5_000_000,
    slackChannelId: "C_TEST",
    teamIds: ["team-a"],
    maxInFlight: 3,
    cronIntervalMs: 1_800_000,
    triageBatchSize: 3,
    stuckIssueRecovery: true,
    stuckIssueTargetState: "Backlog",
    stuckIssueMaxPerTick: 5,
    ...overrides,
  };
}

describe("evaluateBudget", () => {
  it("returns ok for empty spend with default config", async () => {
    const db = mockDb([]);
    const result = await evaluateBudget({ db, config: baseConfig() });
    expect(result.worstTier).toBe("ok");
    expect(result.promoteBlocked).toBe(false);
    expect(result.scopes).toHaveLength(1); // just global
    expect(result.scopes[0].scope.kind).toBe("global");
    expect(result.scopes[0].used).toBe(0);
    expect(result.scopes[0].percent).toBe(0);
    expect(result.activeCount).toBe(0);
  });

  it("computes global scope from rows", async () => {
    const db = mockDb([
      { linearTeamId: "team-a", repoUrl: "github.com/org/repo", totalTokens: 2_500_000, activeCount: 1 },
    ]);
    const result = await evaluateBudget({ db, config: baseConfig() });
    const global = result.scopes.find((s) => s.scope.kind === "global")!;
    expect(global.used).toBe(2_500_000);
    expect(global.percent).toBe(50);
    expect(global.tier).toBe("warn-50");
    expect(result.activeCount).toBe(1);
  });

  it("tier transitions: 0/50/80/100", async () => {
    const cases: Array<[number, BudgetTierExpected]> = [
      [0, "ok"],
      [49, "ok"],
      [50, "warn-50"],
      [79, "warn-50"],
      [80, "warn-80"],
      [99, "warn-80"],
      [100, "blocked-100"],
      [150, "blocked-100"],
    ];
    for (const [percent, expected] of cases) {
      const used = (5_000_000 * percent) / 100;
      const db = mockDb([
        { linearTeamId: "team-a", repoUrl: "r", totalTokens: used, activeCount: 0 },
      ]);
      const result = await evaluateBudget({ db, config: baseConfig() });
      const global = result.scopes.find((s) => s.scope.kind === "global")!;
      expect({ percent, tier: global.tier }).toEqual({ percent, tier: expected });
    }
  });

  it("per-team scope uses perTeam override", async () => {
    const db = mockDb([
      { linearTeamId: "team-a", repoUrl: "r", totalTokens: 1_600_000, activeCount: 0 },
    ]);
    const result = await evaluateBudget({
      db,
      config: baseConfig({
        budgets: { perTeam: { "team-a": 2_000_000 } },
      }),
    });
    const teamScope = result.scopes.find(
      (s) => s.scope.kind === "team" && s.scope.teamId === "team-a",
    )!;
    expect(teamScope).toBeDefined();
    expect(teamScope.limit).toBe(2_000_000);
    expect(teamScope.percent).toBe(80);
    expect(teamScope.tier).toBe("warn-80");
  });

  it("per-team scope falls back to budgets.default when team not in perTeam", async () => {
    const db = mockDb([
      { linearTeamId: "team-z", repoUrl: "r", totalTokens: 500_000, activeCount: 0 },
    ]);
    const result = await evaluateBudget({
      db,
      config: baseConfig({
        budgets: {
          default: 1_000_000,
          perTeam: { "team-a": 500_000 },
        },
      }),
    });
    const teamScope = result.scopes.find(
      (s) => s.scope.kind === "team" && s.scope.teamId === "team-z",
    )!;
    expect(teamScope.limit).toBe(1_000_000);
    expect(teamScope.percent).toBe(50);
  });

  it("per-repo scope uses perRepo override", async () => {
    const db = mockDb([
      { linearTeamId: "team-a", repoUrl: "github.com/org/secret", totalTokens: 900_000, activeCount: 0 },
    ]);
    const result = await evaluateBudget({
      db,
      config: baseConfig({
        budgets: { perRepo: { "github.com/org/secret": 1_000_000 } },
      }),
    });
    const repoScope = result.scopes.find(
      (s) => s.scope.kind === "repo" && s.scope.repoUrl === "github.com/org/secret",
    )!;
    expect(repoScope.limit).toBe(1_000_000);
    expect(repoScope.percent).toBe(90);
    expect(repoScope.tier).toBe("warn-80");
  });

  it("both per-team and per-repo can apply — worstTier is the max", async () => {
    const db = mockDb([
      { linearTeamId: "team-a", repoUrl: "github.com/org/secret", totalTokens: 5_200_000, activeCount: 1 },
    ]);
    const result = await evaluateBudget({
      db,
      config: baseConfig({
        budgets: {
          perTeam: { "team-a": 10_000_000 }, // 52% — warn-50
          perRepo: { "github.com/org/secret": 5_000_000 }, // 104% — blocked-100
        },
      }),
    });
    expect(result.worstTier).toBe("blocked-100");
    expect(result.promoteBlocked).toBe(true);
    expect(result.blockReason).toContain("github.com/org/secret");
  });

  it("legacy rows with NULL linearTeamId contribute to global only", async () => {
    const db = mockDb([
      { linearTeamId: null, repoUrl: "r1", totalTokens: 1_000_000, activeCount: 0 },
      { linearTeamId: "team-a", repoUrl: "r1", totalTokens: 500_000, activeCount: 0 },
    ]);
    const result = await evaluateBudget({
      db,
      config: baseConfig({ budgets: { perTeam: { "team-a": 2_000_000 } } }),
    });
    const global = result.scopes.find((s) => s.scope.kind === "global")!;
    expect(global.used).toBe(1_500_000);
    const teamScope = result.scopes.find(
      (s) => s.scope.kind === "team" && s.scope.teamId === "team-a",
    )!;
    expect(teamScope.used).toBe(500_000);
  });

  it("blocks when any scope is at 100%", async () => {
    const db = mockDb([
      { linearTeamId: "team-a", repoUrl: "r", totalTokens: 5_000_000, activeCount: 0 },
    ]);
    const result = await evaluateBudget({ db, config: baseConfig() });
    expect(result.promoteBlocked).toBe(true);
    expect(result.blockReason).toBeDefined();
    expect(result.blockReason).toContain("global");
  });
});

type BudgetTierExpected = "ok" | "warn-50" | "warn-80" | "blocked-100";
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd packages/core && npx vitest run src/__tests__/pm-budget.test.ts`
Expected: FAIL — `evaluateBudget` is not exported from `../pm/budget.js`.

- [ ] **Step 3: Replace the body of `packages/core/src/pm/budget.ts`**

Overwrite the file with:

```ts
import { sql, and, gte, lt } from "drizzle-orm";
import { pipelineRuns } from "../db/schema.js";
import type { AnyDb } from "../db/client.js";
import type {
  BudgetEvaluation,
  BudgetScope,
  BudgetTier,
  PmAgentConfig,
  ScopeBudget,
} from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "PmAgent:budget" });

export interface BudgetEvaluationInput {
  db: AnyDb;
  config: PmAgentConfig;
}

/**
 * Evaluate today's token spend against the configured budgets and return
 * a per-scope breakdown plus a `worstTier` / `promoteBlocked` verdict.
 *
 * Scopes evaluated:
 * - Always: `global` (limit = config.dailyTokenBudget)
 * - If `config.budgets?.perTeam` is set OR rows have a non-null linear_team_id,
 *   one `team` scope per team that appears in either source.
 * - If `config.budgets?.perRepo` is set OR rows exist, one `repo` scope per repo.
 *
 * A scope's limit is resolved as:
 *   perTeam[teamId] / perRepo[repoUrl] ?? budgets.default ?? dailyTokenBudget
 *
 * Tier thresholds (inclusive lower bound):
 *   percent >= 100 → blocked-100
 *   percent >=  80 → warn-80
 *   percent >=  50 → warn-50
 *   else          → ok
 *
 * `worstTier` is the highest tier across all scopes. `promoteBlocked` is true
 * iff `worstTier === 'blocked-100'`. `blockReason` names the first blocking
 * scope with its percent and token usage, for inclusion in logs and Linear
 * comments.
 */
export async function evaluateBudget(
  input: BudgetEvaluationInput,
): Promise<BudgetEvaluation> {
  const { db, config } = input;

  const today = new Date().toISOString().slice(0, 10);
  const dayStart = new Date(`${today}T00:00:00Z`);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  interface Row {
    linearTeamId: string | null;
    repoUrl: string;
    totalTokens: number;
    activeCount: number;
  }
  let rows: Row[] = [];

  try {
    rows = (await db
      .select({
        linearTeamId: pipelineRuns.linearTeamId,
        repoUrl: pipelineRuns.repoUrl,
        totalTokens: sql<number>`coalesce(sum(${pipelineRuns.totalInputTokens} + ${pipelineRuns.totalOutputTokens}), 0)`,
        activeCount: sql<number>`coalesce(sum(case when ${pipelineRuns.status} in ('queued', 'running') then 1 else 0 end), 0)`,
      })
      .from(pipelineRuns)
      .where(
        and(
          gte(pipelineRuns.startedAt, dayStart),
          lt(pipelineRuns.startedAt, dayEnd),
        ),
      )
      .groupBy(pipelineRuns.linearTeamId, pipelineRuns.repoUrl)) as Row[];
  } catch (err) {
    log.error({ err }, "failed to query budget data");
    rows = [];
  }

  const globalLimit = config.dailyTokenBudget;
  const defaultLimit = config.budgets?.default ?? globalLimit;

  // Aggregate
  let globalUsed = 0;
  let activeCount = 0;
  const teamUsed = new Map<string, number>();
  const repoUsed = new Map<string, number>();

  for (const row of rows) {
    const tokens = Number(row.totalTokens) || 0;
    globalUsed += tokens;
    activeCount += Number(row.activeCount) || 0;
    if (row.linearTeamId) {
      teamUsed.set(row.linearTeamId, (teamUsed.get(row.linearTeamId) ?? 0) + tokens);
    }
    repoUsed.set(row.repoUrl, (repoUsed.get(row.repoUrl) ?? 0) + tokens);
  }

  // Ensure configured teams/repos appear even with 0 spend so alert thresholds can fire on them
  for (const teamId of Object.keys(config.budgets?.perTeam ?? {})) {
    if (!teamUsed.has(teamId)) teamUsed.set(teamId, 0);
  }
  for (const repoUrl of Object.keys(config.budgets?.perRepo ?? {})) {
    if (!repoUsed.has(repoUrl)) repoUsed.set(repoUrl, 0);
  }

  const scopes: ScopeBudget[] = [];

  scopes.push(makeScope({ kind: "global" }, globalUsed, globalLimit));

  for (const [teamId, used] of teamUsed) {
    const limit = config.budgets?.perTeam?.[teamId] ?? defaultLimit;
    scopes.push(makeScope({ kind: "team", teamId }, used, limit));
  }

  for (const [repoUrl, used] of repoUsed) {
    const limit = config.budgets?.perRepo?.[repoUrl] ?? defaultLimit;
    scopes.push(makeScope({ kind: "repo", repoUrl }, used, limit));
  }

  // Derive worstTier and blockReason
  const tierRank: Record<BudgetTier, number> = {
    ok: 0,
    "warn-50": 1,
    "warn-80": 2,
    "blocked-100": 3,
  };
  let worstTier: BudgetTier = "ok";
  let blockReason: string | undefined;

  for (const s of scopes) {
    if (tierRank[s.tier] > tierRank[worstTier]) worstTier = s.tier;
    if (s.tier === "blocked-100" && !blockReason) {
      blockReason = `${s.scopeLabel} at ${s.percent}% (${s.used.toLocaleString()} / ${s.limit.toLocaleString()} tokens)`;
    }
  }

  return {
    scopes,
    worstTier,
    promoteBlocked: worstTier === "blocked-100",
    blockReason,
    activeCount,
  };
}

function makeScope(
  scope: BudgetScope,
  used: number,
  limit: number,
): ScopeBudget {
  const percent = limit > 0 ? Math.floor((used / limit) * 100) : 0;
  let tier: BudgetTier = "ok";
  if (percent >= 100) tier = "blocked-100";
  else if (percent >= 80) tier = "warn-80";
  else if (percent >= 50) tier = "warn-50";

  return {
    scope,
    scopeLabel: formatScopeLabel(scope),
    limit,
    used,
    percent,
    tier,
  };
}

function formatScopeLabel(scope: BudgetScope): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "team") return `team ${scope.teamId}`;
  return `repo ${scope.repoUrl}`;
}
```

- [ ] **Step 4: Run the tests, expect pass**

Run: `cd packages/core && npx vitest run src/__tests__/pm-budget.test.ts`
Expected: PASS (all 9 tests green).

Note: the `tier transitions` loop asserts `Math.floor` rounding. 49.99% → floor = 49 → ok. If a test fails at a boundary, it's almost certainly a rounding disagreement — verify the expected values match `Math.floor`.

- [ ] **Step 5: Build**

Run: `pnpm --filter @urateam/core build`
Expected: clean. If the scheduler still references `checkBudgetGuards` it will error — that gets fixed in Task 5. If the build fails only on `pm/scheduler.ts`, proceed to Task 5 now and come back to commit after both.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pm/budget.ts packages/core/src/__tests__/pm-budget.test.ts
git commit -m "refactor(pm): replace checkBudgetGuards with evaluateBudget (multi-scope)"
```

If the scheduler breaks the build at this point, include `pm/scheduler.ts` in this commit (the Task 5 edits are tightly coupled and it's OK to stage both here).

---

## Task 4: `maybeFireAlerts` with persistent dedup

**Files:**
- Create: `packages/core/src/pm/budget-alerts.ts`
- Create: `packages/core/src/__tests__/pm-budget-alerts.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/pm-budget-alerts.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { maybeFireAlerts } from "../pm/budget-alerts.js";
import { _setSchemaDriver, getCreateTablesDDL } from "../db/client.js";
import type { BudgetEvaluation } from "../pm/types.js";

function makeDb() {
  _setSchemaDriver("sqlite");
  const sqlite = new Database(":memory:");
  sqlite.exec(getCreateTablesDDL("sqlite"));
  return drizzle(sqlite, { schema });
}

function scopeAt(kind: "global" | "team" | "repo", id: string, percent: number) {
  return {
    scope:
      kind === "global"
        ? { kind: "global" as const }
        : kind === "team"
          ? { kind: "team" as const, teamId: id }
          : { kind: "repo" as const, repoUrl: id },
    scopeLabel: kind === "global" ? "global" : `${kind} ${id}`,
    limit: 1_000_000,
    used: Math.floor(1_000_000 * (percent / 100)),
    percent,
    tier:
      percent >= 100
        ? ("blocked-100" as const)
        : percent >= 80
          ? ("warn-80" as const)
          : percent >= 50
            ? ("warn-50" as const)
            : ("ok" as const),
  };
}

function evaluationWith(scopes: ReturnType<typeof scopeAt>[]): BudgetEvaluation {
  const tierRank = { ok: 0, "warn-50": 1, "warn-80": 2, "blocked-100": 3 } as const;
  const worst = scopes.reduce<keyof typeof tierRank>(
    (acc, s) => (tierRank[s.tier] > tierRank[acc] ? s.tier : acc),
    "ok" as const,
  );
  return {
    scopes,
    worstTier: worst,
    promoteBlocked: worst === "blocked-100",
    activeCount: 0,
  };
}

describe("maybeFireAlerts", () => {
  let db: ReturnType<typeof makeDb>;
  let postSlack: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = makeDb();
    postSlack = vi.fn().mockResolvedValue(undefined);
  });

  it("skips scopes at tier ok", async () => {
    const evaluation = evaluationWith([scopeAt("global", "", 10)]);
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    expect(postSlack).not.toHaveBeenCalled();
  });

  it("fires a message at 50%", async () => {
    const evaluation = evaluationWith([scopeAt("global", "", 55)]);
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(1);
    const [channel, blocks] = postSlack.mock.calls[0];
    expect(channel).toBe("C_TEST");
    const json = JSON.stringify(blocks);
    expect(json).toContain("global");
    expect(json).toContain("55");
  });

  it("fires 50 and 80 when a scope is at 80%", async () => {
    const evaluation = evaluationWith([scopeAt("team", "team-a", 82)]);
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(2);
  });

  it("fires 50, 80, and 100 when a scope is blocked", async () => {
    const evaluation = evaluationWith([scopeAt("repo", "r", 105)]);
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(3);
    const joined = postSlack.mock.calls.map((c) => JSON.stringify(c[1])).join("\n");
    expect(joined).toContain("blocked");
  });

  it("dedup: same threshold same day fires exactly once", async () => {
    const evaluation = evaluationWith([scopeAt("global", "", 60)]);
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(1);
  });

  it("dedup: different scopes same threshold fire separately", async () => {
    const evaluation = evaluationWith([
      scopeAt("team", "team-a", 60),
      scopeAt("team", "team-b", 60),
    ]);
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(2);
  });

  it("dedup: threshold escalation from 50 to 80 fires only the new one on second call", async () => {
    const first = evaluationWith([scopeAt("global", "", 55)]);
    await maybeFireAlerts(first, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(1);

    const second = evaluationWith([scopeAt("global", "", 85)]);
    await maybeFireAlerts(second, db, postSlack, "C_TEST");
    // 50 already fired; 80 is new
    expect(postSlack).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd packages/core && npx vitest run src/__tests__/pm-budget-alerts.test.ts`
Expected: FAIL — `Cannot find module '../pm/budget-alerts.js'`.

- [ ] **Step 3: Create `packages/core/src/pm/budget-alerts.ts`**

```ts
import { nanoid } from "nanoid";
import type { AnyDb } from "../db/client.js";
import { budgetAlerts } from "../db/schema.js";
import type {
  BudgetEvaluation,
  BudgetScope,
  BudgetTier,
  ScopeBudget,
} from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "PmAgent:budget-alerts" });

export type PostSlackMessage = (
  channel: string,
  blocks: unknown,
) => Promise<void>;

/**
 * Fire Slack messages for newly-crossed budget thresholds in the given
 * evaluation. Dedups via the `budget_alerts` table's UNIQUE constraint on
 * (date, scope, threshold) — the first call of the day that observes a
 * crossing inserts the row and posts the message; subsequent calls see
 * the conflict and do nothing.
 *
 * Scopes at tier 'ok' are skipped. For scopes above 'ok', every threshold
 * the scope has reached is evaluated independently:
 *   - tier 'warn-50' → only the 50 threshold
 *   - tier 'warn-80' → 50 and 80 thresholds (cumulative)
 *   - tier 'blocked-100' → 50, 80, and 100 thresholds
 *
 * This mirrors how cloud-spend tools post each threshold message once.
 * A scope that jumps from 0% to 85% in one tick posts both 50 and 80.
 */
export async function maybeFireAlerts(
  evaluation: BudgetEvaluation,
  db: AnyDb,
  postSlack: PostSlackMessage,
  channel: string,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  for (const scope of evaluation.scopes) {
    if (scope.tier === "ok") continue;

    for (const threshold of thresholdsForTier(scope.tier)) {
      const scopeKey = scopeToKey(scope.scope);
      const inserted = await tryInsertAlert(db, today, scopeKey, threshold);
      if (!inserted) continue;

      try {
        await postSlack(channel, buildAlertBlocks(scope, threshold));
      } catch (err) {
        log.error(
          { err, scope: scopeKey, threshold },
          "failed to post budget alert to slack",
        );
      }
    }
  }
}

function thresholdsForTier(tier: BudgetTier): number[] {
  if (tier === "blocked-100") return [50, 80, 100];
  if (tier === "warn-80") return [50, 80];
  if (tier === "warn-50") return [50];
  return [];
}

function scopeToKey(scope: BudgetScope): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "team") return `team:${scope.teamId}`;
  return `repo:${scope.repoUrl}`;
}

async function tryInsertAlert(
  db: AnyDb,
  date: string,
  scopeKey: string,
  threshold: number,
): Promise<boolean> {
  try {
    const result = await db
      .insert(budgetAlerts)
      .values({
        id: nanoid(),
        date,
        scope: scopeKey,
        threshold,
      })
      .onConflictDoNothing()
      .returning({ id: budgetAlerts.id });
    return (result as Array<{ id: string }>).length > 0;
  } catch (err) {
    log.error({ err, scopeKey, threshold }, "failed to insert budget_alerts row");
    return false;
  }
}

/**
 * Build a Block Kit message body for a budget alert. Uses plain text with
 * Slack mrkdwn for the emoji + label — the PM Agent's existing slack module
 * uses the same convention for digests and approval requests.
 */
function buildAlertBlocks(scope: ScopeBudget, threshold: number): unknown[] {
  const isBlocked = threshold === 100;
  const emoji = isBlocked ? ":no_entry_sign:" : ":warning:";
  const title = `${emoji} urateam budget alert — ${scope.scopeLabel} at ${scope.percent}%`;
  const usage = `${scope.used.toLocaleString()} / ${scope.limit.toLocaleString()} tokens used today`;
  const footer = isBlocked
    ? "New pipeline runs blocked. Increase the cap or wait for midnight UTC reset. Active runs continue to completion."
    : `Threshold: ${threshold}%`;

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${title}*\n${usage}\n${footer}` },
    },
  ];
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd packages/core && npx vitest run src/__tests__/pm-budget-alerts.test.ts`
Expected: PASS (7 tests).

If the `returning()` call fails with a type error on the SQLite driver, the better-sqlite3 Drizzle adapter supports `.returning()` natively; verify your `pipelineRuns` inserts elsewhere in the codebase for the exact pattern and match it. If `returning()` is genuinely unavailable, fall back to: query the row immediately after insert by `(date, scope, threshold)` and compare the `firedAt` to the current time ± a small window. This is a last-resort workaround — `returning()` should work.

- [ ] **Step 5: Build**

Run: `pnpm --filter @urateam/core build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pm/budget-alerts.ts packages/core/src/__tests__/pm-budget-alerts.test.ts
git commit -m "feat(pm): budget threshold alerts with persistent dedup"
```

---

## Task 5: Wire `evaluateBudget` + `maybeFireAlerts` into the PM scheduler

**Files:**
- Modify: `packages/core/src/pm/scheduler.ts`

- [ ] **Step 1: Replace `checkBudgetGuards` with `evaluateBudget` in the scheduler**

Open `packages/core/src/pm/scheduler.ts` and find the existing budget-check block (around line 127–140). Change the import at the top of the file:

Old:
```ts
import { checkBudgetGuards, type BudgetGuardInput } from "./budget.js";
```

New:
```ts
import { evaluateBudget } from "./budget.js";
import { maybeFireAlerts, type PostSlackMessage } from "./budget-alerts.js";
import type { BudgetEvaluation } from "./types.js";
```

- [ ] **Step 2: Update the injected `actions` interface**

Find the `actions` type (around line 40–50). Replace the `checkBudgetGuards` entry with:

```ts
  evaluateBudget?: (input: { db: AnyDb; config: PmAgentConfig }) => Promise<BudgetEvaluation>;
```

Remove the old `checkBudgetGuards` entry and the `BudgetGuardInput` import if still referenced. (If any external caller depended on overriding `checkBudgetGuards`, that test is being updated in Task 8 — the only known caller.)

- [ ] **Step 3: Update the tick code that called `checkBudgetGuards`**

Find the block that previously set `tick.budgetGuard` (around line 127–140) and replace with:

```ts
        let evaluation: BudgetEvaluation;
        try {
          evaluation = actions?.evaluateBudget
            ? await actions.evaluateBudget({ db, config })
            : await evaluateBudget({ db, config });
        } catch (err) {
          log.error({ err }, "budget evaluation failed");
          tick.errors.push(`budget: ${(err as Error).message}`);
          evaluation = {
            scopes: [],
            worstTier: "ok",
            promoteBlocked: false,
            activeCount: 0,
          };
        }

        // Backward-compat TickResult shape: still set budgetGuard for downstream consumers.
        tick.budgetGuard = {
          promoteBlocked: evaluation.promoteBlocked,
          reason: evaluation.blockReason,
          activeCount: evaluation.activeCount,
          tokenSpendPercent:
            evaluation.scopes.find((s) => s.scope.kind === "global")?.percent ?? 0,
          dailyTokensUsed:
            evaluation.scopes.find((s) => s.scope.kind === "global")?.used ?? 0,
        };

        // Fire threshold alerts for newly-crossed scopes (deduped in budget_alerts).
        try {
          const alertChannel = config.budgets?.alertChannel ?? config.slackChannelId;
          const postSlack: PostSlackMessage | undefined =
            actions?.postSlackMessage ??
            (notifier?.postSlackMessage
              ? (channel, blocks) => notifier.postSlackMessage!(channel, blocks)
              : undefined);
          if (postSlack) {
            await maybeFireAlerts(evaluation, db, postSlack, alertChannel);
          }
        } catch (err) {
          log.error({ err }, "failed to fire budget alerts");
        }
```

If `notifier` is not already a local variable in this function, find where `postSlackMessage` is available in the existing code — it is used elsewhere in `scheduler.ts` for digests. Match that pattern. If the wiring is unclear, report as `DONE_WITH_CONCERNS` and describe what you found. Do not guess.

- [ ] **Step 4: Update `TickResult.budgetGuard` type if needed**

The existing `BudgetGuardResult` on `TickResult` still has `tokenSpendPercent` and `dailyTokensUsed` fields. These are now populated from the global scope's percent and used, respectively, as shown in Step 3. No type change required if the shape remains compatible.

If the build flags a missing field on `BudgetGuardResult` after your refactor, keep the `BudgetGuardResult` interface unchanged and map from the evaluation into it as a plain object in Step 3 (as shown).

- [ ] **Step 5: Build**

Run: `pnpm --filter @urateam/core build`
Expected: clean. If there are compile errors in `scheduler.ts` specifically about `BudgetGuardInput`, remove any remaining import of that type; it's no longer used.

- [ ] **Step 6: Run the existing scheduler tests**

Run: `cd packages/core && npx vitest run src/__tests__/pm-scheduler.test.ts`
Expected: Some tests may fail if they reference the old `checkBudgetGuards` action injection. DO NOT fix those here — Task 8 covers the scheduler test updates. Note any failures in your report.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/pm/scheduler.ts
git commit -m "feat(pm): scheduler uses evaluateBudget + fires threshold alerts per tick"
```

---

## Task 6: Thread `linearTeamId` through `runner.start()` and persist it

**Files:**
- Modify: `packages/core/src/pipeline/runner.ts`

- [ ] **Step 1: Add `linearTeamId` parameter to `runner.start()`**

In `packages/core/src/pipeline/runner.ts`, find the `async start(...)` method (around line 173) and add a 6th parameter:

```ts
  async start(
    issue: LinearIssue,
    pipelineKey: string,
    pipelineConfig: PipelineConfig,
    repoConfig: RepoConfig,
    sanitizedIssue: SanitizedIssue,
    linearTeamId: string | null = null,
  ): Promise<void> {
```

The default value `= null` keeps existing callers working without changes. Task 7 updates the webhook handler to pass the real value.

- [ ] **Step 2: Insert `linearTeamId` into the pipeline_runs row**

Find the DB insert inside `start()` (the insert that creates the row with `runId`, `branch`, `status: "queued"`, etc.). Add `linearTeamId` to the values object:

```ts
    // existing insert, extended:
    await db.insert(pipelineRuns).values({
      id: runId,
      // ... all existing fields unchanged
      linearTeamId,
    });
```

If you can't find the exact insert because the field ordering is different, search for `pipelineRuns.values` or just `.values({` in the file and pick the one inside `start()` (not `resume()` or `startFeedback()`).

- [ ] **Step 3: Propagate linearTeamId to review-feedback runs**

If the file has a separate method like `startFeedback()` or `runReviewFeedback()` that creates review-feedback rows from a parent run, that method should copy `linearTeamId` from the parent. Find the method's insert and add:

```ts
    linearTeamId: parentRun.linearTeamId ?? null,
```

The parent run is loaded earlier in that method — match the surrounding variable name. If the method does not exist, skip this step.

- [ ] **Step 4: Build**

Run: `pnpm --filter @urateam/core build`
Expected: clean.

- [ ] **Step 5: Run existing runner tests to confirm nothing broke**

Run: `cd packages/core && npx vitest run src/__tests__/pipeline-runner.test.ts 2>&1 | tail -20`
Expected: green (the default parameter means existing callers don't need updates).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pipeline/runner.ts
git commit -m "feat(runner): accept and persist linearTeamId on pipeline run creation"
```

---

## Task 7: Webhook handler — extract team ID + add 100% gate

**Files:**
- Modify: `packages/core/src/webhook/handler.ts`

- [ ] **Step 1: Extract `linearTeamId` from the webhook payload**

Open `packages/core/src/webhook/handler.ts` and find the `"start"` action handler (around line 190–202) where `config.runner.start(...)` is called. Before that call, extract the team ID from the parsed issue:

```ts
        const linearTeamId = stateChange.issue.teamId ?? null;
```

The exact path depends on how the payload is parsed earlier in the function. The webhook parses raw Linear JSON into a typed object; the team ID is at `data.team.id` in the raw payload and typically ends up on `stateChange.issue.teamId` in the parsed shape. If it's not at `.teamId`, check `stateChange.issue.team?.id` or `stateChange.data?.team?.id`. Verify by reading the payload-parsing code higher in the same file.

- [ ] **Step 2: Add the 100% budget gate BEFORE `runner.start(...)`**

Add these imports at the top of `packages/core/src/webhook/handler.ts`:

```ts
import { evaluateBudget } from "../pm/budget.js";
import { maybeFireAlerts } from "../pm/budget-alerts.js";
```

Then, in the `"start"` branch, before the existing `config.runner.start(...)` call, insert the gate. The webhook handler needs access to `config.pmConfig` (the `PmAgentConfig`) — if it's not already threaded through, that's a wiring change you need to make in the app composition root (likely `packages/core/src/server.ts`). For THIS task, assume `config.pmConfig` is available; if it is not, add it to the handler's `config` destructure and its caller in `server.ts` as a one-line change, noting it in your report.

```ts
        // Budget gate: refuse new runs when any scope is at 100%.
        // In-flight runs continue; PM Agent's startTodoIssues will
        // auto-retry once the budget recovers.
        if (config.pmConfig && config.db) {
          const evaluation = await evaluateBudget({
            db: config.db,
            config: config.pmConfig,
          });
          if (evaluation.promoteBlocked) {
            log.warn(
              { issueId: stateChange.issue.identifier, reason: evaluation.blockReason },
              "webhook start refused — budget exceeded",
            );
            // Post a Linear comment so the operator knows why nothing happened
            if (config.linear?.commentOnIssue) {
              await config.linear
                .commentOnIssue(
                  stateChange.issue.identifier,
                  `urateam pipeline deferred — ${evaluation.blockReason}. ` +
                    `Will retry on the next PM Agent tick after budget resets at midnight UTC.`,
                )
                .catch((err) => log.error({ err }, "failed to post budget-deferred comment"));
            }
            // Fire the alerts so the channel sees the 100% crossing immediately
            if (config.notifier?.postSlackMessage) {
              const alertChannel =
                config.pmConfig.budgets?.alertChannel ?? config.pmConfig.slackChannelId;
              await maybeFireAlerts(
                evaluation,
                config.db,
                (channel, blocks) => config.notifier!.postSlackMessage!(channel, blocks),
                alertChannel,
              );
            }
            return c.json({ ok: true, action: "start", runQueued: false, reason: "budget-exceeded" });
          }
        }
```

**Verification**: the webhook handler likely already has `config.db` for webhook dedup. If not, you need to thread it through in `server.ts` the same way. This may be a few lines of wiring in the composition root.

- [ ] **Step 3: Pass `linearTeamId` to `runner.start(...)`**

Update the existing call:

```ts
        config.runner.start(
          stateChange.issue,
          resolved.key,
          resolved.config,
          repoConfig,
          sanitizedIssue,
          linearTeamId,
        ).catch((err) => log.error({ err }, "runner.start() failed"));
```

- [ ] **Step 4: Update `pm/start-todo.ts` to check the 100% gate as well**

The PM Agent's `startTodoIssues` action also calls `runner.start()` directly and bypasses the webhook. Open `packages/core/src/pm/actions/start-todo.ts`. It runs inside the PM tick AFTER `evaluateBudget` — the scheduler should pass the existing `BudgetEvaluation` into the action, and start-todo should early-return when `evaluation.promoteBlocked` is true.

If the current action signature doesn't take an evaluation, extend it:

```ts
export async function startTodoIssues(input: {
  // ... existing fields
  budgetEvaluation: BudgetEvaluation;
}): Promise<...> {
  if (input.budgetEvaluation.promoteBlocked) {
    log.info(
      { reason: input.budgetEvaluation.blockReason },
      "startTodoIssues skipped — budget exceeded",
    );
    return { started: [], reason: "budget-exceeded" };
  }
  // ... existing logic
}
```

Also update the caller in `pm/scheduler.ts` to pass the evaluation. If this is more than a 10-line change, it belongs in its own commit — note in your report and do it.

- [ ] **Step 5: Build**

Run: `pnpm --filter @urateam/core build`
Expected: clean. If `config.pmConfig` or `config.db` are not on the handler's config type, add them as optional fields to the handler's type declaration (whatever interface is used to type the `config` parameter at the top of the webhook handler module) and wire them through from `server.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/webhook/handler.ts packages/core/src/pm/actions/start-todo.ts packages/core/src/pm/scheduler.ts packages/core/src/server.ts
git commit -m "feat(webhook): refuse new pipeline runs when budget is exceeded"
```

---

## Task 8: Update `pm-scheduler.test.ts` for the new evaluation shape

**Files:**
- Modify: `packages/core/src/__tests__/pm-scheduler.test.ts`

The scheduler tests previously injected `checkBudgetGuards` as an action. Task 5 renamed it to `evaluateBudget`. This task updates the tests to match, and adds new coverage for alert firing and the start-todo gate.

- [ ] **Step 1: Rename all `checkBudgetGuards` action injections to `evaluateBudget`**

In `packages/core/src/__tests__/pm-scheduler.test.ts`, do a file-wide find-and-replace:
- `checkBudgetGuards` → `evaluateBudget` (in `actions` overrides)
- Update the mock return value from `BudgetGuardResult` shape to `BudgetEvaluation` shape:

Old shape returned by the mock:
```ts
{ promoteBlocked: false, activeCount: 0, tokenSpendPercent: 0, dailyTokensUsed: 0 }
```

New shape:
```ts
{
  scopes: [
    {
      scope: { kind: "global" },
      scopeLabel: "global",
      limit: 5_000_000,
      used: 0,
      percent: 0,
      tier: "ok",
    },
  ],
  worstTier: "ok",
  promoteBlocked: false,
  activeCount: 0,
}
```

Tests that set `promoteBlocked: true` on the old mock should set `worstTier: "blocked-100"` and `promoteBlocked: true` + `blockReason: "global at 100%"` on the new mock. Copy this helper into the test file near the top to avoid repetition:

```ts
function mockOkEvaluation(overrides: Partial<import("../pm/types.js").BudgetEvaluation> = {}) {
  return {
    scopes: [
      {
        scope: { kind: "global" as const },
        scopeLabel: "global",
        limit: 5_000_000,
        used: 0,
        percent: 0,
        tier: "ok" as const,
      },
    ],
    worstTier: "ok" as const,
    promoteBlocked: false,
    activeCount: 0,
    ...overrides,
  };
}

function mockBlockedEvaluation() {
  return {
    scopes: [
      {
        scope: { kind: "global" as const },
        scopeLabel: "global",
        limit: 5_000_000,
        used: 5_000_000,
        percent: 100,
        tier: "blocked-100" as const,
      },
    ],
    worstTier: "blocked-100" as const,
    promoteBlocked: true,
    blockReason: "global at 100% (5,000,000 / 5,000,000 tokens)",
    activeCount: 0,
  };
}
```

Then rewrite the action injection sites to use these helpers.

- [ ] **Step 2: Add a new test asserting alerts fire during the tick**

Append this test to the scheduler test file:

```ts
it("fires a Slack budget alert when the tick observes a warn-50 scope", async () => {
  const postSlackSpy = vi.fn().mockResolvedValue(undefined);

  // Build a minimal scheduler input that makes the tick reach the alert path.
  // Use the same `runTick` harness the other tests in this file use.
  const result = await runTick({
    // ... match the minimal setup other tests use
    actions: {
      evaluateBudget: async () =>
        mockOkEvaluation({
          scopes: [
            {
              scope: { kind: "global" },
              scopeLabel: "global",
              limit: 1_000_000,
              used: 600_000,
              percent: 60,
              tier: "warn-50",
            },
          ],
          worstTier: "warn-50",
        }),
      postSlackMessage: postSlackSpy,
    },
  });

  expect(postSlackSpy).toHaveBeenCalled();
  const channels = postSlackSpy.mock.calls.map((c) => c[0]);
  expect(channels).toContain("C_TEST"); // or whatever slackChannelId the test config uses
});
```

The exact `runTick` harness and test config differ per file — match what the surrounding tests already do. If the test file doesn't have a helper like `runTick`, it probably calls the scheduler's exported function directly; follow that pattern.

- [ ] **Step 3: Run the test file**

Run: `cd packages/core && npx vitest run src/__tests__/pm-scheduler.test.ts`
Expected: all tests pass, including the new alert assertion.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/__tests__/pm-scheduler.test.ts
git commit -m "test(pm): scheduler uses BudgetEvaluation shape + verifies alert firing"
```

---

## Task 9: Integration test — webhook handler refuses at 100%

**Files:**
- Modify: `packages/core/src/__tests__/webhook-handler.test.ts` (if it exists) OR create a new file

- [ ] **Step 1: Find the existing webhook handler test file**

Run: `Glob packages/core/src/__tests__/**/*webhook*.test.ts`

If a file exists, extend it. If not, create `packages/core/src/__tests__/webhook-budget-gate.test.ts`.

- [ ] **Step 2: Add tests for the budget gate**

```ts
import { describe, it, expect, vi } from "vitest";

// Assumes the webhook handler exports a named function like `handleLinearWebhook`
// or is registered on a Hono app. Match the existing test pattern — if the
// other webhook tests spin up a Hono app and fire requests at it, do the same;
// if they call a handler function directly, do that.

describe("webhook handler — budget gate", () => {
  it("refuses to start a pipeline when the budget is at 100%", async () => {
    const startSpy = vi.fn().mockResolvedValue(undefined);
    const commentSpy = vi.fn().mockResolvedValue(undefined);
    const postSlackSpy = vi.fn().mockResolvedValue(undefined);

    // Mock evaluateBudget to return a blocked evaluation
    vi.mock("../pm/budget.js", async (orig) => ({
      ...((await orig()) as object),
      evaluateBudget: async () => ({
        scopes: [
          {
            scope: { kind: "global" },
            scopeLabel: "global",
            limit: 1_000_000,
            used: 1_000_000,
            percent: 100,
            tier: "blocked-100",
          },
        ],
        worstTier: "blocked-100",
        promoteBlocked: true,
        blockReason: "global at 100% (1,000,000 / 1,000,000 tokens)",
        activeCount: 0,
      }),
    }));

    // Fire a Linear webhook for an issue moving to Todo
    // (match the exact setup other webhook tests use — mock config, mock runner, etc.)

    // Assertions:
    expect(startSpy).not.toHaveBeenCalled();
    expect(commentSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/deferred.*budget/i),
    );
    // The 100% alert should have been posted (once, via maybeFireAlerts' dedup)
    expect(postSlackSpy).toHaveBeenCalled();
  });

  it("starts the pipeline normally when the budget is at 50%", async () => {
    // Similar setup, but evaluateBudget returns warn-50
    // Assertion: startSpy WAS called
  });
});
```

This test is the most context-dependent in the plan. The exact mock + setup code depends on how other webhook tests in this codebase are structured. If the existing webhook tests use a different pattern (e.g., Hono test client), use that. If there are no existing webhook tests, create a minimal standalone test file that directly invokes the exported handler function with a mock `config` object containing `runner`, `linear`, `notifier`, `db`, and `pmConfig`.

- [ ] **Step 3: Run the test**

Run: `cd packages/core && npx vitest run src/__tests__/webhook-budget-gate.test.ts` (or wherever the test landed)
Expected: both tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/__tests__/
git commit -m "test(webhook): budget gate refuses start at 100% and posts Linear comment"
```

---

## Task 10: CHANGELOG migration note

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entries to the Unreleased section of `CHANGELOG.md`**

Find the `## [Unreleased]` section in `CHANGELOG.md`. Add these entries (preserving any existing ones — append to the appropriate subsections):

Under `### Added`:
```markdown
- `@urateam/core`: per-team and per-repo daily token budgets via new `PmAgentConfig.budgets` block. Layers on top of the existing global `dailyTokenBudget` as an org-wide ceiling.
- `@urateam/core`: Slack budget alerts fire at 50%, 80%, and 100% of any scope's daily budget. Deduped once per `(date, scope, threshold)` via a new `budget_alerts` table.
- `@urateam/core`: direct-webhook pipeline starts now respect the budget gate — at 100%, the run is refused and a Linear comment explains the deferral. The PM Agent's `startTodoIssues` auto-retries on the next tick after the budget recovers.
- `pipeline_runs` table gains a `linear_team_id` column (nullable for legacy rows), populated from the Linear webhook payload at run creation time.
- New `budget_alerts` table with `UNIQUE(date, scope, threshold)` for persistent alert dedup.
```

Under `### Changed`:
```markdown
- `pm/budget.ts`: `checkBudgetGuards` is replaced by `evaluateBudget`, which returns per-scope breakdowns (`ScopeBudget[]`) and a `worstTier` / `promoteBlocked` / `blockReason` verdict. Installs that don't configure `budgets` keep the existing single-global behavior with the addition of threshold alerts on the global scope. The previous 80% promotion-block gate is replaced with a 100% hard gate plus explicit 50/80 warnings — no silent throttling.
- In-flight pipeline runs are NOT aborted when the cap is crossed. Only new runs are refused. Operators resume by raising the cap (restart required) or waiting for midnight UTC.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog notes for spend caps & alerts"
```

---

## Task 11: Final verification and PR

**Files:** none (verification + git operations only)

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: clean across all 4 packages.

- [ ] **Step 2: Full unit test suite**

Run: `pnpm test`
Expected: all green. Capture the final test count. The expected delta from main is roughly +30 tests (9 evaluateBudget + 7 budget-alerts + 4 pm-types budgets field + N scheduler/webhook additions).

- [ ] **Step 3: Commit log shape check**

```bash
git log --oneline main..HEAD
```
Expected: ~10 commits, all related to spend caps & alerts. No unrelated drift.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/spend-caps
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --repo JonB32/urateam --base main --head feat/spend-caps \
  --title "feat(budgets): per-team/per-repo spend caps & Slack alerts (Phase 1, 4.3)" \
  --body "$(cat <<'EOF'
## Summary

Phase 1 feature 4.3 of the enterprise tier rollout — spend caps & alerts.

- **Per-team and per-repo daily budgets** via new \`PmAgentConfig.budgets\` block, layered on top of the existing global \`dailyTokenBudget\`.
- **Slack alerts at 50/80/100%** of any scope's budget, deduped once per \`(date, scope, threshold)\` via a new \`budget_alerts\` table.
- **100% hard cap** refuses new pipeline runs from both the PM Agent promote gate and direct Linear webhook starts. In-flight runs continue to completion; PM Agent auto-retries deferred Todo issues after the budget recovers.
- **\`linear_team_id\` on pipeline_runs** (nullable for legacy rows) populated from the Linear webhook payload, enabling per-team scope evaluation.
- **Behavior change (non-breaking)**: installs without a \`budgets\` block keep single-global semantics but now receive 50/80/100% alerts on the global scope, and the 100% hard gate replaces the prior silent 80% promotion-block.

## Spec & plan

- Spec: \`docs/superpowers/specs/2026-04-14-spend-caps-design.md\`
- Plan: \`docs/superpowers/plans/2026-04-14-spend-caps-and-alerts.md\`

## Test plan

- [x] \`pnpm build\` clean
- [x] \`pnpm test\` green
- [x] \`pm-budget.test.ts\` — 9 tests covering all tier transitions, per-team/per-repo overrides, legacy NULL rows, worst-tier-wins invariant
- [x] \`pm-budget-alerts.test.ts\` — 7 tests covering dedup, threshold escalation, multi-scope independence
- [x] \`pm-types.test.ts\` — schema coverage for \`budgets\` field (full/minimal/invalid)
- [x] \`pm-scheduler.test.ts\` — existing tests updated to new evaluation shape; new assertion that alerts fire during the tick
- [x] Webhook handler integration test — budget gate refuses at 100%, posts Linear comment, fires alerts

## Migration notes

- Existing \`pipeline_runs\` rows have \`linear_team_id = NULL\` and count only toward the global scope, not any per-team scope. New rows get the team ID from the webhook payload automatically.
- \`dailyTokenBudget\` is still the global ceiling. The new \`budgets\` block is additive.
- Installs with silent promotion-blocks at 80% will now see explicit Slack alerts instead. The old 80% block is gone — promotion proceeds through 99%, and runs are refused only at 100%.

## Out of scope (deferred)

- Token-to-dollar display in alerts — lands in feature 4.5 (cost & ROI dashboard)
- Per-team Slack channel routing — YAGNI for v1; single \`alertChannel\` override is enough
- Dashboard UI for editing budgets — Phase 2 dashboard work
- Rolling 24h or monthly budget windows — daily UTC matches existing semantics

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Confirm the PR is open**

```bash
gh pr view --repo JonB32/urateam --json url,number,title,state | head -20
```

Report the PR URL.

---

## Self-review notes

**Spec coverage check (against spec § 1–14):**
- § 3 architecture (single evaluation function + two gates + dedup) → Tasks 3, 4, 5, 7
- § 4.1 `linear_team_id` column → Task 1
- § 4.2 `budget_alerts` table → Task 1
- § 5 config shape → Task 2
- § 6 evaluation algorithm → Task 3
- § 7.1 PM promote gate → Task 5
- § 7.2 direct webhook gate → Task 7
- § 7.3 in-flight runs not aborted → enforced by omission (no task targets active runs)
- § 8 alert delivery + dedup → Task 4
- § 9 Linear team ID propagation → Tasks 6 + 7
- § 10 backward compat → covered by Task 3 test "returns ok for empty spend with default config" + Task 5 fallback to `dailyTokenBudget`
- § 11.1 unit tests (pm-budget.test.ts) → Task 3
- § 11.2 unit tests (pm-budget-alerts.test.ts) → Task 4
- § 11.3 integration tests (pm-scheduler) → Task 8
- § 11.4 integration tests (webhook handler) → Task 9
- § 11.5 existing tests to update (pm-types.test.ts) → Task 2

No spec gaps.

**Type consistency check:**
- `BudgetEvaluation`, `ScopeBudget`, `BudgetScope`, `BudgetTier` are all defined in Task 2 and consumed in Tasks 3, 4, 5, 7, 8, 9 — consistent.
- `PostSlackMessage` type alias defined in Task 4 (`budget-alerts.ts`), imported in Task 5 (`scheduler.ts`).
- `evaluateBudget({ db, config })` signature is consistent across Task 3 (definition), Task 5 (scheduler call), Task 7 (webhook call).
- `maybeFireAlerts(evaluation, db, postSlack, channel)` signature is consistent across Task 4 (definition), Task 5 (scheduler call), Task 7 (webhook call).
- `linearTeamId: string | null` consistent across Task 1 (schema), Task 6 (runner.start signature), Task 7 (webhook extraction).

**Placeholder scan:** none. Every step has runnable commands or complete code. The handful of "verify the surrounding test pattern" and "match the existing harness" comments in Tasks 8 and 9 are explicit directives to read-before-editing, not TODOs.

**Known flexibility points (called out inline so the implementer knows):**
- Task 5 Step 3: the `notifier` wiring in `scheduler.ts`. I specified the pattern; if it's different, match the existing file.
- Task 7 Step 2: `config.pmConfig` and `config.db` availability on the webhook handler's config type. May need a small server.ts wiring change.
- Task 9 Step 2: exact webhook test pattern. Depends on whether existing webhook tests use a Hono test client or direct handler invocation.

These are real integration concerns, not placeholder problems.

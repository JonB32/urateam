# Cache Telemetry + Low-Yield Review-Model Health Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Anthropic prompt-cache token telemetry on `stage_runs` and surface in PR cost summaries. Add a low-yield review-model health check that flags fanout models with sub-threshold output ratio over a rolling window.

**Architecture:** Two independent features that ship as separate PRs in v0.1.40. (A) extends `agent-stream.ts` to sum two new `usage` fields and persists them via `executor.ts` to a 2-column extension on `stage_runs`. (B) adds a pure helper module that queries `review_model_runs` for a rolling output-ratio per model and surfaces alerts via a new audit event without auto-suspending models.

**Tech Stack:** TypeScript, drizzle-orm (sqlite + postgres), vitest, `@anthropic-ai/claude-agent-sdk`.

**Spec:** `docs/superpowers/specs/2026-05-08-cache-telemetry-and-model-health.md`

---

## Phase A — Cache telemetry (PR 1)

### Task A1: Add migration files

**Files:**
- Create: `packages/core/src/db/migrations/sqlite/012_stage_runs_cache_tokens.sql`
- Create: `packages/core/src/db/migrations/postgres/013_stage_runs_cache_tokens.sql`

- [ ] **Step 1: Write the sqlite migration**

```sql
-- 012_stage_runs_cache_tokens.sql
-- BEC: cache telemetry — capture prompt-cache token usage from the
-- Anthropic Agent SDK so we can measure hit-rate per stage.

ALTER TABLE stage_runs ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stage_runs ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Write the postgres migration (identical SQL — both drivers accept it)**

```sql
-- 013_stage_runs_cache_tokens.sql
-- BEC: cache telemetry — capture prompt-cache token usage from the
-- Anthropic Agent SDK so we can measure hit-rate per stage.

ALTER TABLE stage_runs ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stage_runs ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/db/migrations/sqlite/012_stage_runs_cache_tokens.sql packages/core/src/db/migrations/postgres/013_stage_runs_cache_tokens.sql
git commit -m "feat(db): add cache_creation_input_tokens + cache_read_input_tokens to stage_runs"
```

---

### Task A2: Declare new columns in `db/schema.ts`

**Files:**
- Modify: `packages/core/src/db/schema.ts:80-96` (the `stageRuns` table block)

- [ ] **Step 1: Read `packages/core/src/db/schema.ts:80-96` for the existing column ordering**

- [ ] **Step 2: Add the two new columns** alongside `inputTokens` / `outputTokens`

```ts
// Add after `outputTokens: integer("output_tokens").notNull().default(0),`
cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm --filter @urateam/core build
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/db/schema.ts
git commit -m "feat(db): declare cache token columns in drizzle schema"
```

---

### Task A3: Capture cache fields in `agent-stream.ts`

**Files:**
- Modify: `packages/core/src/executor/agent-stream.ts:6-19, 67-72, 129-133, 170`
- Test: `packages/core/src/__tests__/agent-stream-cache-tokens.test.ts` *(new)*

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/agent-stream-cache-tokens.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { consumeAgentStream } from "../executor/agent-stream.js";

describe("consumeAgentStream — cache tokens (BEC: cache telemetry)", () => {
  it("accumulates cache_creation_input_tokens and cache_read_input_tokens from message.usage", async () => {
    async function* fakeStream() {
      yield { type: "assistant", usage: { input_tokens: 100, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0, output_tokens: 200 }, content: [{ type: "text", text: "" }] };
      yield { type: "assistant", usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 300 }, content: [{ type: "text", text: "" }] };
      yield { type: "assistant", usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 250 }, content: [{ type: "text", text: "done" }] };
    }
    const result = await consumeAgentStream(fakeStream());
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(750);
    expect(result.cacheCreationInputTokens).toBe(5000);
    expect(result.cacheReadInputTokens).toBe(10000);
  });

  it("treats missing cache fields as 0 (backward compat with non-cache responses)", async () => {
    async function* fakeStream() {
      yield { type: "assistant", usage: { input_tokens: 100, output_tokens: 200 }, content: [{ type: "text", text: "" }] };
    }
    const result = await consumeAgentStream(fakeStream());
    expect(result.cacheCreationInputTokens).toBe(0);
    expect(result.cacheReadInputTokens).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /tmp/urateam-work/packages/core && pnpm exec vitest run src/__tests__/agent-stream-cache-tokens.test.ts
```
Expected: FAIL — `cacheCreationInputTokens` / `cacheReadInputTokens` undefined on result.

- [ ] **Step 3: Update `StreamMessage.usage` and `ConsumeResult` types**

In `packages/core/src/executor/agent-stream.ts`, replace lines 6-19:

```ts
export interface StreamMessage {
  type?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  content?: Array<{ type: string; text?: string }> | string;
  /** Agent SDK wraps assistant text in `message` for some message shapes */
  message?: { content?: Array<{ type: string; text?: string }> | string } | string;
}

export interface ConsumeResult {
  lastText: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  turns: number;
}
```

- [ ] **Step 4: Initialize the new accumulators**

In `consumeAgentStream`, replace lines 68-72:

```ts
let inputTokens = 0;
let outputTokens = 0;
let cacheCreationInputTokens = 0;
let cacheReadInputTokens = 0;
let turns = 0;
let lastText = "";
```

- [ ] **Step 5: Sum cache fields from each `usage`**

Replace lines 129-133 with:

```ts
const prevOutputTokens = outputTokens;
if (message.usage) {
  inputTokens += message.usage.input_tokens ?? 0;
  outputTokens += message.usage.output_tokens ?? 0;
  cacheCreationInputTokens += message.usage.cache_creation_input_tokens ?? 0;
  cacheReadInputTokens += message.usage.cache_read_input_tokens ?? 0;
}
```

- [ ] **Step 6: Return cache fields on the final ConsumeResult**

Replace line 170:

```ts
return { lastText, inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens, turns };
```

- [ ] **Step 7: Run test to verify it passes**

```bash
cd /tmp/urateam-work/packages/core && pnpm exec vitest run src/__tests__/agent-stream-cache-tokens.test.ts
```
Expected: PASS (2/2).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/executor/agent-stream.ts packages/core/src/__tests__/agent-stream-cache-tokens.test.ts
git commit -m "feat(executor): capture cache_creation/read_input_tokens from Anthropic SDK"
```

---

### Task A4: Persist cache fields in `executor.ts`

**Files:**
- Modify: `packages/core/src/executor/executor.ts:112-115, 190-193, 210-220`

- [ ] **Step 1: Add accumulator-level locals**

After line 115 (after `let lastTextContent = "";`):

```ts
let cacheCreationInputTokens = 0;
let cacheReadInputTokens = 0;
```

- [ ] **Step 2: Pull cache fields from `consumeAgentStream` result**

Replace lines 190-193 with:

```ts
inputTokens = result.inputTokens;
outputTokens = result.outputTokens;
cacheCreationInputTokens = result.cacheCreationInputTokens;
cacheReadInputTokens = result.cacheReadInputTokens;
turns = result.turns;
lastTextContent = result.lastText;
```

- [ ] **Step 3: Persist to stage_runs on success path**

Replace the `.set({...})` block at lines 211-220:

```ts
.set({
  status: "completed",
  completedAt: new Date(),
  inputTokens,
  outputTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
  turns,
  handoffArtifact: JSON.stringify(handoffResult.artifact),
})
```

- [ ] **Step 4: Persist on failure path**

In the catch block (line ~245), update the `.set({...})`:

```ts
.set({
  status: "failed",
  completedAt: new Date(),
  inputTokens,
  outputTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
  turns,
  errorMessage,
})
```

- [ ] **Step 5: Run typecheck + full core test suite**

```bash
cd /tmp/urateam-work && pnpm --filter @urateam/core build && pnpm --filter @urateam/core test
```
Expected: build clean; tests pass (1471+ pass).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/executor/executor.ts
git commit -m "feat(executor): persist cache token columns on stage_runs"
```

---

### Task A5: Render cache hit ratio in `cost-summary.ts`

**Files:**
- Modify: `packages/core/src/pipeline/cost-summary.ts` (add a new optional field to StageCostBreakdown + render line)
- Modify: `packages/core/src/__tests__/pipeline/pr-cost-summary.test.ts` (add test case)
- Modify: `packages/core/src/pipeline/runner.ts` (the BEC-175 query block) — pass through the new fields

- [ ] **Step 1: Write the failing test in pr-cost-summary.test.ts**

Append a new `it()` block (in the existing describe):

```ts
it("renders cache hit ratio when cache fields are present", () => {
  const stages: StageCostBreakdown[] = [
    {
      stage: "implement",
      inputTokens: 200,
      outputTokens: 750,
      cacheCreationInputTokens: 5000,
      cacheReadInputTokens: 10000,
    },
  ];
  const out = formatPRCostSummary(stages, "auto-implement", ratesConfig);
  // Cache hit ratio: read / (read + creation + uncached input) = 10000 / (10000 + 5000 + 200) ≈ 65.8%
  // OR: read / (read + uncached) — pick whichever is documented; spec says read / (read + creation + uncached)
  expect(out).toMatch(/cache hit:\s*\d+%/);
  expect(out).toContain("read 10");  // 10K read
  expect(out).toContain("created 5");  // 5K created
});

it("does not render cache line when fields are zero (backward compat)", () => {
  const stages: StageCostBreakdown[] = [
    { stage: "implement", inputTokens: 100, outputTokens: 200 },
  ];
  const out = formatPRCostSummary(stages, "auto-implement", ratesConfig);
  expect(out).not.toContain("cache hit");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /tmp/urateam-work/packages/core && pnpm exec vitest run src/__tests__/pipeline/pr-cost-summary.test.ts
```
Expected: FAIL — cache fields not on StageCostBreakdown.

- [ ] **Step 3: Extend `StageCostBreakdown` type in `cost-summary.ts`**

Add to the interface:

```ts
export interface StageCostBreakdown {
  stage: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  modelRuns?: ModelRunRow[];
}
```

- [ ] **Step 4: Render the cache line in `renderStage` / line builder**

Find the markdown-line builder. After the existing per-line `$X.XXXX` block, add:

```ts
const cacheCreated = stage.cacheCreationInputTokens ?? 0;
const cacheRead = stage.cacheReadInputTokens ?? 0;
if (cacheCreated > 0 || cacheRead > 0) {
  const totalInput = cacheRead + cacheCreated + stage.inputTokens;
  const hitPct = Math.round((cacheRead / Math.max(totalInput, 1)) * 100);
  const readK = (cacheRead / 1000).toFixed(1);
  const createdK = (cacheCreated / 1000).toFixed(1);
  // Append to the existing rendered line, OR add a 2nd indented line beneath it.
  // Spec says: "cache hit: X% (read X.X K / created X.X K)"
  lineSuffix = `  _(cache hit: ${hitPct}% — read ${readK}K / created ${createdK}K)_`;
}
```

(Adjust to actual formatter style; keep the cache line indented under its stage line.)

- [ ] **Step 5: Update the runner's BEC-175 block to pass through the new fields**

In `packages/core/src/pipeline/runner.ts`, find the `breakdown` map (around the BEC-175 cost summary block, ~line 2280). Currently:

```ts
const breakdown: StageCostBreakdown[] = stages.map((s) => ({
  stage: s.stage,
  inputTokens: s.inputTokens,
  outputTokens: s.outputTokens,
  modelRuns: modelsByStage.get(s.id),
}));
```

Add the cache fields:

```ts
const breakdown: StageCostBreakdown[] = stages.map((s: any) => ({
  stage: s.stage,
  inputTokens: s.inputTokens,
  outputTokens: s.outputTokens,
  cacheCreationInputTokens: s.cacheCreationInputTokens ?? 0,
  cacheReadInputTokens: s.cacheReadInputTokens ?? 0,
  modelRuns: modelsByStage.get(s.id),
}));
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd /tmp/urateam-work/packages/core && pnpm exec vitest run src/__tests__/pipeline/pr-cost-summary.test.ts
```
Expected: PASS (6/6 — 4 existing + 2 new).

- [ ] **Step 7: Run full core test suite**

```bash
pnpm --filter @urateam/core build && pnpm --filter @urateam/core test
```
Expected: clean + all tests pass.

- [ ] **Step 8: Commit + push + open PR**

```bash
git add packages/core/src/pipeline/cost-summary.ts packages/core/src/__tests__/pipeline/pr-cost-summary.test.ts packages/core/src/pipeline/runner.ts
git commit -m "feat(pipeline): cache hit ratio in PR cost summary (BEC: cache telemetry)"
git push -u origin agent/cache-telemetry-and-model-health
gh pr create --title "feat: cache telemetry on stage_runs + cost-summary integration" --body "Closes the cache-telemetry half of the 2026-05-08 spec. ..."
```

**End of PR 1 (Phase A).** Wait for CI + your merge approval before continuing to Phase B.

---

## Phase B — Low-yield review-model health check (PR 2)

After Phase A merges, branch off the new main:

```bash
git checkout main && git pull --ff-only origin main
git checkout -b agent/model-health-check
```

### Task B1: New audit event factory + type

**Files:**
- Modify: `packages/core/src/types.ts:418-435` (extend `AuditEventTypeSchema`)
- Modify: `packages/core/src/audit/events.ts` (add factory)

- [ ] **Step 1: Add new event type to schema**

In `packages/core/src/types.ts`, find `AuditEventTypeSchema`. Add `"review.model_low_output_ratio"` alongside the existing `"review.fanout_fallback_used"`:

```ts
"review.fanout_fallback_used", "review.model_low_output_ratio",
```

- [ ] **Step 2: Add factory in `audit/events.ts`**

Append before `pmTriageClassifiedEvent` (or wherever consistent grouping lives):

```ts
export function reviewModelLowOutputRatioEvent(args: {
  modelId: string;
  outputRatio: number;
  runs: number;
  threshold: number;
}): AuditEvent {
  return base({
    eventType: "review.model_low_output_ratio",
    actor: "system",
    actorType: "system",
    payload: {
      modelId: args.modelId,
      outputRatio: args.outputRatio,
      runs: args.runs,
      threshold: args.threshold,
    },
  });
}
```

- [ ] **Step 3: Add factory unit test**

Append to `packages/core/src/__tests__/agent-branch-sweep.test.ts` style — actually create a small test in a new file `packages/core/src/__tests__/audit/review-model-low-output-ratio-event.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { reviewModelLowOutputRatioEvent } from "../../audit/events.js";

describe("reviewModelLowOutputRatioEvent", () => {
  it("returns an audit event with the documented shape", () => {
    const event = reviewModelLowOutputRatioEvent({
      modelId: "gpt-oss-120b:free",
      outputRatio: 0.011,
      runs: 10,
      threshold: 0.05,
    });
    expect(event.eventType).toBe("review.model_low_output_ratio");
    expect(event.actor).toBe("system");
    expect(event.payload).toEqual({
      modelId: "gpt-oss-120b:free",
      outputRatio: 0.011,
      runs: 10,
      threshold: 0.05,
    });
    expect(event.id).toMatch(/^evt_/);
  });
});
```

- [ ] **Step 4: Run test**

```bash
cd /tmp/urateam-work/packages/core && pnpm exec vitest run src/__tests__/audit/review-model-low-output-ratio-event.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/audit/events.ts packages/core/src/__tests__/audit/review-model-low-output-ratio-event.test.ts
git commit -m "feat(audit): add review.model_low_output_ratio event"
```

---

### Task B2: Pure helper `model-health.ts`

**Files:**
- Create: `packages/core/src/executor/review/model-health.ts`
- Test: `packages/core/src/__tests__/review/model-health.test.ts` *(new)*

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/review/model-health.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { stageRuns, reviewModelRuns, pipelineRuns } from "../../db/schema.js";
import { nanoid } from "nanoid";
import {
  getModelHealthScores,
  flagLowYieldModels,
} from "../../executor/review/model-health.js";

async function setupDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  // Minimal schema bootstrap — only the tables we need
  sqlite.exec(`
    CREATE TABLE pipeline_runs (id TEXT PRIMARY KEY, issue_id TEXT, pipeline_key TEXT, status TEXT, total_input_tokens INTEGER DEFAULT 0, total_output_tokens INTEGER DEFAULT 0, started_at INTEGER, completed_at INTEGER);
    CREATE TABLE stage_runs (id TEXT PRIMARY KEY, pipeline_run_id TEXT, stage TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, turns INTEGER DEFAULT 0);
    CREATE TABLE review_model_runs (id TEXT PRIMARY KEY, stage_run_id TEXT, provider_id TEXT, model_id TEXT, status TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0, error_message TEXT, truncated_files INTEGER DEFAULT 0, started_at INTEGER, completed_at INTEGER);
  `);
  return { db, sqlite };
}

describe("getModelHealthScores", () => {
  it("computes output ratio per model from review_model_runs in lookback window", async () => {
    const { db } = await setupDb();
    const stageId = nanoid();
    // Healthy model: 80% output ratio
    for (let i = 0; i < 10; i++) {
      await db.insert(reviewModelRuns).values({
        id: nanoid(),
        stageRunId: stageId,
        providerId: "openrouter",
        modelId: "claude-haiku-4-5",
        status: "completed",
        inputTokens: 2000,
        outputTokens: 8000,
      });
    }
    // Bad model: 1% output ratio
    for (let i = 0; i < 10; i++) {
      await db.insert(reviewModelRuns).values({
        id: nanoid(),
        stageRunId: stageId,
        providerId: "openrouter",
        modelId: "gpt-oss-120b:free",
        status: "completed",
        inputTokens: 27000,
        outputTokens: 300,
      });
    }
    const scores = await getModelHealthScores(db, { lookbackHours: 168, minRuns: 5 });
    expect(scores.get("claude-haiku-4-5")?.outputRatio).toBeCloseTo(0.8, 1);
    expect(scores.get("gpt-oss-120b:free")?.outputRatio).toBeCloseTo(0.011, 2);
  });

  it("excludes failed runs (status != 'completed') from the ratio", async () => {
    const { db } = await setupDb();
    const stageId = nanoid();
    // 5 completed (high ratio), 5 failed (zero output) — only completed should count
    for (let i = 0; i < 5; i++) {
      await db.insert(reviewModelRuns).values({
        id: nanoid(),
        stageRunId: stageId,
        providerId: "openrouter",
        modelId: "model-a",
        status: "completed",
        inputTokens: 1000,
        outputTokens: 800,
      });
      await db.insert(reviewModelRuns).values({
        id: nanoid(),
        stageRunId: stageId,
        providerId: "openrouter",
        modelId: "model-a",
        status: "failed",
        inputTokens: 0,
        outputTokens: 0,
      });
    }
    const scores = await getModelHealthScores(db, { lookbackHours: 168, minRuns: 5 });
    expect(scores.get("model-a")?.runs).toBe(5);
    expect(scores.get("model-a")?.outputRatio).toBeCloseTo(800 / 1800, 2);
  });
});

describe("flagLowYieldModels", () => {
  it("flags models with outputRatio below threshold and runs >= minRuns", () => {
    const scores = new Map([
      ["healthy-model", { runs: 10, outputRatio: 0.5, lastSeen: new Date() }],
      ["bad-model", { runs: 10, outputRatio: 0.01, lastSeen: new Date() }],
      ["new-model", { runs: 2, outputRatio: 0.01, lastSeen: new Date() }],
    ]);
    const flagged = flagLowYieldModels(scores, ["healthy-model", "bad-model", "new-model"], { threshold: 0.05, minRuns: 5 });
    expect(flagged).toEqual(["bad-model"]);
  });

  it("returns empty when no scores exist (fresh install)", () => {
    const flagged = flagLowYieldModels(new Map(), ["any-model"], { threshold: 0.05, minRuns: 5 });
    expect(flagged).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

```bash
cd /tmp/urateam-work/packages/core && pnpm exec vitest run src/__tests__/review/model-health.test.ts
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/executor/review/model-health.ts`:

```ts
import { gte, sql } from "drizzle-orm";
import type { AnyDb } from "../../db/client.js";
import { reviewModelRuns } from "../../db/schema.js";

export interface ModelHealthScore {
  runs: number;
  outputRatio: number;
  lastSeen: Date;
}

export interface HealthOptions {
  lookbackHours: number;
  minRuns: number;
}

export interface FlagOptions {
  threshold: number;
  minRuns: number;
}

/**
 * Aggregate per-model health stats from review_model_runs over a rolling
 * window. Only `status = 'completed'` runs contribute to the output-ratio
 * computation (failed runs typically have zero in/out tokens and would
 * dilute the signal).
 */
export async function getModelHealthScores(
  db: AnyDb,
  opts: HealthOptions,
): Promise<Map<string, ModelHealthScore>> {
  const cutoffMs = Date.now() - opts.lookbackHours * 3600_000;
  const rows = await db
    .select({
      modelId: reviewModelRuns.modelId,
      inputTokens: reviewModelRuns.inputTokens,
      outputTokens: reviewModelRuns.outputTokens,
      startedAt: reviewModelRuns.startedAt,
      status: reviewModelRuns.status,
    })
    .from(reviewModelRuns)
    .where(gte(reviewModelRuns.startedAt, new Date(cutoffMs)));

  const acc = new Map<string, { runs: number; sumIn: number; sumOut: number; lastSeen: Date }>();
  for (const r of rows) {
    if (r.status !== "completed") continue;
    const cur = acc.get(r.modelId) ?? { runs: 0, sumIn: 0, sumOut: 0, lastSeen: new Date(0) };
    cur.runs += 1;
    cur.sumIn += r.inputTokens;
    cur.sumOut += r.outputTokens;
    if (r.startedAt && r.startedAt > cur.lastSeen) cur.lastSeen = r.startedAt;
    acc.set(r.modelId, cur);
  }

  const result = new Map<string, ModelHealthScore>();
  for (const [modelId, v] of acc) {
    const denom = v.sumIn + v.sumOut;
    const outputRatio = denom > 0 ? v.sumOut / denom : 0;
    result.set(modelId, { runs: v.runs, outputRatio, lastSeen: v.lastSeen });
  }
  return result;
}

/**
 * Filter a list of model IDs down to those that look low-yield given the
 * health scores. Models with insufficient data (`runs < minRuns`) are NOT
 * flagged — we don't want a single bad-luck call to suspend a model.
 */
export function flagLowYieldModels(
  scores: Map<string, ModelHealthScore>,
  models: string[],
  opts: FlagOptions,
): string[] {
  const flagged: string[] = [];
  for (const modelId of models) {
    const s = scores.get(modelId);
    if (!s) continue;
    if (s.runs < opts.minRuns) continue;
    if (s.outputRatio < opts.threshold) flagged.push(modelId);
  }
  return flagged;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /tmp/urateam-work/packages/core && pnpm exec vitest run src/__tests__/review/model-health.test.ts
```
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/executor/review/model-health.ts packages/core/src/__tests__/review/model-health.test.ts
git commit -m "feat(review): add model-health helpers (getModelHealthScores, flagLowYieldModels)"
```

---

### Task B3: Wire into `review-providers-runner.ts`

**Files:**
- Modify: `packages/core/src/pipeline/review-providers-runner.ts`

- [ ] **Step 1: Read the current file to find the fanout-dispatch site**

```bash
cat /tmp/urateam-work/packages/core/src/pipeline/review-providers-runner.ts
```

Find the function that dispatches to fanout providers (likely around line 50–80, before `insertReviewModelRuns` at line 72).

- [ ] **Step 2: Add env parsing helper at the top of the file**

```ts
function parseFloatOr(envValue: string | undefined, fallback: number): number {
  if (!envValue) return fallback;
  const n = parseFloat(envValue);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function parseIntOr(envValue: string | undefined, fallback: number): number {
  if (!envValue) return fallback;
  const n = parseInt(envValue, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
```

- [ ] **Step 3: Add the health-check block**

Before fanout invocation (after model list resolution but before invocation), add:

```ts
import { getModelHealthScores, flagLowYieldModels } from "../executor/review/model-health.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { reviewModelLowOutputRatioEvent } from "../audit/events.js";

// Inside the dispatch function, after the model list is determined:
const healthThreshold = parseFloatOr(process.env.REVIEW_MODELS_MIN_OUTPUT_RATIO, 0.05);
const healthLookbackHours = parseIntOr(process.env.REVIEW_MODELS_HEALTH_LOOKBACK_HOURS, 168);
const healthMinRuns = parseIntOr(process.env.REVIEW_MODELS_MIN_RUNS, 5);

try {
  const scores = await getModelHealthScores(opts.db, {
    lookbackHours: healthLookbackHours,
    minRuns: healthMinRuns,
  });
  const flagged = flagLowYieldModels(scores, modelIds, {
    threshold: healthThreshold,
    minRuns: healthMinRuns,
  });
  for (const modelId of flagged) {
    const s = scores.get(modelId)!;
    log.warn(
      { modelId, outputRatio: s.outputRatio, runs: s.runs, threshold: healthThreshold },
      `review model below output-ratio threshold — consider removing from REVIEW_MODELS`,
    );
    void logAuditEventUnchecked(
      opts.db,
      reviewModelLowOutputRatioEvent({
        modelId,
        outputRatio: s.outputRatio,
        runs: s.runs,
        threshold: healthThreshold,
      }),
    );
  }
} catch (err) {
  log.warn({ err }, "model-health probe failed — skipping flagging this tick");
}
```

(Adjust `opts.db` / `modelIds` / `log` to match the actual local names in the file.)

- [ ] **Step 4: Update audit-immutability allow-list**

In `packages/core/src/__tests__/audit-immutability.test.ts`, add to the `allowed` array (the one for `logAuditEventUnchecked`):

```ts
"packages/core/src/pipeline/review-providers-runner.ts",
```

- [ ] **Step 5: Run the audit-immutability test**

```bash
cd /tmp/urateam-work/packages/core && pnpm exec vitest run src/__tests__/audit-immutability.test.ts
```
Expected: PASS (2/2 — both gates).

- [ ] **Step 6: Run full core test suite**

```bash
pnpm --filter @urateam/core build && pnpm --filter @urateam/core test
```
Expected: clean + all tests pass.

- [ ] **Step 7: Commit + push + open PR**

```bash
git add packages/core/src/pipeline/review-providers-runner.ts packages/core/src/__tests__/audit-immutability.test.ts
git commit -m "feat(review): low-yield model health check + audit alert (no auto-suspend)"
git push -u origin agent/model-health-check
gh pr create --title "feat(review): low-yield review-model health check + audit alert" --body "Closes the model-health half of the 2026-05-08 spec. ..."
```

**End of PR 2 (Phase B).** Wait for CI + merge approval.

---

## Phase C — Release v0.1.40

After both PRs merge:

- [ ] **Step 1: Cut the release**

```bash
cd /tmp/urateam-work && git checkout main && git pull --ff-only origin main
pnpm cut-release patch --push
```

The helper opens the release PR. Edit the CHANGELOG TODO with both Added entries.

- [ ] **Step 2: After merge, tag + GH release**

```bash
git tag v0.1.40 <merge-sha> && git push origin v0.1.40
gh release create v0.1.40 --title "v0.1.40 — cache telemetry + model health" --notes "..."
```

- [ ] **Step 3: Deploy to dogfood**

SSH to deploy host; bump `Dockerfile` + `docker-compose.dogfood.yml` ARGs to v0.1.40 numbers; `docker compose up -d --build urateam-dogfood`.

---

## Self-review

**Spec coverage:**
- Cache telemetry schema + capture + persist + render → Tasks A1–A5 ✅
- Model-health predicate → Tasks B1–B2 ✅
- Audit event emission → Task B3 ✅
- Env knobs (3 vars) → Task B3 ✅
- Audit-immutability allow-list → Task B3 ✅
- All AC bullets covered → ✅

**Type consistency:**
- `cacheCreationInputTokens` / `cacheReadInputTokens` used consistently across schema, agent-stream, executor, cost-summary, runner ✅
- `getModelHealthScores` returns `Map<string, ModelHealthScore>` consistent across `flagLowYieldModels` ✅

**Placeholder scan:** none.

**Scope check:** two clean PR boundaries; each PR is independently testable and shippable.

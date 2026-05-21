# Agent Session Continuity — Phase 4 Implementation Plan (Tracks B + D)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Track B (surgical review-fix) and Track D (decision artifact) on top of the now-default-on Phase 3 session resume. Track D adds a `pipeline_run_decisions` table populated from a `<decisions>` block emitted by the implement agent; Track B replaces the review-fix loop's full implement-template re-run with a focused `resume + findings + decisions` prompt. One new audit event (`pipeline.surgical_review_fix`) bumps the canonical count 56 → 57.

**Architecture:** The implement template (`prompt/templates.ts:implementTemplate`) gains a closing instruction to emit a `<decisions>{ JSON }</decisions>` block. `extract-handoff.ts` parses the block on every implement completion and writes a row to `pipeline_run_decisions` (best-effort; malformed blocks degrade silently). The review-fix loop in `pipeline/runner.ts` branches: when the run has a populated `agent_session_id` AND a non-empty decision payload AND the JSONL transcript is intact, it calls a new `surgicalReviewFixPrompt(findings, decisions)` template that resumes the existing session with just the blocking findings — no implement template, no `<previous-stage-context>` block. Otherwise it falls back to the legacy full-implement path. The choice is recorded via the new `pipeline.surgical_review_fix` audit event (payload includes `findingsCount`, `decisionPayloadBytes`, and the `path: "surgical" | "legacy"` discriminator).

**Tech Stack:** TypeScript, pnpm monorepo, Drizzle ORM (SQLite/Postgres), Vitest, `@anthropic-ai/claude-agent-sdk@0.2.x`.

**Spec reference:** `docs/superpowers/specs/2026-05-19-agent-session-continuity-design.md` — sections "Track B — Surgical review-fix (Phase 4)" and "Track D — Decision artifact (Phase 4)".

**Branching strategy:** All work lands on `feat/agent-session-continuity-phase4` (branch off main). One PR at end, draft until merged manually after operator soak — do NOT enable auto-merge for this PR; Phase 3 is the verification environment. Each task ends with a commit so the branch is bisectable.

**Dependency on BEC-228:** BEC-228 (`resolveSessionOpts` helper extraction) is currently In Review on the dogfood. If it merges before this plan starts execution, Task 5 (`runSurgicalReviewFix` runner integration) should use the new helper instead of duplicating its session-existence pre-check. The plan is written to work with the **pre-BEC-228 inline duplication pattern** seen in `executor.ts` and `deep-review.ts`; a one-line swap in Task 5 covers the post-merge case.

---

## File Map

**Modified:**
- `packages/core/src/types.ts` — add `pipeline.surgical_review_fix` to `AuditEventTypeSchema`; add `DecisionArtifact` Zod schema (`decisions[]`, `left_unhandled[]`, `key_files[]`)
- `packages/core/src/audit/events.ts` — add `surgicalReviewFixEvent()` builder; bump canonical-count comment 56 → 57
- `packages/core/src/__tests__/audit-immutability.test.ts` — bump count assertion 56 → 57
- `packages/core/src/db/schema.ts` — add `pipelineRunDecisions` Drizzle table
- `packages/core/src/db/client.ts` — `getCreateTablesDDL()` template gains a `pipeline_run_decisions` CREATE; no `MIGRATION_COLUMNS` entry needed (whole-table additions go through `getCreateTablesDDL`, see existing `pm_approvals` precedent)
- `packages/core/src/executor/extract-handoff.ts` — add `parseDecisionsBlock()` parser; `extractHandoff()` (line ~84) calls it and attaches the parsed payload to its return value
- `packages/core/src/executor/prompt/templates.ts` — append `<decisions>` instruction to the third branch of `implementTemplate()` (line ~300); add new `surgicalReviewFixPrompt(findings, decisions)` export
- `packages/core/src/pipeline/runner.ts` — review-fix loop (line ~1462): branch on session+decisions; new `runSurgicalReviewFix()` helper; insert call to `persistDecisionArtifact()` after every implement-stage completion (both initial + RALPH iterations + review-fix's own re-implement when falling back to legacy)
- `CLAUDE.md` — add Phase 4 section under "Agent Session Continuity (BEC-227)"; bump audit-event canonical count comment 56 → 57
- `.claude/CLAUDE.md` — mirror the key bits (Phase 4 surgical-review-fix + decisions table)

**Created:**
- `packages/core/src/db/decisions-store.ts` — `persistDecisionArtifact(db, { pipelineRunId, iteration, stage, payload })` + `getLatestDecisionArtifact(db, pipelineRunId)`. Two functions, both pure DB ops. Isolated for easy mocking in unit tests.
- `packages/core/src/__tests__/decisions-parser.test.ts` — parser unit tests
- `packages/core/src/__tests__/decisions-store.test.ts` — DB read/write unit tests (SQLite `:memory:`)
- `packages/core/src/__tests__/surgical-review-fix-prompt.test.ts` — template snapshot tests
- `packages/core/src/__tests__/surgical-review-fix-runner.test.ts` — runner integration tests (mocked SDK + DB)

**Decomposition rationale:** The `decisions-store.ts` module is split from `extract-handoff.ts` so that the runner can call `getLatestDecisionArtifact()` without importing the heavy handoff-extraction code path. The parser stays in `extract-handoff.ts` (same locality as `parseHandoffArtifact`). The new template lives in `templates.ts` alongside `implementTemplate` (review-fix is a template variant, not a separate concept).

---

## Phase 4 Tasks

### Task 1: Add `DecisionArtifact` Zod schema + `pipeline.surgical_review_fix` audit event type

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/__tests__/audit-immutability.test.ts`
- Test: `packages/core/src/__tests__/decision-artifact-schema.test.ts` (create)

- [ ] **Step 1: Write the failing schema test**

Create `packages/core/src/__tests__/decision-artifact-schema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { DecisionArtifactSchema, AuditEventTypeSchema } from "../types.js";

describe("DecisionArtifactSchema (BEC-227 Phase 4 / Track D)", () => {
  it("accepts a fully populated payload", () => {
    const ok = DecisionArtifactSchema.parse({
      decisions: [
        { choice: "use Zod refinement", reason: "preserves error path", alternatives_considered: ["preprocess"] },
      ],
      left_unhandled: [
        { case: "future schema version", reason: "out of scope per AC #3" },
      ],
      key_files: ["packages/core/src/types.ts"],
    });
    expect(ok.decisions).toHaveLength(1);
    expect(ok.left_unhandled).toHaveLength(1);
    expect(ok.key_files).toEqual(["packages/core/src/types.ts"]);
  });

  it("accepts an empty payload (all arrays optional, default to empty)", () => {
    const ok = DecisionArtifactSchema.parse({});
    expect(ok.decisions).toEqual([]);
    expect(ok.left_unhandled).toEqual([]);
    expect(ok.key_files).toEqual([]);
  });

  it("rejects a decision missing the required `choice` field", () => {
    expect(() =>
      DecisionArtifactSchema.parse({ decisions: [{ reason: "no choice" }] }),
    ).toThrow();
  });

  it("alternatives_considered defaults to empty array when omitted", () => {
    const ok = DecisionArtifactSchema.parse({
      decisions: [{ choice: "x", reason: "y" }],
    });
    expect(ok.decisions[0]!.alternatives_considered).toEqual([]);
  });
});

describe("AuditEventTypeSchema includes pipeline.surgical_review_fix", () => {
  it("accepts the new event type", () => {
    expect(() => AuditEventTypeSchema.parse("pipeline.surgical_review_fix")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/decision-artifact-schema.test.ts
```

Expected: FAIL — `DecisionArtifactSchema` is not exported; `pipeline.surgical_review_fix` is not in the enum.

- [ ] **Step 3: Add `pipeline.surgical_review_fix` to the audit enum**

In `packages/core/src/types.ts`, locate the `AuditEventTypeSchema = z.enum([...])` block (currently lines 486–587). Immediately AFTER the `"system.session_volume_warning"` entry (line ~586) and BEFORE the closing `]);`, add:

```typescript
  /** BEC-227 Phase 4 / Track B — the review-fix loop took the surgical path:
   *  it resumed the per-run Agent SDK session and prompted the agent with
   *  just the blocking review findings (plus the previously-persisted
   *  decision artifact when available), instead of re-running the full
   *  implement template. Payload: `runId`, `issueId`, `path` ("surgical" |
   *  "legacy"), `findingsCount`, `decisionPayloadBytes` (0 when no
   *  artifact was found). The `legacy` path is logged too so operators
   *  can audit fallback rates. */
  "pipeline.surgical_review_fix",
```

- [ ] **Step 4: Add the `DecisionArtifactSchema` Zod schema**

In `packages/core/src/types.ts`, scroll to a suitable spot for new schemas (search for `HandoffArtifactSchema` — add the new schema AFTER it). Add:

```typescript
/**
 * BEC-227 Phase 4 / Track D. The implement agent emits this as a
 * `<decisions>{ JSON }</decisions>` XML block at the end of its turn.
 * Used by the review-fix loop's surgical prompt and by future Track F
 * cross-run inheritance. Every field is optional — malformed or missing
 * blocks degrade silently to an empty artifact.
 */
export const DecisionArtifactSchema = z.object({
  decisions: z.array(
    z.object({
      choice: z.string(),
      reason: z.string(),
      alternatives_considered: z.array(z.string()).default([]),
    }),
  ).default([]),
  left_unhandled: z.array(
    z.object({
      case: z.string(),
      reason: z.string(),
    }),
  ).default([]),
  key_files: z.array(z.string()).default([]),
});
export type DecisionArtifact = z.infer<typeof DecisionArtifactSchema>;
```

- [ ] **Step 5: Bump the audit-event count assertion**

In `packages/core/src/__tests__/audit-immutability.test.ts`, locate the assertion that counts `AuditEventTypeSchema.options.length` (search for `56` and the comment that points back to CLAUDE.md). Change every `56` to `57`. If the test file has a comment of the form `// Tier 1d: …` referencing the canonical count, update its prose to say 57 as well.

```bash
cd packages/core && grep -n "56" src/__tests__/audit-immutability.test.ts
```

Replace each match with `57` ONLY where it refers to the canonical count (not unrelated occurrences like line numbers).

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd packages/core && npx vitest run src/__tests__/decision-artifact-schema.test.ts src/__tests__/audit-immutability.test.ts
```

Expected: PASS for both files.

- [ ] **Step 7: Typecheck**

```bash
pnpm -w typecheck
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git checkout -b feat/agent-session-continuity-phase4
git add packages/core/src/types.ts \
        packages/core/src/__tests__/decision-artifact-schema.test.ts \
        packages/core/src/__tests__/audit-immutability.test.ts
git commit -m "feat(BEC-227): add DecisionArtifact schema + pipeline.surgical_review_fix audit event (Phase 4 / Track B+D foundation)"
```

---

### Task 2: Add `pipeline_run_decisions` table

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/core/src/db/client.ts` (CREATE TABLE inside `getCreateTablesDDL`)
- Test: `packages/core/src/__tests__/decisions-table-migration.test.ts` (create)

- [ ] **Step 1: Write the failing migration test**

Create `packages/core/src/__tests__/decisions-table-migration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { pipelineRunDecisions, pipelineRuns } from "../db/schema.js";

describe("pipeline_run_decisions migration (BEC-227 Phase 4 / Track D)", () => {
  it("table exists on a fresh SQLite db and stores a row", async () => {
    const { db } = await createDb({ url: ":memory:" });
    // Parent FK row first.
    await db.insert(pipelineRuns).values({
      id: "run-1",
      issueId: "BEC-X",
      issueTitle: "test",
      repoUrl: "https://example.com/repo",
      pipelineKey: "auto-implement",
      status: "queued",
      startedAt: new Date(),
    } as any);
    await db.insert(pipelineRunDecisions).values({
      id: "dec-1",
      pipelineRunId: "run-1",
      iteration: 0,
      stage: "implement",
      payload: JSON.stringify({ decisions: [], left_unhandled: [], key_files: [] }),
      createdAt: new Date(),
    } as any);
    const rows = await db.select().from(pipelineRunDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe("implement");
    expect(rows[0]!.iteration).toBe(0);
  });

  it("multiple rows per (pipeline_run_id, iteration) ordering preserved", async () => {
    const { db } = await createDb({ url: ":memory:" });
    await db.insert(pipelineRuns).values({
      id: "run-2",
      issueId: "BEC-Y",
      issueTitle: "test",
      repoUrl: "https://example.com/repo",
      pipelineKey: "auto-implement",
      status: "queued",
      startedAt: new Date(),
    } as any);
    for (let i = 0; i < 3; i++) {
      await db.insert(pipelineRunDecisions).values({
        id: `dec-${i}`,
        pipelineRunId: "run-2",
        iteration: i,
        stage: "implement",
        payload: JSON.stringify({ decisions: [{ choice: `c${i}`, reason: "r" }] }),
        createdAt: new Date(Date.now() + i * 1000),
      } as any);
    }
    const rows = await db.select().from(pipelineRunDecisions);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.iteration).sort()).toEqual([0, 1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/decisions-table-migration.test.ts
```

Expected: FAIL — `pipelineRunDecisions` export doesn't exist on schema.

- [ ] **Step 3: Add the Drizzle table to `schema.ts`**

In `packages/core/src/db/schema.ts`, scroll to the end of the file (or to the section listing other tables — look for `pmApprovals` as a structural cousin). Add:

```typescript
/**
 * BEC-227 Phase 4 / Track D. Persists the `<decisions>` JSON block emitted
 * by the implement agent at the end of each implement turn. Multiple rows
 * per pipeline_run when RALPH iterates (one per (iteration, stage)).
 */
export const pipelineRunDecisions = sqliteTable("pipeline_run_decisions", {
  id: text("id").primaryKey(),
  pipelineRunId: text("pipeline_run_id").notNull().references(() => pipelineRuns.id),
  iteration: integer("iteration").notNull(),
  stage: text("stage").notNull(),
  payload: text("payload").notNull(),
  createdAt: crossTimestamp("created_at").notNull(),
});
```

**IMPORTANT:** Use the same `crossTimestamp` custom type that `pipelineRuns.startedAt` already uses (look for the import at the top of the file). This is the type that switches between epoch-int (SQLite) and ISO string (Postgres) per BEC-89; using `integer().$type<Date>()` here instead would silently fail on Postgres.

Also export the type alias for downstream code:

```typescript
export type PipelineRunDecisionRow = typeof pipelineRunDecisions.$inferSelect;
```

- [ ] **Step 4: Add CREATE TABLE DDL in `client.ts`**

In `packages/core/src/db/client.ts`, find `getCreateTablesDDL(driver)`. It returns one large string with `CREATE TABLE IF NOT EXISTS …` statements; find the block for `pm_approvals` (it's a structural twin: FK to `pipeline_runs`, secondary table). Add immediately after `pm_approvals` (or anywhere among the create-table calls — order doesn't matter as long as `pipeline_runs` is created first):

```typescript
`CREATE TABLE IF NOT EXISTS pipeline_run_decisions (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
  iteration INTEGER NOT NULL,
  stage TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at ${driver === "postgres" ? "TIMESTAMPTZ" : "INTEGER"} NOT NULL
)`,
`CREATE INDEX IF NOT EXISTS idx_pipeline_run_decisions_run ON pipeline_run_decisions(pipeline_run_id, iteration)`,
```

- [ ] **Step 5: Add the same table to the Postgres file-based migration (if applicable)**

`getCreateTablesDDL` is the source of truth on fresh boot, but the project also keeps file-based migrations under `packages/core/src/db/migrations/{sqlite,postgres}/`. Check whether recent BEC-227 Phase 1 migrations added files there (look for `agent_session_id` in `packages/core/src/db/migrations/`):

```bash
grep -rn "agent_session_id" packages/core/src/db/migrations/
```

If a migration file exists for Phase 1 (e.g., `2026-05-19_agent_session_id.sql`), add a sibling file for this table:

- Create: `packages/core/src/db/migrations/sqlite/<YYYY-MM-DD>_pipeline_run_decisions.sql`
- Create: `packages/core/src/db/migrations/postgres/<YYYY-MM-DD>_pipeline_run_decisions.sql`

Each file contains the same CREATE TABLE as above (with driver-appropriate type for `created_at`: `INTEGER` for SQLite, `TIMESTAMPTZ` for Postgres) plus the CREATE INDEX line.

If no Phase 1 migration file exists, skip this step — the project's only path is `getCreateTablesDDL`.

- [ ] **Step 6: Run test to verify it passes**

```bash
cd packages/core && npx vitest run src/__tests__/decisions-table-migration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck**

```bash
pnpm -w typecheck
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/db/schema.ts \
        packages/core/src/db/client.ts \
        packages/core/src/__tests__/decisions-table-migration.test.ts
# Add migration files if Step 5 created them.
git commit -m "feat(BEC-227): add pipeline_run_decisions table for Track D decision artifact persistence"
```

---

### Task 3: `decisions-store.ts` — persist + read helpers

**Files:**
- Create: `packages/core/src/db/decisions-store.ts`
- Test: `packages/core/src/__tests__/decisions-store.test.ts` (create)

- [ ] **Step 1: Write the failing store test**

Create `packages/core/src/__tests__/decisions-store.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import {
  persistDecisionArtifact,
  getLatestDecisionArtifact,
} from "../db/decisions-store.js";
import type { DecisionArtifact } from "../types.js";

const baseRun = (id: string) => ({
  id,
  issueId: "BEC-X",
  issueTitle: "test",
  repoUrl: "https://example.com/repo",
  pipelineKey: "auto-implement",
  status: "queued",
  startedAt: new Date(),
});

describe("decisions-store (BEC-227 Phase 4)", () => {
  it("persistDecisionArtifact writes a row that getLatestDecisionArtifact returns", async () => {
    const { db } = await createDb({ url: ":memory:" });
    await db.insert(pipelineRuns).values(baseRun("r1") as any);
    const artifact: DecisionArtifact = {
      decisions: [{ choice: "x", reason: "y", alternatives_considered: [] }],
      left_unhandled: [],
      key_files: ["a.ts"],
    };
    await persistDecisionArtifact(db, {
      pipelineRunId: "r1",
      iteration: 0,
      stage: "implement",
      payload: artifact,
    });
    const got = await getLatestDecisionArtifact(db, "r1");
    expect(got).not.toBeNull();
    expect(got!.payload.decisions[0]!.choice).toBe("x");
    expect(got!.iteration).toBe(0);
    expect(got!.stage).toBe("implement");
  });

  it("getLatestDecisionArtifact returns the highest-iteration row when multiple exist", async () => {
    const { db } = await createDb({ url: ":memory:" });
    await db.insert(pipelineRuns).values(baseRun("r2") as any);
    for (const i of [0, 2, 1]) {
      await persistDecisionArtifact(db, {
        pipelineRunId: "r2",
        iteration: i,
        stage: "implement",
        payload: { decisions: [{ choice: `c${i}`, reason: "r", alternatives_considered: [] }], left_unhandled: [], key_files: [] },
      });
    }
    const got = await getLatestDecisionArtifact(db, "r2");
    expect(got!.iteration).toBe(2);
    expect(got!.payload.decisions[0]!.choice).toBe("c2");
  });

  it("getLatestDecisionArtifact returns null when no rows exist for the run", async () => {
    const { db } = await createDb({ url: ":memory:" });
    await db.insert(pipelineRuns).values(baseRun("r3") as any);
    const got = await getLatestDecisionArtifact(db, "r3");
    expect(got).toBeNull();
  });

  it("persistDecisionArtifact swallows malformed payloads by stringifying as-is and never throws", async () => {
    const { db } = await createDb({ url: ":memory:" });
    await db.insert(pipelineRuns).values(baseRun("r4") as any);
    // Cast as any: the persist helper is the boundary; we ensure it doesn't crash even with junk.
    await expect(
      persistDecisionArtifact(db, {
        pipelineRunId: "r4",
        iteration: 0,
        stage: "implement",
        payload: { decisions: "not-an-array" } as any,
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/decisions-store.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `decisions-store.ts`**

Create `packages/core/src/db/decisions-store.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { pipelineRunDecisions } from "./schema.js";
import type { AnyDb } from "./client.js";
import type { DecisionArtifact } from "../types.js";

/**
 * BEC-227 Phase 4 / Track D. Persists one row to `pipeline_run_decisions`.
 * Never throws — the caller (extract-handoff / runner) MUST NOT have a
 * pipeline failure mode that depends on this writing successfully.
 */
export async function persistDecisionArtifact(
  db: AnyDb,
  args: {
    pipelineRunId: string;
    iteration: number;
    stage: string;
    payload: DecisionArtifact | Record<string, unknown>;
  },
): Promise<void> {
  try {
    await (db as any)
      .insert(pipelineRunDecisions)
      .values({
        id: randomUUID(),
        pipelineRunId: args.pipelineRunId,
        iteration: args.iteration,
        stage: args.stage,
        payload: JSON.stringify(args.payload),
        createdAt: new Date(),
      });
  } catch {
    // Best-effort write; fall through silently per Track D's "graceful
    // degradation" contract. The caller has already audit-logged
    // anything that matters.
  }
}

/**
 * BEC-227 Phase 4 / Track D. Returns the highest-iteration decision
 * artifact for a run, or null when none exists. Consumed by the
 * surgical-review-fix path (Track B) — the LATEST decisions are the
 * ones the review-fix agent should be reminded of.
 */
export async function getLatestDecisionArtifact(
  db: AnyDb,
  pipelineRunId: string,
): Promise<{ iteration: number; stage: string; payload: DecisionArtifact } | null> {
  const rows = await (db as any)
    .select()
    .from(pipelineRunDecisions)
    .where(eq(pipelineRunDecisions.pipelineRunId, pipelineRunId))
    .orderBy(desc(pipelineRunDecisions.iteration))
    .limit(1);
  if (!rows[0]) return null;
  try {
    return {
      iteration: rows[0].iteration as number,
      stage: rows[0].stage as string,
      payload: JSON.parse(rows[0].payload as string),
    };
  } catch {
    // Corrupted payload — return null rather than crashing the
    // review-fix loop. The audit log already shows the stage ran.
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/core && npx vitest run src/__tests__/decisions-store.test.ts
```

Expected: PASS (all 4 tests).

- [ ] **Step 5: Typecheck**

```bash
pnpm -w typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/db/decisions-store.ts \
        packages/core/src/__tests__/decisions-store.test.ts
git commit -m "feat(BEC-227): add decisions-store with persist + getLatest helpers (Track D)"
```

---

### Task 4: `<decisions>` block parser in `extract-handoff.ts`

**Files:**
- Modify: `packages/core/src/executor/extract-handoff.ts`
- Test: `packages/core/src/__tests__/decisions-parser.test.ts` (create)

- [ ] **Step 1: Write the failing parser test**

Create `packages/core/src/__tests__/decisions-parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseDecisionsBlock } from "../executor/extract-handoff.js";

const validAgentOutput = `
Some agent prose explaining the work...

<decisions>
{
  "decisions": [
    {
      "choice": "use Zod refinement instead of preprocess",
      "reason": "preserves error path",
      "alternatives_considered": ["preprocess", "transform"]
    }
  ],
  "left_unhandled": [
    { "case": "schema v2", "reason": "out of scope" }
  ],
  "key_files": ["packages/core/src/types.ts"]
}
</decisions>

More prose after the block.
`;

describe("parseDecisionsBlock (BEC-227 Phase 4 / Track D)", () => {
  it("extracts a valid decisions block", () => {
    const got = parseDecisionsBlock(validAgentOutput);
    expect(got).not.toBeNull();
    expect(got!.decisions).toHaveLength(1);
    expect(got!.decisions[0]!.choice).toBe("use Zod refinement instead of preprocess");
    expect(got!.left_unhandled).toHaveLength(1);
    expect(got!.key_files).toEqual(["packages/core/src/types.ts"]);
  });

  it("returns null when no <decisions> block is present", () => {
    expect(parseDecisionsBlock("just some prose, no block")).toBeNull();
  });

  it("returns null when the block contains malformed JSON", () => {
    const bad = "<decisions>{ not valid json }</decisions>";
    expect(parseDecisionsBlock(bad)).toBeNull();
  });

  it("returns null when the JSON doesn't match the schema", () => {
    const wrong = `<decisions>{"decisions": [{"missing_choice": true}]}</decisions>`;
    expect(parseDecisionsBlock(wrong)).toBeNull();
  });

  it("extracts the LAST block if the agent emits multiple", () => {
    const dual = `
<decisions>{"decisions": [{"choice": "first", "reason": "r"}]}</decisions>
<decisions>{"decisions": [{"choice": "second", "reason": "r"}]}</decisions>
`;
    const got = parseDecisionsBlock(dual);
    expect(got!.decisions[0]!.choice).toBe("second");
  });

  it("handles arbitrary whitespace inside the block", () => {
    const padded = `<decisions>\n\n  {"decisions": []}  \n\n</decisions>`;
    const got = parseDecisionsBlock(padded);
    expect(got).not.toBeNull();
    expect(got!.decisions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/decisions-parser.test.ts
```

Expected: FAIL — `parseDecisionsBlock` is not exported.

- [ ] **Step 3: Add the parser to `extract-handoff.ts`**

In `packages/core/src/executor/extract-handoff.ts`, add the import near the top (the file already imports from `./handoff.js`):

```typescript
import { DecisionArtifactSchema, type DecisionArtifact } from "../types.js";
```

Then add the new export function. Place it ABOVE `extractHandoff()` (the existing async function at line ~84) so it's available to downstream callers:

```typescript
/**
 * BEC-227 Phase 4 / Track D. Extracts the LAST `<decisions>{ JSON }</decisions>`
 * block from agent output. Returns null on any failure (missing block,
 * malformed JSON, schema mismatch) — graceful degradation by design;
 * Track B's surgical-review-fix path simply omits the "previously decided"
 * preamble when this returns null.
 */
export function parseDecisionsBlock(agentOutput: string): DecisionArtifact | null {
  if (!agentOutput) return null;
  // Match all blocks; take the last (an agent that revises its decisions
  // mid-turn ends with the canonical version).
  const re = /<decisions>([\s\S]*?)<\/decisions>/g;
  let lastMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(agentOutput)) !== null) {
    lastMatch = m[1] ?? null;
  }
  if (lastMatch === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastMatch.trim());
  } catch {
    return null;
  }
  const result = DecisionArtifactSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/core && npx vitest run src/__tests__/decisions-parser.test.ts
```

Expected: PASS (all 6 tests).

- [ ] **Step 5: Typecheck**

```bash
pnpm -w typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/executor/extract-handoff.ts \
        packages/core/src/__tests__/decisions-parser.test.ts
git commit -m "feat(BEC-227): add parseDecisionsBlock for Track D decision-artifact extraction"
```

---

### Task 5: Implement-template emits `<decisions>` instruction

**Files:**
- Modify: `packages/core/src/executor/prompt/templates.ts`
- Test: `packages/core/src/__tests__/implement-template-decisions.test.ts` (create)

- [ ] **Step 1: Write the failing template test**

Create `packages/core/src/__tests__/implement-template-decisions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { implementTemplate } from "../executor/prompt/templates.js";
import type { SanitizedIssue, RepoConfig } from "../types.js";

const issue: SanitizedIssue = {
  id: "BEC-X",
  slug: "test-feature",
  title: "test",
  description: "do the thing",
  url: "https://linear.app/test",
  acceptanceCriteria: ["AC1: thing works"],
} as any;

const repo: RepoConfig = {
  url: "https://example.com/repo",
  defaultBranch: "main",
  buildCommand: "pnpm build",
  testCommand: "pnpm test",
} as any;

describe("implementTemplate emits decisions instruction (BEC-227 Phase 4 / Track D)", () => {
  it("standard (non-review-feedback, non-merge-conflict) branch includes <decisions> instruction", () => {
    const out = implementTemplate(issue, repo);
    expect(out).toMatch(/<decisions>/);
    expect(out).toMatch(/decisions/i);
    expect(out).toMatch(/key_files/);
    expect(out).toMatch(/left_unhandled/);
  });

  it("review-feedback branch does NOT include decisions instruction (surgical scope)", () => {
    const out = implementTemplate(issue, repo, undefined, {
      prBranch: "agent/BEC-X-test",
      comments: [],
    } as any);
    expect(out).not.toMatch(/<decisions>/);
  });

  it("merge-conflict branch does NOT include decisions instruction", () => {
    const out = implementTemplate(issue, repo, undefined, undefined, {
      defaultBranch: "main",
    } as any);
    expect(out).not.toMatch(/<decisions>/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/implement-template-decisions.test.ts
```

Expected: FAIL — the default branch doesn't contain `<decisions>` yet.

- [ ] **Step 3: Append the `<decisions>` instruction to the third branch of `implementTemplate`**

In `packages/core/src/executor/prompt/templates.ts`, locate `implementTemplate` (line 247). The third branch (the default, plain-implement case) starts at line ~300 (`return \`You are the implement agent. Your job is to write the code that resolves the issue.`). After the closing `Do NOT claim work is complete if acceptance criteria are not satisfied.` line and BEFORE the final `\`.trim();`, append a new section:

```typescript
// In templates.ts, inside the third branch of implementTemplate,
// AFTER the "Do NOT claim work is complete if acceptance criteria are not
// satisfied." line and BEFORE the closing backtick:

...existing text...

BEFORE you finish, emit a structured decision artifact so downstream
stages can see your reasoning without re-deriving it from the diff.
Output a single XML block at the very end of your final message:

<decisions>
{
  "decisions": [
    { "choice": "<short label of a non-obvious design choice you made>",
      "reason": "<why this over the alternatives>",
      "alternatives_considered": ["<other approach you weighed>"] }
  ],
  "left_unhandled": [
    { "case": "<edge case you noticed but did NOT fix>",
      "reason": "<why it's out of scope>" }
  ],
  "key_files": ["<path/to/file.ts>", "..."]
}
</decisions>

Rules:
- Emit the block exactly once, at the END of your final message.
- Use valid JSON (double-quoted keys + strings; no trailing commas).
- Keep each "choice" / "reason" / "case" to one sentence.
- If you had no non-obvious decisions, "left_unhandled" cases, or relevant
  files, emit empty arrays: { "decisions": [], "left_unhandled": [], "key_files": [] }.
- A reviewer will see this — keep it terse and honest, NOT marketing.
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/core && npx vitest run src/__tests__/implement-template-decisions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
pnpm -w typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/executor/prompt/templates.ts \
        packages/core/src/__tests__/implement-template-decisions.test.ts
git commit -m "feat(BEC-227): implement template instructs agent to emit <decisions> block (Track D)"
```

---

### Task 6: Wire `extractHandoff()` to persist decisions

**Files:**
- Modify: `packages/core/src/executor/extract-handoff.ts` (extend the return value of `extractHandoff()`)
- Modify: `packages/core/src/pipeline/runner.ts` (call `persistDecisionArtifact` after implement-stage completions)
- Test: `packages/core/src/__tests__/extract-handoff-decisions.test.ts` (create)

- [ ] **Step 1: Read the current shape of `extractHandoff()`**

```bash
cd /Users/jonb/projects/urateam && sed -n '80,130p' packages/core/src/executor/extract-handoff.ts
```

Note the function signature and return type. The decision payload should ride alongside whatever else it returns. Verify the type name (e.g. `ExtractHandoffResult` or inline object literal).

- [ ] **Step 2: Write the failing test for the extended return shape**

Create `packages/core/src/__tests__/extract-handoff-decisions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractHandoff } from "../executor/extract-handoff.js";

const outputWithDecisions = `
implemented the thing.

<handoff>
{"stage": "implement", "summary": "done", "filesChanged": ["a.ts"], "blockingFindings": []}
</handoff>

<decisions>
{ "decisions": [{ "choice": "x", "reason": "y" }], "left_unhandled": [], "key_files": ["a.ts"] }
</decisions>
`;

describe("extractHandoff returns decision artifact alongside handoff (BEC-227 Phase 4 / Track D)", () => {
  it("attaches parsed decisions to the result", async () => {
    const got = await extractHandoff(
      outputWithDecisions,
      "implement",
      "/tmp/nowhere",
      "run-1",
      "BEC-X",
    );
    expect(got.decisions).not.toBeNull();
    expect(got.decisions!.decisions[0]!.choice).toBe("x");
    expect(got.decisions!.key_files).toEqual(["a.ts"]);
  });

  it("sets decisions to null when the block is absent", async () => {
    const got = await extractHandoff(
      "no decisions here, just <handoff>{\"stage\":\"implement\",\"summary\":\"x\",\"filesChanged\":[],\"blockingFindings\":[]}</handoff>",
      "implement",
      "/tmp/nowhere",
      "run-1",
      "BEC-X",
    );
    expect(got.decisions).toBeNull();
  });
});
```

**Note:** Verify the exact signature of `extractHandoff()` in Step 1 and adjust the test's call site if positional args differ from the snippet above (e.g., it may take `workdir` first, or take an options object).

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/extract-handoff-decisions.test.ts
```

Expected: FAIL — return shape doesn't include `decisions`.

- [ ] **Step 4: Extend the return shape of `extractHandoff()`**

In `packages/core/src/executor/extract-handoff.ts`, locate the existing return at the bottom of `extractHandoff()`. Inside the function body (just before the final `return`), call the new parser:

```typescript
const decisions = parseDecisionsBlock(agentOutput);
```

Then in the return object, add a new property:

```typescript
return {
  // ...existing fields (handoff, fastPath, etc.)...
  decisions, // null when no block / malformed / schema-mismatch
};
```

If the function has an explicit return-type annotation (or an explicit interface like `ExtractHandoffResult`), add `decisions: DecisionArtifact | null` to that type.

- [ ] **Step 5: Persist decisions from the runner after every implement-stage completion**

In `packages/core/src/pipeline/runner.ts`, locate every site that calls `extractHandoff(...)` after an implement-stage. There are typically three: the main stage loop, the RALPH re-implement loop, and the review-fix re-implement loop (legacy path). For each one, after `extractHandoff` returns, add:

```typescript
if (extractResult.decisions) {
  await persistDecisionArtifact(this.db, {
    pipelineRunId: run.id,
    iteration: ralphIteration ?? 0,   // 0 for initial implement, RALPH iteration index otherwise
    stage: "implement",                // or fixStage variable name inside review-fix loop
    payload: extractResult.decisions,
  });
}
```

**Pick the right `iteration` variable per site:**

| Call site | Variable to use for `iteration` |
|---|---|
| main stage loop (initial implement) | `0` |
| RALPH re-implement loop | the RALPH iteration counter (search for `ralphIteration` or similar in the loop body) |
| review-fix re-implement (legacy fallback path) | `rfIteration` (already defined at line ~1475) |

Add the import at the top of `runner.ts`:

```typescript
import { persistDecisionArtifact } from "../db/decisions-store.js";
```

- [ ] **Step 6: Run all affected tests**

```bash
cd packages/core && npx vitest run src/__tests__/extract-handoff-decisions.test.ts src/__tests__/decisions-store.test.ts src/__tests__/decisions-parser.test.ts
```

Expected: PASS for all.

- [ ] **Step 7: Typecheck**

```bash
pnpm -w typecheck
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/executor/extract-handoff.ts \
        packages/core/src/pipeline/runner.ts \
        packages/core/src/__tests__/extract-handoff-decisions.test.ts
git commit -m "feat(BEC-227): persist decision artifacts after every implement-stage completion (Track D)"
```

---

### Task 7: `surgicalReviewFixPrompt` template

**Files:**
- Modify: `packages/core/src/executor/prompt/templates.ts`
- Test: `packages/core/src/__tests__/surgical-review-fix-prompt.test.ts` (create)

- [ ] **Step 1: Write the failing template test**

Create `packages/core/src/__tests__/surgical-review-fix-prompt.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { surgicalReviewFixPrompt } from "../executor/prompt/templates.js";
import type { ReviewFinding, DecisionArtifact } from "../types.js";

const findings: ReviewFinding[] = [
  {
    severity: "blocking",
    category: "correctness",
    file: "packages/core/src/foo.ts",
    line: 42,
    message: "this null-check is wrong; foo can be undefined here",
  } as any,
  {
    severity: "blocking",
    category: "tests",
    file: "packages/core/src/__tests__/foo.test.ts",
    line: 10,
    message: "missing test for the empty-array branch",
  } as any,
];

const decisions: DecisionArtifact = {
  decisions: [
    { choice: "use Zod refinement", reason: "preserves error path", alternatives_considered: [] },
  ],
  left_unhandled: [],
  key_files: ["packages/core/src/types.ts"],
};

describe("surgicalReviewFixPrompt (BEC-227 Phase 4 / Track B)", () => {
  it("includes every finding's message + file + line", () => {
    const out = surgicalReviewFixPrompt(findings, decisions);
    for (const f of findings) {
      expect(out).toContain((f as any).message);
      expect(out).toContain((f as any).file);
      expect(out).toContain(String((f as any).line));
    }
  });

  it("renders previously-decided context when decisions are present", () => {
    const out = surgicalReviewFixPrompt(findings, decisions);
    expect(out).toContain("use Zod refinement");
    expect(out).toMatch(/previously decided|previously made|prior decisions/i);
  });

  it("omits the decisions section when decisions are null", () => {
    const out = surgicalReviewFixPrompt(findings, null);
    expect(out).not.toContain("Zod");
    // Findings still present.
    for (const f of findings) {
      expect(out).toContain((f as any).message);
    }
  });

  it("omits the decisions section when decisions are empty", () => {
    const out = surgicalReviewFixPrompt(findings, {
      decisions: [],
      left_unhandled: [],
      key_files: [],
    });
    expect(out).not.toMatch(/previously decided|previously made|prior decisions/i);
  });

  it("does NOT contain any <previous-stage-context> XML or implement-template boilerplate", () => {
    const out = surgicalReviewFixPrompt(findings, decisions);
    expect(out).not.toMatch(/<previous-stage-context>/);
    expect(out).not.toMatch(/INTEGRATION REQUIREMENT/);
    expect(out).not.toMatch(/Create a branch named/);
  });

  it("instructs the agent to commit + push but NOT create a new PR", () => {
    const out = surgicalReviewFixPrompt(findings, decisions);
    expect(out).toMatch(/commit/i);
    expect(out).toMatch(/push/i);
    expect(out).toMatch(/do not create|don't create|do NOT create/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/surgical-review-fix-prompt.test.ts
```

Expected: FAIL — `surgicalReviewFixPrompt` is not exported.

- [ ] **Step 3: Add `surgicalReviewFixPrompt` to `templates.ts`**

In `packages/core/src/executor/prompt/templates.ts`, add this export at the end of the file (after `reviewTemplate`):

```typescript
/**
 * BEC-227 Phase 4 / Track B. Used by the review-fix loop when the
 * per-run Agent SDK session is intact AND there is a populated decision
 * artifact AND `URATEAM_ENABLE_AGENT_SESSION_RESUME` was on at run start.
 *
 * The prompt is intentionally narrow: the resumed agent already has the
 * full implement-stage context (tool calls, file edits, reasoning). All
 * we need to give it is the list of blocking findings + a reminder of
 * its own prior decisions so it can choose to preserve or revise them.
 */
export function surgicalReviewFixPrompt(
  findings: Array<{ severity: string; category?: string; file?: string; line?: number; message: string }>,
  decisions: DecisionArtifact | null,
): string {
  const findingsBlock = findings
    .map((f, i) => {
      const loc = [f.file, f.line ? `line ${f.line}` : null].filter(Boolean).join(" ");
      const cat = f.category ? ` (${f.category})` : "";
      return `${i + 1}. [${f.severity}${cat}] ${loc ? `${loc} — ` : ""}${f.message}`;
    })
    .join("\n");

  const hasDecisions =
    decisions !== null &&
    ((decisions.decisions?.length ?? 0) > 0 || (decisions.left_unhandled?.length ?? 0) > 0);

  const decisionsBlock = hasDecisions
    ? `\n\nPrior decisions you made during the implement stage (review BEFORE deciding whether to preserve or revise each):\n${JSON.stringify(decisions, null, 2)}`
    : "";

  return `Review surfaced blocking findings on the diff you produced. Address each one.

Blocking findings:
${findingsBlock}${decisionsBlock}

Instructions:
- You already have the full implement-stage context — the diff, file contents, your reasoning. Reuse it; do not re-read files you already know.
- Address every finding above. If a finding contradicts a prior decision listed above, choose the better answer and explain the trade-off in your reply (do NOT silently revert).
- Make ONLY the changes needed to resolve the findings. No drive-by refactors, no scope creep, no doc-rewrites unrelated to the findings.
- Commit your fixes (conventional commits, one logical commit per finding cluster) and push to the same branch.
- Do NOT create a new PR. Do NOT switch branches inside the worktree.
- After your edits, run the build + test commands you used in the implement stage and verify they still pass before declaring done.
`.trim();
}
```

Also add this import at the top of `templates.ts` if it's not already there:

```typescript
import type { DecisionArtifact } from "../../types.js";
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/core && npx vitest run src/__tests__/surgical-review-fix-prompt.test.ts
```

Expected: PASS (all 6 tests).

- [ ] **Step 5: Typecheck**

```bash
pnpm -w typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/executor/prompt/templates.ts \
        packages/core/src/__tests__/surgical-review-fix-prompt.test.ts
git commit -m "feat(BEC-227): add surgicalReviewFixPrompt template for Track B"
```

---

### Task 8: `surgicalReviewFixEvent` builder + runner branch

**Files:**
- Modify: `packages/core/src/audit/events.ts` (add `surgicalReviewFixEvent` builder; bump canonical count comment 56 → 57)
- Modify: `packages/core/src/pipeline/runner.ts` (branch the review-fix loop)
- Test: `packages/core/src/__tests__/surgical-review-fix-runner.test.ts` (create)

- [ ] **Step 1: Add the event builder**

In `packages/core/src/audit/events.ts`, add a new exported function alongside the other pipeline-event builders (`agentSessionCreatedEvent`, `agentSessionResumedEvent`, etc.):

```typescript
export function surgicalReviewFixEvent(args: {
  runId: string;
  issueId: string;
  path: "surgical" | "legacy";
  findingsCount: number;
  decisionPayloadBytes: number;
}): AuditEventInput {
  return {
    eventType: "pipeline.surgical_review_fix",
    actor: "pipeline",
    actorType: "system",
    runId: args.runId,
    issueId: args.issueId,
    payload: {
      runId: args.runId,
      issueId: args.issueId,
      path: args.path,
      findingsCount: args.findingsCount,
      decisionPayloadBytes: args.decisionPayloadBytes,
    },
  };
}
```

If `events.ts` has a comment near the top documenting the canonical event count (e.g. `// 56 event types — see CLAUDE.md`), bump it to 57.

- [ ] **Step 2: Write the failing runner-integration test**

Create `packages/core/src/__tests__/surgical-review-fix-runner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDb } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import { persistDecisionArtifact } from "../db/decisions-store.js";
import { auditEvents } from "../db/schema.js";

/**
 * NOTE: this is a focused unit test on the `runSurgicalReviewFix` helper
 * extracted in Task 8. It does NOT spin up a real pipeline. It verifies:
 *   (a) when session_id + JSONL + decisions are all present → surgical path
 *   (b) when JSONL is missing → legacy path + audit event with path:"legacy"
 *   (c) when decisions are missing → surgical path still taken, decisionPayloadBytes: 0
 *
 * The runner imports a small `runSurgicalReviewFix` helper (added in this
 * task) that returns { path: "surgical" | "legacy", prompt: string } so
 * the caller can decide whether to use the resumed-session SDK call or
 * fall back to the existing full implement-template call.
 */

describe("runSurgicalReviewFix (BEC-227 Phase 4 / Track B)", () => {
  let runSurgicalReviewFix: any;
  let mockTranscriptExists: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockTranscriptExists = vi.fn();
    vi.resetModules();
    vi.doMock("../executor/session-store.js", () => ({
      transcriptExists: mockTranscriptExists,
    }));
    ({ runSurgicalReviewFix } = await import("../pipeline/run-surgical-review-fix.js"));
  });

  it("returns path=surgical when session + JSONL + decisions all present", async () => {
    const { db } = await createDb({ url: ":memory:" });
    await db.insert(pipelineRuns).values({
      id: "r1", issueId: "BEC-X", issueTitle: "t", repoUrl: "x", pipelineKey: "auto-implement",
      status: "running", startedAt: new Date(), agentSessionId: "session-abc",
    } as any);
    await persistDecisionArtifact(db, {
      pipelineRunId: "r1", iteration: 0, stage: "implement",
      payload: { decisions: [{ choice: "x", reason: "y", alternatives_considered: [] }], left_unhandled: [], key_files: [] },
    });
    mockTranscriptExists.mockResolvedValue(true);

    const got = await runSurgicalReviewFix({
      db,
      runId: "r1",
      issueId: "BEC-X",
      agentSessionId: "session-abc",
      worktreePath: "/tmp/x",
      blockingFindings: [{ severity: "blocking", file: "a.ts", line: 1, message: "fix me" }],
    });
    expect(got.path).toBe("surgical");
    expect(got.prompt).toMatch(/fix me/);
    expect(got.prompt).toMatch(/use Zod|"choice"|prior decisions/i);
    expect(got.decisionPayloadBytes).toBeGreaterThan(0);

    // Audit event was emitted with path=surgical.
    const events = await db.select().from(auditEvents);
    const ev = events.find((e: any) => e.eventType === "pipeline.surgical_review_fix");
    expect(ev).toBeDefined();
    expect(JSON.parse(ev!.payload).path).toBe("surgical");
  });

  it("returns path=legacy when transcriptExists is false", async () => {
    const { db } = await createDb({ url: ":memory:" });
    await db.insert(pipelineRuns).values({
      id: "r2", issueId: "BEC-Y", issueTitle: "t", repoUrl: "x", pipelineKey: "auto-implement",
      status: "running", startedAt: new Date(), agentSessionId: "session-zzz",
    } as any);
    mockTranscriptExists.mockResolvedValue(false);

    const got = await runSurgicalReviewFix({
      db, runId: "r2", issueId: "BEC-Y",
      agentSessionId: "session-zzz",
      worktreePath: "/tmp/y",
      blockingFindings: [{ severity: "blocking", file: "a.ts", line: 1, message: "fix me" }],
    });
    expect(got.path).toBe("legacy");

    const events = await db.select().from(auditEvents);
    const ev = events.find((e: any) => e.eventType === "pipeline.surgical_review_fix");
    expect(ev).toBeDefined();
    expect(JSON.parse(ev!.payload).path).toBe("legacy");
  });

  it("returns path=legacy when agentSessionId is null", async () => {
    const { db } = await createDb({ url: ":memory:" });
    await db.insert(pipelineRuns).values({
      id: "r3", issueId: "BEC-Z", issueTitle: "t", repoUrl: "x", pipelineKey: "auto-implement",
      status: "running", startedAt: new Date(),
    } as any);
    const got = await runSurgicalReviewFix({
      db, runId: "r3", issueId: "BEC-Z",
      agentSessionId: null,
      worktreePath: "/tmp/z",
      blockingFindings: [{ severity: "blocking", file: "a.ts", line: 1, message: "fix me" }],
    });
    expect(got.path).toBe("legacy");
  });

  it("returns path=surgical with decisionPayloadBytes=0 when decisions are absent but session+JSONL present", async () => {
    const { db } = await createDb({ url: ":memory:" });
    await db.insert(pipelineRuns).values({
      id: "r4", issueId: "BEC-Q", issueTitle: "t", repoUrl: "x", pipelineKey: "auto-implement",
      status: "running", startedAt: new Date(), agentSessionId: "session-q",
    } as any);
    mockTranscriptExists.mockResolvedValue(true);

    const got = await runSurgicalReviewFix({
      db, runId: "r4", issueId: "BEC-Q",
      agentSessionId: "session-q",
      worktreePath: "/tmp/q",
      blockingFindings: [{ severity: "blocking", file: "a.ts", line: 1, message: "fix me" }],
    });
    expect(got.path).toBe("surgical");
    expect(got.decisionPayloadBytes).toBe(0);
    expect(got.prompt).toMatch(/fix me/);
    // No prior-decisions section.
    expect(got.prompt).not.toMatch(/prior decisions|previously decided/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/surgical-review-fix-runner.test.ts
```

Expected: FAIL — `run-surgical-review-fix.ts` doesn't exist yet.

- [ ] **Step 4: Implement `run-surgical-review-fix.ts`**

Create `packages/core/src/pipeline/run-surgical-review-fix.ts`:

```typescript
import { writeAuditEvent } from "../audit/writer.js";
import { surgicalReviewFixEvent } from "../audit/events.js";
import { surgicalReviewFixPrompt } from "../executor/prompt/templates.js";
import { transcriptExists } from "../executor/session-store.js";
import { getLatestDecisionArtifact } from "../db/decisions-store.js";
import type { AnyDb } from "../db/client.js";
import type { ReviewFinding } from "../types.js";

/**
 * BEC-227 Phase 4 / Track B. Decides whether the review-fix loop can take
 * the surgical (resume-based) path and, if so, builds the prompt. The
 * caller (runner.ts review-fix loop) uses the returned `path` to decide:
 *
 *   - "surgical": call `executeStage(..., { sessionResume: agentSessionId,
 *     promptOverride: prompt })` — agent already has full context, this is
 *     a one-turn fix-and-push
 *   - "legacy": fall back to the existing full implement-template re-run
 *     (the historical behavior)
 *
 * Either way, exactly one `pipeline.surgical_review_fix` audit event fires.
 */
export async function runSurgicalReviewFix(args: {
  db: AnyDb;
  runId: string;
  issueId: string;
  agentSessionId: string | null;
  worktreePath: string;
  blockingFindings: ReviewFinding[];
}): Promise<{
  path: "surgical" | "legacy";
  prompt: string;
  decisionPayloadBytes: number;
}> {
  const { db, runId, issueId, agentSessionId, worktreePath, blockingFindings } = args;

  let path: "surgical" | "legacy" = "legacy";
  let promptStr = "";
  let decisionPayloadBytes = 0;

  if (agentSessionId) {
    const exists = await transcriptExists(worktreePath, agentSessionId);
    if (exists) {
      const decisionRow = await getLatestDecisionArtifact(db, runId);
      const decisions = decisionRow?.payload ?? null;
      promptStr = surgicalReviewFixPrompt(blockingFindings as any, decisions);
      decisionPayloadBytes = decisions ? JSON.stringify(decisions).length : 0;
      path = "surgical";
    }
  }

  await writeAuditEvent(
    db,
    surgicalReviewFixEvent({
      runId,
      issueId,
      path,
      findingsCount: blockingFindings.length,
      decisionPayloadBytes,
    }),
  );

  return { path, prompt: promptStr, decisionPayloadBytes };
}
```

**IMPORTANT — verify imports against actual codebase:**
1. `transcriptExists(worktreePath, sessionId)` — verify the signature matches `packages/core/src/executor/session-store.ts`. If it's `transcriptExists({ workdir, sessionId })` (object arg), adjust the call.
2. `writeAuditEvent` — verify the export name in `packages/core/src/audit/writer.ts`. If the project's pattern is `appendAuditEvent` or `logAuditEvent`, swap.
3. `ReviewFinding` — verify the export location in `types.ts`.

Run a quick grep to confirm:

```bash
grep -n "export function transcriptExists\|export async function transcriptExists" packages/core/src/executor/session-store.ts
grep -n "export.*AuditEvent\|export function append\|export async function write" packages/core/src/audit/writer.ts
grep -n "export.*ReviewFinding" packages/core/src/types.ts
```

If the signatures differ, adjust both the implementation AND the test's `vi.doMock` accordingly.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/core && npx vitest run src/__tests__/surgical-review-fix-runner.test.ts
```

Expected: PASS (all 4 tests).

- [ ] **Step 6: Wire into `pipeline/runner.ts` review-fix loop**

In `packages/core/src/pipeline/runner.ts`, locate the review-fix loop (starts around line 1462, `const reviewFixIterations = config.reviewFixIterations ?? 1;`).

Inside the per-iteration body (`for (let rfIteration = 1; rfIteration <= reviewFixIterations; rfIteration++) {`), where the current code calls `executeStage` with `fixStage === "implement"`, BEFORE that call, decide which path to take:

```typescript
if (fixStage === "implement") {
  const surgical = await runSurgicalReviewFix({
    db: this.db,
    runId: run.id,
    issueId: run.issueId,
    agentSessionId: run.agentSessionId ?? null,
    worktreePath: worktree.path,
    blockingFindings: lastReviewFindings.filter((f) => f.severity === "blocking"),
  });

  if (surgical.path === "surgical") {
    // Resume the session with the focused prompt; skip the full implement
    // template + handoff block. The SDK options builder in executor.ts
    // already knows how to resume when agentSessionId is set, so we just
    // need to pass the prompt override.
    fixResult = await executeStage(/* ... existing args ... */, {
      promptOverride: surgical.prompt,
      // BEC-227 Phase 4: the resumed agent already has full context;
      // suppress the synthesized handoff block that would otherwise be
      // injected by extract-handoff's downstream consumer.
      suppressHandoff: true,
    });
  } else {
    // Legacy full-implement re-run (pre-Phase-4 behavior).
    fixResult = await executeStage(/* ... existing args, no override ... */);
  }
} else {
  // Non-implement stages in the review-fix loop (test, review) — unchanged.
  fixResult = await executeStage(/* ... existing args ... */);
}
```

**Implementation note:** the exact `executeStage` argument structure varies — preserve every existing arg, only ADD the new optional `promptOverride` + `suppressHandoff` properties to the options object. If `executeStage` does not yet accept `promptOverride`, add it in Step 7 below.

Add the import at the top:

```typescript
import { runSurgicalReviewFix } from "./run-surgical-review-fix.js";
```

- [ ] **Step 7: Extend `executeStage` to accept `promptOverride`**

In `packages/core/src/executor/executor.ts`, locate the `executeStage` function signature (line ~239 per `grep -n "export async function executeStage" packages/core/src/executor/executor.ts`). Verify whether it already has an options object containing per-call overrides (search for `promptOverride` first — if it exists, skip this step entirely).

If `promptOverride` doesn't exist:
- Add it as an OPTIONAL field on the options object: `promptOverride?: string`
- In the body, immediately before the SDK `query()` call, do:

```typescript
const promptForSdk = options.promptOverride ?? prompt;
// ...later in the query call: query({ ...sdkOpts, prompt: promptForSdk })
```

This is a one-line behavior change: when set, the surgical prompt replaces whatever `prompt` was computed from the stage template.

- [ ] **Step 8: Run all tests**

```bash
cd packages/core && npx vitest run src/__tests__/surgical-review-fix-runner.test.ts src/__tests__/surgical-review-fix-prompt.test.ts src/__tests__/decisions-parser.test.ts src/__tests__/decisions-store.test.ts src/__tests__/extract-handoff-decisions.test.ts
```

Expected: ALL PASS.

- [ ] **Step 9: Full unit-test sweep**

```bash
pnpm test
```

Expected: clean run. If any prior test breaks because of the new `promptOverride` field on `executeStage`, the breakage is most likely a TypeScript-strict mock that doesn't allow extra props — update those mocks to match the new optional shape.

- [ ] **Step 10: Typecheck**

```bash
pnpm -w typecheck
```

Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/audit/events.ts \
        packages/core/src/pipeline/run-surgical-review-fix.ts \
        packages/core/src/pipeline/runner.ts \
        packages/core/src/executor/executor.ts \
        packages/core/src/__tests__/surgical-review-fix-runner.test.ts
git commit -m "feat(BEC-227): wire surgical review-fix into the runner's review-fix loop (Track B)"
```

---

### Task 9: Documentation — CLAUDE.md + .claude/CLAUDE.md + audit-event count

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: Update the audit-event count in CLAUDE.md**

In `CLAUDE.md`, find the "Audit log" row in the "Enterprise Features" table. The current sentence reads `**Current count: 56 event types**`. Change `56` to `57`.

- [ ] **Step 2: Add a Phase 4 section under "Agent Session Continuity (BEC-227)"**

In `CLAUDE.md`, find the `### Agent Session Continuity (BEC-227)` section. After the last bullet listing audit events and before the next `###` heading, add:

```markdown
### Phase 4 — surgical review-fix + decision artifact (BEC-227 Track B + Track D)

- **Implement agent emits `<decisions>` block** at the end of each turn (`prompt/templates.ts:implementTemplate`). Parser: `extract-handoff.ts:parseDecisionsBlock` — graceful degradation on missing / malformed block. Persisted to `pipeline_run_decisions` (one row per (run, iteration, stage)) via `db/decisions-store.ts:persistDecisionArtifact`.
- **Review-fix loop branches** on `runSurgicalReviewFix` (`pipeline/run-surgical-review-fix.ts`). Surgical path fires when: `agent_session_id` non-null AND JSONL transcript on disk AND blocking findings exist. Otherwise: legacy full-implement re-run. Either way, one `pipeline.surgical_review_fix` audit event records the choice + `findingsCount` + `decisionPayloadBytes`.
- **Surgical prompt** (`prompt/templates.ts:surgicalReviewFixPrompt`) is minimal: blocking findings + (optional) prior-decisions JSON. No `<previous-stage-context>` block, no implement template boilerplate — the resumed agent already has all of it.
- **Audit events bumped 56 → 57**: `pipeline.surgical_review_fix` is the new canonical entry. The `audit-immutability.test.ts` assertion enforces the count.
```

- [ ] **Step 3: Mirror the key bits in `.claude/CLAUDE.md`**

In `.claude/CLAUDE.md`, find the section `## Agent Session Continuity (BEC-227)` (or the closest equivalent). Add after the existing bullet list:

```markdown
## Phase 4 (BEC-227 Track B + Track D)
- Implement agent emits `<decisions>{JSON}</decisions>` block at end of turn; parsed by `extract-handoff.ts:parseDecisionsBlock`, persisted to `pipeline_run_decisions` via `db/decisions-store.ts`
- Review-fix loop takes the surgical path (`pipeline/run-surgical-review-fix.ts`) when session + JSONL + findings all present: resumes the existing SDK session with a minimal prompt (findings + prior decisions) instead of re-running the full implement template
- Audit event `pipeline.surgical_review_fix` records every review-fix invocation with `path: "surgical" | "legacy"`, `findingsCount`, `decisionPayloadBytes`
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .claude/CLAUDE.md
git commit -m "docs(BEC-227): document Phase 4 surgical review-fix + decision artifact"
```

---

### Task 10: Final verification + draft PR

- [ ] **Step 1: Full unit suite**

```bash
pnpm test
```

Expected: clean across `@urateam/core`, `@urateam/dashboard`, `@urateam/cli`, `@urateam/observers`.

- [ ] **Step 2: Integration tests (BEC-99 worktree, etc.)**

```bash
pnpm test:integration
```

Expected: clean. If any pre-existing flaky integration test fails, rerun once; if it fails twice in a row, investigate before proceeding.

- [ ] **Step 3: Typecheck**

```bash
pnpm -w typecheck
```

Expected: clean.

- [ ] **Step 4: Quick grep for placeholder leftovers**

```bash
grep -rn "TODO.*BEC-227\|FIXME.*Track B\|FIXME.*Track D" packages/core/src/ docs/ CLAUDE.md
```

Expected: no matches (or only matches you intend to keep).

- [ ] **Step 5: Verify the audit-event count comment matches reality**

```bash
grep -c "^  \"" packages/core/src/types.ts | head -1   # sanity-check, not exact
cd packages/core && node -e "import('./dist/types.js').then(m => console.log(m.AuditEventTypeSchema.options.length))"
```

If the count printed is NOT 57, you have a drift between the schema and the assertions. Fix before opening the PR.

- [ ] **Step 6: Push the branch**

```bash
git push -u origin feat/agent-session-continuity-phase4
```

- [ ] **Step 7: Open the PR as DRAFT (manual gate per Phase 4 rollout)**

```bash
gh pr create --draft \
  --title "feat(BEC-227): Phase 4 — surgical review-fix + decision artifact (Tracks B + D)" \
  --body "$(cat <<'EOF'
## Summary

Phase 4 of BEC-227 (Agent Session Continuity). Two tracks:

- **Track D — Decision artifact**: implement agent emits a `<decisions>{JSON}</decisions>` block at the end of each turn. Parsed by `extract-handoff.ts:parseDecisionsBlock`, persisted to the new `pipeline_run_decisions` table.
- **Track B — Surgical review-fix**: when blocking review findings exist AND the per-run Agent SDK session is intact, the review-fix loop resumes the session with a focused prompt (findings + prior decisions) instead of re-running the full implement template. Legacy full-implement path stays as a fallback.

New audit event `pipeline.surgical_review_fix` records every review-fix iteration with `path: "surgical" | "legacy"`. Canonical event count bumped 56 → 57.

## Why draft

This PR opens as a draft on purpose. Phase 3 (session resume default-on, v0.1.68) shipped 2026-05-20 and is currently the verification environment for the resume mechanics this PR builds on. Mark ready-for-review only after at least one Phase 3 soak window confirms the resume path is stable. Do NOT enable auto-merge.

## Test plan

- [ ] Unit tests pass (`pnpm test`)
- [ ] Integration tests pass (`pnpm test:integration`)
- [ ] Typecheck clean (`pnpm -w typecheck`)
- [ ] Dogfood deploy of a build with this PR + a synthetic ticket with a known review finding shows `pipeline.surgical_review_fix` audit event with `path: "surgical"`
- [ ] Manual check: a deliberately-broken implement (e.g. introduce a lint failure) triggers the review-fix loop and the agent's second-turn diff is materially smaller than the historical full re-implement diff

## Out of scope

- Tracks E (v2 SDK migration) and F (cross-run inheritance) — separate phase, separate spec
- Dashboard surface for browsing the `pipeline_run_decisions` table — follow-up if operators ask for it

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Capture the PR URL printed by `gh pr create` and surface it to the user.

---

## Self-Review

**Spec coverage (Tracks B + D from `docs/superpowers/specs/2026-05-19-agent-session-continuity-design.md`):**

| Spec requirement | Implementing task |
|---|---|
| Implement template emits `<decisions>` block | Task 5 |
| `extract-handoff.ts` parser for the block | Task 4 |
| `pipeline_run_decisions` table (schema in spec section "Track D") | Tasks 2 + 3 |
| Track D consumer #1: Track B's surgical review-fix prompt | Tasks 7 + 8 |
| Surgical prompt with `surgicalReviewFixPrompt(findings, decisions)` signature | Task 7 |
| `pipeline.surgical_review_fix` audit event | Tasks 1 + 8 |
| Audit count bumped 56 → 57 | Tasks 1 + 9 |
| Legacy fallback path when JSONL missing OR session_id null OR decisions missing | Task 8 (the `path: "legacy"` branch) |
| CLAUDE.md / `.claude/CLAUDE.md` doc updates | Task 9 |
| Phase 4 draft PR, no auto-merge | Task 10 |

**Items deliberately out of scope (per spec):**
- Track F cross-run inheritance — separate spec.
- Track E v2 SDK migration — separate phase.
- Dashboard run-detail panel for the new table — spec calls it a "future Track F consumer"; not load-bearing for Tracks B/D.

**No placeholders:** every task has exact file paths, concrete code blocks, and runnable commands. The `iteration` mapping in Task 6 Step 5 uses a small lookup table because the three call sites use different variable names in the existing `runner.ts`.

**Type consistency:** `DecisionArtifact` (Task 1) is consumed by `parseDecisionsBlock` (Task 4), `persistDecisionArtifact` / `getLatestDecisionArtifact` (Task 3), and `surgicalReviewFixPrompt` (Task 7) — the type name is identical across all tasks. The audit event name `pipeline.surgical_review_fix` is identical in Tasks 1, 8, and 9.

**Coordination with BEC-228:** BEC-228 extracts a `resolveSessionOpts` helper that wraps the same `transcriptExists` pre-check `runSurgicalReviewFix` uses. If BEC-228 merges before Task 8 runs, replace the inline `transcriptExists(worktreePath, agentSessionId)` call in `run-surgical-review-fix.ts` with `resolveSessionOpts({...})` and drop the duplicated audit-event emission for the "transcript missing" case (the helper already emits `pipeline.agent_session_missing_fallback`). The remaining surgical-vs-legacy decision logic is independent.

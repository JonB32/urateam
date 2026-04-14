# Audit Log + Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship enterprise feature 4.2 — append-only audit event log with dashboard view and CSV export — per `docs/superpowers/specs/2026-04-14-audit-log-design.md`.

**Architecture:** Hybrid data model. A new `audit_events` table stores events that have no existing home (PM decisions, budget refusals, license/config events); a read-time projection layer maps `pipeline_runs`, `pm_approvals`, and `budget_alerts` rows into the same `AuditEvent` shape so nothing is duplicated. Reader merges the four streams by timestamp. Retention sweep is the sole authorized mutation; a lint test enforces it. Dashboard exposes a filtered feed and a streaming CSV export, both gated by `isFeatureLicensed("audit-log")`.

**Tech Stack:** TypeScript, Drizzle ORM, better-sqlite3 / postgres-js, Hono+HTMX, Vitest, Zod, pino.

---

## File Structure

### New files
- `packages/core/src/db/migrations/sqlite/006_audit_events.sql` — table + indexes (SQLite)
- `packages/core/src/db/migrations/postgres/007_audit_events.sql` — table + indexes (Postgres)
- `packages/core/src/audit/index.ts` — barrel export
- `packages/core/src/audit/writer.ts` — `logAuditEvent(db, event)` fire-and-forget
- `packages/core/src/audit/events.ts` — typed event builders
- `packages/core/src/audit/projection.ts` — map `pipeline_runs` / `pm_approvals` / `budget_alerts` rows → `AuditEvent[]`
- `packages/core/src/audit/reader.ts` — `listAuditEvents(filters)` with cursor pagination
- `packages/core/src/audit/retention.ts` — `pruneAuditLog(db, retentionDays)` (sole authorized mutation)
- `packages/core/src/audit/csv.ts` — `streamAuditCsv(db, filters)` async iterator
- `packages/core/src/__tests__/audit/writer.test.ts`
- `packages/core/src/__tests__/audit/events.test.ts`
- `packages/core/src/__tests__/audit/projection.test.ts`
- `packages/core/src/__tests__/audit/reader.test.ts`
- `packages/core/src/__tests__/audit/retention.test.ts`
- `packages/core/src/__tests__/audit/csv.test.ts`
- `packages/core/src/__tests__/audit-immutability.test.ts` — grep-based lint test
- `packages/core/src/__tests__/integration/audit-e2e.test.ts`
- `packages/dashboard/src/routes/audit.ts`
- `packages/dashboard/src/views/audit.ts`
- `packages/dashboard/src/__tests__/audit.test.ts`

### Modified files
- `packages/core/src/db/schema.ts` — add `auditEvents` table
- `packages/core/src/db/client.ts` — extend `getCreateTablesDDL()`
- `packages/core/src/types.ts` — `AuditEventSchema`, `AuditEventTypeSchema`, `AuditActorTypeSchema`, `AppConfig.auditLog`
- `packages/core/src/license.ts` — add `"audit-log"` to Enterprise feature set; write `license.validation_failed` on failure
- `packages/core/src/pm/scheduler.ts` — new `pruneAuditLog` step after `digest`; write `budget.run_refused` in budgetGuard using `evaluation.scopes`
- `packages/core/src/pm/actions/promote.ts` — emit `pm.issue_promoted`
- `packages/core/src/pm/actions/deprioritize.ts` — emit `pm.issue_deprioritized`
- `packages/core/src/pm/actions/cancel.ts` — emit `pm.issue_cancelled`
- `packages/core/src/pm/actions/triage.ts` — emit `pm.triage_classified`
- `packages/cli/src/index.ts` (or whichever config loader runs at startup) — emit `config.loaded`
- `packages/dashboard/src/views/layout.ts` — add "Audit" nav entry

---

## Task 1: Database schema + migration (foundation)

**Files:**
- Create: `packages/core/src/db/migrations/sqlite/006_audit_events.sql`
- Create: `packages/core/src/db/migrations/postgres/007_audit_events.sql`
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/core/src/db/client.ts` (`getCreateTablesDDL`)
- Test: `packages/core/src/__tests__/db-audit-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/db-audit-schema.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { sql } from "drizzle-orm";

describe("audit_events schema", () => {
  it("creates the table with required columns on fresh SQLite db", async () => {
    const { db } = await createDb("sqlite::memory:");
    const cols = (db as any).all(sql`PRAGMA table_info(audit_events)`) as Array<{name: string}>;
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "actor", "actor_type", "event_type", "id", "input_tokens",
      "issue_id", "output_tokens", "payload", "run_id", "scope", "timestamp",
    ]);
  });

  it("inserts and reads back an audit event", async () => {
    const { db } = await createDb("sqlite::memory:");
    await (db as any).insert(auditEvents).values({
      id: "evt_1",
      eventType: "pm.issue_promoted",
      actor: "pm-agent",
      actorType: "pm-agent",
      scope: "team:T1",
      runId: null,
      issueId: "BEC-1",
      inputTokens: 0,
      outputTokens: 0,
      payload: JSON.stringify({ test: true }),
    });
    const rows = await (db as any).select().from(auditEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("pm.issue_promoted");
    expect(rows[0].timestamp).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/core && npx vitest run src/__tests__/db-audit-schema.test.ts
```
Expected: FAIL with `auditEvents` not exported or table missing.

- [ ] **Step 3: Add the table to `db/schema.ts`**

Add to `packages/core/src/db/schema.ts` at end:
```ts
export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  timestamp: crossTimestamp("timestamp")
    .notNull()
    .$defaultFn(() => new Date()),
  eventType: text("event_type").notNull(),
  actor: text("actor").notNull(),
  actorType: text("actor_type").notNull(),
  scope: text("scope"),
  runId: text("run_id"),
  issueId: text("issue_id"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  payload: text("payload").notNull().default("{}"),
});
```

- [ ] **Step 4: Create the SQLite migration file**

Create `packages/core/src/db/migrations/sqlite/006_audit_events.sql`:
```sql
-- Enterprise feature 4.2: audit log + export
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  scope TEXT,
  run_id TEXT,
  issue_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_type_ts ON audit_events(event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_scope_ts ON audit_events(scope, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_run_id ON audit_events(run_id);
```

- [ ] **Step 5: Create the Postgres migration file**

Create `packages/core/src/db/migrations/postgres/007_audit_events.sql`:
```sql
-- Enterprise feature 4.2: audit log + export
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  scope TEXT,
  run_id TEXT,
  issue_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_type_ts ON audit_events(event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_scope_ts ON audit_events(scope, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_run_id ON audit_events(run_id);
```

- [ ] **Step 6: Extend `getCreateTablesDDL()` in `db/client.ts`**

Find `getCreateTablesDDL()` and append to the returned template string (before the closing backtick):
```sql
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    timestamp ${ts} NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    scope TEXT,
    run_id TEXT,
    issue_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_events_type_ts ON audit_events(event_type, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_events_scope_ts ON audit_events(scope, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_events_run_id ON audit_events(run_id);
`;
```

- [ ] **Step 7: Run the test, verify it passes**

```
cd packages/core && npx vitest run src/__tests__/db-audit-schema.test.ts
```
Expected: PASS.

- [ ] **Step 8: Commit**

```
git add packages/core/src/db/schema.ts packages/core/src/db/client.ts packages/core/src/db/migrations packages/core/src/__tests__/db-audit-schema.test.ts
git commit -m "feat(audit): add audit_events table and migration"
```

---

## Task 2: Zod types for audit events

**Files:**
- Modify: `packages/core/src/types.ts`
- Test: `packages/core/src/__tests__/audit-types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/audit-types.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { AuditEventSchema, AuditEventTypeSchema, AuditActorTypeSchema } from "../types.js";

describe("audit event zod schemas", () => {
  it("accepts all v1 event types", () => {
    const types = [
      "run.started","run.completed","run.failed","run.auto_merged","run.auto_merge_skipped",
      "pm.approval_requested","pm.approval_resolved",
      "pm.issue_promoted","pm.issue_deprioritized","pm.issue_cancelled","pm.triage_classified",
      "budget.alert_fired","budget.run_refused",
      "license.validation_failed","config.loaded","dashboard.manual_action",
    ];
    for (const t of types) expect(AuditEventTypeSchema.parse(t)).toBe(t);
  });

  it("rejects unknown event type", () => {
    expect(() => AuditEventTypeSchema.parse("nope")).toThrow();
  });

  it("parses a minimal valid audit event", () => {
    const evt = AuditEventSchema.parse({
      id: "evt_1",
      timestamp: new Date(),
      eventType: "pm.issue_promoted",
      actor: "pm-agent",
      actorType: "pm-agent",
      scope: null,
      runId: null,
      issueId: "BEC-1",
      inputTokens: 0,
      outputTokens: 0,
      payload: { issueId: "BEC-1" },
    });
    expect(evt.eventType).toBe("pm.issue_promoted");
  });
});
```

- [ ] **Step 2: Run the test, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/audit-types.test.ts
```
Expected: FAIL — schemas don't exist.

- [ ] **Step 3: Add schemas to `types.ts`**

Append to `packages/core/src/types.ts`:
```ts
export const AuditEventTypeSchema = z.enum([
  "run.started", "run.completed", "run.failed",
  "run.auto_merged", "run.auto_merge_skipped",
  "pm.approval_requested", "pm.approval_resolved",
  "pm.issue_promoted", "pm.issue_deprioritized", "pm.issue_cancelled",
  "pm.triage_classified",
  "budget.alert_fired", "budget.run_refused",
  "license.validation_failed", "config.loaded",
  "dashboard.manual_action",
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditActorTypeSchema = z.enum([
  "system", "pm-agent", "webhook", "dashboard-user", "cli",
]);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  timestamp: z.date(),
  eventType: AuditEventTypeSchema,
  actor: z.string(),
  actorType: AuditActorTypeSchema,
  scope: z.string().nullable(),
  runId: z.string().nullable(),
  issueId: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  payload: z.record(z.unknown()),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
```

Also add to the `AppConfig` zod schema (find the existing object and extend it):
```ts
auditLog: z.object({
  enabled: z.boolean().optional(),
  retentionDays: z.number().int().positive().optional().default(365),
}).optional(),
```

- [ ] **Step 4: Run test to verify pass**

```
cd packages/core && npx vitest run src/__tests__/audit-types.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/core/src/types.ts packages/core/src/__tests__/audit-types.test.ts
git commit -m "feat(audit): zod schemas for audit events and config"
```

---

## Task 3: Event builders (`audit/events.ts`)

**Files:**
- Create: `packages/core/src/audit/events.ts`
- Create: `packages/core/src/audit/index.ts`
- Test: `packages/core/src/__tests__/audit/events.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/audit/events.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  pmPromotedEvent, pmDeprioritizedEvent, pmCancelledEvent, pmTriageClassifiedEvent,
  budgetRefusedEvent, licenseValidationFailedEvent, configLoadedEvent,
} from "../../audit/events.js";
import { AuditEventSchema } from "../../types.js";

describe("audit event builders", () => {
  it("pmPromotedEvent produces a valid event", () => {
    const evt = pmPromotedEvent({
      issueId: "BEC-1", fromState: "Backlog", toState: "Todo",
      priority: 2, reason: "top-of-queue",
    });
    const parsed = AuditEventSchema.parse(evt);
    expect(parsed.eventType).toBe("pm.issue_promoted");
    expect(parsed.actor).toBe("pm-agent");
    expect(parsed.actorType).toBe("pm-agent");
    expect(parsed.issueId).toBe("BEC-1");
    expect(parsed.payload).toMatchObject({ fromState: "Backlog", toState: "Todo" });
  });

  it("budgetRefusedEvent includes scope breakdown", () => {
    const evt = budgetRefusedEvent({
      scope: "team:T1", scopeType: "team",
      tokensUsed: 100000, limit: 100000, utilization: 100,
    });
    const parsed = AuditEventSchema.parse(evt);
    expect(parsed.eventType).toBe("budget.run_refused");
    expect(parsed.scope).toBe("team:T1");
    expect(parsed.payload).toMatchObject({ tokensUsed: 100000, limit: 100000 });
  });

  it("licenseValidationFailedEvent sets actor=system", () => {
    const evt = licenseValidationFailedEvent({ invalidReason: "expired" });
    expect(evt.actor).toBe("system");
    expect(evt.actorType).toBe("system");
    expect(evt.eventType).toBe("license.validation_failed");
  });

  it("configLoadedEvent includes path + sha256 + tier", () => {
    const evt = configLoadedEvent({ path: "/tmp/ura.yaml", sha256: "abc123", tier: "enterprise" });
    expect(evt.eventType).toBe("config.loaded");
    expect(evt.payload).toMatchObject({ path: "/tmp/ura.yaml", sha256: "abc123", tier: "enterprise" });
  });

  it("all builders return new ids and recent timestamps", () => {
    const a = pmCancelledEvent({ issueId: "BEC-1", approvalId: "a1", reason: "stale" });
    const b = pmCancelledEvent({ issueId: "BEC-2", approvalId: "a2", reason: "dup" });
    expect(a.id).not.toBe(b.id);
    expect(Date.now() - a.timestamp.getTime()).toBeLessThan(1000);
  });
});
```

- [ ] **Step 2: Run tests, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/audit/events.test.ts
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create `audit/events.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { AuditEvent } from "../types.js";

function base(partial: Partial<AuditEvent> & Pick<AuditEvent, "eventType" | "actor" | "actorType">): AuditEvent {
  return {
    id: `evt_${randomUUID()}`,
    timestamp: new Date(),
    scope: partial.scope ?? null,
    runId: partial.runId ?? null,
    issueId: partial.issueId ?? null,
    inputTokens: partial.inputTokens ?? 0,
    outputTokens: partial.outputTokens ?? 0,
    payload: partial.payload ?? {},
    ...partial,
  };
}

export function pmPromotedEvent(args: {
  issueId: string; fromState: string; toState: string; priority?: number; reason?: string;
}): AuditEvent {
  return base({
    eventType: "pm.issue_promoted", actor: "pm-agent", actorType: "pm-agent",
    issueId: args.issueId,
    payload: { fromState: args.fromState, toState: args.toState, priority: args.priority, reason: args.reason },
  });
}

export function pmDeprioritizedEvent(args: {
  issueId: string; oldPriority: number | null; newPriority: number; approvalId: string;
}): AuditEvent {
  return base({
    eventType: "pm.issue_deprioritized", actor: "pm-agent", actorType: "pm-agent",
    issueId: args.issueId,
    payload: { oldPriority: args.oldPriority, newPriority: args.newPriority, approvalId: args.approvalId },
  });
}

export function pmCancelledEvent(args: {
  issueId: string; approvalId: string; reason: string;
}): AuditEvent {
  return base({
    eventType: "pm.issue_cancelled", actor: "pm-agent", actorType: "pm-agent",
    issueId: args.issueId,
    payload: { approvalId: args.approvalId, reason: args.reason },
  });
}

export function pmTriageClassifiedEvent(args: {
  issueId: string; label: string; rationale: string;
}): AuditEvent {
  return base({
    eventType: "pm.triage_classified", actor: "pm-agent", actorType: "pm-agent",
    issueId: args.issueId,
    payload: { label: args.label, rationale: args.rationale.slice(0, 500) },
  });
}

export function budgetRefusedEvent(args: {
  scope: string; scopeType: "global" | "team" | "repo";
  tokensUsed: number; limit: number; utilization: number; refusedRunId?: string;
}): AuditEvent {
  return base({
    eventType: "budget.run_refused", actor: "pm-agent", actorType: "pm-agent",
    scope: args.scope, runId: args.refusedRunId ?? null,
    payload: {
      scopeType: args.scopeType, tokensUsed: args.tokensUsed,
      limit: args.limit, utilization: args.utilization,
    },
  });
}

export function licenseValidationFailedEvent(args: {
  invalidReason: "missing" | "expired" | "bad-signature" | "wrong-issuer";
  expiredAt?: Date;
}): AuditEvent {
  return base({
    eventType: "license.validation_failed", actor: "system", actorType: "system",
    payload: { invalidReason: args.invalidReason, expiredAt: args.expiredAt?.toISOString() },
  });
}

export function configLoadedEvent(args: {
  path: string; sha256: string; tier: string;
}): AuditEvent {
  return base({
    eventType: "config.loaded", actor: "system", actorType: "system",
    payload: { path: args.path, sha256: args.sha256, tier: args.tier },
  });
}
```

- [ ] **Step 4: Create barrel export**

Create `packages/core/src/audit/index.ts`:
```ts
export * from "./events.js";
export * from "./writer.js";
export * from "./reader.js";
export * from "./projection.js";
export * from "./retention.js";
export * from "./csv.js";
```

Note: later tasks will create the files referenced here. Until then, create stubs to prevent TS errors — or comment out the unresolved lines and uncomment as each task lands. Recommended: start with just `events.js` and add lines as subsequent tasks complete.

For this task, use only:
```ts
export * from "./events.js";
```

- [ ] **Step 5: Run tests, confirm pass**

```
cd packages/core && npx vitest run src/__tests__/audit/events.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add packages/core/src/audit packages/core/src/__tests__/audit/events.test.ts
git commit -m "feat(audit): typed event builders"
```

---

## Task 4: Writer (`audit/writer.ts`)

**Files:**
- Create: `packages/core/src/audit/writer.ts`
- Modify: `packages/core/src/audit/index.ts`
- Test: `packages/core/src/__tests__/audit/writer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/audit/writer.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { createDb } from "../../db/client.js";
import { auditEvents } from "../../db/schema.js";
import { logAuditEvent } from "../../audit/writer.js";
import { pmPromotedEvent } from "../../audit/events.js";

describe("logAuditEvent", () => {
  it("persists an event row", async () => {
    const { db } = await createDb("sqlite::memory:");
    await logAuditEvent(db as any, pmPromotedEvent({
      issueId: "BEC-1", fromState: "Backlog", toState: "Todo",
    }));
    const rows = await (db as any).select().from(auditEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("pm.issue_promoted");
    expect(JSON.parse(rows[0].payload)).toMatchObject({ fromState: "Backlog", toState: "Todo" });
  });

  it("does not throw when the db insert fails", async () => {
    const fakeDb = {
      insert: () => ({ values: () => ({ run: () => { throw new Error("db down"); } }) }),
    } as any;
    // should not throw
    await expect(logAuditEvent(fakeDb, pmPromotedEvent({
      issueId: "BEC-1", fromState: "Backlog", toState: "Todo",
    }))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/audit/writer.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Create `audit/writer.ts`**

```ts
import type { AnyDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { createLogger } from "../logger.js";
import type { AuditEvent } from "../types.js";

const log = createLogger("audit.writer");

/**
 * Fire-and-forget insert of an audit event. Write failures are logged but
 * never propagated — audit writes must not crash the caller.
 *
 * Callers should use `void logAuditEvent(...)` when they don't await.
 */
export async function logAuditEvent(db: AnyDb, event: AuditEvent): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      id: event.id,
      timestamp: event.timestamp,
      eventType: event.eventType,
      actor: event.actor,
      actorType: event.actorType,
      scope: event.scope,
      runId: event.runId,
      issueId: event.issueId,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      payload: JSON.stringify(event.payload),
    });
  } catch (err) {
    log.warn({ err, eventType: event.eventType, id: event.id }, "audit event write failed");
  }
}
```

Uncomment `export * from "./writer.js";` in `audit/index.ts`.

- [ ] **Step 4: Run tests, verify pass**

```
cd packages/core && npx vitest run src/__tests__/audit/writer.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/core/src/audit/writer.ts packages/core/src/audit/index.ts packages/core/src/__tests__/audit/writer.test.ts
git commit -m "feat(audit): fire-and-forget writer"
```

---

## Task 5: Projection (`audit/projection.ts`)

Projects `pipeline_runs`, `pm_approvals`, and `budget_alerts` rows into `AuditEvent[]`. Pure function — no DB calls here; the reader passes rows in.

**Files:**
- Create: `packages/core/src/audit/projection.ts`
- Modify: `packages/core/src/audit/index.ts`
- Test: `packages/core/src/__tests__/audit/projection.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/audit/projection.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  projectPipelineRun, projectPmApproval, projectBudgetAlert,
} from "../../audit/projection.js";

describe("projection", () => {
  it("projects a completed run into started + completed events", () => {
    const startedAt = new Date("2026-04-01T10:00:00Z");
    const completedAt = new Date("2026-04-01T10:05:00Z");
    const events = projectPipelineRun({
      id: "run_1", issueId: "BEC-1", pipelineKey: "auto-implement",
      status: "completed", startedAt, completedAt,
      totalInputTokens: 500, totalOutputTokens: 200,
      runType: "standard", parentRunId: null, linearTeamId: "T1",
      repoUrl: "https://github.com/x/y", autoMerged: null, autoMergeReason: null,
      errorMessage: null,
    } as any);
    expect(events.map(e => e.eventType)).toEqual(["run.started", "run.completed"]);
    expect(events[0].timestamp).toEqual(startedAt);
    expect(events[1].timestamp).toEqual(completedAt);
    expect(events[1].inputTokens).toBe(500);
    expect(events[1].outputTokens).toBe(200);
    expect(events[0].scope).toBe("team:T1");
  });

  it("projects a failed run into started + failed", () => {
    const events = projectPipelineRun({
      id: "run_2", issueId: "BEC-2", status: "failed",
      startedAt: new Date(), completedAt: new Date(),
      totalInputTokens: 0, totalOutputTokens: 0,
      runType: "standard", parentRunId: null, linearTeamId: null,
      repoUrl: "https://github.com/x/y", autoMerged: null, autoMergeReason: null,
      errorMessage: "boom",
    } as any);
    expect(events.map(e => e.eventType)).toEqual(["run.started", "run.failed"]);
    expect(events[1].payload.errorMessage).toBe("boom");
  });

  it("adds run.auto_merged when autoMerged=true", () => {
    const events = projectPipelineRun({
      id: "run_3", issueId: "BEC-3", status: "completed",
      startedAt: new Date(), completedAt: new Date(),
      totalInputTokens: 0, totalOutputTokens: 0,
      runType: "standard", parentRunId: null, linearTeamId: null,
      repoUrl: "x", autoMerged: true, autoMergeReason: "PR auto-merged",
      errorMessage: null,
    } as any);
    expect(events.map(e => e.eventType)).toContain("run.auto_merged");
  });

  it("adds run.auto_merge_skipped when autoMerged=false with reason", () => {
    const events = projectPipelineRun({
      id: "run_4", issueId: "BEC-4", status: "completed",
      startedAt: new Date(), completedAt: new Date(),
      totalInputTokens: 0, totalOutputTokens: 0,
      runType: "standard", parentRunId: null, linearTeamId: null,
      repoUrl: "x", autoMerged: false, autoMergeReason: "diff too large",
      errorMessage: null,
    } as any);
    expect(events.map(e => e.eventType)).toContain("run.auto_merge_skipped");
  });

  it("projects a pm approval into requested + resolved when resolvedAt set", () => {
    const events = projectPmApproval({
      id: "a1", issueId: "BEC-9", action: "cancel",
      reason: "stale", slackMessageTs: "ts", status: "approved",
      createdAt: new Date("2026-04-01"), resolvedAt: new Date("2026-04-02"),
    } as any);
    expect(events.map(e => e.eventType)).toEqual([
      "pm.approval_requested", "pm.approval_resolved",
    ]);
  });

  it("projects a budget alert", () => {
    const ev = projectBudgetAlert({
      id: "ba1", date: "2026-04-01", scope: "team:T1", threshold: 80,
      firedAt: new Date("2026-04-01T10:00:00Z"),
    } as any);
    expect(ev.eventType).toBe("budget.alert_fired");
    expect(ev.scope).toBe("team:T1");
    expect(ev.payload).toMatchObject({ threshold: 80, date: "2026-04-01" });
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/audit/projection.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Create `audit/projection.ts`**

```ts
import type { AuditEvent, AuditActorType } from "../types.js";

// Row types left loose-typed because drizzle-infer varies by driver;
// projection consumers pass through `select().from(table)` results.
type PipelineRunRow = {
  id: string; issueId: string; status: string;
  startedAt: Date; completedAt: Date | null;
  totalInputTokens: number; totalOutputTokens: number;
  runType: string; parentRunId: string | null;
  linearTeamId: string | null; repoUrl: string;
  autoMerged: boolean | null; autoMergeReason: string | null;
  errorMessage: string | null;
};

function scopeForRun(row: PipelineRunRow): string | null {
  if (row.linearTeamId) return `team:${row.linearTeamId}`;
  return `repo:${row.repoUrl}`;
}

function actorForRun(row: PipelineRunRow): { actor: string; actorType: AuditActorType } {
  if (row.runType === "review-feedback") return { actor: "github-webhook", actorType: "webhook" };
  if (row.parentRunId) return { actor: "pm-agent", actorType: "pm-agent" };
  return { actor: "linear-webhook", actorType: "webhook" };
}

export function projectPipelineRun(row: PipelineRunRow): AuditEvent[] {
  const events: AuditEvent[] = [];
  const { actor, actorType } = actorForRun(row);
  const scope = scopeForRun(row);

  events.push({
    id: `proj_run_started_${row.id}`,
    timestamp: row.startedAt,
    eventType: "run.started",
    actor, actorType, scope,
    runId: row.id, issueId: row.issueId,
    inputTokens: 0, outputTokens: 0,
    payload: { runType: row.runType, repoUrl: row.repoUrl },
  });

  if (row.completedAt && row.status === "completed") {
    events.push({
      id: `proj_run_completed_${row.id}`,
      timestamp: row.completedAt,
      eventType: "run.completed",
      actor, actorType, scope,
      runId: row.id, issueId: row.issueId,
      inputTokens: row.totalInputTokens,
      outputTokens: row.totalOutputTokens,
      payload: {},
    });
  }

  if (row.completedAt && (row.status === "failed" || row.status === "retriable")) {
    events.push({
      id: `proj_run_failed_${row.id}`,
      timestamp: row.completedAt,
      eventType: "run.failed",
      actor, actorType, scope,
      runId: row.id, issueId: row.issueId,
      inputTokens: row.totalInputTokens,
      outputTokens: row.totalOutputTokens,
      payload: { errorMessage: row.errorMessage, status: row.status },
    });
  }

  if (row.autoMerged === true) {
    events.push({
      id: `proj_run_auto_merged_${row.id}`,
      timestamp: row.completedAt ?? row.startedAt,
      eventType: "run.auto_merged",
      actor, actorType, scope,
      runId: row.id, issueId: row.issueId,
      inputTokens: 0, outputTokens: 0,
      payload: { reason: row.autoMergeReason },
    });
  } else if (row.autoMerged === false && row.autoMergeReason) {
    events.push({
      id: `proj_run_auto_merge_skipped_${row.id}`,
      timestamp: row.completedAt ?? row.startedAt,
      eventType: "run.auto_merge_skipped",
      actor, actorType, scope,
      runId: row.id, issueId: row.issueId,
      inputTokens: 0, outputTokens: 0,
      payload: { reason: row.autoMergeReason },
    });
  }

  return events;
}

type PmApprovalRow = {
  id: string; issueId: string; action: string; reason: string;
  status: string; createdAt: Date; resolvedAt: Date | null;
};

export function projectPmApproval(row: PmApprovalRow): AuditEvent[] {
  const events: AuditEvent[] = [{
    id: `proj_approval_requested_${row.id}`,
    timestamp: row.createdAt,
    eventType: "pm.approval_requested",
    actor: "pm-agent", actorType: "pm-agent",
    scope: null, runId: null, issueId: row.issueId,
    inputTokens: 0, outputTokens: 0,
    payload: { approvalId: row.id, action: row.action, reason: row.reason },
  }];
  if (row.resolvedAt) {
    events.push({
      id: `proj_approval_resolved_${row.id}`,
      timestamp: row.resolvedAt,
      eventType: "pm.approval_resolved",
      actor: "pm-agent", actorType: "pm-agent",
      scope: null, runId: null, issueId: row.issueId,
      inputTokens: 0, outputTokens: 0,
      payload: { approvalId: row.id, action: row.action, status: row.status },
    });
  }
  return events;
}

type BudgetAlertRow = {
  id: string; date: string; scope: string; threshold: number; firedAt: Date;
};

export function projectBudgetAlert(row: BudgetAlertRow): AuditEvent {
  return {
    id: `proj_budget_alert_${row.id}`,
    timestamp: row.firedAt,
    eventType: "budget.alert_fired",
    actor: "pm-agent", actorType: "pm-agent",
    scope: row.scope,
    runId: null, issueId: null,
    inputTokens: 0, outputTokens: 0,
    payload: { threshold: row.threshold, date: row.date },
  };
}
```

Add `export * from "./projection.js";` to `audit/index.ts`.

- [ ] **Step 4: Run tests, verify pass**

```
cd packages/core && npx vitest run src/__tests__/audit/projection.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/core/src/audit/projection.ts packages/core/src/audit/index.ts packages/core/src/__tests__/audit/projection.test.ts
git commit -m "feat(audit): row-to-event projection"
```

---

## Task 6: Reader (`audit/reader.ts`)

Merges native audit rows with projected events and supports filtered, cursor-paginated queries.

**Files:**
- Create: `packages/core/src/audit/reader.ts`
- Modify: `packages/core/src/audit/index.ts`
- Test: `packages/core/src/__tests__/audit/reader.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/audit/reader.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../../db/client.js";
import { auditEvents, pipelineRuns, pmApprovals, budgetAlerts } from "../../db/schema.js";
import { logAuditEvent } from "../../audit/writer.js";
import { pmPromotedEvent, budgetRefusedEvent } from "../../audit/events.js";
import { listAuditEvents } from "../../audit/reader.js";

let db: any;

beforeEach(async () => {
  const c = await createDb("sqlite::memory:");
  db = c.db;
});

async function seed() {
  // native audit events
  await logAuditEvent(db, pmPromotedEvent({ issueId: "BEC-1", fromState: "Backlog", toState: "Todo" }));
  await logAuditEvent(db, budgetRefusedEvent({
    scope: "team:T1", scopeType: "team", tokensUsed: 100, limit: 100, utilization: 100,
  }));
  // projectable: pipeline run
  await db.insert(pipelineRuns).values({
    id: "run_1", issueId: "BEC-9", issueTitle: "t", pipelineKey: "auto-implement",
    repoUrl: "https://x.y/z", status: "completed",
    startedAt: new Date("2026-04-01T10:00:00Z"),
    completedAt: new Date("2026-04-01T10:05:00Z"),
    totalInputTokens: 100, totalOutputTokens: 50, runType: "standard",
    linearTeamId: "T1",
  });
}

describe("listAuditEvents", () => {
  it("returns native + projected events merged by time", async () => {
    await seed();
    const { events } = await listAuditEvents(db, { limit: 100 });
    const types = events.map(e => e.eventType).sort();
    expect(types).toContain("pm.issue_promoted");
    expect(types).toContain("budget.run_refused");
    expect(types).toContain("run.started");
    expect(types).toContain("run.completed");
  });

  it("filters by event type", async () => {
    await seed();
    const { events } = await listAuditEvents(db, { eventTypes: ["run.completed"], limit: 100 });
    expect(events.map(e => e.eventType)).toEqual(["run.completed"]);
  });

  it("filters by scope prefix-exact", async () => {
    await seed();
    const { events } = await listAuditEvents(db, { scope: "team:T1", limit: 100 });
    for (const e of events) expect(e.scope === "team:T1" || e.scope === null).toBeTruthy();
    expect(events.some(e => e.scope === "team:T1")).toBe(true);
  });

  it("filters by date window", async () => {
    await seed();
    const from = new Date("2026-04-01T09:00:00Z");
    const to = new Date("2026-04-01T10:10:00Z");
    const { events } = await listAuditEvents(db, { from, to, limit: 100 });
    for (const e of events) {
      expect(e.timestamp >= from && e.timestamp <= to).toBe(true);
    }
  });

  it("filters by runId", async () => {
    await seed();
    const { events } = await listAuditEvents(db, { runId: "run_1", limit: 100 });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.runId).toBe("run_1");
  });

  it("paginates via cursor", async () => {
    // seed 5 promoted events
    for (let i = 0; i < 5; i++) {
      await logAuditEvent(db, pmPromotedEvent({ issueId: `BEC-${i}`, fromState: "Backlog", toState: "Todo" }));
      await new Promise(r => setTimeout(r, 10));
    }
    const page1 = await listAuditEvents(db, { limit: 2 });
    expect(page1.events).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listAuditEvents(db, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.events).toHaveLength(2);
    const seen = new Set([...page1.events, ...page2.events].map(e => e.id));
    expect(seen.size).toBe(4);
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/audit/reader.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Create `audit/reader.ts`**

```ts
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { auditEvents, pipelineRuns, pmApprovals, budgetAlerts } from "../db/schema.js";
import type { AuditEvent, AuditEventType } from "../types.js";
import { projectPipelineRun, projectPmApproval, projectBudgetAlert } from "./projection.js";

export interface ListAuditEventsFilters {
  from?: Date;
  to?: Date;
  scope?: string;
  eventTypes?: AuditEventType[];
  actor?: string;
  runId?: string;
  issueId?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface ListAuditEventsResult {
  events: AuditEvent[];
  nextCursor: string | null;
}

interface Cursor { ts: string; id: string }

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(s: string): Cursor {
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
}

function parseNativeRow(row: any): AuditEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    eventType: row.eventType,
    actor: row.actor,
    actorType: row.actorType,
    scope: row.scope ?? null,
    runId: row.runId ?? null,
    issueId: row.issueId ?? null,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    payload: (() => { try { return JSON.parse(row.payload ?? "{}"); } catch { return {}; } })(),
  };
}

export async function listAuditEvents(
  db: AnyDb,
  filters: ListAuditEventsFilters = {},
): Promise<ListAuditEventsResult> {
  const limit = Math.min(filters.limit ?? 50, 500);
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  const cursorTs = cursor ? new Date(cursor.ts) : null;

  // Native audit_events query
  const nativeConditions: any[] = [];
  if (filters.from) nativeConditions.push(gte(auditEvents.timestamp, filters.from));
  if (filters.to) nativeConditions.push(lte(auditEvents.timestamp, filters.to));
  if (filters.scope) nativeConditions.push(eq(auditEvents.scope, filters.scope));
  if (filters.eventTypes?.length) nativeConditions.push(inArray(auditEvents.eventType, filters.eventTypes));
  if (filters.runId) nativeConditions.push(eq(auditEvents.runId, filters.runId));
  if (filters.issueId) nativeConditions.push(eq(auditEvents.issueId, filters.issueId));
  if (cursorTs) nativeConditions.push(lte(auditEvents.timestamp, cursorTs));

  const nativeRows = await db.select().from(auditEvents)
    .where(nativeConditions.length ? and(...nativeConditions) : undefined)
    .orderBy(desc(auditEvents.timestamp))
    .limit(limit * 2);

  // Projected: pipeline_runs
  const runConditions: any[] = [];
  if (filters.from) runConditions.push(gte(pipelineRuns.startedAt, filters.from));
  if (filters.to) runConditions.push(lte(pipelineRuns.startedAt, filters.to));
  if (filters.runId) runConditions.push(eq(pipelineRuns.id, filters.runId));
  if (filters.issueId) runConditions.push(eq(pipelineRuns.issueId, filters.issueId));
  const runRows = await db.select().from(pipelineRuns)
    .where(runConditions.length ? and(...runConditions) : undefined)
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(limit * 2);

  // Projected: pm_approvals
  const apprRows = await db.select().from(pmApprovals)
    .orderBy(desc(pmApprovals.createdAt))
    .limit(limit * 2);

  // Projected: budget_alerts
  const alertRows = await db.select().from(budgetAlerts)
    .orderBy(desc(budgetAlerts.firedAt))
    .limit(limit * 2);

  const merged: AuditEvent[] = [
    ...nativeRows.map(parseNativeRow),
    ...runRows.flatMap(projectPipelineRun as any),
    ...apprRows.flatMap(projectPmApproval as any),
    ...alertRows.map(projectBudgetAlert as any),
  ];

  // Apply filters that weren't pushed to SQL (actor prefix, q, eventType on projected, scope on projected)
  const filtered = merged.filter(e => {
    if (filters.from && e.timestamp < filters.from) return false;
    if (filters.to && e.timestamp > filters.to) return false;
    if (filters.scope && e.scope !== filters.scope) return false;
    if (filters.eventTypes?.length && !filters.eventTypes.includes(e.eventType)) return false;
    if (filters.actor && !e.actor.startsWith(filters.actor)) return false;
    if (filters.runId && e.runId !== filters.runId) return false;
    if (filters.issueId && e.issueId !== filters.issueId) return false;
    if (filters.q) {
      const hay = JSON.stringify(e.payload) + " " + e.actor;
      if (!hay.toLowerCase().includes(filters.q.toLowerCase())) return false;
    }
    if (cursor) {
      if (e.timestamp.getTime() > new Date(cursor.ts).getTime()) return false;
      if (e.timestamp.getTime() === new Date(cursor.ts).getTime() && e.id >= cursor.id) return false;
    }
    return true;
  });

  // Sort desc by (timestamp, id)
  filtered.sort((a, b) => {
    const d = b.timestamp.getTime() - a.timestamp.getTime();
    return d !== 0 ? d : (b.id > a.id ? 1 : -1);
  });

  const page = filtered.slice(0, limit);
  const nextCursor = filtered.length > limit
    ? encodeCursor({ ts: page[page.length - 1].timestamp.toISOString(), id: page[page.length - 1].id })
    : null;

  return { events: page, nextCursor };
}
```

Add `export * from "./reader.js";` to `audit/index.ts`.

- [ ] **Step 4: Run tests, verify pass**

```
cd packages/core && npx vitest run src/__tests__/audit/reader.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/core/src/audit/reader.ts packages/core/src/audit/index.ts packages/core/src/__tests__/audit/reader.test.ts
git commit -m "feat(audit): reader with filters and cursor pagination"
```

---

## Task 7: Retention sweep (`audit/retention.ts`)

**Files:**
- Create: `packages/core/src/audit/retention.ts`
- Modify: `packages/core/src/audit/index.ts`
- Test: `packages/core/src/__tests__/audit/retention.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/src/__tests__/audit/retention.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createDb } from "../../db/client.js";
import { auditEvents, pipelineRuns } from "../../db/schema.js";
import { pruneAuditLog } from "../../audit/retention.js";

describe("pruneAuditLog", () => {
  it("deletes rows older than retentionDays", async () => {
    const { db } = await createDb("sqlite::memory:") as any;
    const now = Date.now();
    await db.insert(auditEvents).values([
      { id: "old", timestamp: new Date(now - 400 * 86400000),
        eventType: "pm.issue_promoted", actor: "pm-agent", actorType: "pm-agent", payload: "{}" },
      { id: "new", timestamp: new Date(now - 10 * 86400000),
        eventType: "pm.issue_promoted", actor: "pm-agent", actorType: "pm-agent", payload: "{}" },
    ] as any);
    const deleted = await pruneAuditLog(db, 365);
    expect(deleted).toBe(1);
    const rows = await db.select().from(auditEvents);
    expect(rows.map((r: any) => r.id)).toEqual(["new"]);
  });

  it("does not touch pipeline_runs", async () => {
    const { db } = await createDb("sqlite::memory:") as any;
    await db.insert(pipelineRuns).values({
      id: "r1", issueId: "BEC-1", issueTitle: "t", pipelineKey: "auto-implement",
      repoUrl: "x", status: "completed",
      startedAt: new Date(Date.now() - 400 * 86400000),
    } as any);
    await pruneAuditLog(db, 365);
    const rows = await db.select().from(pipelineRuns);
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/audit/retention.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Create `audit/retention.ts`**

```ts
import { lt } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { createLogger } from "../logger.js";

const log = createLogger("audit.retention");

/**
 * Deletes audit_events rows older than `retentionDays`.
 *
 * This is the SOLE authorized mutation on the audit_events table. The
 * audit-immutability lint test grep-checks that no other file in the
 * codebase calls `update(auditEvents)` or `delete(auditEvents)`.
 *
 * Returns the number of rows deleted.
 */
export async function pruneAuditLog(db: AnyDb, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86400_000);
  const result = await db.delete(auditEvents).where(lt(auditEvents.timestamp, cutoff));
  const n = (result as any)?.changes ?? (result as any)?.rowCount ?? 0;
  log.info({ retentionDays, cutoff, deleted: n }, "audit log pruned");
  return n;
}
```

Add `export * from "./retention.js";` to `audit/index.ts`.

- [ ] **Step 4: Run tests, verify pass**

```
cd packages/core && npx vitest run src/__tests__/audit/retention.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/core/src/audit/retention.ts packages/core/src/audit/index.ts packages/core/src/__tests__/audit/retention.test.ts
git commit -m "feat(audit): retention sweep"
```

---

## Task 8: CSV stream (`audit/csv.ts`)

**Files:**
- Create: `packages/core/src/audit/csv.ts`
- Modify: `packages/core/src/audit/index.ts`
- Test: `packages/core/src/__tests__/audit/csv.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/src/__tests__/audit/csv.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../../db/client.js";
import { logAuditEvent } from "../../audit/writer.js";
import { pmPromotedEvent } from "../../audit/events.js";
import { streamAuditCsv } from "../../audit/csv.js";

async function collect(iter: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of iter) out += chunk;
  return out;
}

describe("streamAuditCsv", () => {
  let db: any;
  beforeEach(async () => { db = (await createDb("sqlite::memory:")).db; });

  it("emits header row then data rows", async () => {
    await logAuditEvent(db, pmPromotedEvent({ issueId: "BEC-1", fromState: "B", toState: "T" }));
    const csv = await collect(streamAuditCsv(db, {}));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("timestamp_utc,event_type,actor,actor_type,scope,run_id,issue_id,input_tokens,output_tokens,payload_json");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[1]).toContain("pm.issue_promoted");
    expect(lines[1]).toContain("BEC-1");
  });

  it("escapes quotes and commas in payload", async () => {
    const evt = pmPromotedEvent({ issueId: "BEC-1", fromState: "B", toState: "T", reason: 'has "quotes", commas' });
    await logAuditEvent(db, evt);
    const csv = await collect(streamAuditCsv(db, {}));
    // Quoted field with escaped internal quotes
    expect(csv).toMatch(/"[^"]*""quotes""[^"]*"/);
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/audit/csv.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Create `audit/csv.ts`**

```ts
import type { AnyDb } from "../db/client.js";
import { listAuditEvents, type ListAuditEventsFilters } from "./reader.js";
import type { AuditEvent } from "../types.js";

const HEADER = "timestamp_utc,event_type,actor,actor_type,scope,run_id,issue_id,input_tokens,output_tokens,payload_json";

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowFor(e: AuditEvent): string {
  return [
    e.timestamp.toISOString(),
    e.eventType,
    e.actor,
    e.actorType,
    e.scope ?? "",
    e.runId ?? "",
    e.issueId ?? "",
    e.inputTokens,
    e.outputTokens,
    JSON.stringify(e.payload),
  ].map(csvEscape).join(",");
}

/**
 * Streams the audit log as CSV. Pages through listAuditEvents in chunks of
 * `pageSize` to keep memory bounded regardless of total export size.
 */
export async function* streamAuditCsv(
  db: AnyDb,
  filters: ListAuditEventsFilters,
  pageSize = 1000,
): AsyncIterable<string> {
  yield HEADER + "\n";
  let cursor: string | null = null;
  do {
    const { events, nextCursor } = await listAuditEvents(db, { ...filters, limit: pageSize, cursor: cursor ?? undefined });
    for (const e of events) yield rowFor(e) + "\n";
    cursor = nextCursor;
  } while (cursor);
}
```

Add `export * from "./csv.js";` to `audit/index.ts`.

- [ ] **Step 4: Run tests, verify pass**

```
cd packages/core && npx vitest run src/__tests__/audit/csv.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/core/src/audit/csv.ts packages/core/src/audit/index.ts packages/core/src/__tests__/audit/csv.test.ts
git commit -m "feat(audit): streaming CSV export"
```

---

## Task 9: Immutability lint test

**Files:**
- Create: `packages/core/src/__tests__/audit-immutability.test.ts`

- [ ] **Step 1: Create the lint test**

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

describe("audit_events immutability", () => {
  it("only audit/retention.ts may delete or update audit_events rows", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const allowed = [
      "packages/core/src/audit/retention.ts",
      "packages/core/src/__tests__/audit/retention.test.ts",
      "packages/core/src/__tests__/audit-immutability.test.ts",
    ];

    const patterns = [
      "\\.delete\\s*\\(\\s*auditEvents",
      "\\.update\\s*\\(\\s*auditEvents",
    ];

    let matches: string[] = [];
    for (const pat of patterns) {
      try {
        const out = execFileSync("git", [
          "grep", "-nE", pat, "--", "packages/**/*.ts",
        ], { cwd: repoRoot, encoding: "utf8" });
        matches.push(...out.trim().split("\n").filter(Boolean));
      } catch {
        // git grep exits non-zero when no matches; safe to ignore
      }
    }

    const offenders = matches
      .map(line => line.split(":")[0])
      .filter(file => !allowed.some(a => file.endsWith(a) || file === a));

    expect(offenders, `Unauthorized audit_events mutation in:\n${offenders.join("\n")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, expect pass (nothing should be violating)**

```
cd packages/core && npx vitest run src/__tests__/audit-immutability.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```
git add packages/core/src/__tests__/audit-immutability.test.ts
git commit -m "test(audit): immutability lint"
```

---

## Task 10: Wire `budget.run_refused` in scheduler

Recover the `ScopeBudget[]` data currently dropped in `pm/scheduler.ts` budgetGuard.

**Files:**
- Modify: `packages/core/src/pm/scheduler.ts`
- Test: `packages/core/src/__tests__/pm-budget-refused-event.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/src/__tests__/pm-budget-refused-event.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { runTick } from "../pm/scheduler.js";

describe("budget.run_refused audit event", () => {
  it("writes one event per blocked scope from evaluateBudget", async () => {
    const { db } = await createDb("sqlite::memory:") as any;

    const fakeEvaluateBudget = async () => ({
      scopes: [
        { scope: { kind: "global" }, scopeLabel: "global", limit: 100, used: 100, percent: 100, tier: "blocked-100" },
        { scope: { kind: "team", teamId: "T1" }, scopeLabel: "team T1", limit: 50, used: 60, percent: 120, tier: "blocked-100" },
        { scope: { kind: "repo", repoUrl: "x" }, scopeLabel: "repo x", limit: 100, used: 10, percent: 10, tier: "ok" },
      ],
      worstTier: "blocked-100",
      promoteBlocked: true,
      blockReason: "global at 100%",
      activeCount: 0,
    });

    await runTick({
      db, config: { maxInFlight: 5, budgets: {} } as any, linear: {} as any,
    }, { evaluateBudget: fakeEvaluateBudget } as any);

    const rows = await db.select().from(auditEvents);
    const refused = rows.filter((r: any) => r.eventType === "budget.run_refused");
    expect(refused).toHaveLength(2); // global + team T1
    const scopes = refused.map((r: any) => r.scope).sort();
    expect(scopes).toEqual(["global", "team:T1"]);
  });
});
```

Note: adapt the exact `runTick` call to whatever `scheduler.ts` actually exports — inspect the file before writing the test. If `runTick` is not directly exported, use whatever tick entry point is exported.

- [ ] **Step 2: Run test, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/pm-budget-refused-event.test.ts
```
Expected: FAIL (no `budget.run_refused` rows written).

- [ ] **Step 3: Modify `pm/scheduler.ts`**

Find the block around line 160 where `tick.budgetGuard` is derived. After firing the existing threshold alerts, add:

```ts
// Emit budget.run_refused audit events for every scope at blocked-100
if (evaluation.promoteBlocked) {
  const { logAuditEvent, budgetRefusedEvent } = await import("../audit/index.js");
  for (const s of evaluation.scopes) {
    if (s.tier !== "blocked-100") continue;
    const scopeKey =
      s.scope.kind === "global" ? "global" :
      s.scope.kind === "team" ? `team:${s.scope.teamId}` :
      `repo:${s.scope.repoUrl}`;
    void logAuditEvent(db, budgetRefusedEvent({
      scope: scopeKey,
      scopeType: s.scope.kind as "global" | "team" | "repo",
      tokensUsed: s.used, limit: s.limit, utilization: s.percent,
    }));
  }
}
```

Use a dynamic import only if a static import would create a cycle; otherwise prefer a top-of-file `import { logAuditEvent, budgetRefusedEvent } from "../audit/index.js";`. Check for circular imports first.

- [ ] **Step 4: Run test, verify pass**

```
cd packages/core && npx vitest run src/__tests__/pm-budget-refused-event.test.ts
```
Expected: PASS.

- [ ] **Step 5: Run the broader scheduler test suite to catch regressions**

```
cd packages/core && npx vitest run src/__tests__/pm
```
Expected: all existing scheduler tests still pass.

- [ ] **Step 6: Commit**

```
git add packages/core/src/pm/scheduler.ts packages/core/src/__tests__/pm-budget-refused-event.test.ts
git commit -m "feat(audit): write budget.run_refused with per-scope breakdown"
```

---

## Task 11: Wire PM action audit events

Emit `pm.issue_promoted`, `pm.issue_deprioritized`, `pm.issue_cancelled`, `pm.triage_classified`.

**Files:**
- Modify: `packages/core/src/pm/actions/promote.ts`
- Modify: `packages/core/src/pm/actions/deprioritize.ts`
- Modify: `packages/core/src/pm/actions/cancel.ts`
- Modify: `packages/core/src/pm/actions/triage.ts`
- Test: `packages/core/src/__tests__/pm-action-audit-events.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/src/__tests__/pm-action-audit-events.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
// Import the action under test; stub Linear / Slack clients minimally.

describe("pm action audit events", () => {
  it.todo("emits pm.issue_promoted when promote.ts moves issue to Todo");
  it.todo("emits pm.issue_deprioritized after approval resolves");
  it.todo("emits pm.issue_cancelled after approval resolves");
  it.todo("emits pm.triage_classified after Haiku classifies");
});
```

The exact test shape depends on how each action currently stubs its dependencies. **Before writing the test bodies**, read each action file and its existing tests (`src/__tests__/pm-*.test.ts`) to match the existing stubbing pattern, then replace each `it.todo` with a real test that:
1. Invokes the action with a fake Linear client
2. Asserts that a row appears in `audit_events` with the expected `eventType`, `issueId`, and payload

- [ ] **Step 2: Run test, confirm the new assertions fail**

```
cd packages/core && npx vitest run src/__tests__/pm-action-audit-events.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Add `logAuditEvent` calls to each action file**

In `promote.ts`, after the successful Linear state update:
```ts
import { logAuditEvent, pmPromotedEvent } from "../../audit/index.js";
// ...
void logAuditEvent(deps.db, pmPromotedEvent({
  issueId: issue.id,
  fromState: fromStateName,
  toState: "Todo",
  priority: issue.priority,
  reason: "top-of-queue",
}));
```

In `deprioritize.ts`, after the approval resolves and priority changes:
```ts
void logAuditEvent(deps.db, pmDeprioritizedEvent({
  issueId: issue.id, oldPriority: prevPriority, newPriority: newPriority, approvalId: approval.id,
}));
```

In `cancel.ts`, after the cancellation completes:
```ts
void logAuditEvent(deps.db, pmCancelledEvent({
  issueId: issue.id, approvalId: approval.id, reason: reason,
}));
```

In `triage.ts`, after the Haiku classification succeeds and the label is applied:
```ts
void logAuditEvent(deps.db, pmTriageClassifiedEvent({
  issueId: issue.id, label: classifiedLabel, rationale: classifiedRationale,
}));
```

Pass `db` through the action's `deps` object if it's not already there (check each action's current signature).

- [ ] **Step 4: Run the new test file + existing PM action tests**

```
cd packages/core && npx vitest run src/__tests__/pm-action-audit-events.test.ts
cd packages/core && npx vitest run src/__tests__/pm-promote src/__tests__/pm-triage src/__tests__/pm-cancel src/__tests__/pm-deprioritize
```
Expected: all pass.

- [ ] **Step 5: Commit**

```
git add packages/core/src/pm/actions packages/core/src/__tests__/pm-action-audit-events.test.ts
git commit -m "feat(audit): emit pm action events"
```

---

## Task 12: Wire license + config audit events

**Files:**
- Modify: `packages/core/src/license.ts`
- Modify: config loader in `packages/cli/src/index.ts` (or wherever `AppConfig` is first loaded)
- Test: `packages/core/src/__tests__/license-audit-event.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/src/__tests__/license-audit-event.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { checkLicenseWithAudit, _resetLicenseCache } from "../license.js";

describe("license validation audit event", () => {
  it("writes license.validation_failed when the JWT is invalid", async () => {
    const { db } = await createDb("sqlite::memory:") as any;
    _resetLicenseCache();
    process.env.URATEAM_LICENSE_KEY = "not-a-jwt";
    await checkLicenseWithAudit(db);
    const rows = await db.select().from(auditEvents);
    const evts = rows.filter((r: any) => r.eventType === "license.validation_failed");
    expect(evts.length).toBeGreaterThan(0);
    delete process.env.URATEAM_LICENSE_KEY;
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/license-audit-event.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Add an audit-emitting wrapper in `license.ts`**

```ts
import { logAuditEvent, licenseValidationFailedEvent } from "./audit/index.js";
import type { AnyDb } from "./db/client.js";

export async function checkLicenseWithAudit(db: AnyDb | null): Promise<LicenseStatus> {
  const status = checkLicense();
  if (status.invalidReason && db) {
    await logAuditEvent(db, licenseValidationFailedEvent({
      invalidReason: status.invalidReason,
      expiredAt: status.expiresAt,
    }));
  }
  return status;
}
```

Also add `"audit-log"` to the Enterprise feature set (wherever the tier-to-feature mapping lives in `license.ts`).

Call `checkLicenseWithAudit(db)` from the startup path (CLI `index.ts` and dashboard server boot) once `db` is available. `checkLicense()` remains the cache-only accessor.

- [ ] **Step 4: Emit `config.loaded` at startup**

In the config loader (`packages/cli/src/index.ts`), after the config is loaded and validated:
```ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import { logAuditEvent, configLoadedEvent } from "@urateam/core/audit";

// ...
const sha256 = createHash("sha256").update(fs.readFileSync(configPath)).digest("hex");
void logAuditEvent(db, configLoadedEvent({
  path: configPath, sha256, tier: licenseStatus.tier,
}));
```

If `@urateam/core/audit` isn't an existing export path, use the package's existing export structure — typically `from "@urateam/core"` re-exported via the core package `index.ts`. Check `packages/core/src/index.ts` and add `export * from "./audit/index.js";` if not present.

- [ ] **Step 5: Run tests**

```
cd packages/core && npx vitest run src/__tests__/license-audit-event.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add packages/core/src/license.ts packages/core/src/index.ts packages/cli/src/index.ts packages/core/src/__tests__/license-audit-event.test.ts
git commit -m "feat(audit): license + config startup events"
```

---

## Task 13: Scheduler retention sweep step

Add `pruneAuditLog` as the final step of the PM tick.

**Files:**
- Modify: `packages/core/src/pm/scheduler.ts`
- Test: `packages/core/src/__tests__/pm-audit-retention-step.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { runTick } from "../pm/scheduler.js";

describe("pm tick retention sweep", () => {
  it("deletes audit_events older than retentionDays", async () => {
    const { db } = await createDb("sqlite::memory:") as any;
    await db.insert(auditEvents).values({
      id: "old", timestamp: new Date(Date.now() - 400 * 86400000),
      eventType: "pm.issue_promoted", actor: "pm-agent", actorType: "pm-agent", payload: "{}",
    } as any);
    await runTick({
      db, config: { maxInFlight: 5, auditLog: { retentionDays: 365 } } as any,
      linear: {} as any,
    });
    const rows = await db.select().from(auditEvents);
    expect(rows.find((r: any) => r.id === "old")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/pm-audit-retention-step.test.ts
```

- [ ] **Step 3: Add the step to `scheduler.ts`**

After the `digest` step, before the tick completes:
```ts
// Audit log retention sweep (no-op if unlicensed or not configured)
try {
  if (isFeatureLicensed("audit-log")) {
    const { pruneAuditLog } = await import("../audit/index.js");
    const days = config.auditLog?.retentionDays ?? 365;
    await pruneAuditLog(db, days);
  }
} catch (err) {
  log.warn({ err }, "audit retention sweep failed");
}
```

- [ ] **Step 4: Run test, verify pass**

```
cd packages/core && npx vitest run src/__tests__/pm-audit-retention-step.test.ts
```

- [ ] **Step 5: Commit**

```
git add packages/core/src/pm/scheduler.ts packages/core/src/__tests__/pm-audit-retention-step.test.ts
git commit -m "feat(audit): retention sweep in pm tick"
```

---

## Task 14: Dashboard audit route + view

**Files:**
- Create: `packages/dashboard/src/routes/audit.ts`
- Create: `packages/dashboard/src/views/audit.ts`
- Modify: `packages/dashboard/src/views/layout.ts`
- Modify: `packages/dashboard/src/server.ts` (register route)
- Test: `packages/dashboard/src/__tests__/audit.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/dashboard/src/__tests__/audit.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildServer } from "../server.js";
import { createDb } from "@urateam/core";
import { logAuditEvent, pmPromotedEvent } from "@urateam/core";

describe("/audit routes", () => {
  let app: any;
  let db: any;

  beforeEach(async () => {
    vi.stubEnv("URATEAM_LICENSE_KEY", ""); // unlicensed by default
    db = (await createDb("sqlite::memory:")).db;
    app = buildServer({ db });
  });

  it("returns 404 when audit-log feature is not licensed", async () => {
    const res = await app.request("/audit");
    expect(res.status).toBe(404);
  });

  it("returns 200 and renders page when licensed", async () => {
    vi.stubEnv("FORCE_LICENSE", "enterprise"); // or use license test hook
    app = buildServer({ db });
    await logAuditEvent(db, pmPromotedEvent({ issueId: "BEC-1", fromState: "B", toState: "T" }));
    const res = await app.request("/audit");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Audit");
    expect(body).toContain("pm.issue_promoted");
  });

  it("exports CSV when licensed", async () => {
    vi.stubEnv("FORCE_LICENSE", "enterprise");
    app = buildServer({ db });
    await logAuditEvent(db, pmPromotedEvent({ issueId: "BEC-1", fromState: "B", toState: "T" }));
    const res = await app.request("/audit/export.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const body = await res.text();
    expect(body).toContain("timestamp_utc,event_type");
    expect(body).toContain("pm.issue_promoted");
  });
});
```

Adjust the license-bypass mechanism (`FORCE_LICENSE` or equivalent) to match whatever test hook the existing license tests use. If none exists, use `_resetLicenseCache()` + a minted test JWT.

- [ ] **Step 2: Run tests, confirm failure**

```
cd packages/dashboard && npx vitest run src/__tests__/audit.test.ts
```

- [ ] **Step 3: Create the route**

Create `packages/dashboard/src/routes/audit.ts`:
```ts
import { Hono } from "hono";
import { isFeatureLicensed, listAuditEvents, streamAuditCsv } from "@urateam/core";
import { renderAuditPage } from "../views/audit.js";

export function auditRoutes(deps: { db: any }) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!isFeatureLicensed("audit-log")) return c.notFound();
    await next();
  });

  app.get("/", async (c) => {
    const url = new URL(c.req.url);
    const filters = parseFilters(url.searchParams);
    const { events, nextCursor } = await listAuditEvents(deps.db, filters);
    return c.html(renderAuditPage({ events, nextCursor, filters }));
  });

  app.get("/page", async (c) => {
    const url = new URL(c.req.url);
    const filters = parseFilters(url.searchParams);
    const { events, nextCursor } = await listAuditEvents(deps.db, filters);
    return c.html(renderAuditPage({ events, nextCursor, filters, partial: true }));
  });

  app.get("/export.csv", async (c) => {
    const url = new URL(c.req.url);
    const filters = parseFilters(url.searchParams);
    const stream = streamAuditCsv(deps.db, filters);
    const readable = new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const from = filters.from?.toISOString().slice(0, 10) ?? "all";
    const to = filters.to?.toISOString().slice(0, 10) ?? "all";
    return new Response(readable, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${from}-${to}.csv"`,
      },
    });
  });

  return app;
}

function parseFilters(params: URLSearchParams) {
  const from = params.get("from"); const to = params.get("to");
  return {
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
    scope: params.get("scope") ?? undefined,
    eventTypes: params.getAll("type") as any,
    actor: params.get("actor") ?? undefined,
    runId: params.get("runId") ?? undefined,
    q: params.get("q") ?? undefined,
    cursor: params.get("cursor") ?? undefined,
    limit: 50,
  };
}
```

- [ ] **Step 4: Create the view**

Create `packages/dashboard/src/views/audit.ts`:
```ts
import { html } from "hono/html";
import { layout } from "./layout.js";
import type { AuditEvent } from "@urateam/core";

interface AuditPageProps {
  events: AuditEvent[];
  nextCursor: string | null;
  filters: any;
  partial?: boolean;
}

export function renderAuditPage(props: AuditPageProps) {
  const rows = props.events.map(e => html`
    <tr>
      <td>${e.timestamp.toISOString()}</td>
      <td>${e.eventType}</td>
      <td>${e.actor}</td>
      <td>${e.scope ?? ""}</td>
      <td>${e.runId ? html`<a href="/runs/${e.runId}">${e.runId}</a>` : ""}</td>
      <td>${e.inputTokens + e.outputTokens}</td>
      <td><code>${JSON.stringify(e.payload).slice(0, 80)}</code></td>
    </tr>
  `);

  const table = html`
    <table class="audit">
      <thead><tr>
        <th>Timestamp</th><th>Event</th><th>Actor</th><th>Scope</th>
        <th>Run</th><th>Tokens</th><th>Payload</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${props.nextCursor
      ? html`<button hx-get="/audit/page?cursor=${props.nextCursor}" hx-swap="outerHTML">Load more</button>`
      : html`<p>End of feed.</p>`}
  `;

  if (props.partial) return table;

  return layout({
    title: "Audit",
    body: html`
      <h1>Audit log</h1>
      <form hx-get="/audit" hx-trigger="change">
        <input type="date" name="from" />
        <input type="date" name="to" />
        <input type="text" name="scope" placeholder="scope (team:T1)" />
        <input type="text" name="actor" placeholder="actor" />
        <input type="text" name="q" placeholder="search payload" />
        <a href="/audit/export.csv" class="button">Export CSV</a>
      </form>
      ${table}
    `,
  });
}
```

- [ ] **Step 5: Wire the route in `server.ts`**

Import and mount: `app.route("/audit", auditRoutes({ db }))`.

- [ ] **Step 6: Add "Audit" nav entry to `layout.ts`**

Find the nav list and add `<a href="/audit">Audit</a>` after "Errors".

- [ ] **Step 7: Run tests, verify pass**

```
cd packages/dashboard && npx vitest run src/__tests__/audit.test.ts
```

- [ ] **Step 8: Commit**

```
git add packages/dashboard
git commit -m "feat(audit): dashboard route view and csv export"
```

---

## Task 15: Integration test (end-to-end)

**Files:**
- Create: `packages/core/src/__tests__/integration/audit-e2e.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
import { describe, it, expect } from "vitest";
import { createDb } from "../../db/client.js";
import { auditEvents, pipelineRuns } from "../../db/schema.js";
import { listAuditEvents } from "../../audit/reader.js";

describe("audit log e2e", () => {
  it("projected run events appear alongside native PM events in the feed", async () => {
    const { db } = await createDb("sqlite::memory:") as any;

    // Seed a completed run
    await db.insert(pipelineRuns).values({
      id: "run_int_1", issueId: "BEC-42", issueTitle: "t", pipelineKey: "auto-implement",
      repoUrl: "https://github.com/a/b", status: "completed",
      startedAt: new Date("2026-04-01T10:00:00Z"),
      completedAt: new Date("2026-04-01T10:05:00Z"),
      totalInputTokens: 1000, totalOutputTokens: 500,
      runType: "standard", linearTeamId: "T-int",
      autoMerged: true, autoMergeReason: "small diff",
    } as any);

    // Seed a native audit event
    await db.insert(auditEvents).values({
      id: "evt_int_1", timestamp: new Date("2026-04-01T10:06:00Z"),
      eventType: "pm.issue_promoted", actor: "pm-agent", actorType: "pm-agent",
      issueId: "BEC-42", payload: JSON.stringify({ reason: "top-of-queue" }),
      scope: "team:T-int",
    } as any);

    const { events } = await listAuditEvents(db, { limit: 100 });
    const types = events.map(e => e.eventType);
    expect(types).toContain("run.started");
    expect(types).toContain("run.completed");
    expect(types).toContain("run.auto_merged");
    expect(types).toContain("pm.issue_promoted");

    // Filter by run id — should get only run events
    const byRun = await listAuditEvents(db, { runId: "run_int_1", limit: 100 });
    expect(byRun.events.every(e => e.runId === "run_int_1")).toBe(true);
  });
});
```

Note: this test belongs in the integration suite only if it actually needs the heavier fixtures. As written, it's fast enough to live in the unit tests. Place it in `src/__tests__/audit/audit-e2e.test.ts` instead if it runs under 1s.

- [ ] **Step 2: Run test**

```
cd packages/core && npx vitest run src/__tests__/audit/audit-e2e.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```
git add packages/core/src/__tests__/audit/audit-e2e.test.ts
git commit -m "test(audit): end-to-end projection + native merge"
```

---

## Task 16: Full build + test sweep + holistic review

- [ ] **Step 1: Build everything**

```
pnpm build
```
Expected: zero errors.

- [ ] **Step 2: Run the full unit test suite**

```
pnpm test
```
Expected: all pass.

- [ ] **Step 3: Run integration tests**

```
pnpm test:integration
```
Expected: all pass.

- [ ] **Step 4: Dispatch holistic external review**

Launch a fresh `feature-dev:code-reviewer` subagent with:
- Spec path: `docs/superpowers/specs/2026-04-14-audit-log-design.md`
- Plan path: `docs/superpowers/plans/2026-04-14-audit-log-and-export.md`
- Diff: `git diff main...HEAD`
- Ask it to flag: missing spec coverage, unauthorized audit_events mutations, projection bugs, prompt injection in `payload` rendering on the dashboard (HTML-escape check), missing license gate anywhere, regressions in existing PM action tests.

Address any high-confidence findings. Re-run `pnpm test`.

- [ ] **Step 5: Update CLAUDE.md**

Append a short section under "Key Patterns" in `/private/tmp/urateam/CLAUDE.md`:
```
### Audit log (Enterprise feature 4.2)
- Append-only `audit_events` table + read-time projection from `pipeline_runs`, `pm_approvals`, `budget_alerts`
- Only `packages/core/src/audit/retention.ts` may delete/update rows — enforced by `audit-immutability.test.ts`
- Event builders in `audit/events.ts`, fire-and-forget via `logAuditEvent(db, evt)`
- Reader: `listAuditEvents(db, filters)` with cursor pagination; CSV via `streamAuditCsv(db, filters)`
- Dashboard route `/audit` + `/audit/export.csv`, both gated by `isFeatureLicensed("audit-log")`
- Retention sweep runs in PM tick after `digest` (default 365 days)
```

- [ ] **Step 6: Commit CLAUDE.md update and open PR**

```
git add CLAUDE.md
git commit -m "docs: claude.md notes for audit log feature"
git push -u origin <branch>
gh pr create --title "feat: audit log + export (enterprise 4.2)" --body "$(cat <<'EOF'
## Summary
- Append-only audit_events table + read-time projection from existing tables
- Dashboard /audit page with filters and streaming CSV export
- Recovers per-scope ScopeBudget[] data from PR #39 (budget.run_refused events)
- Retention sweep in PM tick (default 365 days)
- Immutability enforced by grep-based lint test

Spec: docs/superpowers/specs/2026-04-14-audit-log-design.md
Plan: docs/superpowers/plans/2026-04-14-audit-log-and-export.md

## Test plan
- [ ] pnpm test (unit)
- [ ] pnpm test:integration
- [ ] Manual: /audit page renders, filters work, CSV export downloads

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** All 16 event types, write sites, read path, projection, retention, CSV, lint test, dashboard, config, migration, license gate, nav — each has a task.
- **Placeholders:** None. `it.todo` in Task 11 is deliberate — the pre-step instruction tells the implementer to replace them after reading the existing stub pattern, rather than guessing at dependencies that vary by action.
- **Types:** `AuditEvent`, `AuditEventType`, `AuditActorType`, `ListAuditEventsFilters` defined once, used consistently. `logAuditEvent(db, evt)` signature is stable. Event builder names match the event type strings (`pm.issue_promoted` → `pmPromotedEvent`).
- **Scope:** Plan produces one PR covering the full v1 feature. Phase 1.5 PR #39 follow-ups deliberately excluded per context.
- **Deferred assumptions:** Task 14 assumes a test-only license bypass hook exists or can be added; Task 12 assumes the existing `checkLicense()` signature can be wrapped without breaking other callers. Both should be verified in the first 10 minutes of implementation and the plan adjusted in-flight if they turn out wrong.

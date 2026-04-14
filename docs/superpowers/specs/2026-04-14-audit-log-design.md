# Design: Audit log + export (Enterprise feature 4.2)

**Date**: 2026-04-14
**Status**: Draft for review
**Parent strategy**: `docs/superpowers/specs/2026-04-13-enterprise-tier-design.md` § 4.2
**Scope**: Append-only audit event log with dashboard view and CSV export. Enterprise-tier feature, gated by `isFeatureLicensed("audit-log")`.

---

## 1. Goals and non-goals

### Goals
- Record every meaningful action across the urateam system (pipeline runs, PM agent decisions, budget events, license events, config loads) as a queryable event stream.
- Give a compliance/security reviewer a single page and a single CSV export that answers: *what happened, who/what triggered it, when, at what cost, in which scope*.
- Surface the per-scope `ScopeBudget[]` data from `evaluateBudget` that is currently dropped on the floor in `pm/tick.ts` `budgetGuard`.
- First-class events for actions that have no existing table today (config loads, license validation failures, budget refusals, PM promote decisions).
- Reuse existing run data via read-time projection rather than duplicating rows, to avoid bloating the hottest table.

### Non-goals
- Splunk / Datadog / SIEM push integrations (HTTP export is v2).
- Cryptographic tamper-evidence (hash chains, signed events). The buyer profile in the parent spec explicitly excludes regulated enterprise; convention-only immutability is sufficient for v1.
- Per-stage (`stage_runs`) or per-agent-log-line (`agent_logs`) events in the audit feed. Those tables already exist and are the right place to drill in.
- Webhook-received events. Noisy and already covered by `webhookDedup`.
- RBAC-aware attribution of manual dashboard actions. Reserved event type only; nothing writes it in v1 because there are no authenticated dashboard users yet (feature 4.4).
- Changes to `pipeline_runs` retention. The audit feed projects from it; retention of the source table is out of scope.
- PR #39 Phase 1.5 follow-ups (per-scope data in PM digest, UTC day-boundary test, `hasOwn` check, Postgres parity dedup test). Tracked separately.

## 2. Event taxonomy

Fifteen event types in v1, split by whether they're stored in the new table or projected from existing tables at read time.

### 2.1 Projected at read time (no new writes)
Read adapter in `audit/reader.ts` queries existing tables and maps rows into `AuditEvent` shape:

| Event type | Source table | Notes |
|---|---|---|
| `run.started` | `pipeline_runs` | Timestamp = `started_at`. Actor derived from `run_type` + `parent_run_id` (webhook, pm-agent, review-feedback). |
| `run.completed` | `pipeline_runs` | Only emitted when `status = 'completed'`. Timestamp = `completed_at`. |
| `run.failed` | `pipeline_runs` | `status in ('failed','retriable')`. Payload includes `error_message`. |
| `run.auto_merged` | `pipeline_runs` | `auto_merged = true`. Payload includes `auto_merge_reason`. |
| `run.auto_merge_skipped` | `pipeline_runs` | `auto_merged = false` but `auto_merge_reason` set. |
| `pm.approval_requested` | `pm_approvals` | Timestamp = `created_at`. |
| `pm.approval_resolved` | `pm_approvals` | `resolved_at not null`. Payload includes final `status`. |
| `budget.alert_fired` | `budget_alerts` | Timestamp = `fired_at`. Payload = `{date, scope, threshold}`. |

Projection is centralized: a single `projectEvents(rows, sourceTable)` helper in `audit/reader.ts` keeps the mapping testable in isolation.

### 2.2 Written to `audit_events` table
New write sites emit these directly:

| Event type | Write site | Payload |
|---|---|---|
| `pm.issue_promoted` | `pm/actions/promote.ts` | `{issueId, fromState, toState, priority, reason}` |
| `pm.issue_deprioritized` | `pm/actions/deprioritize.ts` | `{issueId, oldPriority, newPriority, approvalId}` |
| `pm.issue_cancelled` | `pm/actions/cancel.ts` | `{issueId, approvalId, reason}` |
| `pm.triage_classified` | `pm/actions/triage.ts` | `{issueId, label, rationale (≤500 chars)}` |
| `budget.run_refused` | `pm/tick.ts` `budgetGuard` | `{scope, scopeType, tokensUsed, limit, utilization, refusedRunId?}` — **this is the `ScopeBudget` data currently dropped** |
| `license.validation_failed` | `license.ts` `checkLicense()` | `{invalidReason, expiredAt?}` |
| `config.loaded` | config loader in `cli`/`core` startup | `{path, sha256, tier}` |
| `dashboard.manual_action` | *reserved* | v1 writes nothing; placeholder for feature 4.4 |

### 2.3 Explicitly excluded from v1
- Per-stage lifecycle events (`stage_runs` is already the right surface).
- Per-agent-log-line events (`agent_logs` is the drill-down).
- Webhook-received / webhook-deduped events.
- Git push/PR creation events (derivable from `run.completed` + `pr_url`).

## 3. Data model

### 3.1 New table `audit_events`

Added to `packages/core/src/db/schema.ts`, `MIGRATION_COLUMNS` (for ALTER-style migrations), `getCreateTablesDDL()` (for fresh installs), and a new file-based migration in `db/migrations/{sqlite,postgres}/`:

```ts
export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  timestamp: crossTimestamp("timestamp").notNull().$defaultFn(() => new Date()),
  eventType: text("event_type").notNull(),
  actor: text("actor").notNull(),           // 'system' | pm-agent | linear-webhook | github-webhook | cli:<user> | dashboard:<user>
  actorType: text("actor_type").notNull(),  // 'system' | 'pm-agent' | 'webhook' | 'dashboard-user' | 'cli'
  scope: text("scope"),                     // null | 'global' | 'team:<linearTeamId>' | 'repo:<repoUrl>'
  runId: text("run_id"),                    // nullable FK-ish to pipeline_runs.id; no hard constraint so projected events don't break
  issueId: text("issue_id"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  payload: text("payload").notNull().default("{}"), // JSON
});
```

Indexes (declared in the migration, not on the Drizzle table object — matches existing convention):
- `idx_audit_events_timestamp` on `(timestamp DESC)`
- `idx_audit_events_type_ts` on `(event_type, timestamp DESC)`
- `idx_audit_events_scope_ts` on `(scope, timestamp DESC)`
- `idx_audit_events_run_id` on `(run_id)`

Timestamp type uses `crossTimestamp` for driver parity (SQLite integer / Postgres TIMESTAMPTZ).

### 3.2 Zod schema

Added to `packages/core/src/types.ts`:

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

export const AuditActorTypeSchema = z.enum([
  "system", "pm-agent", "webhook", "dashboard-user", "cli",
]);

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
```

## 4. Module layout

New directory `packages/core/src/audit/`:

```
audit/
  index.ts            — barrel export
  writer.ts           — logAuditEvent(db, event): fire-and-forget insert, pino warn on failure
  events.ts           — typed event builders (runStartedEvent, pmPromotedEvent, budgetRefusedEvent, …)
  reader.ts           — listAuditEvents({from,to,scope,eventType,actor,runId,limit,cursor}) with projection
  retention.ts        — pruneAuditLog(db, retentionDays): the only authorized mutation on audit_events
  csv.ts              — streamAuditCsv(reader, filters): AsyncIterable<string> row emitter
```

### 4.1 Writer semantics
- `logAuditEvent` is `async` but callers use `void logAuditEvent(...)` — **fire-and-forget**. It wraps the insert in try/catch and logs a pino warning on failure. Audit write failures never crash the caller. This matches the principle that audit is observational, not load-bearing.
- No write buffering in v1. If volume becomes a problem, add a batched writer in v2 modeled on the existing `agent_logs` batcher.

### 4.2 Reader semantics
- `listAuditEvents(filters)` returns `{events: AuditEvent[], nextCursor: string | null}`.
- Implementation:
  1. Query `audit_events` with filters → rows.
  2. Query `pipeline_runs`, `pm_approvals`, `budget_alerts` for the same window → project into events via `projectEvents`.
  3. Merge the four streams by `(timestamp DESC, id DESC)`.
  4. Apply post-merge filters that couldn't be pushed to SQL (e.g. free-text search on payload).
  5. Truncate to `limit` (default 50, max 500).
- Cursor encoding: `base64url(JSON.stringify({ts: isoString, id}))`. Next-page query adds `WHERE timestamp < :ts OR (timestamp = :ts AND id < :id)`.
- Filters supported in v1: `from`, `to` (date window), `scope` (exact match), `eventType` (in-list), `actor` (prefix match), `runId`, `issueId`, `q` (free-text on payload JSON — applied in-process after merge).

### 4.3 Retention
- `pruneAuditLog(db, retentionDays)` deletes rows where `timestamp < now() - retentionDays days`.
- Called from the PM scheduler tick, after `digest`, in a new `pruneAuditLog` step (see § 6).
- Default `auditLog.retentionDays = 365`. Configurable per-deployment.
- Projected events from `pipeline_runs` / `pm_approvals` / `budget_alerts` are not touched — their retention belongs to those tables.
- `retention.ts` is the **sole authorized mutation** on `audit_events`. Documented inline and enforced by the lint test in § 7.

### 4.4 CSV stream
- `streamAuditCsv(db, filters)` is an `AsyncIterable<string>` that yields header row then data rows.
- Internally calls `listAuditEvents` in a pagination loop (1000 rows per page) so memory stays bounded regardless of export size.
- Columns:
  `timestamp_utc, event_type, actor, actor_type, scope, run_id, issue_id, input_tokens, output_tokens, payload_json`
- `payload_json` is the raw JSON column with CSV-escaping applied (wraps in `"..."`, doubles embedded quotes). Keeps schema stable as event types evolve.

## 5. Write-site integration

Every new write site becomes a 1–2 line addition next to the existing logic. Example from `pm/actions/promote.ts`:

```ts
await linear.updateIssue(issue.id, { stateId: todoStateId });
log.info({ issueId: issue.id }, "promoted");
void logAuditEvent(db, pmPromotedEvent({
  issueId: issue.id, fromState, toState: "Todo",
  priority: issue.priority, reason: "top-of-queue",
}));
```

### 5.1 `budget.run_refused` — recovering the dropped `ScopeBudget` data

In `pm/tick.ts` `budgetGuard`, the current code discards the per-scope breakdown from `evaluateBudget`. The fix:

```ts
const result = await evaluateBudget(db, config);
if (!result.allowed) {
  for (const scope of result.scopes.filter(s => s.refused)) {
    void logAuditEvent(db, budgetRefusedEvent({
      scope: scope.id, scopeType: scope.type,
      tokensUsed: scope.tokensUsed, limit: scope.limit,
      utilization: scope.utilization,
    }));
  }
  return { allowed: false, reason: "budget" };
}
```

This is the single place the `ScopeBudget[]` breakdown becomes visible downstream.

### 5.2 Actor derivation
- Linear webhook → `actor="linear-webhook"`, `actorType="webhook"`
- GitHub webhook → `actor="github-webhook"`, `actorType="webhook"`
- PM Agent → `actor="pm-agent"`, `actorType="pm-agent"`
- CLI (`ura start`, `ura dev`) → `actor="cli:<os_user>"`, `actorType="cli"`
- Dashboard manual action → `actor="dashboard:<username>"`, `actorType="dashboard-user"` (reserved; v1 writes nothing)
- System startup (license, config) → `actor="system"`, `actorType="system"`

## 6. PM scheduler tick integration

Update `pm/scheduler.ts` tick sequence. Current:

> budget check → recover retriable → recover stuck → startTodoIssues → triage → resolve approvals → promote → deprioritize → cancel → digest

New:

> budget check → recover retriable → recover stuck → startTodoIssues → triage → resolve approvals → promote → deprioritize → cancel → digest → **pruneAuditLog**

`pruneAuditLog` is a no-op if audit log is disabled or unlicensed.

## 7. Immutability enforcement

Convention-only (per brainstorm decision): a lint test guards it.

New file `packages/core/src/__tests__/audit-immutability.test.ts`, modeled on `prompt-injection.test.ts`:
- Greps all `.ts` files under `packages/` for `update(auditEvents)` and `delete(auditEvents)`.
- Test passes iff the **only** matching files are:
  - `packages/core/src/audit/retention.ts` (the sole authorized deleter)
  - The test file itself

If a future change introduces an unauthorized mutation, CI fails with a clear error pointing at the offending file. The test file's docstring explains the reasoning so a future engineer sees the intent.

## 8. Config

New section in `AppConfig` (in `types.ts`):

```ts
auditLog: z.object({
  enabled: z.boolean().optional(),        // defaults to true when audit-log feature is licensed
  retentionDays: z.number().int().positive().optional().default(365),
}).optional(),
```

Gating:
- `isFeatureLicensed("audit-log")` → write sites call `logAuditEvent`, reader works, dashboard page + export enabled.
- Unlicensed → write sites are no-ops, reader returns empty feed, dashboard route returns 404, export returns 404.

The feature flag `audit-log` is added to the Enterprise tier feature set in `license.ts`.

## 9. Dashboard

### 9.1 Routes
New file `packages/dashboard/src/routes/audit.ts`:

- `GET /audit` — HTML page. Renders filter bar + first page of results (default window: last 7 days).
- `GET /audit/page` — HTMX partial for pagination. Returns table rows + next-page HTMX hook.
- `GET /audit/event/:id` — HTMX partial for the expanded payload view.
- `GET /audit/export.csv` — streams CSV. Uses Hono's `c.body(new ReadableStream(...))`. Filters read from query string, identical to the list endpoint. Filename: `audit-<from>-<to>.csv`.

All four routes return 404 if `!isFeatureLicensed("audit-log")`.

### 9.2 Views
New file `packages/dashboard/src/views/audit.ts`:

- Filter bar: date range picker, scope dropdown (populated from distinct scopes seen in last 30d), event type multi-select, actor free-text search, payload free-text search.
- Table: `timestamp · event · actor · scope · run (→ /runs/:id when set) · cost · payload preview (first 80 chars)`.
- Row click expands payload via `GET /audit/event/:id`.
- Footer: pagination via HTMX `hx-get="/audit/page"` with cursor preserved.
- Export button top-right, `hx-boost="false"`, href built from current filter state.

### 9.3 Navigation
`packages/dashboard/src/views/layout.ts` — add "Audit" nav entry after "Errors".

## 10. Testing strategy

### 10.1 Unit tests (`packages/core/src/__tests__/audit/`)
- `writer.test.ts` — insert happy path, failure path logs but doesn't throw, payload serialized correctly.
- `events.test.ts` — each event builder produces valid schema (zod parse round-trip).
- `reader.test.ts` — each filter (from/to/scope/eventType/actor/runId/q), cursor pagination, limit cap, merge ordering.
- `projection.test.ts` — `projectEvents` maps `pipeline_runs`, `pm_approvals`, `budget_alerts` rows to correct event shapes.
- `retention.test.ts` — deletes only rows older than cutoff, leaves `pipeline_runs` untouched.
- `csv.test.ts` — header row correct, escaping correct (quotes, commas, newlines in payload), streams without buffering (assertion: memory doesn't grow with row count).

### 10.2 Integration tests (`packages/core/src/__tests__/integration/audit-e2e.test.ts`)
- Webhook → run start → `run.started` appears in feed and in CSV export.
- `evaluateBudget` refuses → `budget.run_refused` row contains the `ScopeBudget` fields.
- PM promote → `pm.issue_promoted` row.

### 10.3 Lint test
- `audit-immutability.test.ts` — see § 7.

### 10.4 Dashboard tests (`packages/dashboard/src/__tests__/audit.test.ts`)
- Unlicensed → 404 on all four routes.
- Licensed → `GET /audit` returns page, HTMX pagination preserves filters across pages, CSV export streams with correct `Content-Type: text/csv` and `Content-Disposition` header.

### 10.5 Explicitly deferred
- Per-scope digest surfacing in PM Slack digest (PR #39 Phase 1.5 follow-up).
- Postgres parity test for the audit insert + read path (the existing test suite covers both drivers through the shared schema; no audit-specific parity test planned unless a driver-specific bug surfaces).

## 11. Migration + rollout

### 11.1 Schema migration
- New file `db/migrations/sqlite/0007_audit_events.sql` and `db/migrations/postgres/0007_audit_events.sql` containing `CREATE TABLE` + indexes.
- `MIGRATION_COLUMNS` entry: not applicable (new table, not a column add). Migration runs via file-based migration runner.
- `getCreateTablesDDL(driver)` extended to include the new table for fresh installs.
- Drizzle schema in `schema.ts` gets the new `auditEvents` table declaration.

### 11.2 Backfill
None. Audit log starts empty on first boot after the migration. Historical runs remain queryable through the projected read path — they surface in the audit feed as `run.started/completed/failed` events derived from existing `pipeline_runs` rows, retroactively.

### 11.3 Feature flag
- `audit-log` added to Enterprise feature set in `license.ts`.
- OSS / Pro deployments see no audit routes, no writes, no retention sweep — no behavior change.

## 12. Open questions (deferred, not blockers)
- Whether to add a `correlationId` for multi-event causality chains (e.g. linking a `pm.approval_requested` to the subsequent `pm.issue_cancelled`). Not needed in v1 because `payload.approvalId` already threads through.
- Whether the retention sweep should be soft-delete (archive to cold storage) for Enterprise-Plus in future. v1 is hard-delete only.
- Whether `dashboard.manual_action` should be written in v1 for the existing unauthenticated "retry run" button. Currently the dashboard has no user identity, so this would produce `actor="dashboard:anonymous"` rows with limited value. Deferred until feature 4.4 (RBAC).

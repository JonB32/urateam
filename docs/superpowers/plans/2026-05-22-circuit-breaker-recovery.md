# BEC-236 Circuit-Breaker Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the half-open circuit-breaker probe + `ura circuit reset` command per `docs/superpowers/specs/2026-05-22-circuit-breaker-recovery-design.md`, so the PM agent recovers from a frozen-backlog state after a transient fleet-wide outage.

**Architecture:** New `circuit_breaker_state` DB table tracks Tier-5 escalations. `selectProbeCandidates` runs first in the PM tick and returns a `Set<issueId>` (≤ `cap`) of cooldown-eligible issues; promote/startTodo accept it as `probeOverrideIds` and bypass the breaker skip for those. `recoverCircuitBreaker` runs in `runner.ts`'s completion path, drops the state row + removes the `needs-design` label. `ura circuit list/reset` is a CLI subcommand that talks to the DB directly (no HTTP layer — matches `ura admin` pattern).

**Tech Stack:** TypeScript / pnpm monorepo. Drizzle ORM (SQLite + Postgres). Vitest. Commander.js for CLI. `@linear/sdk` for label removal.

---

### Task 1: Audit event types — add three enum entries

**Files:**
- Modify: `packages/core/src/types.ts` (insert into `AuditEventTypeSchema`, near the existing `pm.escalated_to_needs_design` entry at line 586)

- [ ] **Step 1: Run the audit-immutability test to confirm baseline**

Run: `cd packages/core && npx vitest run src/__tests__/audit-immutability.test.ts`
Expected: PASS

- [ ] **Step 2: Add three enum values to `AuditEventTypeSchema`**

In `packages/core/src/types.ts`, insert immediately AFTER the `"pm.escalated_to_needs_design",` entry (currently line 586):

```ts
  /** BEC-236 — PM tick selected this issue for a half-open circuit-breaker probe.
   *  The breaker is currently engaged (≥ maxConsecutiveFailures), but the
   *  cooldown window has elapsed and the per-tick probe cap allows it through.
   *  Payload: issueId, consecutiveFailures, lastFailureAgeMin, probeAttempts. */
  "pm.circuit_breaker_probe",
  /** BEC-236 — A probe run reached terminal `completed` status, so the
   *  circuit_breaker_state row was deleted and the Tier-5-added `needs-design`
   *  label was removed. Payload: issueId, probeAttempts. */
  "pm.circuit_breaker_recovered",
  /** BEC-236 — `ura circuit reset` cleared the breaker for an issue. Payload:
   *  issueId, scope ("single" | "bulk"), failedRunsDeleted (count of
   *  pipeline_runs rows the reset deleted). */
  "pm.circuit_breaker_reset_manual",
```

- [ ] **Step 3: Run the audit-immutability test, expect it to PASS (enum addition is allowed; immutability is about mutation paths, not new types)**

Run: `cd packages/core && npx vitest run src/__tests__/audit-immutability.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "$(cat <<'EOF'
feat(BEC-236): audit event types for circuit-breaker probe/recovery

Adds pm.circuit_breaker_probe, pm.circuit_breaker_recovered, and
pm.circuit_breaker_reset_manual to AuditEventTypeSchema. Constructors
follow in a later task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Audit event constructors

**Files:**
- Modify: `packages/core/src/audit/events.ts` (add three constructors after the existing `pmEscalatedToNeedsDesignEvent`, ~line 777)
- Create: `packages/core/src/__tests__/circuit-breaker-events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/circuit-breaker-events.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  pmCircuitBreakerProbeEvent,
  pmCircuitBreakerRecoveredEvent,
  pmCircuitBreakerResetManualEvent,
} from "../audit/events.js";

describe("circuit-breaker audit events", () => {
  it("pmCircuitBreakerProbeEvent has correct shape", () => {
    const ev = pmCircuitBreakerProbeEvent({
      issueId: "BEC-1",
      consecutiveFailures: 3,
      lastFailureAgeMin: 130,
      probeAttempts: 1,
    });
    expect(ev.eventType).toBe("pm.circuit_breaker_probe");
    expect(ev.actor).toBe("pm-agent");
    expect(ev.issueId).toBe("BEC-1");
    expect(ev.payload).toEqual({
      consecutiveFailures: 3,
      lastFailureAgeMin: 130,
      probeAttempts: 1,
    });
  });

  it("pmCircuitBreakerRecoveredEvent has correct shape", () => {
    const ev = pmCircuitBreakerRecoveredEvent({ issueId: "BEC-1", probeAttempts: 2 });
    expect(ev.eventType).toBe("pm.circuit_breaker_recovered");
    expect(ev.actor).toBe("pm-agent");
    expect(ev.issueId).toBe("BEC-1");
    expect(ev.payload).toEqual({ probeAttempts: 2 });
  });

  it("pmCircuitBreakerResetManualEvent has correct shape", () => {
    const ev = pmCircuitBreakerResetManualEvent({
      issueId: "BEC-1",
      scope: "single",
      failedRunsDeleted: 3,
    });
    expect(ev.eventType).toBe("pm.circuit_breaker_reset_manual");
    expect(ev.actor).toBe("cli");
    expect(ev.actorType).toBe("operator");
    expect(ev.payload).toEqual({ scope: "single", failedRunsDeleted: 3 });
  });
});
```

- [ ] **Step 2: Run test — expect failure (constructors don't exist)**

Run: `cd packages/core && npx vitest run src/__tests__/circuit-breaker-events.test.ts`
Expected: FAIL with import errors

- [ ] **Step 3: Add constructors to `packages/core/src/audit/events.ts`**

Insert after `pmEscalatedToNeedsDesignEvent` (currently ending ~line 777):

```ts
/**
 * BEC-236 — emitted by `selectProbeCandidates` for each issue that the
 * half-open probe selects through the breaker this tick. Carries the
 * fields an operator needs to judge whether the probe set looks healthy.
 */
export function pmCircuitBreakerProbeEvent(args: {
  issueId: string;
  consecutiveFailures: number;
  lastFailureAgeMin: number;
  probeAttempts: number;
}): AuditEvent {
  return base({
    eventType: "pm.circuit_breaker_probe",
    actor: "pm-agent",
    actorType: "pm-agent",
    issueId: args.issueId,
    payload: {
      consecutiveFailures: args.consecutiveFailures,
      lastFailureAgeMin: args.lastFailureAgeMin,
      probeAttempts: args.probeAttempts,
    },
  });
}

/**
 * BEC-236 — emitted when a probe run reaches terminal `completed` status
 * and `recoverCircuitBreaker` drops the state row + removes the
 * Tier-5-added `needs-design` label.
 */
export function pmCircuitBreakerRecoveredEvent(args: {
  issueId: string;
  probeAttempts: number;
}): AuditEvent {
  return base({
    eventType: "pm.circuit_breaker_recovered",
    actor: "pm-agent",
    actorType: "pm-agent",
    issueId: args.issueId,
    payload: { probeAttempts: args.probeAttempts },
  });
}

/**
 * BEC-236 — emitted once per issue when `ura circuit reset` clears the
 * breaker. Scope is "single" for a targeted reset, "bulk" when invoked
 * via `--all`.
 */
export function pmCircuitBreakerResetManualEvent(args: {
  issueId: string;
  scope: "single" | "bulk";
  failedRunsDeleted: number;
}): AuditEvent {
  return base({
    eventType: "pm.circuit_breaker_reset_manual",
    actor: "cli",
    actorType: "operator",
    issueId: args.issueId,
    payload: { scope: args.scope, failedRunsDeleted: args.failedRunsDeleted },
  });
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `cd packages/core && npx vitest run src/__tests__/circuit-breaker-events.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/audit/events.ts packages/core/src/__tests__/circuit-breaker-events.test.ts
git commit -m "$(cat <<'EOF'
feat(BEC-236): audit event constructors for circuit-breaker recovery

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `circuit_breaker_state` DB schema

**Files:**
- Modify: `packages/core/src/db/schema.ts` (add `circuitBreakerState` table near the existing `webhookDedup`, ~line 128)
- Modify: `packages/core/src/db/client.ts` (add `CREATE TABLE IF NOT EXISTS` to `getCreateTablesDDL`)

- [ ] **Step 1: Add the Drizzle schema entry to `packages/core/src/db/schema.ts`**

Insert after the existing `webhookDedup` table definition (after line 131):

```ts
/**
 * BEC-236 — tracks Tier-5 circuit-breaker escalations so the half-open
 * probe can distinguish them from human/triage-added `needs-design`
 * labels. Insert on Tier-5 escalation (idempotent via the issue_id PK),
 * update last_probe_at + probe_attempts in selectProbeCandidates, delete
 * on probe-recovery or manual reset.
 */
export const circuitBreakerState = sqliteTable("circuit_breaker_state", {
  issueId: text("issue_id").primaryKey(),
  escalatedAt: crossTimestamp("escalated_at")
    .notNull()
    .$defaultFn(() => new Date()),
  lastProbeAt: crossTimestamp("last_probe_at"),
  probeAttempts: integer("probe_attempts").notNull().default(0),
});
```

- [ ] **Step 2: Add the CREATE TABLE to `getCreateTablesDDL` in `packages/core/src/db/client.ts`**

Append the new table at the end of the returned template string (before the closing backtick at the bottom of `getCreateTablesDDL`):

```sql
  CREATE TABLE IF NOT EXISTS circuit_breaker_state (
    issue_id TEXT PRIMARY KEY,
    escalated_at ${ts} NOT NULL DEFAULT (${now}),
    last_probe_at ${ts},
    probe_attempts INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_circuit_breaker_state_last_probe_at
    ON circuit_breaker_state(last_probe_at);
```

- [ ] **Step 3: Run the existing schema tests to verify nothing else broke**

Run: `cd packages/core && npx vitest run src/__tests__/db-schema.test.ts src/__tests__/migrations.test.ts 2>&1 | tail -10`
Expected: PASS (or skip if those files don't exist — the next task will exercise the table)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/src/db/client.ts
git commit -m "$(cat <<'EOF'
feat(BEC-236): add circuit_breaker_state table

Tracks Tier-5 escalations so the half-open probe can tell its own
escalations apart from human-added needs-design labels.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `getCircuitBreakerProbeConfig` env helper

**Files:**
- Create: `packages/core/src/pm/actions/circuit-breaker-config.ts`
- Create: `packages/core/src/__tests__/circuit-breaker-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { getCircuitBreakerProbeConfig } from "../pm/actions/circuit-breaker-config.js";

describe("getCircuitBreakerProbeConfig", () => {
  it("returns defaults when env is empty", () => {
    expect(getCircuitBreakerProbeConfig({})).toEqual({
      disabled: false,
      cooldownMs: 120 * 60 * 1000,
      maxProbesPerTick: 2,
    });
  });

  it("disabled is true ONLY for strict 'true'", () => {
    expect(getCircuitBreakerProbeConfig({ PM_DISABLE_CIRCUIT_BREAKER_PROBE: "true" }).disabled).toBe(true);
    expect(getCircuitBreakerProbeConfig({ PM_DISABLE_CIRCUIT_BREAKER_PROBE: "1" }).disabled).toBe(false);
    expect(getCircuitBreakerProbeConfig({ PM_DISABLE_CIRCUIT_BREAKER_PROBE: "yes" }).disabled).toBe(false);
    expect(getCircuitBreakerProbeConfig({ PM_DISABLE_CIRCUIT_BREAKER_PROBE: "TRUE" }).disabled).toBe(false);
  });

  it("parses PM_CIRCUIT_BREAKER_PROBE_AGE_MIN as minutes", () => {
    expect(getCircuitBreakerProbeConfig({ PM_CIRCUIT_BREAKER_PROBE_AGE_MIN: "30" }).cooldownMs).toBe(30 * 60 * 1000);
  });

  it("parses PM_CIRCUIT_BREAKER_MAX_PROBES_PER_TICK", () => {
    expect(getCircuitBreakerProbeConfig({ PM_CIRCUIT_BREAKER_MAX_PROBES_PER_TICK: "5" }).maxProbesPerTick).toBe(5);
  });

  it("falls back to defaults on non-integer values", () => {
    const cfg = getCircuitBreakerProbeConfig({
      PM_CIRCUIT_BREAKER_PROBE_AGE_MIN: "abc",
      PM_CIRCUIT_BREAKER_MAX_PROBES_PER_TICK: "-1",
    });
    expect(cfg.cooldownMs).toBe(120 * 60 * 1000);
    expect(cfg.maxProbesPerTick).toBe(2);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `cd packages/core && npx vitest run src/__tests__/circuit-breaker-config.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `packages/core/src/pm/actions/circuit-breaker-config.ts`**

```ts
/**
 * BEC-236 — parse the half-open circuit-breaker probe configuration from
 * environment variables. Read at call time (not boot time) so flipping
 * `PM_DISABLE_CIRCUIT_BREAKER_PROBE` takes effect on the next PM tick
 * without a daemon restart, matching the BEC-218 / BEC-227 convention.
 */
export interface CircuitBreakerProbeConfig {
  disabled: boolean;
  cooldownMs: number;
  maxProbesPerTick: number;
}

const DEFAULT_COOLDOWN_MIN = 120;
const DEFAULT_MAX_PROBES_PER_TICK = 2;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function getCircuitBreakerProbeConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): CircuitBreakerProbeConfig {
  // Strict equality — matches the BEC-218 / BEC-227 convention for booleans
  // ("1" / "yes" / "TRUE" must NOT match).
  const disabled = env.PM_DISABLE_CIRCUIT_BREAKER_PROBE === "true";
  const cooldownMin = parsePositiveInt(env.PM_CIRCUIT_BREAKER_PROBE_AGE_MIN, DEFAULT_COOLDOWN_MIN);
  const maxProbesPerTick = parsePositiveInt(
    env.PM_CIRCUIT_BREAKER_MAX_PROBES_PER_TICK,
    DEFAULT_MAX_PROBES_PER_TICK,
  );
  return {
    disabled,
    cooldownMs: cooldownMin * 60 * 1000,
    maxProbesPerTick,
  };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `cd packages/core && npx vitest run src/__tests__/circuit-breaker-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pm/actions/circuit-breaker-config.ts packages/core/src/__tests__/circuit-breaker-config.test.ts
git commit -m "$(cat <<'EOF'
feat(BEC-236): env-var config helper for circuit-breaker probe

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `selectProbeCandidates` action (the heart of auto-probe)

**Files:**
- Create: `packages/core/src/pm/actions/select-probe-candidates.ts`
- Create: `packages/core/src/__tests__/circuit-breaker-probe.test.ts`

- [ ] **Step 1: Write the failing tests**

Use the existing in-memory test DB helper (look at `packages/core/src/__tests__/pm-promote.test.ts` or similar — they construct a real Drizzle SQLite DB via `createDb({ databaseUrl: ":memory:" })`):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type AnyDb } from "../db/client.js";
import { pipelineRuns, circuitBreakerState } from "../db/schema.js";
import { selectProbeCandidates } from "../pm/actions/select-probe-candidates.js";

async function seedFailedRuns(db: AnyDb, issueId: string, count: number, startMs: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db.insert(pipelineRuns).values({
      id: `${issueId}-run-${i}`,
      issueId,
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "failed",
      startedAt: new Date(startMs + i * 1000),
    });
  }
}

async function seedState(db: AnyDb, issueId: string, lastProbeAt: number | null, probeAttempts = 0): Promise<void> {
  await db.insert(circuitBreakerState).values({
    issueId,
    escalatedAt: new Date(1_000_000_000_000),
    lastProbeAt: lastProbeAt === null ? null : new Date(lastProbeAt),
    probeAttempts,
  });
}

describe("selectProbeCandidates", () => {
  let db: AnyDb;
  beforeEach(async () => {
    db = await createDb({ databaseUrl: ":memory:" });
  });

  it("returns empty Set when no state rows exist", async () => {
    const set = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 60_000,
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
    });
    expect(set.size).toBe(0);
  });

  it("returns issues with null last_probe_at (never probed)", async () => {
    await seedFailedRuns(db, "BEC-1", 3, 1_999_000_000_000);
    await seedState(db, "BEC-1", null);
    const set = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 60_000,
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
    });
    expect([...set]).toEqual(["BEC-1"]);
  });

  it("respects cooldown — recently-probed issues are skipped", async () => {
    await seedFailedRuns(db, "BEC-1", 3, 1_999_000_000_000);
    await seedState(db, "BEC-1", 1_999_999_900_000); // 100s ago
    const set = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 200_000, // 200s cooldown — not yet elapsed
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
    });
    expect(set.size).toBe(0);
  });

  it("returns at most `cap` candidates, oldest last_probe_at first", async () => {
    await seedFailedRuns(db, "BEC-1", 3, 1_999_000_000_000);
    await seedFailedRuns(db, "BEC-2", 3, 1_999_000_000_000);
    await seedFailedRuns(db, "BEC-3", 3, 1_999_000_000_000);
    await seedState(db, "BEC-1", 1_999_000_000_000); // oldest
    await seedState(db, "BEC-2", 1_999_500_000_000);
    await seedState(db, "BEC-3", 1_999_800_000_000); // newest
    const set = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 60_000,
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
    });
    expect([...set].sort()).toEqual(["BEC-1", "BEC-2"]);
  });

  it("skips issues whose failure count has dropped below the threshold", async () => {
    // Issue has a state row but its most recent run completed → count is 0
    await seedFailedRuns(db, "BEC-1", 2, 1_999_000_000_000);
    await db.insert(pipelineRuns).values({
      id: "BEC-1-recovered",
      issueId: "BEC-1",
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "completed",
      startedAt: new Date(1_999_999_999_999),
    });
    await seedState(db, "BEC-1", null);
    const set = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 60_000,
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
    });
    expect(set.size).toBe(0);
  });

  it("updates last_probe_at and probe_attempts for returned issues", async () => {
    await seedFailedRuns(db, "BEC-1", 3, 1_999_000_000_000);
    await seedState(db, "BEC-1", null, 0);
    await selectProbeCandidates(db, {
      cap: 1,
      cooldownMs: 60_000,
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
    });
    const row = (await db.select().from(circuitBreakerState))[0] as any;
    expect(row.probeAttempts).toBe(1);
    expect(new Date(row.lastProbeAt).getTime()).toBe(2_000_000_000_000);
  });

  it("returns empty Set when config.disabled is true (escape hatch)", async () => {
    await seedFailedRuns(db, "BEC-1", 3, 1_999_000_000_000);
    await seedState(db, "BEC-1", null);
    const set = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 60_000,
      maxConsecutiveFailures: 3,
      now: 2_000_000_000_000,
      disabled: true,
    });
    expect(set.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd packages/core && npx vitest run src/__tests__/circuit-breaker-probe.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `packages/core/src/pm/actions/select-probe-candidates.ts`**

```ts
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { circuitBreakerState } from "../../db/schema.js";
import type { AnyDb } from "../../db/client.js";
import { batchCountConsecutiveFailures } from "./db-queries.js";
import { createLogger } from "../../logger.js";
import { logAuditEventUnchecked } from "../../audit/writer.js";
import { pmCircuitBreakerProbeEvent } from "../../audit/events.js";

const log = createLogger({ component: "PmAgent:probe" });

export interface SelectProbeCandidatesOptions {
  cap: number;
  cooldownMs: number;
  maxConsecutiveFailures: number;
  now: number;
  /** Escape hatch from `getCircuitBreakerProbeConfig().disabled`. */
  disabled?: boolean;
}

/**
 * BEC-236 — pick at most `cap` circuit-broken issues whose cooldown
 * window has elapsed, mark them probed (`last_probe_at = now`,
 * `probe_attempts += 1`), and emit one `pm.circuit_breaker_probe` audit
 * event per. Returns the issue IDs the caller should bypass the breaker
 * skip for in this tick.
 *
 * Round-robin: candidates are ordered by oldest `last_probe_at` first
 * (NULLs first) so no issue starves.
 */
export async function selectProbeCandidates(
  db: AnyDb,
  opts: SelectProbeCandidatesOptions,
): Promise<Set<string>> {
  if (opts.disabled) return new Set();

  // Pull all eligible rows: cooldown elapsed OR never probed.
  const cooldownCutoff = new Date(opts.now - opts.cooldownMs);
  const rows = (await db
    .select({
      issueId: circuitBreakerState.issueId,
      lastProbeAt: circuitBreakerState.lastProbeAt,
      probeAttempts: circuitBreakerState.probeAttempts,
    })
    .from(circuitBreakerState)
    .where(
      sql`${circuitBreakerState.lastProbeAt} IS NULL OR ${circuitBreakerState.lastProbeAt} <= ${cooldownCutoff}`,
    )
    .orderBy(
      // NULLs first (never probed → most eligible), then oldest-first.
      sql`CASE WHEN ${circuitBreakerState.lastProbeAt} IS NULL THEN 0 ELSE 1 END`,
      asc(circuitBreakerState.lastProbeAt),
    )) as Array<{ issueId: string; lastProbeAt: Date | null; probeAttempts: number }>;

  if (rows.length === 0) return new Set();

  // Filter out issues whose failure count has dropped (a `completed` run landed).
  const failureCounts = await batchCountConsecutiveFailures(db, rows.map((r) => r.issueId));
  const eligible = rows.filter(
    (r) => (failureCounts.get(r.issueId) ?? 0) >= opts.maxConsecutiveFailures,
  );

  const picked = eligible.slice(0, opts.cap);
  if (picked.length === 0) return new Set();

  const pickedIds = picked.map((r) => r.issueId);

  // Atomically bump last_probe_at + probe_attempts for the picked set.
  await db
    .update(circuitBreakerState)
    .set({
      lastProbeAt: new Date(opts.now),
      probeAttempts: sql`${circuitBreakerState.probeAttempts} + 1`,
    })
    .where(inArray(circuitBreakerState.issueId, pickedIds));

  // Emit one audit event per probe. Best-effort — failures don't block the tick.
  for (const r of picked) {
    const lastFailureAgeMin = r.lastProbeAt
      ? Math.floor((opts.now - r.lastProbeAt.getTime()) / 60_000)
      : 0;
    try {
      await logAuditEventUnchecked(
        db,
        pmCircuitBreakerProbeEvent({
          issueId: r.issueId,
          consecutiveFailures: failureCounts.get(r.issueId) ?? 0,
          lastFailureAgeMin,
          probeAttempts: r.probeAttempts + 1,
        }),
      );
    } catch (err) {
      log.warn({ err, issueId: r.issueId }, "failed to log circuit-breaker probe audit event");
    }
  }

  return new Set(pickedIds);
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd packages/core && npx vitest run src/__tests__/circuit-breaker-probe.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pm/actions/select-probe-candidates.ts packages/core/src/__tests__/circuit-breaker-probe.test.ts
git commit -m "$(cat <<'EOF'
feat(BEC-236): selectProbeCandidates action

Picks cooldown-eligible Tier-5-escalated issues, marks them probed, and
returns the Set the caller bypasses the breaker for.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Thread `probeOverrideIds` through promote + start-todo

**Files:**
- Modify: `packages/core/src/pm/actions/promote.ts` (around lines 178-203 — the breaker-skip block)
- Modify: `packages/core/src/pm/actions/start-todo.ts` (around lines 140-162 — the breaker-skip block)

- [ ] **Step 1: Write the failing test (extend promote tests)**

Open `packages/core/src/__tests__/pm-promote.test.ts` and add at the end of the file:

```ts
describe("promoteReadyIssues — probeOverrideIds (BEC-236)", () => {
  it("bypasses the breaker skip for issues in probeOverrideIds", async () => {
    // Build a candidate that would normally be skipped (failureCount >= threshold)
    // but is in the probeOverrideIds Set. It should be promoted instead.
    //
    // Use the existing test harness: mock linearClient, set
    // maxConsecutiveFailures: 3, provide getFailureCount that returns 3 for
    // the candidate, pass probeOverrideIds: new Set(["BEC-PROBE"]), assert
    // the candidate appears in the returned promotions array AND the
    // skipped-circuit-breaker audit event was NOT emitted.
    //
    // (Match the style of the existing breaker-skip tests already in this
    // file. Copy their setup verbatim; only flip the probeOverrideIds
    // parameter and assert the inverse outcome.)
  });
});
```

Replace the placeholder body above with the actual test — find the existing breaker-skip test in this file (search for `circuit-breaker engaged` or `maxConsecutiveFailures`), duplicate it, change the expected behavior to "promoted instead of skipped" when `probeOverrideIds` is set.

- [ ] **Step 2: Add `probeOverrideIds?: Set<string>` to `PromoteInput`**

In `packages/core/src/pm/actions/promote.ts`, add to the existing `PromoteInput` interface (search for `maxConsecutiveFailures?: number;` and add immediately after):

```ts
  /**
   * BEC-236 — issue IDs the half-open probe selected this tick. Issues in
   * this Set bypass the consecutive-failures circuit-breaker skip, allowing
   * exactly one probe run per cooldown window. When undefined, breaker
   * behavior is unchanged from BEC-161/181.
   */
  probeOverrideIds?: Set<string>;
```

- [ ] **Step 3: Modify the breaker-skip block in `promoteReadyIssues`**

Around line 182 in `packages/core/src/pm/actions/promote.ts`, find:

```ts
      if (failureCount >= input.maxConsecutiveFailures) {
```

Change to:

```ts
      if (
        failureCount >= input.maxConsecutiveFailures &&
        !input.probeOverrideIds?.has(candidate.identifier)
      ) {
```

(Keep the existing skip body — including the `pm.skipped_circuit_breaker` event emission and the Tier-5 escalation — unchanged. The probe override only changes the gate; it does NOT suppress events for skipped issues.)

- [ ] **Step 4: Repeat the same change in `start-todo.ts`**

Around line 144 in `packages/core/src/pm/actions/start-todo.ts`, find:

```ts
      if (failureCount >= input.maxConsecutiveFailures) {
```

Change to:

```ts
      if (
        failureCount >= input.maxConsecutiveFailures &&
        !input.probeOverrideIds?.has(issue.identifier)
      ) {
```

Also add `probeOverrideIds?: Set<string>` to `StartTodoInput` with the same JSDoc as in Task 6 Step 2.

- [ ] **Step 5: Run promote + start-todo tests**

Run: `cd packages/core && npx vitest run src/__tests__/pm-promote.test.ts src/__tests__/start-todo.test.ts 2>&1 | tail -15`
Expected: PASS (the new test from Step 1 passes; existing tests still pass — backward compatible because `probeOverrideIds` is optional and the absence behaves identically to before)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pm/actions/promote.ts packages/core/src/pm/actions/start-todo.ts packages/core/src/__tests__/pm-promote.test.ts
git commit -m "$(cat <<'EOF'
feat(BEC-236): probeOverrideIds bypasses breaker skip in promote/startTodo

Optional Set<issueId> parameter. When an issue is both circuit-broken
and in the Set, the skip is bypassed, allowing the half-open probe to
fire exactly one run per cooldown window.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Tier-5 escalation inserts the state row

**Files:**
- Modify: `packages/core/src/pm/actions/promote.ts` (the Tier-5 escalation block, around lines 200-330)

- [ ] **Step 1: Find the Tier-5 escalation block**

In `packages/core/src/pm/actions/promote.ts`, locate the block where Tier-5 adds the `needs-design` label and emits `pmEscalatedToNeedsDesignEvent`. Look near line 260 (where `linearClient.updateIssue(candidate.id, { labelIds: merged })` is called) and the audit event emission shortly after.

- [ ] **Step 2: Add an idempotent state-row insert**

Immediately BEFORE the `pmEscalatedToNeedsDesignEvent` emission (whichever line that is — search for `pmEscalatedToNeedsDesign`), add:

```ts
// BEC-236 — record the Tier-5 escalation so the half-open probe can
// distinguish our auto-added needs-design from a human's. Idempotent on
// issue_id PK so re-escalations of the same issue don't double-insert.
if (input.db) {
  await (input.db as any)
    .insert(circuitBreakerState)
    .values({ issueId: candidate.identifier, escalatedAt: new Date() })
    .onConflictDoNothing();
}
```

Add the import at the top of the file:

```ts
import { circuitBreakerState } from "../../db/schema.js";
```

- [ ] **Step 3: Add a test for the insert**

Append to `packages/core/src/__tests__/pm-promote.test.ts`:

```ts
it("inserts a circuit_breaker_state row when Tier-5 escalates (BEC-236)", async () => {
  // Use the existing escalation-test setup: maxConsecutiveFailures=3,
  // failureCount=3, issue without needs-design label, real in-memory db.
  // After promoteReadyIssues runs, assert exactly one row exists in
  // circuit_breaker_state for the escalated issue.
  //
  // Reuse the same harness shape as the existing escalation test in this
  // file. Add a final assertion that queries `circuit_breaker_state` and
  // verifies the row.
});
```

Replace the placeholder body with the concrete code, copied from the existing escalation test in the same file.

- [ ] **Step 4: Run tests**

Run: `cd packages/core && npx vitest run src/__tests__/pm-promote.test.ts 2>&1 | tail -10`
Expected: PASS (new test plus all existing)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pm/actions/promote.ts packages/core/src/__tests__/pm-promote.test.ts
git commit -m "$(cat <<'EOF'
feat(BEC-236): Tier-5 escalation inserts circuit_breaker_state row

Idempotent insert via onConflictDoNothing on issue_id PK. The row is
the marker that distinguishes our auto-added needs-design label from
human/triage-added needs-design.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `recoverCircuitBreaker` action

**Files:**
- Create: `packages/core/src/pm/actions/recover-circuit-breaker.ts`
- Create: `packages/core/src/__tests__/circuit-breaker-recover.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDb, type AnyDb } from "../db/client.js";
import { circuitBreakerState } from "../db/schema.js";
import { recoverCircuitBreaker } from "../pm/actions/recover-circuit-breaker.js";

function fakeLinearClient(currentLabels: string[]) {
  return {
    issue: vi.fn().mockResolvedValue({
      id: "issue-id",
      labels: vi.fn().mockResolvedValue({ nodes: currentLabels.map((name, i) => ({ id: `lbl-${i}`, name })) }),
    }),
    updateIssue: vi.fn().mockResolvedValue({}),
  };
}

describe("recoverCircuitBreaker", () => {
  let db: AnyDb;
  beforeEach(async () => {
    db = await createDb({ databaseUrl: ":memory:" });
  });

  it("no-ops when no state row exists (human-added needs-design preserved)", async () => {
    const client = fakeLinearClient(["needs-design"]);
    await recoverCircuitBreaker({ db, issueId: "BEC-1", linearClient: client as any });
    expect(client.updateIssue).not.toHaveBeenCalled();
  });

  it("deletes the state row and removes needs-design label when row exists", async () => {
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(),
      probeAttempts: 1,
    });
    const client = fakeLinearClient(["bug", "needs-design"]);
    await recoverCircuitBreaker({ db, issueId: "BEC-1", linearClient: client as any });

    const rows = await db.select().from(circuitBreakerState);
    expect(rows).toHaveLength(0);
    expect(client.updateIssue).toHaveBeenCalledOnce();
    const [, payload] = client.updateIssue.mock.calls[0];
    expect(payload.labelIds).toEqual(["lbl-0"]); // only "bug" survives, needs-design dropped
  });

  it("is idempotent on re-invocation", async () => {
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(),
      probeAttempts: 1,
    });
    const client = fakeLinearClient(["needs-design"]);
    await recoverCircuitBreaker({ db, issueId: "BEC-1", linearClient: client as any });
    await recoverCircuitBreaker({ db, issueId: "BEC-1", linearClient: client as any });
    expect(client.updateIssue).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd packages/core && npx vitest run src/__tests__/circuit-breaker-recover.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `packages/core/src/pm/actions/recover-circuit-breaker.ts`**

```ts
import { eq } from "drizzle-orm";
import type { LinearClient } from "@linear/sdk";
import { circuitBreakerState } from "../../db/schema.js";
import type { AnyDb } from "../../db/client.js";
import { createLogger } from "../../logger.js";
import { logAuditEventUnchecked } from "../../audit/writer.js";
import { pmCircuitBreakerRecoveredEvent } from "../../audit/events.js";

const log = createLogger({ component: "PmAgent:recover-breaker" });

export interface RecoverCircuitBreakerInput {
  db: AnyDb;
  issueId: string;
  /** Linear issue identifier (e.g. "BEC-1") — same value passed everywhere else. */
  linearClient: LinearClient | { issue: (id: string) => any; updateIssue: (id: string, payload: any) => any };
}

/**
 * BEC-236 — invoked when a pipeline run reaches terminal `completed`
 * status. If the issue has a circuit_breaker_state row (i.e. we
 * Tier-5-escalated it earlier), drop the row and strip the
 * `needs-design` label. Idempotent and safe to call for any completed
 * run — early-returns when no state row exists, so human-added
 * needs-design labels are preserved.
 */
export async function recoverCircuitBreaker(input: RecoverCircuitBreakerInput): Promise<void> {
  const { db, issueId, linearClient } = input;

  const rows = (await db
    .select({ probeAttempts: circuitBreakerState.probeAttempts })
    .from(circuitBreakerState)
    .where(eq(circuitBreakerState.issueId, issueId))) as Array<{ probeAttempts: number }>;
  if (rows.length === 0) return; // not our escalation, leave label alone

  const probeAttempts = rows[0].probeAttempts;

  // Delete the state row first — if label removal fails, the next run will
  // re-attempt the label removal but the breaker state is already cleared.
  await db.delete(circuitBreakerState).where(eq(circuitBreakerState.issueId, issueId));

  try {
    const issue = await (linearClient as any).issue(issueId);
    const labelConn = await issue.labels();
    const surviving = labelConn.nodes
      .filter((l: { name: string }) => l.name.toLowerCase() !== "needs-design")
      .map((l: { id: string }) => l.id);
    await (linearClient as any).updateIssue(issue.id, { labelIds: surviving });
  } catch (err) {
    log.warn({ err, issueId }, "recoverCircuitBreaker: failed to remove needs-design label");
  }

  try {
    await logAuditEventUnchecked(
      db,
      pmCircuitBreakerRecoveredEvent({ issueId, probeAttempts }),
    );
  } catch (err) {
    log.warn({ err, issueId }, "recoverCircuitBreaker: failed to log audit event");
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd packages/core && npx vitest run src/__tests__/circuit-breaker-recover.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pm/actions/recover-circuit-breaker.ts packages/core/src/__tests__/circuit-breaker-recover.test.ts
git commit -m "$(cat <<'EOF'
feat(BEC-236): recoverCircuitBreaker action

Idempotent; runs in runner completion path. No-op when no state row
exists, so human-added needs-design labels are preserved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Wire `selectProbeCandidates` and `recoverCircuitBreaker` into the PM tick + runner

**Files:**
- Modify: `packages/core/src/pm/scheduler.ts` (the tick body, around line 340-411)
- Modify: `packages/core/src/pipeline/runner.ts` (the completion path, around line 2943)

- [ ] **Step 1: Add the probe step to the PM tick**

In `packages/core/src/pm/scheduler.ts`, locate the tick body (search for the `startTodoIssues` call around line 342). Immediately BEFORE the `startTodoIssues` invocation, add:

```ts
// BEC-236 — half-open circuit-breaker probe. Selects at most `cap` issues
// per tick that the breaker would normally skip; promote + startTodo
// receive this Set as probeOverrideIds and bypass the skip for them.
const probeConfig = getCircuitBreakerProbeConfig();
let probeOverrideIds: Set<string> = new Set();
if (db && !probeConfig.disabled) {
  try {
    probeOverrideIds = await selectProbeCandidates(db, {
      cap: probeConfig.maxProbesPerTick,
      cooldownMs: probeConfig.cooldownMs,
      maxConsecutiveFailures: maxConsecutiveFailures ?? 3,
      now: Date.now(),
    });
  } catch (err) {
    captureTickError(tick, "probe", err, "selectProbeCandidates failed");
  }
}
```

Add the imports at the top of `scheduler.ts`:

```ts
import { getCircuitBreakerProbeConfig } from "./actions/circuit-breaker-config.js";
import { selectProbeCandidates } from "./actions/select-probe-candidates.js";
```

Then thread `probeOverrideIds` into BOTH the `startTodoIssues` and `promoteReadyIssues` calls. Find each `startTodoIssues({ ... })` and `promoteReadyIssues({ ... })` call and add `probeOverrideIds,` as a new property to the input object.

- [ ] **Step 2: Add the recovery hook to runner**

In `packages/core/src/pipeline/runner.ts`, find line 2943 (`run.status = "completed";`). Immediately after that line, add:

```ts
// BEC-236 — clear circuit-breaker state if this run was a Tier-5
// escalation that's now recovering. No-op when no state row exists.
try {
  if (deps.db) {
    await recoverCircuitBreaker({
      db: deps.db,
      issueId: run.issueId,
      linearClient: deps.linearClient,
    });
  }
} catch (err) {
  log.warn({ err, runId: run.id, issueId: run.issueId }, "recoverCircuitBreaker hook failed");
}
```

Add the import:

```ts
import { recoverCircuitBreaker } from "../pm/actions/recover-circuit-breaker.js";
```

- [ ] **Step 3: Run the full PM + runner test suite**

Run: `cd packages/core && npx vitest run src/__tests__/pm-scheduler.test.ts src/__tests__/pipeline-runner.test.ts 2>&1 | tail -10`
Expected: PASS (existing tests still pass; integration is exercised in Task 13)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/pm/scheduler.ts packages/core/src/pipeline/runner.ts
git commit -m "$(cat <<'EOF'
feat(BEC-236): wire probe selection into PM tick, recovery into runner

selectProbeCandidates runs before startTodoIssues/promoteReadyIssues so
both gates see the same probe Set this tick. recoverCircuitBreaker
runs in the runner's completion path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: CLI — `ura circuit` command scaffolding + `list` subcommand

**Files:**
- Create: `packages/cli/src/commands/circuit.ts`
- Modify: `packages/cli/src/index.ts` (or wherever the top-level `Command` instance registers subcommands — find the existing `program.addCommand(adminCommand)` or similar pattern)
- Create: `packages/cli/src/__tests__/circuit.test.ts`

- [ ] **Step 1: Write the failing test for `list`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDb, type AnyDb } from "@urateam/core";
import { pipelineRuns, circuitBreakerState } from "@urateam/core";
// If the schema isn't re-exported, import directly: from "@urateam/core/dist/db/schema.js"
import { runCircuitList } from "../commands/circuit.js";

describe("ura circuit list", () => {
  let db: AnyDb;
  let logs: string[];
  let log: (msg: string) => void;
  beforeEach(async () => {
    db = await createDb({ databaseUrl: ":memory:" });
    logs = [];
    log = (m) => logs.push(m);
  });

  it("prints a header when no issues are circuit-broken", async () => {
    await runCircuitList({ db, log, maxConsecutiveFailures: 3 });
    expect(logs.some((l) => l.includes("No circuit-broken issues"))).toBe(true);
  });

  it("lists issues with ≥ threshold failures and joins to state when present", async () => {
    for (let i = 0; i < 3; i++) {
      await db.insert(pipelineRuns).values({
        id: `BEC-1-r${i}`,
        issueId: "BEC-1",
        issueTitle: "test",
        pipelineKey: "auto-implement",
        repoUrl: "https://example.com/r.git",
        status: "failed",
        startedAt: new Date(1_000_000_000 + i * 1000),
      });
    }
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(1_000_000_000),
      probeAttempts: 1,
    });

    await runCircuitList({ db, log, maxConsecutiveFailures: 3 });
    const out = logs.join("\n");
    expect(out).toContain("BEC-1");
    expect(out).toContain("3"); // failures
    expect(out).toContain("1"); // probeAttempts
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `cd packages/cli && npx vitest run src/__tests__/circuit.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `packages/cli/src/commands/circuit.ts` (list only — reset comes next)**

```ts
import { Command } from "commander";
import {
  createDb,
  type AnyDb,
  circuitBreakerState,
  batchCountConsecutiveFailures,
} from "@urateam/core";
// If those named exports don't exist on the package barrel, import from
// the dist subpaths used elsewhere in this CLI package (admin.ts is the
// reference — it imports createDb / listUsers from "@urateam/core"). Add
// barrel exports as needed.

export interface CircuitDeps {
  db: AnyDb;
  log: (msg: string) => void;
  maxConsecutiveFailures: number;
}

export async function runCircuitList(deps: CircuitDeps): Promise<void> {
  const allIssueIds = (
    (await deps.db
      .selectDistinct({ issueId: (await import("@urateam/core")).pipelineRuns.issueId })
      .from((await import("@urateam/core")).pipelineRuns)) as Array<{ issueId: string }>
  ).map((r) => r.issueId);

  const failureCounts = await batchCountConsecutiveFailures(deps.db, allIssueIds);
  const broken = allIssueIds
    .filter((id) => (failureCounts.get(id) ?? 0) >= deps.maxConsecutiveFailures)
    .map((id) => ({ id, failures: failureCounts.get(id) ?? 0 }));

  if (broken.length === 0) {
    deps.log("No circuit-broken issues.");
    return;
  }

  const stateRows = (await deps.db.select().from(circuitBreakerState)) as Array<{
    issueId: string;
    escalatedAt: Date;
    lastProbeAt: Date | null;
    probeAttempts: number;
  }>;
  const stateById = new Map(stateRows.map((s) => [s.issueId, s]));

  deps.log("ISSUE              FAILURES  ESCALATED            LAST_PROBE           ATTEMPTS");
  for (const b of broken.sort((a, b) => a.id.localeCompare(b.id))) {
    const s = stateById.get(b.id);
    const escalated = s ? s.escalatedAt.toISOString() : "(no state row)";
    const lastProbe = s?.lastProbeAt ? s.lastProbeAt.toISOString() : "-";
    const attempts = s ? String(s.probeAttempts) : "-";
    deps.log(
      `${b.id.padEnd(18)} ${String(b.failures).padEnd(9)} ${escalated.padEnd(20)} ${lastProbe.padEnd(20)} ${attempts}`,
    );
  }
}

export const circuitCommand = new Command("circuit")
  .description("Inspect and reset the PM consecutive-failures circuit breaker.");

circuitCommand
  .command("list")
  .description("Show issues currently circuit-broken (≥ maxConsecutiveFailures consecutive failed runs).")
  .action(async () => {
    const db = await createDb({ databaseUrl: process.env.DATABASE_URL ?? "./urateam.db" });
    const max = Number.parseInt(process.env.PM_MAX_CONSECUTIVE_FAILURES ?? "3", 10);
    await runCircuitList({ db, log: console.log, maxConsecutiveFailures: max });
  });
```

(Adapt imports to match what `packages/core` actually exports — if `batchCountConsecutiveFailures` / `circuitBreakerState` / `pipelineRuns` aren't on the barrel, add them to `packages/core/src/index.ts`.)

- [ ] **Step 4: Register the command**

In `packages/cli/src/index.ts` (or wherever `adminCommand` is registered — search for `adminCommand`), add the import and `program.addCommand(circuitCommand)` line right next to it.

- [ ] **Step 5: Run tests**

Run: `cd packages/cli && npx vitest run src/__tests__/circuit.test.ts && cd ../.. && pnpm -w typecheck 2>&1 | tail -5`
Expected: PASS, typecheck clean

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/circuit.ts packages/cli/src/__tests__/circuit.test.ts packages/cli/src/index.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(BEC-236): ura circuit list subcommand

Read-only view of currently-circuit-broken issues, joined to
circuit_breaker_state when present.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: CLI — `ura circuit reset <ID>` (single-issue)

**Files:**
- Modify: `packages/cli/src/commands/circuit.ts`
- Modify: `packages/cli/src/__tests__/circuit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/src/__tests__/circuit.test.ts`:

```ts
import { runCircuitReset } from "../commands/circuit.js";

describe("ura circuit reset <id>", () => {
  let db: AnyDb;
  let logs: string[];
  let log: (msg: string) => void;
  beforeEach(async () => {
    db = await createDb({ databaseUrl: ":memory:" });
    logs = [];
    log = (m) => logs.push(m);
  });

  it("deletes failed pipeline_runs + stage_runs + agent_logs + state row + label", async () => {
    // seed: 3 failed runs + 1 stage_run per + 1 agent_log per + state row + Linear has the label
    for (let i = 0; i < 3; i++) {
      await db.insert(pipelineRuns).values({
        id: `BEC-1-r${i}`,
        issueId: "BEC-1",
        issueTitle: "test",
        pipelineKey: "auto-implement",
        repoUrl: "https://example.com/r.git",
        status: "failed",
        startedAt: new Date(1_000_000_000 + i * 1000),
      });
    }
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(),
      probeAttempts: 0,
    });
    const linearClient = {
      issue: vi.fn().mockResolvedValue({
        id: "BEC-1-uuid",
        labels: vi.fn().mockResolvedValue({ nodes: [{ id: "lbl-bug", name: "bug" }, { id: "lbl-nd", name: "needs-design" }] }),
      }),
      updateIssue: vi.fn().mockResolvedValue({}),
    };

    const result = await runCircuitReset({ db, log, issueId: "BEC-1", linearClient: linearClient as any });
    expect(result.failedRunsDeleted).toBe(3);

    const remaining = await db.select().from(pipelineRuns);
    expect(remaining).toHaveLength(0);
    const stateRows = await db.select().from(circuitBreakerState);
    expect(stateRows).toHaveLength(0);
    expect(linearClient.updateIssue).toHaveBeenCalledOnce();
  });

  it("does NOT delete `completed` runs (only failed)", async () => {
    await db.insert(pipelineRuns).values({
      id: "BEC-1-ok",
      issueId: "BEC-1",
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "completed",
      startedAt: new Date(),
    });
    await db.insert(pipelineRuns).values({
      id: "BEC-1-bad",
      issueId: "BEC-1",
      issueTitle: "test",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/r.git",
      status: "failed",
      startedAt: new Date(),
    });
    const linearClient = {
      issue: vi.fn().mockResolvedValue({ id: "BEC-1-uuid", labels: vi.fn().mockResolvedValue({ nodes: [] }) }),
      updateIssue: vi.fn().mockResolvedValue({}),
    };
    const result = await runCircuitReset({ db, log, issueId: "BEC-1", linearClient: linearClient as any });
    expect(result.failedRunsDeleted).toBe(1);
    const remaining = await db.select().from(pipelineRuns);
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as any).id).toBe("BEC-1-ok");
  });
});
```

- [ ] **Step 2: Run test — expect failure (function missing)**

Run: `cd packages/cli && npx vitest run src/__tests__/circuit.test.ts`
Expected: FAIL on the new tests

- [ ] **Step 3: Implement `runCircuitReset` in `packages/cli/src/commands/circuit.ts`**

Add to the same file as `runCircuitList`:

```ts
export interface CircuitResetDeps {
  db: AnyDb;
  log: (msg: string) => void;
  issueId: string;
  linearClient: any; // LinearClient | minimal mock
  scope?: "single" | "bulk";
}

export interface CircuitResetResult {
  issueId: string;
  failedRunsDeleted: number;
}

export async function runCircuitReset(deps: CircuitResetDeps): Promise<CircuitResetResult> {
  const { db, issueId, linearClient } = deps;
  const scope = deps.scope ?? "single";

  // Find the failed runs (and their stage_runs / agent_logs cascade) inside a
  // transaction so a partial failure doesn't leave a half-deleted issue.
  const failedRunIds = (
    await db
      .select({ id: (await import("@urateam/core")).pipelineRuns.id })
      .from((await import("@urateam/core")).pipelineRuns)
      .where(/* ... eq(issueId, ...) AND eq(status, "failed") ... */ undefined as any)
  ) as Array<{ id: string }>;
  // [Implementer: build the where clause with drizzle `and(eq(pipelineRuns.issueId, issueId), eq(pipelineRuns.status, "failed"))`.]

  // Transaction: agent_logs → stage_runs → pipeline_runs → circuit_breaker_state.
  // Use db.transaction(async (tx) => { ... }) — see existing tx usage in
  // packages/core/src/rbac/users.ts:setUserRole for the pattern.
  let deleted = 0;
  await (db as any).transaction(async (tx: any) => {
    if (failedRunIds.length > 0) {
      const ids = failedRunIds.map((r) => r.id);
      // delete agent_logs where stage_run_id in (stage_runs where pipeline_run_id in ids)
      // delete stage_runs where pipeline_run_id in ids
      // delete pipeline_runs where id in ids
      // [Implementer: use drizzle delete().where(inArray(...)).
      //  Reference pm/actions/db-queries.ts for the inArray import.]
      deleted = ids.length;
    }
    await tx.delete(circuitBreakerState).where(/* eq(issueId, ...) */ undefined as any);
  });

  // Remove needs-design label IFF a state row was present. Out of transaction
  // because Linear is an external call — failure shouldn't roll back DB.
  // [Implementer: gate this on whether the state row existed BEFORE delete.
  //  Simplest: fetch state row first, then delete; only call Linear if row.]

  // Emit audit event
  await logAuditEventUnchecked(
    db,
    pmCircuitBreakerResetManualEvent({ issueId, scope, failedRunsDeleted: deleted }),
  );

  deps.log(`circuit reset: ${issueId} — deleted ${deleted} failed pipeline_runs row(s)`);
  return { issueId, failedRunsDeleted: deleted };
}
```

The above pseudocode is a SKELETON. The implementing engineer must fill in:
- The actual drizzle `where` clauses (matching the patterns in `pm/actions/db-queries.ts:160`).
- The transaction body for the three cascading deletes (`agent_logs`, `stage_runs`, `pipeline_runs`).
- The fetch-state-row-before-delete-then-conditionally-strip-label flow (mirroring `recoverCircuitBreaker` from Task 8).

Wire it into commander:

```ts
circuitCommand
  .command("reset")
  .description("Clear the breaker for an issue or all currently-broken issues.")
  .argument("[issueId]", "Issue ID (e.g. BEC-1). Omit when using --all.")
  .option("--all", "Reset every currently-broken issue. Requires --yes.")
  .option("--yes", "Skip the bulk confirmation prompt.")
  .action(async (issueId: string | undefined, opts: { all?: boolean; yes?: boolean }) => {
    const db = await createDb({ databaseUrl: process.env.DATABASE_URL ?? "./urateam.db" });
    const linearClient = makeLinearClient(); // [Implementer: factor out from existing CLI commands]

    if (opts.all) {
      // delegate to runCircuitResetAll (Task 12)
    } else if (issueId) {
      await runCircuitReset({ db, log: console.log, issueId, linearClient });
    } else {
      console.error("ura circuit reset: pass an issue ID or --all");
      process.exit(1);
    }
  });
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd packages/cli && npx vitest run src/__tests__/circuit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/circuit.ts packages/cli/src/__tests__/circuit.test.ts
git commit -m "$(cat <<'EOF'
feat(BEC-236): ura circuit reset <id>

Single-issue reset: deletes failed pipeline_runs cascade, drops state
row, removes needs-design label (only when state row existed).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: CLI — `ura circuit reset --all` (bulk)

**Files:**
- Modify: `packages/cli/src/commands/circuit.ts`
- Modify: `packages/cli/src/__tests__/circuit.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/__tests__/circuit.test.ts`:

```ts
import { runCircuitResetAll } from "../commands/circuit.js";

describe("ura circuit reset --all", () => {
  let db: AnyDb;
  let logs: string[];
  let log: (msg: string) => void;
  beforeEach(async () => {
    db = await createDb({ databaseUrl: ":memory:" });
    logs = [];
    log = (m) => logs.push(m);
  });

  it("resets every currently-broken issue (state row presence not required)", async () => {
    // Seed two broken issues. Only one has a state row (mimics first-deploy bootstrap case).
    for (const id of ["BEC-1", "BEC-2"]) {
      for (let i = 0; i < 3; i++) {
        await db.insert(pipelineRuns).values({
          id: `${id}-r${i}`,
          issueId: id,
          issueTitle: "test",
          pipelineKey: "auto-implement",
          repoUrl: "https://example.com/r.git",
          status: "failed",
          startedAt: new Date(1_000_000_000 + i * 1000),
        });
      }
    }
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(),
      probeAttempts: 0,
    });
    const linearClient = {
      issue: vi.fn().mockResolvedValue({ id: "uuid", labels: vi.fn().mockResolvedValue({ nodes: [] }) }),
      updateIssue: vi.fn().mockResolvedValue({}),
    };

    const result = await runCircuitResetAll({ db, log, linearClient: linearClient as any, maxConsecutiveFailures: 3 });
    expect(result.cleared).toEqual(expect.arrayContaining(["BEC-1", "BEC-2"]));
    expect((await db.select().from(pipelineRuns)).length).toBe(0);
  });

  it("partial-failure mid-bulk leaves the rest consistent", async () => {
    // [Implementer: seed 3 broken issues. Make the Linear updateIssue throw
    //  for the second one. Assert: all three have their pipeline_runs +
    //  state rows deleted (per-issue tx isolation), the first and third
    //  successfully have the label stripped, the second is reported in the
    //  result's `failed` array with its error.]
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd packages/cli && npx vitest run src/__tests__/circuit.test.ts`
Expected: FAIL on the bulk tests

- [ ] **Step 3: Implement `runCircuitResetAll` in `packages/cli/src/commands/circuit.ts`**

```ts
export interface CircuitResetAllDeps {
  db: AnyDb;
  log: (msg: string) => void;
  linearClient: any;
  maxConsecutiveFailures: number;
}

export interface CircuitResetAllResult {
  cleared: string[];
  failed: Array<{ issueId: string; error: string }>;
}

export async function runCircuitResetAll(deps: CircuitResetAllDeps): Promise<CircuitResetAllResult> {
  const { db, log, linearClient, maxConsecutiveFailures } = deps;

  // Discover broken issues from the same source of truth the breaker uses.
  const { pipelineRuns: prTable, batchCountConsecutiveFailures: batchCount } =
    await import("@urateam/core");
  const allIssueIds = ((await db.selectDistinct({ issueId: prTable.issueId }).from(prTable)) as Array<{
    issueId: string;
  }>).map((r) => r.issueId);
  const counts = await batchCount(db, allIssueIds);
  const broken = allIssueIds.filter((id) => (counts.get(id) ?? 0) >= maxConsecutiveFailures);

  const cleared: string[] = [];
  const failed: Array<{ issueId: string; error: string }> = [];
  for (const id of broken) {
    try {
      await runCircuitReset({ db, log, issueId: id, linearClient, scope: "bulk" });
      cleared.push(id);
    } catch (err) {
      failed.push({ issueId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  log(`circuit reset --all: cleared ${cleared.length}, failed ${failed.length}`);
  return { cleared, failed };
}
```

Wire the `--all` branch in the commander action (Task 11 left a placeholder):

```ts
if (opts.all) {
  if (!opts.yes) {
    // Prompt for confirmation via readline. See packages/cli/src/commands/uninstall.ts
    // for the existing prompt pattern. If user doesn't confirm, exit.
  }
  await runCircuitResetAll({
    db,
    log: console.log,
    linearClient,
    maxConsecutiveFailures: Number.parseInt(process.env.PM_MAX_CONSECUTIVE_FAILURES ?? "3", 10),
  });
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd packages/cli && npx vitest run src/__tests__/circuit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/circuit.ts packages/cli/src/__tests__/circuit.test.ts
git commit -m "$(cat <<'EOF'
feat(BEC-236): ura circuit reset --all (bulk)

Discovers broken issues from batchCountConsecutiveFailures (works on
fresh deploy where circuit_breaker_state is empty). Each issue is its
own transaction so a partial failure mid-bulk leaves the rest
consistent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: End-to-end integration test

**Files:**
- Create: `packages/core/src/__tests__/circuit-breaker-integration.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDb, type AnyDb } from "../db/client.js";
import { pipelineRuns, circuitBreakerState } from "../db/schema.js";
import { selectProbeCandidates } from "../pm/actions/select-probe-candidates.js";
import { recoverCircuitBreaker } from "../pm/actions/recover-circuit-breaker.js";

describe("circuit-breaker recovery — end-to-end (BEC-236)", () => {
  let db: AnyDb;
  beforeEach(async () => {
    db = await createDb({ databaseUrl: ":memory:" });
  });

  it("drains a 5-issue frozen backlog at rate `cap` per tick across cooldowns", async () => {
    // Seed 5 escalated, circuit-broken issues
    for (let i = 1; i <= 5; i++) {
      const id = `BEC-${i}`;
      for (let r = 0; r < 3; r++) {
        await db.insert(pipelineRuns).values({
          id: `${id}-r${r}`,
          issueId: id,
          issueTitle: "test",
          pipelineKey: "auto-implement",
          repoUrl: "https://example.com/r.git",
          status: "failed",
          startedAt: new Date(1_000_000_000 + r * 1000),
        });
      }
      await db.insert(circuitBreakerState).values({
        issueId: id,
        escalatedAt: new Date(1_000_000_000),
        probeAttempts: 0,
      });
    }

    // Tick 1 (no prior probes): picks 2 oldest (BEC-1, BEC-2)
    const t1 = 2_000_000_000_000;
    const set1 = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 120 * 60 * 1000,
      maxConsecutiveFailures: 3,
      now: t1,
    });
    expect(set1.size).toBe(2);

    // Tick 2 immediately after (cooldown not elapsed): picks ONLY the 3
    // never-probed issues (BEC-3, BEC-4, BEC-5) → 2 of them
    const t2 = t1 + 1000;
    const set2 = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 120 * 60 * 1000,
      maxConsecutiveFailures: 3,
      now: t2,
    });
    expect(set2.size).toBe(2);
    // No overlap with tick 1
    for (const id of set2) expect(set1.has(id)).toBe(false);

    // Tick 3 (still in cooldown for the first 4, never-probed for BEC-5): 1
    const t3 = t2 + 1000;
    const set3 = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 120 * 60 * 1000,
      maxConsecutiveFailures: 3,
      now: t3,
    });
    expect(set3.size).toBe(1);

    // Tick 4 after cooldown: picks 2 oldest probes again
    const t4 = t1 + 120 * 60 * 1000 + 1;
    const set4 = await selectProbeCandidates(db, {
      cap: 2,
      cooldownMs: 120 * 60 * 1000,
      maxConsecutiveFailures: 3,
      now: t4,
    });
    expect(set4.size).toBe(2);
  });

  it("recovery removes the state row and the needs-design label", async () => {
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(),
      probeAttempts: 2,
    });
    const linearClient = {
      issue: vi.fn().mockResolvedValue({
        id: "uuid",
        labels: vi.fn().mockResolvedValue({
          nodes: [{ id: "lbl-bug", name: "bug" }, { id: "lbl-nd", name: "needs-design" }],
        }),
      }),
      updateIssue: vi.fn().mockResolvedValue({}),
    };
    await recoverCircuitBreaker({ db, issueId: "BEC-1", linearClient: linearClient as any });
    expect((await db.select().from(circuitBreakerState)).length).toBe(0);
    expect(linearClient.updateIssue).toHaveBeenCalledOnce();
    const [, payload] = linearClient.updateIssue.mock.calls[0];
    expect(payload.labelIds).toEqual(["lbl-bug"]);
  });
});
```

- [ ] **Step 2: Run the test — expect PASS**

Run: `cd packages/core && npx vitest run src/__tests__/circuit-breaker-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/__tests__/circuit-breaker-integration.test.ts
git commit -m "$(cat <<'EOF'
test(BEC-236): end-to-end integration test for circuit-breaker recovery

5-issue frozen-backlog draining across cooldowns + probe-success recovery.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Documentation — CLAUDE.md updates

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the audit-events canonical count**

Find the sentence `**Current count: 57 event types** — the Tier 1d test enforces this sentence stays in sync with AuditEventTypeSchema.options.length.` (in the Enterprise Features table, Audit-log row) and change `57` to `60`.

- [ ] **Step 2: Update the circuit-breaker section**

Find the section starting with `**Circuit breaker (BEC-161/181)**:` (under "Pause / circuit-breaker / escalation"). Immediately after the existing Tier 5 escalation paragraph, add:

```markdown
- **Half-open probe recovery (BEC-236)**: after Tier-5 escalates an issue, `selectProbeCandidates` (`pm/actions/select-probe-candidates.ts`) runs first in each PM tick and picks up to `PM_CIRCUIT_BREAKER_MAX_PROBES_PER_TICK` (default 2) circuit-broken issues whose `last_probe_at` is older than `PM_CIRCUIT_BREAKER_PROBE_AGE_MIN` minutes (default 120). These are passed to `promoteReadyIssues` / `startTodoIssues` as `probeOverrideIds`, bypassing the breaker skip for one probe run. On probe success (any `completed` run lands), `recoverCircuitBreaker` (called from the runner's completion path) drops the `circuit_breaker_state` row and removes the Tier-5-added `needs-design` label. State tracked in `circuit_breaker_state` table; Tier-5-added labels are distinguished from human-added ones by row presence (humans never get a row). Escape hatch: `PM_DISABLE_CIRCUIT_BREAKER_PROBE=true` (strict equality, read at call time). Audit events: `pm.circuit_breaker_probe`, `pm.circuit_breaker_recovered`, `pm.circuit_breaker_reset_manual`.
- **Operator escape hatch**: `ura circuit list` shows currently-broken issues; `ura circuit reset <ID>` clears a single issue (deletes failed `pipeline_runs` + cascade, drops state row, removes label); `ura circuit reset --all --yes` bulk-clears every broken issue. Uses direct DB access (matches `ura admin` pattern, NOT the `ura stop`/`halt` HTTP pattern), so the operator only needs `DATABASE_URL` + `LINEAR_API_KEY`.
```

- [ ] **Step 3: Update the DB schema-change checklist**

Find the convention line `**DB schema changes**: add to MIGRATION_COLUMNS array in client.ts (generates both SQLite + Postgres ALTER TABLE), update getCreateTablesDDL() template, and add the column to the Drizzle schema in schema.ts.` and leave it unchanged (this task adds a new TABLE, not a new COLUMN, so it follows the existing CREATE TABLE template path — no new convention).

- [ ] **Step 4: Run the canonical-count test**

Run: `cd packages/core && npx vitest run src/__tests__/claude-md-event-count.test.ts 2>&1 | tail -5`
(If the test file has a different name, search for the test that pins the count: `grep -rln "Current count" packages/core/src/__tests__/`.)
Expected: PASS

- [ ] **Step 5: Run the full unit-test suite to make sure nothing broke**

Run: `pnpm test 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(BEC-236): document circuit-breaker recovery + canonical count bump

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**Spec coverage:**
- ✅ `circuit_breaker_state` table — Task 3
- ✅ `selectProbeCandidates` action with cooldown, cap, ordering, audit emission — Tasks 4 + 5
- ✅ `probeOverrideIds` threading through promote/startTodo — Task 6
- ✅ Tier-5 state-row insertion — Task 7
- ✅ `recoverCircuitBreaker` action — Task 8
- ✅ Runner completion hook — Task 9
- ✅ PM tick wiring — Task 9
- ✅ `ura circuit list / reset / reset --all` — Tasks 10–12
- ✅ Three audit event types + constructors — Tasks 1 + 2
- ✅ `PM_DISABLE_CIRCUIT_BREAKER_PROBE` / `PM_CIRCUIT_BREAKER_PROBE_AGE_MIN` / `PM_CIRCUIT_BREAKER_MAX_PROBES_PER_TICK` — Task 4 helper, consumed in Task 9
- ✅ Unit tests per spec — Tasks 5, 8, 10, 11, 12
- ✅ Integration test — Task 13
- ✅ CLAUDE.md updates + canonical count bump — Task 14

**Placeholder scan:**
- Task 11 Step 3 contains skeleton code with `[Implementer: ...]` notes for the drizzle `where` clauses, transaction body, and label-strip flow. Justification: the patterns are already documented in detail (mirror `recoverCircuitBreaker` from Task 8 + `pm/actions/db-queries.ts:160` for `inArray`), and writing fully-specified TS for every drizzle delete here would balloon the plan without adding signal. The skeleton is callable and the test from Step 1 will fail until the implementer fills it in.

**Type consistency:**
- `probeOverrideIds: Set<string>` — used identically in `PromoteInput`, `StartTodoInput`, and `selectProbeCandidates` return type.
- `pmCircuitBreakerResetManualEvent { scope: "single" | "bulk", failedRunsDeleted }` — matches across constructor, CLI single-issue path, and bulk path.
- `CircuitResetDeps.scope` defaults to `"single"`; bulk path explicitly passes `"bulk"`.
# PM Circuit-Breaker Recovery — Design

**Date**: 2026-05-22
**Status**: draft for review
**Tracking**: BEC-236

## Goal

Give the PM circuit breaker a recovery path. Today a fleet-wide transient outage (auth expiry, network blip, host restart) trips the breaker on every in-flight issue, Tier-5 escalates each to `needs-design`, and the backlog stays permanently frozen until an operator manually `ura retry`s 18+ issues one at a time. Add (a) an automatic half-open probe that drains the backlog after a cooldown without operator action, and (b) a manual `ura circuit reset` command for the impatient-operator case.

## Why now

Discovered during a dogfood log review on 2026-05-21 and again on 2026-05-22. A multi-hour `CLAUDE_CODE_OAUTH_TOKEN` expiry caused 18+ tickets to consecutively fail three runs each. The BEC-161/181 breaker correctly stopped the doom loop — but with no recovery path the backlog stayed frozen for ~38 hours, and even after auth was restored the only fix was manual DB surgery (delete failed `pipeline_runs` rows per issue, drop the stale `needs-design` label, move back to Todo).

The breaker correctly prevents infinite retry loops on genuinely-broken issues. It cannot distinguish "this issue's code is broken" from "the whole fleet failed because the host died." A probe-and-see-what-happens loop is exactly that distinguisher.

## Background — what exists today

**Trip path** (`packages/core/src/pm/actions/promote.ts` + `start-todo.ts`):

```
PM tick
 ├─ batchCountConsecutiveFailures(db, candidateIds)        // single DB round-trip
 ├─ for each candidate:
 │   if failureCount ≥ maxConsecutiveFailures (default 3):
 │     emit pm.skipped_circuit_breaker
 │     if !hasNeedsDesignLabel:
 │       Tier-5 escalation:                                 // promote.ts:200-330
 │         add needs-design label
 │         post Linear comment with last error
 │         slackPostAlert
 │         emit pm.escalated_to_needs_design
 │     skip the issue
```

`batchCountConsecutiveFailures` (`pm/actions/db-queries.ts:160`) returns the number of leading `failed` rows in the `pipeline_runs` table ordered by `started_at DESC, id DESC`. A `completed` run anywhere in the lead resets the count to 0 — the existing semantics already encode "one success heals it."

**The frozen-backlog property**: once an issue is circuit-broken, neither `promote` (moves Backlog → Todo) nor `startTodoIssues` (starts pipelines for orphaned Todo issues) will ever attempt it again. With no run started, no `completed` row ever lands, the count never resets, the breaker stays engaged forever. BEC-223's exclusion of recovered issues from the daily digest only fires once a `completed` run exists — circular dependency.

## Design

### One new table, two new actions, one CLI subcommand

#### `circuit_breaker_state` table

Keyed by `issue_id`, tracks Tier-5-escalated issues so probe can distinguish them from human/triage-added `needs-design` labels.

```ts
{
  issue_id: text primary key,
  escalated_at: integer (crossTimestamp),   // Tier-5 sets on first escalation
  last_probe_at: integer | null,            // null until first probe
  probe_attempts: integer default 0,
}
```

Migration: new table, added to `MIGRATION_COLUMNS` in `db/client.ts` with the existing `CREATE TABLE IF NOT EXISTS` template path. Drizzle schema in `db/schema.ts`. Index on `(last_probe_at)` for the cooldown query.

Lifecycle:
- **Insert**: `promoteReadyIssues` inserts (idempotent `onConflictDoNothing`) immediately before emitting `pm.escalated_to_needs_design`.
- **Update**: `selectProbeCandidates` updates `last_probe_at = now`, increments `probe_attempts` for each issue it returns.
- **Delete**: `recoverCircuitBreaker` deletes the row when a `completed` run lands. `ura circuit reset` deletes on manual invocation.

Tier-5-vs-human distinction is solely the presence of this row. A human who manually labels a ticket `needs-design` for genuine triage reasons never gets a row, so probe ignores it.

#### `selectProbeCandidates(db, cap, cooldownMs)` action

Runs as the FIRST step in the PM tick (before promote/startTodo). Pure query — no side effects on Linear or pipeline state, only writes to `circuit_breaker_state`.

```ts
async function selectProbeCandidates(
  db: AnyDb,
  cap: number,
  cooldownMs: number,
): Promise<Set<string>>;
```

Logic (single SQL round-trip + small in-memory filter):
1. Select `issue_id, last_probe_at` from `circuit_breaker_state` where `last_probe_at IS NULL OR (now - last_probe_at) ≥ cooldownMs`, ordered by `last_probe_at ASC NULLS FIRST` (oldest first = round-robin, no starvation).
2. For each, call `batchCountConsecutiveFailures` (one DB round-trip for the whole batch) to filter out issues whose count has already dropped below the threshold (manual reset or successful run elsewhere).
3. Take top `cap` survivors.
4. Update `last_probe_at = now` and `probe_attempts = probe_attempts + 1` for the returned set (single `UPDATE … WHERE issue_id IN (…)`).
5. Emit one `pm.circuit_breaker_probe { issueId, consecutiveFailures, lastFailureAgeMin }` per issue.

Returns `Set<issueId>`. Threaded into `promoteReadyIssues` and `startTodoIssues` as a new optional `probeOverrideIds` parameter — when set, those issues bypass the breaker skip.

#### `recoverCircuitBreaker(db, issueId, linearClient)` action

Called from `runner.ts`'s pipeline-completion path (the `status === "completed"` branch). Atomic operation:
1. `SELECT FROM circuit_breaker_state WHERE issue_id = ?` — return early if no row (issue wasn't Tier-5-escalated, nothing to clean up).
2. `DELETE FROM circuit_breaker_state WHERE issue_id = ?`.
3. Remove the `needs-design` label from the Linear issue (idempotent — `removeLabel` is a no-op if absent).
4. Emit `pm.circuit_breaker_recovered { issueId, probeAttempts }`.

Probe success is detected naturally: `batchCountConsecutiveFailures` returns 0 the moment a `completed` run lands (most recent terminal row breaks the leading-failed streak). No explicit "is this a probe run?" flag needed.

#### `ura circuit` CLI subcommand (`packages/cli/src/commands/circuit.ts`)

```
ura circuit list                  # show issues with state rows + their failure counts
ura circuit reset <ISSUE_ID>      # single-issue reset
ura circuit reset --all [--yes]   # bulk reset; --yes skips confirmation prompt
```

Reset semantics (matches the proven manual unfreeze recipe):
1. `BEGIN` transaction.
2. `DELETE FROM agent_logs WHERE stage_run_id IN (SELECT id FROM stage_runs WHERE pipeline_run_id IN (SELECT id FROM pipeline_runs WHERE issue_id = ? AND status = 'failed'))`.
3. `DELETE FROM stage_runs WHERE pipeline_run_id IN (…same subquery…)`.
4. `DELETE FROM pipeline_runs WHERE issue_id = ? AND status = 'failed'`.
5. `DELETE FROM circuit_breaker_state WHERE issue_id = ?`.
6. `COMMIT`.
7. Remove `needs-design` label from Linear (only if state row had existed — same gate as `recoverCircuitBreaker`).
8. Emit `pm.circuit_breaker_reset_manual { issueId, scope: "single" | "bulk", failedRunsDeleted }`.

Bulk variant: discover the set of issue IDs via `batchCountConsecutiveFailures` over all `pipeline_runs.issue_id`s with ≥ `maxConsecutiveFailures` consecutive failures (NOT via `circuit_breaker_state` membership — that table is bootstrapped from new Tier-5 escalations, so on the first deploy it will be empty even though the frozen backlog exists). Then run the per-issue transaction in a loop. Each issue is its own transaction (a partial failure mid-bulk leaves the rest in a consistent state). `--yes` is required; interactive confirmation prompt if absent. Auth: `URATEAM_CLI_TOKEN` (same pattern as `ura stop` / `ura halt` / `ura retry`).

`ura circuit list` shows the set of currently-circuit-broken issues, derived from `batchCountConsecutiveFailures` (the same source of truth the breaker itself uses), LEFT JOINed to `circuit_breaker_state` for the optional `escalated_at` / `last_probe_at` / `probe_attempts` columns. Prints a small table: `ISSUE | FAILURES | ESCALATED | LAST_PROBE | ATTEMPTS`. Rows where the JOIN is null mark issues that are circuit-broken without a state row (pre-deploy escalations) — they're still listed so the operator can see and reset them. Read-only, no auth requirement.

### Defaults & env vars (all read at call time, strict equality for booleans)

| Env var | Default | Notes |
|---------|---------|-------|
| `PM_DISABLE_CIRCUIT_BREAKER_PROBE` | unset | `true` → `selectProbeCandidates` returns empty Set, reverts to today's always-skip behavior. Strict equality — `"1"` / `"yes"` / `"TRUE"` do NOT match (matches the BEC-218/BEC-227 convention). |
| `PM_CIRCUIT_BREAKER_PROBE_AGE_MIN` | 120 | Cooldown in minutes between probes of the same issue. Fixed cooldown, no exponential backoff (YAGNI for v1 — the per-tick cap already bounds spend on chronically-broken issues). |
| `PM_CIRCUIT_BREAKER_MAX_PROBES_PER_TICK` | 2 | Fleet-wide rate limit. Two probes per 30-min tick = ≤ 96 probes/day even if 100 issues are broken. |

Helper `getCircuitBreakerProbeConfig(env?)` in `pm/actions/circuit-breaker-config.ts` returns the parsed values; takes optional env for testability.

### Audit events (bumps canonical count 57 → 60)

Three new types added to `AuditEventTypeSchema` in `types.ts`:

| Event | Emitted by | Payload |
|-------|-----------|---------|
| `pm.circuit_breaker_probe` | `selectProbeCandidates` | `{ issueId, consecutiveFailures, lastFailureAgeMin, probeAttempts }` |
| `pm.circuit_breaker_recovered` | `recoverCircuitBreaker` | `{ issueId, probeAttempts }` |
| `pm.circuit_breaker_reset_manual` | `ura circuit reset` | `{ issueId, scope: "single" \| "bulk", failedRunsDeleted }` |

The Tier 1d test that pins the "Current count: N event types" sentence in CLAUDE.md to `AuditEventTypeSchema.options.length` will fail until the CLAUDE.md update lands — caught by the test suite, not a manual checklist.

### PM tick integration

Current tick sequence (from CLAUDE.md):
> budget check → recover retriable runs → recover stuck In Progress → startTodoIssues → triage → resolve approvals → promote → deprioritize → cancel → digest

New sequence:
> budget check → **selectProbeCandidates** → recover retriable runs → recover stuck In Progress → startTodoIssues (with `probeOverrideIds`) → triage → resolve approvals → promote (with `probeOverrideIds`) → deprioritize → cancel → digest

The probe selection runs early so the same Set is consumed by both `startTodoIssues` and `promoteReadyIssues` (an issue might be in Backlog OR orphaned in Todo; one probe budget covers both gates in one tick). Probe selection is idempotent within a tick — if either action somehow re-asks, the Set is identical.

`recoverCircuitBreaker` lives in the runner's `finally` block, gated on `run.status === "completed"`. It runs for every completed run, not just probes — that's fine, the table-lookup early-return is cheap and self-healing for any path that lands a completed run.

## Testing

Unit tests live in `packages/core/src/__tests__/`:

| File | Coverage |
|------|----------|
| `circuit-breaker-probe.test.ts` | `selectProbeCandidates`: cooldown boundary (just-eligible vs not-yet); per-tick cap honored; oldest-first ordering; escape hatch returns empty Set; issues whose count dropped below threshold are filtered out; idempotent within a tick |
| `circuit-breaker-recover.test.ts` | `recoverCircuitBreaker`: idempotent on re-run; no-op when state row absent (human-added `needs-design`); label removed only when row present; deletes state row even if Linear label removal throws (caller's `finally`) |
| `circuit-breaker-cli.test.ts` | `ura circuit reset`: single-issue deletes the failed-run cascade + state row; `--all` requires `--yes`; partial-failure mid-bulk leaves remaining issues consistent; `ura circuit list` formats correctly |
| `circuit-breaker-integration.test.ts` | Simulate 5 circuit-broken issues with synthetic failed-run history; advance `Date.now()` across cooldowns; assert the backlog drains at rate `cap` per tick, one `pm.circuit_breaker_probe` event fires per probe, and recovered issues drop their `needs-design` label and state row |

Existing tests that hit `promoteReadyIssues` / `startTodoIssues` need an additional case asserting that `probeOverrideIds` bypasses the breaker skip without breaking the existing skip behavior for non-override issues.

## Migration & rollout

The new table is `CREATE TABLE IF NOT EXISTS` — safe to redeploy. On first deploy: zero state rows, `selectProbeCandidates` returns empty, behavior identical to today. Tier-5 escalations start populating the table immediately on next breaker trip; the table is bootstrapped naturally from real traffic — no backfill needed.

For the currently-frozen backlog at deploy time (the 17+ issues without state rows), the operator runs `ura circuit reset --all --yes` once to bootstrap. Because `--all`'s candidate set is computed from `batchCountConsecutiveFailures` rather than from `circuit_breaker_state` membership, this works even though no state rows exist yet on the first deploy. After that, auto-probe takes over for new escalations.

## CLAUDE.md updates

Required edits to the "Pause / circuit-breaker / escalation" section:
- Document the half-open probe mechanism with the two env vars.
- Document `ura circuit list` / `ura circuit reset` under the operator-control surface table (alongside `ura stop` / `ura halt` / `ura retry`).
- Bump the "Current count: N event types" sentence from 57 to 60.
- Add the `circuit_breaker_state` table to the schema-change checklist line.

## Anti-goals

- **Do not remove or weaken the breaker itself.** Genuinely-broken issues must still be skipped between probes — the probe is a controlled retry, not a removal of the gate.
- **Do not change `maxConsecutiveFailures` default.** Threshold tuning is orthogonal.
- **No exponential backoff in v1.** The per-tick cap already bounds spend on chronically-broken issues; per-issue backoff complicates reasoning for no clear gain. Revisit if a real operational pattern demands it.
- **No Slack `/pm circuit reset` command in v1.** CLI surface is sufficient; doubling the surface for the same operation is not warranted yet.
- **`ura circuit reset` does NOT re-queue the issue.** It just clears the breaker state. The next PM tick's `startTodoIssues` / `promoteReadyIssues` picks the issue up naturally based on its Linear state. This keeps the reset action narrowly scoped.

## Open questions for implementation

- The `probeOverrideIds` parameter is new for `promoteReadyIssues` / `startTodoIssues` — confirm the prefetch path that uses `batchCountConsecutiveFailures` (promote.ts:134, start-todo.ts:128) still works when an issue is in the override set (it should — override is checked AFTER the count, only changes the skip decision).
- `recoverCircuitBreaker` should run inside or after the runner's `finally`? Inside ensures atomicity with run completion; after avoids touching Linear inside the hot pipeline-completion path. Defer to the implementer.

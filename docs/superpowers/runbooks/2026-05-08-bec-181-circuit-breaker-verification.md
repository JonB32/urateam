# BEC-181: Circuit Breaker Verification Runbook

**Date:** 2026-05-08  
**Issue:** [BEC-181](https://linear.app/beckerspace/issue/BEC-181)  
**Related:** [BEC-161](https://linear.app/beckerspace/issue/BEC-161) (original circuit breaker implementation)

---

## Summary

BEC-181 was filed after dogfood DB showed two issues (BEC-147, BEC-157) with 3–4 consecutive
failed runs. The concern was that the BEC-161 circuit breaker was either not engaging or engaging
silently with no audit trail.

**Verdict: The circuit breaker was working correctly. The gap was observability** — when the
breaker fired, no audit event was written to `audit_events`. Operators could only detect breaker
activity by grepping application logs for `"circuit-breaker engaged"`.

**Fix:** `pm.skipped_circuit_breaker` audit events are now emitted by both `promoteReadyIssues`
and `startTodoIssues` when the breaker fires.

---

## Investigation Queries

### 1. Check recent promote/start-todo attempts for a doom-looping issue

```sql
-- Check if BEC-147 or BEC-157 were re-promoted after hitting the failure cap
SELECT id, event_type, issue_id, timestamp, payload
FROM audit_events
WHERE issue_id IN ('BEC-147', 'BEC-157')
  AND event_type IN ('pm.issue_promoted', 'pm.start_todo', 'pm.skipped_circuit_breaker')
ORDER BY timestamp DESC
LIMIT 20;
```

After the BEC-181 fix, breaker skips appear as `pm.skipped_circuit_breaker` rows. Before the fix,
only `pm.issue_promoted` rows appeared (successful promotions), and breaker skips were invisible.

### 2. Confirm consecutive failures for an issue

```sql
-- Count consecutive failed runs since the last successful run
-- This mirrors countConsecutiveFailures() in db-queries.ts
SELECT status, started_at, completed_at, id
FROM pipeline_runs
WHERE issue_id = 'BEC-147'
  AND status IN ('completed', 'failed')
ORDER BY started_at DESC, id DESC
LIMIT 20;
```

Count the leading "failed" rows before the first "completed" row — that is the consecutive failure
count. If it equals or exceeds `maxConsecutiveFailures` (default 3), the breaker should engage.

### 3. Verify the circuit breaker is engaging (post-fix)

```sql
-- Show all circuit-breaker skip events in the last 7 days
SELECT
  event_type,
  issue_id,
  timestamp,
  json_extract(payload, '$.failureCount') AS failure_count,
  json_extract(payload, '$.threshold')    AS threshold,
  json_extract(payload, '$.action')       AS action
FROM audit_events
WHERE event_type = 'pm.skipped_circuit_breaker'
  AND timestamp >= datetime('now', '-7 days')
ORDER BY timestamp DESC;
```

For Postgres, replace `json_extract(payload, '$.failureCount')` with `payload->>'failureCount'`.

### 4. Check if an issue is stuck in the doom loop

```sql
-- Count consecutive failures per issue (top doom-looping candidates)
WITH ranked AS (
  SELECT
    issue_id,
    status,
    row_number() OVER (PARTITION BY issue_id ORDER BY started_at DESC, id DESC) AS rn
  FROM pipeline_runs
  WHERE status IN ('completed', 'failed')
),
consec AS (
  SELECT
    issue_id,
    count(*) FILTER (WHERE status = 'failed' AND rn <= coalesce(
      min(CASE WHEN status = 'completed' THEN rn END) - 1,
      count(*)
    )) AS consecutive_failures
  FROM ranked
  GROUP BY issue_id
)
SELECT issue_id, consecutive_failures
FROM consec
WHERE consecutive_failures >= 3
ORDER BY consecutive_failures DESC;
```

---

## Findings on BEC-147 and BEC-157

### BEC-147 (tech-debt: changelog UNRELEASED section stale)

- **Failed runs in last 48h:** 4
- **Circuit breaker threshold:** 3 (default `maxConsecutiveFailures`)
- **Expected behavior:** Breaker should engage on tick 4 (failureCount=4 >= threshold=3)
- **Actual behavior (pre-fix):** Breaker was engaging correctly (no new promotions), but no audit
  event was written. The only evidence was a `WARN` log line:
  `"skipped promote: circuit-breaker engaged (too many consecutive failures)"`
- **Actual behavior (post-fix):** `pm.skipped_circuit_breaker` event written to `audit_events`
  with `{failureCount: 4, threshold: 3, action: "promote"}`.

### BEC-157 (pipeline: filter agent scratchpad files)

- **Failed runs in last 48h:** 3
- **Circuit breaker threshold:** 3 (default `maxConsecutiveFailures`)
- **Expected behavior:** Breaker engages at exactly 3 consecutive failures (failureCount >= threshold)
- **Actual behavior (pre-fix):** Same as BEC-147 — breaker was working, but silent.
- **Actual behavior (post-fix):** `pm.skipped_circuit_breaker` event written with
  `{failureCount: 3, threshold: 3, action: "promote"}`.

---

## How to Verify the Circuit Breaker is Working

### 1. Check the batch failure-count query is used at the right sites

The breaker is wired at two call sites in the PM scheduler (`packages/core/src/pm/scheduler.ts`).
Both calls omit `getFailureCount`, so each function fetches failure counts internally via
`batchCountConsecutiveFailures` (a single DB round-trip for all candidates):

- **`promoteReadyIssues`** (line ~413): passes `db` and `maxConsecutiveFailures`; internally calls
  `batchCountConsecutiveFailures(db, candidateIds)` before the per-candidate loop.
- **`startTodoIssues`** (line ~307): same pattern — `db` + `maxConsecutiveFailures`; internally
  calls `batchCountConsecutiveFailures(db, candidateIds)` before the per-issue loop.

Both are gated on `config.maxConsecutiveFailures > 0`, which means the breaker is disabled when
`maxConsecutiveFailures` is `0` or unset in the config.

### 2. Confirm the breaker is enabled in your config

```yaml
# In your urateam config:
maxConsecutiveFailures: 3  # default; set to 0 to disable
```

### 3. Simulate the breaker in a test environment

Run the unit tests to confirm end-to-end behavior:

```bash
cd packages/core
npx vitest run src/__tests__/bec-181-circuit-breaker-audit-gap.test.ts
```

Expected output: all 7 tests pass, including:
- `BEC-181 Part 1 > returns 4 when issue has 4 consecutive failed runs and no completed run`
- `BEC-181 Part 1 > returns 3 when issue has exactly 3 consecutive failed runs (at default threshold)`
- `BEC-181 Part 2 > skips promotion for issue with 4 consecutive failures and writes a pm.skipped_circuit_breaker audit event (fix verified)`
- `BEC-181 Part 2 > skips promotion for BEC-157 with exactly 3 consecutive failures (at threshold)`
- `BEC-181 Part 3 > skips start for issue with 4 consecutive failures WITHOUT touching Linear SDK, and writes an audit event (fix verified)`
- `BEC-181 Part 4 > AuditEventTypeSchema contains pm.skipped_circuit_breaker`
- `BEC-181 Part 4 > audit/events.ts exports pmSkippedCircuitBreakerEvent builder`

### 4. Observe in production via audit events

After the BEC-181 fix is deployed, the `audit_events` table will contain
`pm.skipped_circuit_breaker` rows whenever the breaker fires. Use the queries in the
[Investigation Queries](#investigation-queries) section above to monitor doom-looping issues.

### 5. Clear the circuit breaker manually

If an issue has been fixed and you want to let the PM agent retry it, you have two options:
1. **Mark a run as completed** (not recommended — artificial DB change)
2. **Lower the failure count** by deleting old failed runs for the issue from `pipeline_runs`
   (only if you're certain the previous failures are no longer relevant)

The recommended approach is to fix the underlying problem that caused the failures, then set the
issue back to Backlog. On the next promote cycle, the breaker re-evaluates the consecutive failure
count from `pipeline_runs`. If a completed run now appears before the failed ones, `count` resets.

---

## What Changed in BEC-181

| File | Change |
|---|---|
| `packages/core/src/types.ts` | Added `"pm.skipped_circuit_breaker"` to `AuditEventTypeSchema` |
| `packages/core/src/audit/events.ts` | Added `pmSkippedCircuitBreakerEvent()` builder |
| `packages/core/src/pm/actions/db-queries.ts` | Added `batchCountConsecutiveFailures()` — single DB round-trip for all candidates |
| `packages/core/src/pm/actions/promote.ts` | Emits `pm.skipped_circuit_breaker` when circuit breaker fires; uses batch query |
| `packages/core/src/pm/actions/start-todo.ts` | Emits `pm.skipped_circuit_breaker` when circuit breaker fires; uses batch query |
| `packages/core/src/pm/scheduler.ts` | Omits `getFailureCount` so promote/start-todo use the batch query path |
| `packages/core/src/__tests__/bec-181-circuit-breaker-audit-gap.test.ts` | Updated tests to verify audit events and batch path |
| `packages/core/src/__tests__/pm-circuit-breaker.test.ts` | Added `batchCountConsecutiveFailures` tests |
| `packages/core/src/__tests__/audit-immutability.test.ts` | Added `start-todo.ts` to `logAuditEventUnchecked` allowlist |

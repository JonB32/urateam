# BEC-136 — QA Agent + Release-Readiness Check (Phase 1)

**Issue:** [BEC-136](https://linear.app/beckerspace/issue/BEC-136/v10-46-qa-agent-release-readiness-check-orchestrate-existing-ci-file)
**Tier:** OSS+ (workflow runner is not a premium feature; gap-issue filing reuses the Pro-tier `LINEAR_API_KEY`)
**Estimate:** 2–3 weeks
**v1.0 gate:** 5 of 6 (sequence after BEC-135)
**Date:** 2026-05-04

---

## 1. Goal

Wire a release-time QA gate into Release Manager (BEC-135). When configured, each Release Manager tick verifies that a customer-defined GitHub Actions workflow has run green against the merge commit before the agent fires a release tag. If no workflow is configured at the expected path, the agent files a Linear issue describing how to set one up and pauses the release pipeline until a human resolves it.

urateam DOES: trigger workflow_dispatch on `qaCheck.workflow`, poll its status, gate the release decision on pass/fail, file an idempotent Linear gap issue if the workflow file is missing.

urateam DOES NOT: provision ephemeral environments, generate test code, parse test output, run tests itself, or analyze the codebase with an LLM. The customer's existing CI is the source of truth.

## 2. Decisions (locked 2026-05-04)

| # | Decision | Reason |
|---|---|---|
| D1 | QA integrates as a 5th trigger field on `ReleaseManagerTriggers` (Architecture A) | Cleanest fit with existing trigger DSL; reuses decision-flow + audit + Slack-dedup plumbing. |
| D2 | Gap-detection is rule-based with a static Linear template (A3) | Phase 1 keeps Claude API surface tiny. LLM-driven analysis is real value but riskier (prompt engineering + token cost) — defer to v2. |
| D3 | Async fire-and-check across ticks (X2) | A workflow run can take 5–30 min. Synchronous-in-tick blocks scheduler activity. Async costs one extra tick of release latency in exchange for fast ticks + composable concurrent repos. |
| D4 | QA evaluates at trigger-order position 4, before `requireSlackApproval` | Customers using both `qaCheck` AND `requireSlackApproval` should see "QA failed" as a regular skip BEFORE the awaiting-approval branch — keeps the human-in-loop flow uncluttered when QA is broken. |
| D5 | New persistence: 2 columns on `release_decisions` (`qaRunId`, `qaRunSha`) + new tiny `qa_gap_issues` table | No standalone QA scheduler / DB. Two minimal touchpoints; partial UNIQUE on `qa_gap_issues` mirrors the proven `release_approvals` pattern. |
| D6 | Reuse `LINEAR_API_KEY` (existing PM agent secret) for filing gap issues | No new secrets to plumb. |
| D7 | Reuse the dormant `attempt_count` column on `release_decisions` (originally for partial-fire retries, now dead per BEC-135 v2 cleanup) for QA dispatch / gap-file 3-attempt retry counter | Avoids adding another column. Documents the column's actual current use. |
| D8 | Audit events use `release-manager` actor type (not a new `qa-agent` actor) | QA is a sub-feature of Release Manager, not a peer. Single actor namespace = simpler audit-log queries. |
| D9 | Audit emissions use `logAuditEventUnchecked` (matches BEC-135 v2 audit-gating pattern) | Pro-tier features must produce audit rows for Pro customers without requiring the Enterprise `audit-log` dashboard. |

## 3. Architecture

```
packages/core/src/qa/
  types.ts          # QaCheckConfigSchema + QaTriggerResult union
  github.ts         # triggerWorkflow() / pollWorkflowRun() / workflowFileExists()
  gap.ts            # detectMissingHarness() / fileGapIssue() (idempotent via DB)
  index.ts          # barrel re-export

packages/core/src/release-manager/
  types.ts          # MODIFY — add qaCheck to ReleaseManagerTriggers
  triggers.ts       # MODIFY — add evalQaCheck() evaluator
  decide.ts         # MODIFY — call evalQaCheck() at slot 4 (before requireSlackApproval)
  state.ts          # MODIFY — surface in-flight qaRun lookup from release_decisions
  scheduler.ts      # MODIFY — dispatch qaActionNeeded (triggerWorkflow / fileGapIssue)

packages/core/src/db/
  schema.ts         # MODIFY — add qaRunId/qaRunSha columns to releaseDecisions; add qaGapIssues table
  migrations/sqlite/010_qa_run_columns.sql        # NEW — ALTER TABLE release_decisions ADD COLUMN
  migrations/sqlite/011_qa_gap_issues.sql         # NEW — CREATE TABLE qa_gap_issues + partial UNIQUE
  migrations/postgres/011_qa_run_columns.sql      # NEW
  migrations/postgres/012_qa_gap_issues.sql       # NEW

packages/core/src/audit/events.ts          # MODIFY — add 3 factories
packages/core/src/types.ts                 # MODIFY — extend AuditEventTypeSchema with 3 entries

packages/cli/src/commands/start.ts         # MODIFY — startup config validation for qaCheck

packages/create-urateam/template/.urateam/.env.example  # MODIFY — document RELEASE_MANAGER_TRIGGER_QA_*

packages/core/src/__tests__/
  qa-config.test.ts                              # NEW
  qa-github.test.ts                              # NEW
  qa-gap.test.ts                                 # NEW
  qa-eval.test.ts                                # NEW
  qa-audit-events.test.ts                        # NEW
  db-qa-gap-issues.test.ts                       # NEW
  release-manager-decide.test.ts                 # MODIFY — add 3 tests for qaCheck slot
  release-manager-scheduler.test.ts              # MODIFY — add 4 tests for qaActionNeeded dispatch
```

## 4. Configuration

### 4.1 RepoConfig schema addition

```ts
// packages/core/src/qa/types.ts
export const QaCheckConfigSchema = z.object({
  /** Path to the workflow file in the repo (e.g., ".github/workflows/smoke.yml"). */
  workflow: z.string().min(1),
  /** Max time we'll wait for a single workflow run before reporting timed_out. Default 30. */
  timeoutMinutes: z.number().int().positive().default(30),
  /** Linear team UUID for filing gap issues. Required for gap-issue path to work. */
  linearTeamId: z.string().min(1),
  /** Optional inputs passed to workflow_dispatch (e.g., { environment: "preview" }). */
  workflowInputs: z.record(z.string(), z.string()).optional(),
});
export type QaCheckConfig = z.infer<typeof QaCheckConfigSchema>;
```

Then in `release-manager/types.ts`, extend `ReleaseManagerTriggersSchema`:

```ts
qaCheck: QaCheckConfigSchema.optional(),
```

### 4.2 Startup validation

Throws on:
- `qaCheck.workflow` set but `LINEAR_API_KEY` env unset → "qaCheck requires LINEAR_API_KEY for filing gap issues"
- `qaCheck.workflow` set but `linearTeamId` empty → caught by Zod `.min(1)` automatically
- (Optional, post-Zod) `gh api repos/{owner}/{repo}/actions/workflows/{file}` returns the workflow but it lacks `on: workflow_dispatch` trigger → "workflow X must have `on: workflow_dispatch` to be triggered by the release agent". This is a soft-validate done at scheduler creation time (not a startup throw) because GitHub creds may not be loaded at config-parse time.

### 4.3 Env-driven kickstart

| Env var | Maps to | Notes |
|---|---|---|
| `RELEASE_MANAGER_TRIGGER_QA_WORKFLOW` | `qaCheck.workflow` | Setting any one of the QA env vars implies qaCheck is configured. |
| `RELEASE_MANAGER_TRIGGER_QA_TIMEOUT_MINUTES` | `qaCheck.timeoutMinutes` | Optional, default 30 |
| `RELEASE_MANAGER_TRIGGER_QA_LINEAR_TEAM_ID` | `qaCheck.linearTeamId` | Required when qaCheck is set |

`workflowInputs` is per-repo only (no env path); customers configure via per-repo `pipelineConfig` JSON. Realistically most won't need it — the fallback default omits the field entirely.

## 5. Decision flow

```
ReleaseManagerScheduler.tick()
  ├─ ... existing pre-decide steps (license, paused, manual-tag, collectState)
  ├─ # state now includes state.qaRun (most-recent in-flight QA run for headSha, or null)
  ├─ result = decide(state, config.triggers)
  │     # decide() in turn calls evalQaCheck at slot 4 if triggers.qaCheck is set
  │     # evalQaCheck returns one of 5 kinds (see §5.1).
  │     # When the kind requires action, decide bubbles it via { kind: "skip", reason, qaActionNeeded }
  ├─ persistDecision(...)
  │     # if qaActionNeeded.reason === "qa_needs_trigger", persistDecision sets qaRunSha = state.headSha
  │     #                                                             qaRunId  = (filled in next step after dispatch)
  ├─ # Dispatch any qaAction needed:
  ├─ if qaActionNeeded.reason === "qa_needs_trigger":
  │     runId = await qa.triggerWorkflow({ octokit, owner, repo, workflow, ref: state.headSha, inputs })
  │     update release_decisions row to set qaRunId
  │     audit qaRunTriggeredEvent
  │     return  # tick complete; next tick observes the run
  ├─ if qaActionNeeded.reason === "qa_no_workflow":
  │     await qa.fileGapIssue({ db, linearClient, repoUrl, branch, workflowPath })
  │     # fileGapIssue is idempotent via qa_gap_issues partial UNIQUE; no-op if already filed
  │     # On first file: audit qaGapIssueFiledEvent
  │     return
  ├─ if qaActionNeeded.reason === "qa_failed":
  │     audit qaRunCompletedEvent({ conclusion: <actual conclusion> })
  │     # decision row is already persisted; no further action
  │     return
  ├─ if qaActionNeeded.reason === "qa_running" / "qa_timed_out":
  │     # No new dispatch; just persisted skip row + Slack-dedup notification
  │     return
  ├─ ... (existing flow continues — fire/skip/awaiting-approval as before)
```

### 5.1 `evalQaCheck` result kinds

```ts
export type QaTriggerResult =
  | { pass: true;  reason: string }                            // workflow run completed, conclusion=success
  | { pass: false; reason: "qa_failed"; runId: number }        // completed, conclusion in {failure, cancelled, timed_out, action_required, skipped, stale}
  | { pass: false; reason: "qa_running"; runId: number }       // in-flight — await next tick
  | { pass: false; reason: "qa_timed_out"; runId: number }     // in-flight beyond timeoutMinutes — synthetic timeout
  | { pass: false; reason: "qa_needs_trigger" }                // workflow file exists but no run exists for state.headSha
  | { pass: false; reason: "qa_no_workflow" };                 // workflow file missing — file gap issue
```

### 5.2 Trigger ordering (updated)

`decide()` evaluates in this order; first failing trigger wins:
1. `mergedPRsSince` (in-memory count — cheapest)
2. `timeSinceLastHours` (single timestamp compare)
3. `ciGreenForMinutes` (already-fetched into state)
4. **`qaCheck`** (NEW — uses already-fetched in-flight run state from DB; may bubble qaActionNeeded)
5. `requireSlackApproval` (last; "awaiting-approval" terminal kind)

QA is at position 4 because: if the workflow's failing/missing, that's a regular `skip` — we don't want it bumping into the `awaiting-approval` branch. The whole approval flow only triggers when QA has already passed.

### 5.3 SHA-mismatch handling

When evaluating, if `state.qaRun.runSha !== state.headSha` (commits landed mid-run):
- Mark `state.qaRun = null` for the eval purpose (treat as no in-flight run).
- evalQaCheck returns `qa_needs_trigger` → scheduler triggers fresh.
- Old run is left alive in GitHub history (do NOT cancel — could be expensive cloud spend in flight).
- Old `release_decisions` row is unchanged (audit trail preserved).

### 5.4 Decision-row qaRun retrieval

`state.qaRun` is computed in `state.ts` `collectState()` via:

```sql
SELECT qa_run_id, qa_run_sha, decided_at
FROM release_decisions
WHERE repo_url = $1 AND branch = $2 AND qa_run_id IS NOT NULL
ORDER BY decided_at DESC
LIMIT 1
```

The most-recent decision with a non-null `qa_run_id` represents the in-flight run we're tracking. evalQaCheck then uses Octokit to poll its status.

## 6. Schema migration

```ts
// schema.ts — additions to releaseDecisions
qaRunId: integer("qa_run_id"),               // GitHub workflow run ID — null when no QA in flight
qaRunSha: text("qa_run_sha"),                // SHA the workflow was triggered against

// schema.ts — new table
export const qaGapIssues = sqliteTable(
  "qa_gap_issues",
  {
    id: text("id").primaryKey(),
    repoUrl: text("repo_url").notNull(),
    branch: text("branch").notNull(),
    workflowPath: text("workflow_path").notNull(),
    /** Linear issue identifier returned at file time (e.g., "BEC-150"). */
    linearIssueId: text("linear_issue_id").notNull(),
    filedAt: crossTimestamp("filed_at").notNull().$defaultFn(() => new Date()),
    /** Set when the gap is detected as resolved (workflow file appears). Linear issue itself is closed manually by operator. */
    resolvedAt: crossTimestamp("resolved_at"),
  },
);
// Partial UNIQUE in raw migration:
//   UNIQUE (repo_url, branch, workflow_path) WHERE resolved_at IS NULL
```

**Migration files:**
- `packages/core/src/db/migrations/sqlite/010_qa_run_columns.sql` — `ALTER TABLE release_decisions ADD COLUMN qa_run_id INTEGER; ALTER TABLE release_decisions ADD COLUMN qa_run_sha TEXT;`
- `packages/core/src/db/migrations/sqlite/011_qa_gap_issues.sql` — `CREATE TABLE qa_gap_issues (...)` + 1 partial UNIQUE index + 1 lookup index
- `packages/core/src/db/migrations/postgres/011_qa_run_columns.sql` — postgres equivalent
- `packages/core/src/db/migrations/postgres/012_qa_gap_issues.sql` — postgres equivalent (TIMESTAMPTZ for `filed_at` / `resolved_at`)

## 7. Audit events

Three new event types in `AuditEventTypeSchema`:
- `qa.run_triggered` — payload: `{ branch, workflow, runId, sha }`
- `qa.run_completed` — payload: `{ branch, runId, conclusion, durationMs, synthetic? }` (synthetic=true for `qa_timed_out` since GitHub didn't actually conclude it)
- `qa.gap_issue_filed` — payload: `{ branch, workflowPath, linearIssueId }`

Factories live in `packages/core/src/audit/events.ts`. All three:
- `actor: "release-manager"`
- `actorType: "release-manager"`
- `scope: \`repo:${args.repoUrl}\``
- Emitted via `logAuditEventUnchecked` so they appear for Pro customers (matches BEC-135 v2 pattern).

`audit-immutability.test.ts` allowlist gets 2 new entries: `packages/core/src/qa/github.ts` (emits `qa.run_triggered` after dispatch returns the runId) and `packages/core/src/qa/gap.ts` (emits `qa.gap_issue_filed` after Linear API returns the issue ID). The third event, `qa.run_completed`, fires from `release-manager/scheduler.ts` which is already in the allowlist from BEC-135.

## 8. Error handling

| Failure | Behavior |
|---|---|
| `gh workflow run` 5xx / rate-limit | Log + return `qa_needs_trigger` for next tick. Increment `attempt_count` on the new decision row. After 3 attempts → `skip` with `reason="qa_dispatch_error"` + audit event. |
| `gh workflow run` 422 (workflow not workflow_dispatch-triggered) | Same path as above (3-attempt retry then permanent skip with `reason="qa_dispatch_error"`). The startup validator should catch this earlier. |
| `gh workflow run` 404 (workflow file removed between state-cache and dispatch) | Drop into `qa_no_workflow` path — file gap issue, persist skip row. |
| Polled run still `in_progress` after `timeoutMinutes` | Decision = `skip`, reason = `qa_timed_out`. Audit `qa.run_completed` with synthetic conclusion. Do NOT auto-cancel the GitHub run. |
| Run conclusion in {`failure`, `cancelled`, `timed_out`, `action_required`, `skipped`, `stale`} | Decision = `skip`, reason = `qa_failed`. Audit captures actual conclusion. |
| Linear API failure when filing gap issue | Log + retry next tick. After 3 attempts → `skip` with `reason="qa_gap_file_error"` + audit event. |
| GitHub API rate-limit (429) on poll | Octokit throttling middleware (already configured in `repo/github.ts`) handles the retry. Tick treats the throttle wait as transient — returns `qa_running` if status couldn't be determined. |
| `qaRunSha !== state.headSha` (mid-run new commits) | evalQaCheck → `qa_needs_trigger`. Scheduler dispatches a fresh workflow run. Old run becomes orphan. |
| `LINEAR_API_KEY` invalid mid-run (401 from Linear) | Treated like Linear API failure (3-attempt retry). |
| Multi-process Release Manager | Mitigated by Postgres advisory lock at scheduler tick start (already there from BEC-135). v2 cross-process is out of scope (BEC-141). |

**Retry counter:** reuses the existing `attempt_count` column on `release_decisions`. Each transient failure increments the counter on the new decision row; transient retries do NOT audit. Only the final 3rd-attempt skip audits.

## 9. Testing

8 test files, ~80 tests. Mirrors BEC-135's layout (proven out in implementation).

| File | Coverage |
|---|---|
| `qa-config.test.ts` | `QaCheckConfigSchema` happy path; superRefine + startup-validation guards (workflow + linearTeamId both required; `LINEAR_API_KEY` env requirement) |
| `qa-github.test.ts` | `triggerWorkflow` happy + 422 + 5xx; `pollWorkflowRun` for each conclusion + in_progress; `workflowFileExists` 404 vs 200 vs 5xx |
| `qa-gap.test.ts` | `detectMissingHarness` returns true on 404, false on 200; `fileGapIssue` happy path with mocked Linear SDK; idempotent re-call (existing open row → no-op); resolved row handling |
| `qa-eval.test.ts` | All 5 result kinds of `evalQaCheck`; SHA-mismatch returns `qa_needs_trigger`; timeout calc respects `timeoutMinutes`; nothing-running case |
| `release-manager-decide.test.ts` (extend) | qaCheck slot-4 ordering; qaCheck failure path; qaActionNeeded bubbles through |
| `release-manager-scheduler.test.ts` (extend) | Tick triggers workflow (action=needs-trigger); tick polls existing run; tick files gap issue (action=no-workflow); 3-attempt retry counter |
| `db-qa-gap-issues.test.ts` | Schema + UNIQUE partial index round-trip; resolved row allows re-file |
| `qa-audit-events.test.ts` | 3 new factories pass schema validation; correct actor/actorType/scope |

**No e2e in v1** — production integration test gated on `TEST_POSTGRES_URL` + `TEST_LINEAR_API_KEY` (latter is new; document but don't require for CI).

**Pre-existing flaky-test reminder:** the 5 license-helper tests still take 4-5s in isolation under the now-30s timeout. New QA tests should NOT use `installTestProLicense()` unless they truly need a Pro license — for pure-fn tests, just construct config objects directly.

## 10. Out of scope (v2 / post-1.0)

- LLM-driven gap analysis (rule-based for v1 per D2)
- Auto-cancellation of stuck workflows
- Auto-fix bootstrap PR (gap issue is just a Linear issue; no starter-workflow PR)
- Multi-workflow chains (one workflow per qaCheck in v1)
- Test-result surfacing in Slack (v1 just says "QA failed: see GitHub run #X")
- Cost/duration alerting (no "this run cost $X" detection)
- Per-PR QA (v1 only after merge, gated by Release Manager)
- Workflow file at non-default location (v1 paths only under `.github/workflows/`)
- Multi-repo QA fan-out (paired with BEC-141 multi-repo Release Manager)
- Linear issue auto-close (operator closes manually)

## 11. Acceptance criteria mapping (from BEC-136)

| Acceptance criterion | Where covered |
|---|---|
| New `qa-agent` action under `packages/core/src/qa/` | §3 |
| Triggered by Release Manager | §5 — qaCheck integrates as 5th trigger |
| Calls `gh workflow run <workflow> --ref <commit>`, polls status | `qa/github.ts` triggerWorkflow + pollWorkflowRun |
| Result reported back to Release Manager as part of release decision | §5.1 — QaTriggerResult kinds; §5 — bubble via qaActionNeeded |
| Gap-detection: when no smoke workflow exists, files a Linear issue | §5 (`qa_no_workflow` branch) + `qa/gap.ts` |
| Tests cover: workflow-success, workflow-failure, no-workflow-detected paths | §9 — qa-eval + qa-github + qa-gap + scheduler-extension tests |

## 12. Release & cascade

- Bump `@urateam/core` (next sequential after `0.1.17`) → `0.1.18`
- Cascade `@urateam/cli` `0.1.19` → `0.1.20` and `@urateam/dashboard` `0.1.17` → `0.1.18`
- Tag `v0.1.32`
- Customers must have `LINEAR_API_KEY` and `GITHUB_APP_*` already configured (from PM agent + BEC-135). No new secrets to set up.
- BEC-136 hands off to BEC-138 (self-dogfood + 1.0.0 cut). After BEC-138 merges, the urateam team itself runs the full agent stack on the urateam repo for ≥7 days before tagging 1.0.0.

## 13. Known v1 simplifications (deliberate trade-offs)

These are pragmatic v1 trade-offs the implementer should NOT try to "fix" without checking with the user. Each is a deliberate scope reduction.

1. **Gap detection is rule-based, not LLM-driven.** Per D2: when the configured workflow file is missing, we file a Linear issue from a static template. No Claude call inspects the repo for the right ephemeral-env provider, no auto-suggestion of test-framework path. The Linear issue body links to documentation; operator does the bootstrap. v2 (filed as Linear ticket post-1.0) can layer LLM analysis on top.

2. **Synchronous-tick is rejected; we run async across ticks.** A release that takes 30 min normally now takes ~30 min + one extra tick for QA. Acceptable v1 behavior. Operators should set `RELEASE_MANAGER_SCHEDULE` to a faster cron (e.g., `*/15 * * * *`) if they want tighter release latency.

3. **No QA workflow auto-cancel on timeout.** When `timeoutMinutes` elapses, we report `qa_timed_out` and walk away. The workflow keeps running on GitHub's side. This is intentional — auto-cancelling would surprise operators with cost spikes/data loss in mid-flight ephemeral envs. Operators cancel manually via GitHub UI.

4. **`qaCheck.workflow` is path-only, no name resolution.** `gh workflow run` accepts both filenames and display names. v1 requires the file path (e.g., `.github/workflows/smoke.yml`). Display-name support is a v2 nice-to-have.

5. **Single Release Manager instance per process** (inherited from BEC-135 v1). Multi-repo QA fan-out is gated on BEC-141 (multi-repo Release Manager).

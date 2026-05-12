# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

urateam is an autonomous agent system that receives Linear issues via webhooks, runs them through configurable pipelines (triage, implement, test, review), and delivers pull requests powered by Claude.

It is a pnpm monorepo with 4 packages:
- `@urateam/core` — webhook receiver, pipeline runner, agent executor, database (Drizzle ORM), notifiers
- `@urateam/dashboard` — Hono + HTMX ops dashboard for monitoring runs
- `@urateam/cli` — `ura` command-line tool for local development
- `@urateam/observers` — quality observer: detects recurring patterns in pipeline run data, files GitHub Issues for new findings, with first-tick dedup seeding to prevent batch-flooding on fresh deploy

## Build & Test Commands
- `pnpm install` — install all dependencies
- `pnpm build` — build all packages (via Turborepo)

### Test Workflows
- **Unit tests** (default): `pnpm test` — runs all tests except heavy git integration tests (~60s, excludes `src/__tests__/integration/**`)
- **Integration tests**: `pnpm test:integration` — runs BEC-99 cross-worktree guard tests and other heavy git integration tests (~30-40s each, sequential)
- **Changed-files only**: `cd packages/core && npx vitest --changed` — runs only tests affected by uncommitted changes or the latest commit (fast iteration during development)

### Per-package test commands
- `cd packages/core && npx vitest run` — run core unit tests only
- `cd packages/core && npx vitest run src/__tests__/<file>.test.ts` — run a specific test file
- `cd packages/core && npx vitest run --config vitest.integration.config.ts` — run core integration tests only

### Test organisation
- Unit tests: `packages/core/src/__tests__/**/*.test.ts` (excluding `integration/` sub-directory)
- Integration tests: `packages/core/src/__tests__/integration/**/*.test.ts` (BEC-99 cross-worktree guard, auto-commit, vitest --changed validation)

## Repository Structure

- `packages/core/` — Core library (types, webhook, pipeline, executor, DB, notifiers, security)
- `packages/dashboard/` — Dashboard server and HTMX templates
- `packages/cli/` — CLI entry point
- `packages/observers/` — Quality observer (first-tick dedup seeding, GitHub Issues filing, SQLite store)
- `deploy/` — Docker, Caddy, setup script, env example, CLAUDE.md template
- `examples/` — Example configurations (basic, monorepo, multi-repo, custom stages)
- `scripts/` — Setup scripts for Linear webhook and GitHub App; `gh-linear-sync.ts` (GH→Linear sync entry point)
- `docs/` — Design specs and documentation

### GitHub Issues → Linear Sync (BEC-173)

Autonomous incident/change-management bridge. Open GitHub issues are synced to Linear tickets in the Triage state every hour via a scheduled GitHub Action.

- **Deployment:** GitHub Action (`.github/workflows/gh-linear-sync.yml`) — zero host infra, free for public repos
- **Entry point:** `scripts/gh-linear-sync.ts` (run with `pnpm tsx`)
- **Core logic:** `packages/core/src/sync/gh-linear-sync.ts` (mockable client interfaces, exported from `@urateam/core`)
- **Setup guide:** `deploy/GH_LINEAR_SYNC_SETUP.md`

**Operator mental model:** GitHub = inbound (public filings, Quality Observer findings). Linear = triage / work-tracking / autonomous-pipeline routing.

Key exported functions:
- `runGhLinearSync(config, clients)` — main orchestrator; idempotent via `[GH#NNN]` title prefix
- `findLinearTicketForGhIssue(client, ghNumber, teamId)` — checks for existing Linear ticket
- `createLinearTicketForGhIssue(client, ghIssue, teamId, stateId)` — creates Triage ticket with idempotency marker
- `makeIdempotencyMarker(n)` → `<!-- gh-linear-sync:N -->`
- `createGitHubSyncClientFromToken(token)` / `createLinearSyncClientFromApiKey(apiKey)` — real client factories

Config env vars: `GH_LINEAR_SYNC_GITHUB_TOKEN`, `GH_LINEAR_SYNC_GITHUB_REPO`, `GH_LINEAR_SYNC_LINEAR_API_KEY`, `GH_LINEAR_SYNC_LINEAR_TEAM_ID`, `GH_LINEAR_SYNC_LABEL_FILTERS`, `GH_LINEAR_SYNC_TRIAGE_STATE`, `GH_LINEAR_SYNC_BIDIRECTIONAL_CLOSE`, `GH_LINEAR_SYNC_DRY_RUN`

`GH_LINEAR_SYNC_LABEL_FILTERS` is comma-separated (e.g. `bug,enhancement`). **OR semantics**: multiple labels → issues matching ANY of them are synced. One `listIssues` API call is made per label and results are deduplicated by issue number. (The GitHub REST API treats comma-separated labels as AND/intersection; this workaround restores the expected OR/union behavior — fixed in BEC-185.)

Bidirectional close-out (GH issue closed when Linear ticket reaches Done state) is opt-in via `GH_LINEAR_SYNC_BIDIRECTIONAL_CLOSE=true`.

## Codebase Optimization Pass — In Flight (BEC-187 → BEC-207)

A codebase-wide analysis (2026-05-11) surfaced a set of foundational improvements that are tracked in Linear and should land before substantial new feature work. Contributors touching the affected areas should coordinate with these tickets to avoid merge conflicts:

- **Foundation (P1 Urgent)**: BEC-187 (DB indexes), BEC-188 (`util/env.ts` + `util/json.ts`), BEC-190 (tighten `AnyDb` + `retry_count` schema fix + Linear SDK typing).
- **Completed**: BEC-189 (`util/linear.ts` + Promise.all relations) ✅ — `getLinearClient`, `resolveIssueRelations`, `resolveWorkflowStatesByTeam` shipped in `packages/core/src/util/linear.ts`.
- **Cleanup (P2 High)**: BEC-191 (dead code), BEC-192 (resume-payload zod), BEC-193 (Octokit memoization + parseRepoUrl hoist).
- **File splits (P2 High, sequential)**: BEC-194 (`create-urateam/index.ts`), BEC-195 (`pm/slack-interface.ts`), BEC-196 (`release-manager/scheduler.ts`), BEC-197 (`audit/events.ts`), BEC-199 (extract feedback-pipeline from `runner.ts`).
- **Infrastructure (P2 High)**: BEC-198 (env-validation module + `deploy/ENV_VARS.md`), BEC-200 (test gaps in runner retry-strategies + policyErr + status webhook + paused-tick).
- **Competitive response (P2/P3)**: BEC-201 (multi-AI for implement stage), BEC-207 (`CLAUDE_CODE_OAUTH_TOKEN`), BEC-203 (Sentry + CloudWatch integrations), BEC-205 (one-command bootstrap), BEC-206 (GitLab parity + Bitbucket).
- **Strategic / needs-design**: BEC-202 (managed-runtime tier), BEC-204 (IDE/CLI agent surface).

Known limitations being addressed (don't compound these):
- `AnyDb = any` in `db/client.ts:23` cascades into ~50 `as any` casts. Don't add new `(this.db as AnyDb)` casts; wait for BEC-190.
- `linearClient: any` in `pm/actions/*` and `pm/linear-helpers.ts`. Use `LinearClient` from `@linear/sdk` when adding new code there.
- 5 missing indexes on `pipeline_runs` + `pm_approvals` — landing in BEC-187. Don't add new hot-path queries that scan these tables until BEC-187 ships.
- Sequential `await issue.team` / `await issue.state` patterns in `pm/actions/*` have been eliminated (BEC-189 ✅). New code in these files should call `resolveIssueRelations(issue)` from `util/linear.ts` to fetch team, state, and labels concurrently.

## Key Patterns

### Types & Schemas
- All types and Zod schemas live in `packages/core/src/types.ts`
- Pipeline stages: triage, await-approval, reproduce, implement, test, review
- `AnyDb` type exported from `db/client.ts` for SQLite/Postgres union handling

### Pipeline Flow
- Webhook → parse → route by label → clone → worktree → execute stages → push → PR
- RALPH loops: iterative requirements checking on implement stage (configurable)
- Handoff extraction: git-diff-based (deterministic, no agent subprocess)
- Validation gate: haiku agent verifies handoff accuracy after each non-final stage (skipped on last stage to save tokens)
- Handoff compression: only blocking review findings passed downstream (warnings/suggestions omitted with count)
- **RALPH gate**: after implement, RALPH checks acceptance criteria. If unsatisfied after `ralphIterations` (default 2), PR is created as **draft** with gap comments. Last iteration skips re-implement (no verification slot left). RALPH result tracked via `ralphSatisfied` / `ralphGaps`.
- **Draft PRs**: created when RALPH is unsatisfied OR blocking review findings remain after review-fix loop. Draft body includes summary, files changed, and gap analysis. PR comments detail RALPH gaps, review findings, and suggested next steps. Draft PRs skip auto-merge and GitHub feedback webhook.
- **Implement prompt verification**: agent must verify each acceptance criterion before declaring completion. Implement template includes explicit INTEGRATION REQUIREMENT: new exports must be called from existing code, documentation must be updated for new config/behavior, tests must cover the integration path. Review prompt cross-references diff against acceptance criteria, flags unaddressed criteria as blocking `"incomplete-implementation"` findings.
- **Dead code detection**: RALPH verification and review stage both check for new exports that are only referenced in their definition file and test file — flagged as gaps/blocking findings respectively. This prevents the common failure mode where agent creates a utility but never wires it into the pipeline.
- **Documentation enforcement**: Triage generates ACs requiring doc updates when applicable. RALPH and review stage verify CLAUDE.md/README.md updates for new config, CLI flags, or behavior changes.
- **Scratch-file denylist gate** (Tier 1a, `packages/core/src/pipeline/scratch-file-guard.ts`): runs after all stages and the org-policy gate, before the push queue. Scans `git diff --diff-filter=A origin/<base>...HEAD` plus `git status --porcelain` (untracked / staged adds) and flags any path matching the denylist: `*.bak`, `*.bak.*`, repo-root `TEST_*.md` / `TESTING_*.md` / `FINAL_*.md` / `*_REPORT.md` / `*_CHECKLIST.md`, repo-root `commit-*.sh` / `run-*.sh`, `*.tmp` anywhere, `*.log` anywhere, and any new repo-root `*.md` outside the standard documentation exemption set (`README.md`, `CLAUDE.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `LICENSE.md`, `AUTHORS.md`; case-insensitive). On match the gate pushes one `category: "scratch-files"` blocking `ReviewFinding` per file, forces `shouldDraft = true`, and emits a `pipeline.scratch_files_blocked` audit event (payload includes matched paths, capped at 50). Escape hatch: `URATEAM_DISABLE_SCRATCH_GUARD=true` short-circuits the gate. The gate never deletes files; the operator decides.
- Auto-merge: configurable for trivial PRs (diff < maxLines, no blocking findings, no excluded file patterns). `autoMergeExcludePatterns` supports glob patterns (e.g. `**/migrations/**`). Auto-merge decisions logged to DB (`autoMerged`, `autoMergeReason` columns).
- Token budget: optional maxTokens with 80% alert and hard abort
- Per-stage model override: `stageModels` map in `PipelineConfig` (e.g. `{ implement: "claude-opus-4-6" }`); resolved as `config.stageModels?.[stage] ?? profile.model`
- Transient failure recovery: auth/network/rate-limit errors classified as `"retriable"`, worktree preserved, PM Agent auto-resumes on next tick (max 3 retries)
- Worktree auto-recovery: `createWorktree` detects both "already checked out" and "already used by worktree" errors (urateam#112), force-removes the stale worktree, runs `git worktree prune` to clear metadata (BEC-179), and retries with idempotent `-B <branch>` to guarantee the worktree HEAD is on a symbolic ref (not detached)
- GitHub PR feedback: `/webhooks/github` receives PR review comments (`pull_request_review`, `pull_request_review_comment`) and regular PR comments (`issue_comment`), triggers `review-feedback` pipeline runs that check out the existing branch and address comments. Supports `@ateam` trigger keyword from the regular PR comment box.

### Claude Authentication
- Three supported paths (full guide in `deploy/CLAUDE_AUTH.md`):
  1. `ANTHROPIC_API_KEY` — long-lived API key, pay-per-token. Recommended for production.
  2. `CLAUDE_CODE_OAUTH_TOKEN` — long-lived programmatic OAuth token from `claude setup-token`. Bills against Pro/Max subscription. Recommended for subscription users on headless deploys.
  3. Local `claude login` session — mounted credentials at `~/.config/claude/`. Convenient for local dev but **expires weekly**; not for production.
- Precedence: `CLAUDE_CODE_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` → local session.
- `preflightClaudeAuth` (`packages/cli/src/lib/preflight-claude-auth.ts`) gates boot on session validity. No-op when either env var is set (those have no session-lifetime semantics).
- BEC-207 tracks adding first-class `CLAUDE_CODE_OAUTH_TOKEN` support to the executor — currently only the local CLI session path is wired up.

### Agent Execution
- Agent SDK `query()` with per-stage MCP server + plugin resolution
- `consumeAgentStream()` shared helper for all agent message iteration
- `parseJsonBlock()` shared helper for JSON extraction from agent output
- `buildStagePermissionOptions()` for per-stage permission modes
- Devcontainer support (auto/always/never mode)
- CLAUDE.md injected into worktrees (git-excluded via .git/info/exclude)

### PM Agent (`packages/core/src/pm/`)
- Autonomous backlog manager running on cron (default 30 min)
- Tick sequence: budget check → **recover retriable runs** → recover stuck In Progress → **startTodoIssues** → triage → resolve approvals → promote → deprioritize → cancel → digest
- **startTodoIssues** (`actions/start-todo.ts`): scans Linear for issues in "Todo" state with no active pipeline run, starts pipelines for orphans. Closes the gap when webhooks are missed or process restarts with issues already in Todo. Respects maxInFlight budget.
- **Multi-repo routing (BEC-177)**: `RepoConfig` supports an optional `labelPattern` field. `selectRepoConfig()` (`actions/select-repo-config.ts`) selects the repo by label-pattern match first, falling back to teamId/projectId key lookup. Wired into both `start-todo.ts` and `webhook/handler.ts`. Configure by adding `labelPattern: "observer-fix"` to a `RepoConfig` entry; tickets with that pipeline label will clone that repo. Backwards compatible — existing teamId-keyed configs need no changes.
- Triage: Claude Haiku classifies issues, adds pipeline label (`auto-implement`/`bug`/`quick-fix`), generates acceptance criteria and appends to issue description (for RALPH)
- Promote: moves highest-priority non-conflicting issues to "Todo" (triggers webhook pipeline). Runs AFTER startTodoIssues so existing orphaned issues fill slots first.
- Approval-gated: deprioritize/cancel require Slack reaction approval (48h timeout) via shared `requestApprovalIfNotPending()`
- Conflict detection: git diff for active branches + Claude prediction for candidates
- Slack interface (`slack-interface.ts`): slash commands, @mentions, natural language via Haiku
- Shared helpers: `call-claude.ts` (Haiku factory), `slack-helpers.ts` (postSlackMessage), `linear-helpers.ts` (`resolveWorkflowStates`, `createLazyLinearClient`), `approval-helpers.ts`
- **`PM_AGENT_PAUSED=true` env var** (BEC-170): pauses promote/start-todo/recover-stuck without stopping the container. OR'd with the Slack `/pm pause` state — either source can pause independently. Requires a container restart to toggle (env vars read at each tick). Boot log emits the setting at startup.
- `parseJsonObject()` in `agent-stream.ts` for bare JSON extraction from Claude responses
- **Key design:** PM Agent's promote action moves issues in Linear (triggering webhooks). The `startTodoIssues` action directly calls `runner.start()` as a fallback for missed webhooks.
- **Circuit breaker (BEC-161):** `promoteReadyIssues` and `startTodoIssues` pre-fetch failure counts for all candidates in a single DB round-trip via `batchCountConsecutiveFailures(db, issueIds)` (BEC-181 batch optimization; avoids N+1 per candidate). If the count ≥ `maxConsecutiveFailures` (default 3), the issue is skipped and a `pm.skipped_circuit_breaker` audit event is written. This prevents the recover-stuck → promote → start-todo → fail doom loop. To verify the breaker is active, query `audit_events WHERE event_type = 'pm.skipped_circuit_breaker'`. To disable, set `maxConsecutiveFailures: 0` in the PM config. See also: `docs/superpowers/runbooks/2026-05-08-bec-181-circuit-breaker-verification.md`.
- **Zombie run recovery (BEC-184):** `recoverStuckInProgressIssues` now also detects pipeline runs that have been `status='running'` for longer than `PM_AGENT_STUCK_RUN_AGE_MIN` minutes (default 60). When detected: marks the `pipeline_runs` row `status='failed'` with `error_message='recovered: running > N min with no completion'`, moves the Linear issue to `stuckIssueTargetState`, and emits a `pm.recovered_long_running` audit event. Defence-in-depth: complements (not replaces) executor-level stall fixes. `getActiveAndRecentIssueIds` in `db-queries.ts` accepts `stuckRunAgeMs` — running runs older than this threshold are excluded from `activeIssueIds` so they fall through to stuck detection.

### Linear SDK Lazy Relations
- **All relation fields** on Linear SDK objects (`.team`, `.state`, `.project`, `.assignee`, etc.) are **lazy Promise-like** — sync access like `issue.team?.id` returns `undefined`
- **Always await**: `const team = await issue.team; const teamId = team?.id;`
- **`.labels` is a method, not a property**: use `const labels = await issue.labels();` (not `await issue.labels`). It returns `LinearFetch<IssueLabelConnection>` — the `()` is required.
- This applies to: issue objects in triage/promote/startTodo, workflow state objects in resolveWorkflowStates, and any other SDK model with relation fields
- Failure mode: silent `undefined` — no error thrown, just missing data that causes downstream lookups to fail

### Agent SDK Stream Handling
- `consumeAgentStream()` handles two message shapes:
  - `message.content` — tool-using sessions (executor stages)
  - `message.message` — no-tool sessions (PM Agent Haiku calls with `allowedTools: []`)
- Always use `consumeAgentStream` — never hand-roll stream iteration
- **Pre-stream stall protection (BEC-183):** Two-layer defence against hung stages:
  1. `firstMessageTimeoutMs` (default 5 min) in `consumeAgentStream` — throws `StagePreStreamStalledError` if no message arrives before the deadline. Covers SDK hangs before the first message (auth-retry loop, MCP init failure, never-resolving iterator).
  2. `WALL_CLOCK_STAGE_TIMEOUT_MS` in `executor.ts` — per-stage hard cap (`implement`: 60 min, others: 30 min) via `Promise.race`. Second layer in case the first-message timer somehow fails to fire.
  Both paths throw `StagePreStreamStalledError` → caught in `executeStage` catch block → `stage_runs.status = 'failed'`, run completes normally.
- **`StageStalledError`** — mid-stream silence (after ≥1 message, no output tokens or turns) for `progressTimeoutMs` (default 30 min). See urateam#122.
- **`StagePreStreamStalledError`** — pre-stream hang (no first message) within `firstMessageTimeoutMs` (default 5 min). See BEC-183. Exported from `executor/index.ts`.

### Notifiers
- Linear: issue comments + state transitions (In Progress → In Review → Done)
- Slack: Block Kit messages with human review alerts
- Discord: embed-based notifications
- Composite: fan-out with Promise.allSettled isolation

### Database
- Drizzle ORM with SQLite (dev) / PostgreSQL (prod)
- Auto-detect driver from DATABASE_URL prefix
- Batch agent_logs inserts (flush every 20)
- **Unified schema with crossTimestamp (BEC-89, PR #153):** Single `db/schema.ts` using `crossTimestamp` custom Drizzle type. `_setSchemaDriver()` called by `createDb()` switches serialization between epoch integers (SQLite) and ISO strings (Postgres). All Postgres timestamp columns are now TIMESTAMPTZ (migrated from INTEGER in PR #153).
- **crossTimestamp works natively on both drivers:** Drizzle's `gte()`, `lt()`, `eq()` operators work correctly on crossTimestamp columns for both SQLite and Postgres. No raw SQL workarounds needed.
- **Migrations:** `MIGRATION_COLUMNS` array in `client.ts` generates driver-appropriate ALTER TABLE statements. `getCreateTablesDDL(driver)` generates CREATE TABLE with correct types per driver. File-based migrations in `db/migrations/` run automatically on startup via `runMigrationsPostgres()` / `runMigrationsSqlite()` called from `createDb()`.
- Webhook dedup uses `webhookDedup` table with DB-backed storage (survives restarts). Falls back to in-memory when no DB provided.
- **Postgres SQL helpers:** `sqlDateGroup(db, col)` formats timestamps as 'YYYY-MM-DD'. `sqlDaysAgoFilter(db, col, days)` filters recent rows. Both are driver-aware (no `isPostgres()` branching needed in application code).

### Git Operations
- `gitExec()` — throwing, with structured logging and timeout
- `gitExecSafe()` — non-throwing, returns "" on failure
- `gitExecRaw()` — preserves leading whitespace (for porcelain output)
- `checkDuplicateBranch()` — server-side filtered ls-remote
- `rebaseBranch()` — returns `{ success, hasConflicts }` for push queue conflict resolution
- `verifyBranchMatch(worktreePath, expectedBranch)` — throws if HEAD ≠ expected branch (cross-contamination guard)
- `installPrePushHook(repoDir)` — idempotent; writes `.git/hooks/pre-push` that aborts pushes when HEAD ≠ remote ref
- PR creation via `gh` CLI (fallback), GitHub App (Octokit), or GitLab REST API

### Worktree Isolation Model & Parallel Agent Dispatch Safety (BEC-99)

**Shared `.git` directory limitation:** `git worktree add` creates a separate working directory with its own `HEAD`, but all worktrees of the same clone share **one** `.git/` directory and **one** object database. This has important implications for parallel agent dispatch:

- **Each worktree has its own HEAD.** Running `git checkout <branch>` inside worktree A only changes that worktree's HEAD — it does not affect worktree B.
- **Cross-branch contamination risk.** If an agent (or a tool it invokes) runs `git checkout <other-branch>` inside its assigned worktree, subsequent commits and pushes will silently land on the wrong branch. This caused the contamination described in BEC-99.
- **Contamination guards.** Three defences are in place (as of BEC-99):
  1. `autoCommitChanges(path, issueId, expectedBranch)` — verifies HEAD = expectedBranch before staging/committing; throws on mismatch.
  2. `pushBranch` / `pushBranchForce` — call `verifyBranchMatch` before every push.
  3. `installPrePushHook` — installs a `.git/hooks/pre-push` script (shared across all worktrees) that aborts the push if HEAD ≠ the remote ref being pushed.

**Safe patterns for parallel agent dispatch:**
- ✅ Use `isolation: "worktree"` — each agent gets its own working directory with a locked HEAD.
- ✅ Never instruct agents to run `git checkout <other-branch>` inside their worktree.
- ✅ For truly isolated parallel work with no `.git` sharing, use separate repo clones (`cloneRepo` to distinct directories).
- ❌ Do **not** reuse the same branch name across concurrent runs (`-B` resets the ref to HEAD, orphaning prior commits).

**Recovering from contaminated branches (cherry-pick procedure):**
1. Identify the correct SHAs: `git log --oneline --all | grep "<issue-id>"` to find commits that landed on the wrong branch.
2. Check out the correct target branch: `git checkout agent/<correct-issue>-<slug>`.
3. Cherry-pick the stray commit: `git cherry-pick <sha>`.
4. Force-push the corrected branch: `git push --force-with-lease origin agent/<correct-issue>-<slug>`.
5. On the contaminated branch, remove the stray commit: `git rebase -i --onto <parent-sha> <stray-sha> HEAD` or `git reset --hard <pre-stray-sha>`, then `git push --force-with-lease`.

### Audit log (Enterprise feature 4.2)
- Append-only `audit_events` table + read-time projection from `pipeline_runs`, `pm_approvals`, `budget_alerts` (no run-data duplication)
- Module: `packages/core/src/audit/` — `events.ts` (typed builders), `writer.ts` (`logAuditEvent`, fire-and-forget; license-gated, returns no-op if `audit-log` feature unlicensed), `reader.ts` (`listAuditEvents` with cursor pagination), `projection.ts`, `retention.ts` (`pruneAuditLog` — sole authorized mutation), `csv.ts` (`streamAuditCsv` async iterator)
- 41 event types (canonical list in `AuditEventTypeSchema` at `packages/core/src/types.ts`): `run.{started,completed,failed,auto_merged,auto_merge_skipped,cancelled}`, `system.halted`, `pm.{approval_requested,approval_resolved,issue_promoted,issue_deprioritized,issue_cancelled,triage_classified,agent_branch_swept,skipped_circuit_breaker,recovered_long_running}`, `budget.{alert_fired,run_refused}`, `license.validation_failed`, `config.loaded`, `claude.auth_expired` (BEC-207, AuthMonitor), `dashboard.{manual_action,login,logout,login_denied}`, `policy.{path_blocked,cost_exceeded,override_used,reviewers_requested}`, `release.{fired,skipped,approved,tag_conflict,partial}`, `slack.post_failed`, `qa.{run_triggered,run_completed,gap_issue_filed}`, `review.{fanout_fallback_used,model_low_output_ratio}`, `pipeline.scratch_files_blocked` (Tier 1a). Tier 1d adds a unit test that fails when this count diverges from the schema.
- Write sites: `pm/scheduler.ts` (budget refused, including `maxInFlight` blocks), `pm/actions/promote.ts`, `pm/actions/triage.ts`, `pm/actions/resolve-approvals.ts` (deprioritize/cancel — emitted on actual execution, not approval request), `license.ts` + `executor/auth-monitor.ts` (both via `logAuditEventUnchecked` — base-tier operational signals that must surface regardless of `audit-log` license), `cli/commands/run.ts` (`config.loaded`)
- **Immutability is convention-only**, enforced by `packages/core/src/__tests__/audit-immutability.test.ts` (greps for `delete(auditEvents)` / `update(auditEvents)`; only `audit/retention.ts` is allow-listed). Adding a new mutation site requires updating the allow-list.
- Reader merges native rows + projected rows by `(timestamp DESC, id DESC)` and supports cursor-based SQL filtering on all 4 sources to avoid pagination truncation
- Dashboard route: `/audit` (filter bar, HTMX pagination), `/audit/page` (partial), `/audit/export.csv` (streamed). All return 404 unless `isFeatureLicensed("audit-log")`. View: `packages/dashboard/src/views/audit.ts` — all user-controlled fields go through `escapeHtml`
- Retention sweep runs in PM tick after `digest`, default 365 days, configurable via `auditLog.retentionDays`. Tick step is gated on `isFeatureLicensed("audit-log")`
- **`config.loaded` event fires from all CLI paths** — `ura run` fingerprints the config file; `ura dev` / `ura start` emit with `path: "(env-vars)"` and a hash of pipeline config keys.
- `/audit/event/:id` HTMX detail expansion: each row has a `+` button that hx-gets this route; server resolves the ID (native audit_events or projected `proj_*` synthetic IDs) via `findAuditEventById()` and returns a detail `<tr>` with the full formatted payload. Projected ID prefixes routed to source tables: `proj_run_*_<runId>` → pipeline_runs, `proj_approval_*_<approvalId>` → pm_approvals, `proj_budget_alert_<alertId>` → budget_alerts.

### SSO via WorkOS (Enterprise feature 4.1)
- Module: `packages/core/src/auth/` — `sso-config.ts` (zod schema, `signState`/`verifyState`/`validateNextPath` HMAC helpers), `user-store.ts` (`upsertUser` via atomic `onConflictDoUpdate`, `getUserById`), `session-store.ts` (`createSession`, `getSession`, `deleteSession`, `pruneExpiredSessions`, `touchSessionLastSeen`), `workos-client.ts` (DI seam over `@workos-inc/node`)
- Tables: `dashboard_users` and `dashboard_sessions` (both via `crossTimestamp`)
- Dashboard middleware: `packages/dashboard/src/middleware/sso.ts` — cookie → session → user → `c.set("user", ...)`. Skips `/auth/*` and `/webhooks/*`
- Routes: `packages/dashboard/src/routes/auth.ts` — `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`
- Server wiring: `packages/dashboard/src/server.ts` mounts SSO stack iff `isFeatureLicensed("sso") && config.sso?.enabled === true`. Otherwise basicAuth (or 503). Mutually exclusive
- CLI bootstrap: `packages/cli/src/sso-bootstrap.ts` reads env vars (`URATEAM_WORKOS_API_KEY`, `URATEAM_WORKOS_CLIENT_ID`, `URATEAM_WORKOS_REDIRECT_URI`, `URATEAM_SSO_STATE_SECRET`, `URATEAM_SSO_ALLOWED_DOMAIN`, `URATEAM_SSO_ENABLED`), validates, instantiates the WorkOS client, returns `{ sso, workos }`. Used from both `start.ts` and `dev.ts`
- CSRF: `/auth/login` and `/auth/callback` bypass CSRF (GET); `/auth/logout` is CSRF-protected. Sign-out uses `hx-post` with `HX-Request: true` header to satisfy the dashboard CSRF middleware
- Audit events: `dashboard.login`, `dashboard.logout`, `dashboard.login_denied` flow through the existing license-gated `logAuditEvent`
- Retention: PM tick calls `pruneExpiredSessions` after `pruneAuditLog`, gated on the SSO feature
- Setup doc: `deploy/SSO_SETUP.md`
- **Sign Out link** renders on all dashboard pages when SSO is active (user context threaded through all route handlers)
- **Session id MUST NOT be logged** — they're credentials. The `touchSessionLastSeen` warn logs only `idPrefix: id.slice(0,8) + "…"`

### Org policy / guardrails (Enterprise feature 4.6)
- Module: `packages/core/src/policy/` — `path-gate.ts`, `cost-gate.ts`, `reviewer-gate.ts`, `override.ts`, `evaluate.ts` (orchestrator)
- Config: `PipelineConfig.policy = { pathBlocklist, maxTokensPerIssue, overrideLabel, mandatoryReviewers: { users, teams } }` — per-pipeline
- Path gate: uses `matchesAnyPattern` from `util/glob.ts` (not `pipeline/runner.ts` — moved to break a circular dep)
- Cost gate: checks `run.totalInputTokens + run.totalOutputTokens` once after all stages complete (cumulative snapshot); the `stage` field in the audit event is `"all-stages"`
- Override: `hasOverrideLabel(issue, labelName)` — case-insensitive Linear label check. **SECURITY NOTE: the override bypass relies on Linear label creation being restricted to authorized team members** — operators should scope the `overrideLabel` to principals they trust
- Reviewer gate: `buildReviewerRequest` builds `{users, teams}`; PR creation threads it through `createPRViaCli`, GitHub App `createPR`, and GitLab `createMR` (warn-only on GitLab); auto-merge is blocked until `verifyApprovalsReceived` returns satisfied
- Reviewer gate fires on **GitHub App path only** at auto-merge — `gh` CLI fallback has no API client; CLI path still passes `--reviewer` args at PR creation
- Violations set `run.shouldDraft = true` and push `ReviewFinding` entries (`category: "policy-path" | "policy-cost"`) into `unresolvedBlockingFindings` — flows through the existing draft-PR renderer
- Audit events: `policy.path_blocked`, `policy.cost_exceeded`, `policy.override_used`, `policy.reviewers_requested`
- License gate: `isFeatureLicensed("org-policy")` required at every call site
- **Team membership cache**: `verifyApprovalsReceived` caches `listMembersInOrg` results in a module-level TTL map keyed by `(org, team_slug)`. Default TTL is 15 minutes. Tests can clear via `_clearTeamMembershipCache()`. Previously uncached — high-frequency CI webhooks on a PR with 5+ required teams could exhaust GitHub's secondary rate limit.

### Cost & ROI dashboard (Enterprise feature 4.5)
- Module: `packages/core/src/cost/` — `rates.ts` (model-rate + time-saved resolution), `per-run.ts` (`computeRunCost`), `aggregate.ts` (`aggregateAll` over runs+stages with 10k row cap + `truncated` flag), `rollup.ts` (`recomputeCostRollups`, `readRollupWindow`), `csv.ts` (`streamCostCsv` with formula-injection guard)
- Config: `AppConfig.costs = { modelPricing, hourlyEngRate, timeSavedPerPrDefault }`. Per-pipeline `PipelineConfig.timeSavedPerPr` override. Defaults: $50/h eng rate, 4h per PR, Anthropic list pricing
- Per-run cost = Σ(stage_runs.input/output tokens × model rate). Model per stage = `pipelineConfig.stageModels[stage] ?? pipelineConfig.profile.model ?? "claude-sonnet-4-6"`
- Time saved = `count(completed runs) × resolveTimeSavedPerPr(pipelineKey)`. ROI = `(timeSavedHours × hourlyEngRate) / dollars`
- New table: `cost_rollups_daily` — rebuilt nightly in PM tick via `recomputeCostRollups`. **Uses `""` empty-string sentinel instead of NULL for `linear_team_id`** so composite UNIQUE `(date, pipeline_key, linear_team_id, repo_url)` fires correctly with `onConflictDoUpdate` on both SQLite and Postgres
- Day boundary: half-open `[start, end)` with `lt` (not `lte`) to avoid sub-millisecond precision drops on Postgres `TIMESTAMPTZ`
- Dashboard route `/cost` — summary card + daily-cost sparkline (inline SVG, no JS, CSP-safe) + 3 breakdown tables (team/repo/pipeline) + collapsible formula footer + CSV export at `/cost/export.csv`. All 3 routes 404 unless `isFeatureLicensed("cost-roi")`
- **`AggregateResult.byDay`**: per-UTC-day time series populated by both `aggregateAll` (buckets runs by completion date) and `aggregateFromRollups` (one entry per rollup row's `date`). Sorted ascending. Used for sparkline rendering via `renderCostChart()` in `packages/dashboard/src/views/cost.ts`. Returns empty string for fewer than 2 data points.
- **10k run cap on `aggregateAll`**: when exceeded, results are truncated to the 10k most recent and `summary.truncated = true`; dashboard shows a warning banner
- Preset windows (7d/30d/90d/365d) use `aggregateHybrid` — pre-computed rollup rows for whole UTC days before today, plus live `aggregateAll` for today's partial data, merged into one `AggregateResult`. Custom ranges bypass rollups via `opts.enableRollups = false` since arbitrary `from` times don't align to UTC day boundaries. Preset `from` is snapped to UTC midnight via `snapToUtcDayStart`.
- **Rollup rows are immutable snapshots**: `dollars` and `timeSavedHours` are baked in at rollup compute time using the `modelPricing` and `timeSavedPerPr` config in effect then. Changing those config values later affects only future rollup recomputations, not historical rows. The dashboard's historical view will not backfill pricing changes.
- **Fresh deployment caveat**: on a fresh deployment (before the first PM tick runs `recomputeCostRollups`), preset windows show only today's live data. Rollup rows populate after the first nightly tick.

### RBAC / multi-user (Enterprise feature 4.4)
- Module: `packages/core/src/rbac/` — `matrix.ts` (PERMISSION_MATRIX + canAccess), `user-role-store.ts` (setUserRole, getUserRole, listUsers, applyBootstrapAdmins), `errors.ts` (SelfDemoteError, LastAdminError)
- Schema: added `role TEXT NOT NULL DEFAULT 'viewer'` to `dashboard_users` via MIGRATION_COLUMNS
- Three roles: `admin`, `operator`, `viewer`. Global-only in v1 — scoped roles (per team/repo) deferred to v2 via a new `user_scope_roles` table
- Middleware: `packages/dashboard/src/middleware/rbac.ts` — `requirePermission(action)` decorates routes, returns 403 on insufficient role, no-op when feature unlicensed
- **`getUserById` MUST include `role`** — the SSO middleware reads it from the returned `DashboardUser` and the RBAC middleware reads `user.role`. Dropping it silently makes every user 403
- Bootstrap: `URATEAM_ADMIN_EMAILS` env var — comma-separated list, case-insensitive. Fire-and-forget from `/auth/callback` via `applyBootstrapAdmins`
- Admin UI: `/users` dashboard page (admin-only) with role dropdown per user. CSRF via `HX-Request` header
- CLI: `ura admin list/grant/revoke` — for emergency recovery and scripted management
- Audit: four `dashboard.manual_action` subtypes — `grant_role`, `revoke_role`, `bootstrap_admin`, `retry_run`. No new `AuditEventTypeSchema` entries
- Write actions in v1: only `POST /runs/:id/retry` (operator+admin, license-gated to 404 when unlicensed). Others (abort, approve, cancel) deferred
- Guardrails: `setUserRole` wraps SELECT+COUNT+UPDATE in a transaction (SQLite `BEGIN IMMEDIATE`; Postgres `db.transaction()`) to prevent the TOCTOU race on last-admin demotion
- Setup doc: `deploy/RBAC_SETUP.md`

### Operator stop & container halt (`packages/core/src/pipeline/control-signals.ts`)
- **Single-run stop** (`requestStop(runId, mode)`): two modes — `"cancel"` aborts the active Agent SDK stream via an `AbortController` wired into `consumeAgentStream`; `"graceful"` lets the current stage finish, then the runner skips remaining stages at the per-stage signal check at the top of the stage loop. Both land the run in `status: "cancelled"` (distinct from `"aborted"` which is reserved for system-initiated aborts).
- **Container halt** (`PipelineRunner.haltAll()`): sets `setPmPaused(true)` (same flag as BEC-170 / Slack `/pm pause`) AND sends `cancel` to every entry in `activeRuns` + `activeFeedbackRuns`. Reversible via `/pm resume` (in-flight cancellations themselves stay cancelled).
- **Three surfaces**, all funnel through `Runner.requestStop` / `Runner.haltAll`:
  - **Dashboard**: `POST /runs/:id/cancel`, `POST /runs/:id/stop`, `POST /admin/halt-all` — RBAC-gated (`runs.stop`, `system.halt`), CSRF-protected via `HX-Request` header. Buttons in the run-detail meta card. Routes 404 when RBAC is unlicensed.
  - **CLI**: `ura stop <runId> [--graceful]`, `ura halt` — POST to `/cli/runs/:id/{cancel,stop}` and `/cli/halt-all`. Auth: `URATEAM_CLI_TOKEN` shared secret in `X-Ura-Cli-Token`; routes 404 when the env var is unset. Works regardless of RBAC license.
  - **Slack**: `/pm cancel <runId>`, `/pm stop <runId>`, `/pm halt`. Reacts with 🤔 on receipt of an app_mention / message; swaps to ✅ / ⚠️ on completion. Slash commands return an immediate ephemeral "Working on it…" and post the real reply via `response_url` so slow commands don't trip Slack's 3s timeout.
- **Audit events**: `run.cancelled` per stopped run (`mode`, `actor`, `actorType`), and `system.halted` for halt-all (`cancelledRunIds`, `cancelledCount`). `actorType` distinguishes `dashboard-user` / `cli` / `slack`.
- **Single-process state caveat**: signal map lives in memory; resets on container restart. Cross-container coordination (Redis) intentionally out of scope.
- Setup doc: `deploy/STOP_AND_HALT.md`.

### Coordination (`packages/core/src/pm/coordination.ts`)
- DB-backed `active_work` table tracks files modified by in-flight pipeline runs
- `upsertActiveWork` uses atomic `onConflictDoUpdate` (requires UNIQUE on `run_id`)
- `removeActiveWork` called in runner's `finally` block and `abort()` method
- `checkFileOverlap` compares candidate files against active runs

### Quality Observer (`packages/observers/`)
- Module: `packages/observers/src/` — `engine.ts` (isFirstTick, seedDedupOnFirstTick, processFindings), `scheduler.ts` (createObserverScheduler), `store.ts` (SQLite-backed ObserverStore), `types.ts`
- **First-tick dedup seeding (BEC-172):** On a fresh deploy the observer's SQLite store is empty. Without special handling, the 24h lookback window causes every historical pattern to be filed as a GitHub Issue at once. `scheduler.tick()` calls `isFirstTick(store)` before computing findings. If true (and `QUALITY_OBSERVER_FIRST_TICK_FILE` is not set), calls `seedDedupOnFirstTick(store, computeFindings)` which writes fingerprints without filing issues, then logs `"first-tick seed: N findings registered for dedup; not filed (observer is fresh-installed)"`.
- `isFirstTick(store)` returns true when `observer_findings` is empty OR `meta.firstTickAt` row is absent.
- `QUALITY_OBSERVER_FIRST_TICK_FILE=true` env var bypasses seeding and files normally on first tick (CI / deliberate-reset use case). Also configurable programmatically via `ObserverSchedulerDeps.firstTickFile`.
- SQLite tables: `observer_findings` (fingerprint + timestamp), `observer_meta` (key/value, stores `firstTickAt`)
- `createObserverScheduler(deps)` accepts pluggable `computeFindings` and `fileGithubIssue` functions — the observers package does not depend on `@urateam/core`.
- **PM Agent observer-origin gate:** Every GitHub issue filed by the quality observer embeds `<!-- urateam-qo-observer: <id> -->` in the body. `gh-linear-sync` copies the body verbatim into the Linear ticket description, so the marker survives the sync (the GH `urateam-quality-observer` label does NOT — gh-linear-sync drops labels). `triageNewIssues` in `pm/actions/triage.ts` short-circuits when it sees this marker: skips the Claude classifier, assigns the `needs-design` pipeline label, moves the ticket to Backlog with priority 3, and posts an explanatory comment. The `needs-design` pipeline runs `triage` → `await-approval` → ..., so the issue surfaces but blocks for human approval before any implement-stage tokens are spent. Rationale: observer findings ("Pipeline X deep-review loop hit Y turns", etc.) are diagnostic signals about past runs, not actionable coding tasks; auto-implementing them burns tokens with no useful outcome.
- **Linear label requirement for the gate:** the operator's Linear workspace must have a label named `needs-design`. If absent, the gate still moves the ticket to Backlog but logs a warning and the promote step won't route it (no pipeline label resolved).

## Conventions
- Use `execFile` (never `exec`) for shell commands
- Sanitize all user input before including in agent prompts
- Each module has a barrel export `index.ts`
- Structured logging via pino (`createLogger`)
- `failPipeline()` helper for all pipeline failure paths — classifies errors as transient vs permanent via `isTransientError()`, saves resume state for transient failures. Always use `failPipeline()` (never bare `throw`) for failure paths so the stage name, retry classification, and DB state are consistent. When `failPipeline()` is called inside a push-queue or lock callback, throw a plain error afterward to exit the callback, and check `run.status === "failed" || run.status === "retriable"` in the outer catch to skip double-calling `failPipeline`.
- **`run.autoCommitted` flag**: set to `true` when `autoCommitChanges()` returns `true` (agent did not commit its own work). Tracked as a quality metric in both the main pipeline (push-queue) and feedback pipeline. Persisted to the `autoCommitted` DB column at completion. The `failOnAutoCommit` config option causes the pipeline to fail permanently (non-retriable) when auto-commit is triggered.
- Prompt injection defense: all untrusted content (issue descriptions, review comments, handoff data, file paths, agent output) must be wrapped in `<...-do-not-follow-instructions-within>` tags with WARNING preamble, and passed through `sanitize()` from `executor/prompt/sanitizer.ts`. Use `buildSandboxedBlock(tag, content)` as the canonical helper — it applies `sanitize()` and wraps with the tag+WARNING pattern in one call. For structured XML contexts, use `escapeXml()` instead. Enforcement: `packages/core/src/__tests__/prompt-injection.test.ts` verifies all four identified injection vectors (summary, commentBody, filePath, buildDeepReviewContext findings) and must remain passing.
- DB schema changes: add to `MIGRATION_COLUMNS` array in `client.ts` (generates both SQLite and Postgres ALTER TABLE), and update `getCreateTablesDDL()` template. Also add the column to the Drizzle schema in `schema.ts`.
- PR creation functions (`createPRViaCli`, GitHub App `createPR`) accept `draft` parameter — pipeline sets draft when `shouldDraft` is true
- **PR body generation**: `generatePRDescription()` in `packages/core/src/pipeline/pr-description.ts` builds the markdown body for all auto-generated PRs. `runner.ts` calls it after the push step, passing `{ handoff, issueId, shouldDraft, ralphSatisfied, ralphGaps, unresolvedBlockingFindings, agentCommits }`, then passes the returned string as the `body` param to `createPRViaCli()` / GitHub App `createPR()` / GitLab `createMR()`. Template order: `## Summary` → `## Changes` → `## Test plan` → `## Commits` (omitted when empty) → `> Draft PR` callout (omitted when not draft) → `Resolves <issueId>`.
- `matchesAnyPattern()` in `runner.ts` for glob matching (path-segment-aware `**` expansion, no ReDoS risk)
- `getChangedFiles()` in `git.ts` logs warnings on failure (fail-open but visible)
- Optional notifier methods use `?.` convention
- All `console.log/error` replaced with structured logger
- Pipeline labels must match keys in `pipeline/config.ts`: `auto-implement`, `bug`, `quick-fix`, `needs-design`
- Slack url_verification challenge must be handled before signature verification
- Redact credentials from URLs before logging: `url.replace(/:\/\/[^@]+@/, "://[redacted]@")`

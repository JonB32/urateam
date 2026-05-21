# CLAUDE.md

Guidance for Claude Code working in this repository.

> **Foundational reference**: the urateam Constitution at
> `.specify/memory/constitution.md` is the source of truth for the 7 core
> principles that govern the autonomous agent and human-driven work. The
> 9 convention gates, audit-event discipline, and operator-control
> surfaces enforced below all implement principles from that document.
> Amendments require updating both files in the same PR.

## Project Overview

urateam is an autonomous agent system that receives Linear issues via webhooks, runs them through configurable pipelines (triage → implement → test → review), and delivers pull requests powered by Claude.

pnpm monorepo with 4 packages:
- `@urateam/core` — webhook receiver, pipeline runner, agent executor, DB (Drizzle ORM), notifiers, PM Agent
- `@urateam/dashboard` — Hono + HTMX ops dashboard (CSP, CSRF, rate limiting, credential redaction)
- `@urateam/cli` — `ura` command-line tool (user-level via `ura init`/`ura start`, or sidecar via env vars)
- `@urateam/observers` — quality observer (first-tick dedup seeding, GitHub Issues filing, SQLite store)

## Build & Test Commands
- `pnpm install` — install all deps
- `pnpm build` — build all packages (Turborepo)
- `pnpm test` — unit tests, ~60s (excludes `src/__tests__/integration/**`)
- `pnpm test:integration` — heavy git integration tests (BEC-99 cross-worktree, etc.), ~30-40s each sequential
- `cd packages/core && npx vitest --changed` — fastest feedback: only tests affected by uncommitted/recent changes
- `cd packages/core && npx vitest run src/__tests__/<file>.test.ts` — run a specific test file
- `cd packages/core && npx vitest run --config vitest.integration.config.ts` — core integration tests only

## Repository Structure

- `packages/core/` — types, webhook, pipeline, executor, DB, notifiers, security, PM Agent, observers wiring
- `packages/dashboard/` — Hono server + HTMX templates
- `packages/cli/` — entry point for `ura` commands. User-level surface (`ura init` / `ura repo {add,list,remove}` / `ura start` / `ura service {install,uninstall}` / `ura self-auth-linear`) reads `~/.urateam/config.json`; project-level (sidecar) install stays env-var driven. **See `deploy/USER_LEVEL_INSTALL.md`** for service auto-start (launchd plist / systemd-user unit), Linear OAuth flow, cloudflared tunnel supervision (`--tunnel <none|cloudflare-quick|cloudflare-token>`), and config hot-reload semantics. **`ura start` hot-reload caveat:** field changes to `labelPattern` / `testCommand` / `buildCommand` / `teamId` apply live; `url` / `path` / `defaultBranch` log a "restart required" warning instead.
- `packages/observers/` — quality observer (no dep on `@urateam/core`; pluggable `computeFindings` / `fileGithubIssue`)
- `deploy/` — Docker, Caddy, setup scripts, env example, feature setup docs
- `examples/` — example configs (basic, monorepo, multi-repo, custom stages)
- `scripts/` — Linear/GitHub App setup, `gh-linear-sync.ts`
- `docs/` — design specs

### Multi-VCS Providers (BEC-206)

Set `provider` in `RepoConfig`. All three are fully supported.

| Provider | `provider` | Auth | Webhook handler | Signature scheme |
|----------|-----------|------|-----------------|------------------|
| GitHub | `"github"` (default) | GitHub App or `gh` CLI | `/webhooks/github` | `X-Hub-Signature-256` HMAC-SHA256 |
| GitLab | `"gitlab"` | Personal/deploy token | `/webhooks/gitlab` | `X-Gitlab-Token` shared secret |
| Bitbucket | `"bitbucket"` | OAuth token or App Password | `/webhooks/bitbucket` | `X-Hub-Signature-256` HMAC-SHA256 |

- GitLab webhook events to enable: "Comments" + "Merge request events". `ServerConfig.gitlab = { token, host? }`.
- Bitbucket webhook events: "PR: Comment created" + "PR: Fulfilled". `ServerConfig.bitbucket = { accessToken } | { appUsername, appPassword }`.

### GitHub Issues → Linear Sync (BEC-173)

Hourly GitHub Action (`.github/workflows/gh-linear-sync.yml`) syncs open GH issues to Linear Triage tickets. Idempotent via `[GH#NNN]` title prefix and `<!-- gh-linear-sync:N -->` body marker. Entry point `scripts/gh-linear-sync.ts`, logic in `packages/core/src/sync/gh-linear-sync.ts`. Setup: `deploy/GH_LINEAR_SYNC_SETUP.md`.

- **Mental model:** GitHub = inbound (public filings, observer findings). Linear = triage / work tracking / pipeline routing.
- **`GH_LINEAR_SYNC_LABEL_FILTERS`** is comma-separated with **OR semantics** (one `listIssues` per label, deduped). GitHub's REST API does AND on comma-separated labels — this workaround restores the expected union behaviour (BEC-185).
- Bidirectional close-out opt-in: `GH_LINEAR_SYNC_BIDIRECTIONAL_CLOSE=true`.

## Active Codebase Constraints

Things shipping soon — **don't compound them**:
- `AnyDb = any` in `db/client.ts` cascades into ~50 `as any` casts. **Don't add new `(this.db as AnyDb)` casts** (BEC-190 will fix).
- `linearClient: any` in `pm/actions/*` and `pm/linear-helpers.ts`. **Use `LinearClient` from `@linear/sdk`** in new code there.
- Missing indexes on `pipeline_runs` + `pm_approvals`. **Don't add new hot-path queries** scanning these tables until BEC-187 ships.
- New code in `pm/actions/*` must use `resolveIssueRelations(issue)` from `util/linear.ts` (concurrent fetch of team/state/labels). Sequential `await issue.team` / `await issue.state` patterns were removed in BEC-189.

## Key Patterns

### Types & Schemas
All types and Zod schemas live in `packages/core/src/types.ts`. Pipeline stages: `triage`, `await-approval`, `reproduce`, `implement`, `test`, `review`. `AnyDb` type in `db/client.ts` handles SQLite/Postgres union.

### Pipeline Flow

Webhook → parse → route by label → clone → worktree → execute stages → push → PR.

- **RALPH loops**: iterative AC checking on implement (`ralphIterations`, default 2). If unsatisfied after final iteration → **draft PR** with gap comments. Last iteration skips re-implement (no verification slot left).
- **Validation gate**: Haiku verifies handoff accuracy after each non-final stage. Skipped on last stage to save tokens.
- **Handoff compression**: only blocking review findings passed downstream; warnings/suggestions omitted with count.
- **Implement prompt**: agent must verify each AC and integrate new exports (call from existing code, update docs, cover with tests) before declaring completion. Review stage cross-references diff against ACs.
- **Dead-code detection**: RALPH + review flag new exports referenced only in their definition/test file.
- **Doc enforcement**: triage generates doc-update ACs; RALPH + review verify CLAUDE.md/README.md updates for new config, CLI flags, behaviour changes.

**Push-time deterministic gates** (run after all stages + org-policy, before push queue):

| Gate | File | Trigger | Audit event | Escape hatch |
|------|------|---------|-------------|--------------|
| Scratch-file denylist (1a) | `pipeline/scratch-file-guard.ts` | `*.bak`, `*.tmp`, `*.log`, repo-root `TEST_*.md`/`*_REPORT.md`/`commit-*.sh`/non-standard `*.md` (allowlist: README/CLAUDE/CHANGELOG/CONTRIBUTING/SECURITY/CODE_OF_CONDUCT/LICENSE/AUTHORS) | `pipeline.scratch_files_blocked` | `URATEAM_DISABLE_SCRATCH_GUARD=true` |
| Typecheck (1b) | `pipeline/typecheck-gate.ts` | `pnpm -w typecheck` exits non-zero (configurable) | `pipeline.typecheck_failed` | `URATEAM_DISABLE_TYPECHECK_GATE=true` |
| Spec-vs-impl JSDoc (1c) | `pipeline/spec-vs-impl-gate.ts` | JSDoc references `config.X` / `opts.X` / `env.X` / `deps.X` / `options.X` not found anywhere in tracked source | `pipeline.spec_vs_impl_failed` | `URATEAM_DISABLE_SPEC_VS_IMPL_GATE=true` |

Each gate forces `shouldDraft = true` and emits one blocking `ReviewFinding` per match. None deletes files. All fail-open on runner error (logged, swallowed).

- **Project-convention review checklist (Tier 2)**: `security/review-checklist.ts:PROJECT_CONVENTION_CHECKLIST` injects 9 categories into the review prompt — `scratch-files`, `db-ddl-drift`, `audit-bypass-undocumented`, `credential-in-interface`, `spec-vs-impl`, `convention-execfile`, `convention-console`, `convention-throw`, `convention-as-any`. Review defaults to `claude-sonnet-4-6` (never Haiku).
- **Auto-deep-review thresholds (Tier 3)**: `pipeline/auto-deep-review.ts`. Bumps `deepReviewPasses` to ≥1 when diff trips `autoDeepReviewThresholds` (defaults: 5 files / 200 lines / 2 new public exports) AND `deep-review` license active. `deepReviewFindingsAreBlocking` defaults `true` (upgrades all deep-review findings to blocking). Disable: `URATEAM_DISABLE_AUTO_DEEP_REVIEW=true`. Audit: `pipeline.auto_deep_review_bumped`. **BC note**: existing operators with `deepReviewPasses: 1` will see warnings become blocking unless they set `deepReviewFindingsAreBlocking: false`.
- **Review fanout output cap (BEC-164)**: `REVIEW_MODELS_MAX_OUTPUT_TOKENS` (optional) caps `max_tokens` per OpenRouter fanout-model request. Unset = provider default (can be 65536 for gemini-2.5-pro). Non-integer or ≤0 values warn + treated as unset; values <256 emit a low-floor warning but apply. Read at call time. Module: `executor/review/review-provider.ts:parsePositiveIntOrUndefined`.
- **Draft PRs**: created when RALPH unsatisfied OR blocking findings remain. Body includes summary, changed files, gap analysis. Comments detail RALPH gaps + findings + next steps. Skip auto-merge and GitHub-feedback webhook.
- **Auto-merge**: configurable per pipeline (`autoMerge`, `autoMergeMaxLines` default 200, `autoMergeExcludePatterns` globs). DB columns `autoMerged`, `autoMergeReason`. Skip → `notifier.onHumanReviewNeeded()`.
- **Per-stage model override**: `stageModels` map (e.g. `{ implement: "claude-opus-4-6" }`); resolved as `config.stageModels?.[stage] ?? profile.model`.
- **Token budget**: optional `maxTokens` with 80% alert and hard abort.
- **Transient failure recovery**: auth/network/rate-limit classified as `"retriable"`, worktree preserved, PM Agent auto-resumes (max 3 retries).
- **Worktree auto-recovery**: `createWorktree` detects both "already checked out" and "already used by worktree" errors, force-removes the stale worktree, `git worktree prune`, retries with idempotent `-B <branch>` to guarantee HEAD is on a symbolic ref (not detached). See BEC-179.
- **GitHub PR feedback** at `/webhooks/github`: `pull_request_review`, `pull_request_review_comment`, and `issue_comment` (regular PR comments — supports `@ateam` trigger keyword) all trigger `review-feedback` pipeline runs that check out the existing branch.

### Claude Authentication

Three paths (full guide: `deploy/CLAUDE_AUTH.md`):
1. `ANTHROPIC_API_KEY` — long-lived API key, pay-per-token. Recommended for production.
2. `CLAUDE_CODE_OAUTH_TOKEN` — programmatic OAuth token from `claude setup-token`, bills against Pro/Max. Recommended for subscription users on headless deploys.
3. Local `claude login` session at `~/.config/claude/` — convenient for dev but **expires weekly**.

Precedence: `CLAUDE_CODE_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` → local session. `preflightClaudeAuth` (`packages/cli/src/lib/preflight-claude-auth.ts`) gates boot on session validity; no-op when either env var is set. BEC-207 tracks first-class executor support for `CLAUDE_CODE_OAUTH_TOKEN`.

### Agent Execution

- Agent SDK `query()` with per-stage MCP server + plugin resolution
- Shared helpers: `consumeAgentStream()` (always use this — never hand-roll stream iteration), `parseJsonBlock()`, `buildStagePermissionOptions()`
- Devcontainer support (`auto` / `always` / `never`)
- CLAUDE.md injected into worktrees (git-excluded via `.git/info/exclude`)

### Agent SDK Stream Handling

`consumeAgentStream()` handles two message shapes:
- `message.content` — tool-using sessions (executor stages)
- `message.message` — no-tool sessions (PM Agent Haiku calls with `allowedTools: []`)

**Pre-stream stall protection (BEC-183)** — two layers:
1. `firstMessageTimeoutMs` (default 5 min) in `consumeAgentStream` throws `StagePreStreamStalledError` if no message arrives. Covers SDK hangs (auth-retry loop, MCP init failure, never-resolving iterator).
2. `WALL_CLOCK_STAGE_TIMEOUT_MS` in `executor.ts` — per-stage hard cap via `Promise.race` (implement: 60 min; others: 30 min).

Both paths land in `stage_runs.status = 'failed'`. `StageStalledError` is for mid-stream silence (≥1 message, then no output for `progressTimeoutMs`, default 30 min). Exported from `executor/index.ts`.

### Linear SDK Lazy Relations

- All relation fields (`.team`, `.state`, `.project`, `.assignee`, …) are **lazy Promise-like** — sync access returns `undefined` silently with no error
- **Always await**: `const team = await issue.team; const teamId = team?.id;`
- **`.labels` is a method**: `await issue.labels()` (with parens). Returns `LinearFetch<IssueLabelConnection>`.
- Failure mode is silent — missing data causes downstream lookups to fail with no obvious origin.

### Agent Session Continuity (BEC-227)

Each pipeline run mints `agent_session_id = randomUUID()` (when `URATEAM_ENABLE_AGENT_SESSION_RESUME=true`) and threads it through every `executeStage()` call. First resumable stage uses `query({ sessionId })`; subsequent stages use `query({ resume: sessionId })`. The Claude Agent SDK writes JSONL transcripts to `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, mounted as the named volume `urateam-dogfood-agent-sessions` in dogfood compose.

- `isResumable(stage, model)` (`executor/session-policy.ts`) — static rule: stage NOT IN `{validate, ralph-check}` AND model family is `claude-{sonnet,opus}` (Haiku stages stay fresh). Validator + RALPH-check Haiku calls always run fresh; OpenRouter fanout review providers (non-Claude) also stay fresh.
- **Feature flag (Phase 3 — default ON)**: `URATEAM_DISABLE_AGENT_SESSION_RESUME=true` opts out (strict equality — `"1"` / `"yes"` / `"TRUE"` do NOT match). Default: enabled. Read at call time per run, so flipping the var takes effect on the next pipeline run without daemon restart. The Phase-1/2 var `URATEAM_ENABLE_AGENT_SESSION_RESUME` is ignored under Phase 3 (operators with it set in .env see no behavior change since default is now on). Helper: `isAgentSessionResumeEnabled(env?)` in `executor/session-policy.ts`.
- **Fallback**: if `agent_session_id` is null (flag off at run start) OR the JSONL file is missing on disk → legacy handoff path. Audit events `pipeline.agent_session_missing_fallback` and `system.session_volume_warning` capture both. The `<previous-stage-context>` block is suppressed in resumed RALPH iterations (the agent already saw it).
- **Validator skip rule**: `runMode === "resumed"` → skip entirely (the next agent IS the prior agent). Only the FIRST resumed stage runs validation as a paranoia check. `runMode: "first-resumed" | "resumed" | "fallback"` is computed per call-site in `runner.ts`.
- **Track C-1 cache booster**: `excludeDynamicSections: true` on the `claude_code` SDK preset is now ON for every stage regardless of resume state — strips per-session cwd/git-status from the cached prefix, lifting cache hit rate from ~95% toward 99%.
- **Audit events added (BEC-227)**: `pipeline.agent_session_created`, `pipeline.agent_session_resumed`, `pipeline.agent_session_missing_fallback`, `system.session_volume_warning`. (Canonical count comment lives in the Audit log row of the Enterprise Features table — see below.)
- **Zombie-age tuning (BEC-227 / BEC-184)**: `PM_AGENT_STUCK_RUN_AGE_MIN` default raised from 60 → 120 minutes. Real RALPH-iterated implementation work routinely takes 60-90 min; the prior 60-min default produced false-positive reaps on healthy long runs.

Spec: `docs/superpowers/specs/2026-05-19-agent-session-continuity-design.md`. Phase 1 implementation plan: `docs/superpowers/plans/2026-05-19-agent-session-continuity-phase1.md`.

### PM Agent (`packages/core/src/pm/`)

Autonomous backlog manager on cron (default 30 min). Tick sequence:
budget check → **recover retriable runs** → recover stuck In Progress → **startTodoIssues** → triage → resolve approvals → promote → deprioritize → cancel → digest.

- **startTodoIssues** (`actions/start-todo.ts`): scans Linear for issues in "Todo" with no active pipeline run, starts pipelines for orphans (closes the gap when webhooks are missed or process restarts with issues already in Todo). Respects `maxInFlight`.
- **Multi-repo routing (BEC-177)**: `RepoConfig.labelPattern` selects repo by pipeline label first; falls back to teamId/projectId key. Wired in `selectRepoConfig()` (`actions/select-repo-config.ts`), used from both `start-todo.ts` and `webhook/handler.ts`. Backwards compatible.
- **Triage** (Tier 6a+6b — `actions/triage.ts` + `actions/triage-prompt.ts` + `actions/triage-render.ts`): Haiku classifies, adds pipeline label (`auto-implement` / `bug` / `quick-fix` / `needs-design`), appends ACs and Tier-6b sections to issue description for RALPH + implement-stage consumption. The **v2 prompt** (default on) uses XML-delineated sections (`<role>`, `<output_format>`, `<examples>`, `<issue>`, `<reasoning>`), role + audience priming, 12 multishot examples (2 positive + 1 anti-example per pipeline label), scratchpad CoT, and JSON prefill — see `specs/001-triage-v2/research.md` for rationale. The **v2 `TriageResult` extensions** (all optional): `assumptions` (max 10), `examples` (max 3, `{scenario, expected}`), `affectedFiles` (max 20), `testStrategy` (`{unit?, integration?}`), `riskAssessment` (`{severity: "low"|"medium"|"high", areas: string[]}`, areas max 5). Caps enforced by pre-zod truncation in `parseTriageV2Extensions` (`pm/types.ts`); excess entries silently truncated, malformed inner shapes dropped, severity-enum miss drops the entire `riskAssessment` block. The Linear comment renders v2 fields as `### Assumptions` / `### Examples` / `### Affected Files` / `### Test Strategy` / `### Risk Assessment` headed sections with `(none)` placeholders when partial. The issue description gets the same content as `**Acceptance Criteria:**` / `**Examples:**` / `**Affected Files:**` / `**Test Strategy:**` / `**Risk Assessment:**` sections via the idempotent `appendTriageSectionsToDescription` (skips any section whose marker already appears, so re-triage doesn't duplicate). **Escape hatch**: `URATEAM_DISABLE_TRIAGE_V2=true` (strict equality — `"1"` / `"yes"` / `"TRUE"` do NOT match) falls back to the v1 prompt + schema with no new fields parsed; the env var is read at call time so flipping it takes effect on the next PM tick without a daemon restart. **Tier 6b foundation for 6e**: `pm/triage-prediction-quality.ts:computeAffectedFilesPredictionQuality(predicted, actualDiff)` is a pure function that compares triage's `affectedFiles` against the real diff; returns `{hasV2Prediction, predicted, actual, intersection, missed, unexpected}` so Tier 6e (the audit-event writer) can compute scores without further schema changes. **Tier 6e plumbing**: triage v2 persists the prediction to `triage_results.v2_prediction` (JSON) at classification time via `upsertTriageResult` (`pm/triage-results-store.ts`). The runner's Tier 6e hook reads it via `getTriageResult(db, issueId)` — **not** by parsing the issue description, which `mapIssueToSchema` truncates at 4000 chars (silently losing the appended v2 sections for realistic issues). The DB-backed path is the single source of truth; the description appender remains for human readability only. **Tier 6e escape hatch (BEC-218)**: `URATEAM_DISABLE_TIER_6E=true` (strict equality — `"1"` / `"yes"` / `"TRUE"` do NOT match) skips the entire `pm.triage_quality_score` emission block (no `getTriageResult`, no `getChangedFiles`, no DB write); read at call time so flipping it takes effect without a daemon restart. Helper `isTier6eDisabled(env?)` in `pm/triage-prediction-quality.ts`.
- **Promote**: moves highest-priority non-conflicting Backlog issues to Todo (triggers webhook pipeline). Runs after startTodoIssues so orphans fill slots first.
- **Approval-gated**: deprioritize/cancel require Slack reaction approval (48h timeout) via shared `requestApprovalIfNotPending()`.
- **Conflict detection**: git diff for active branches + Claude prediction for candidates.
- **Slack interface** (`slack-interface.ts`): slash commands, @mentions, natural language via Haiku.
- **Daily digest circuit-broken block (BEC-223)**: `postDigest` (`pm/slack.ts`) includes a `*Circuit-Broken Issues*` section listing every issue with ≥ `maxConsecutiveFailures` (default 3) consecutive failed runs that had at least one failure in the last 7 days. Each entry shows: identifier (hyperlinked when URL is available), title (≤ 80 chars), most-recent `error_message` (≤ 200 chars), and failure timestamp. Issues whose most-recent terminal run is `'completed'` are automatically excluded (recovered). Section omitted when empty; capped at 10 entries with `_+N more_` overflow footer. Query logic: `fetchCircuitBrokenIssues` in `pm/actions/db-queries.ts`; uses `batchCountConsecutiveFailures` to avoid N+1 DB queries. Populated by `scheduler.ts` before posting the digest.

**Pause / circuit-breaker / escalation:**
- `PM_AGENT_PAUSED=true` (BEC-170) pauses promote / start-todo / recover-stuck. OR'd with the Slack `/pm pause` state. Read at each tick — container restart required.
- **Circuit breaker (BEC-161/181)**: `promoteReadyIssues` + `startTodoIssues` pre-fetch failure counts via `batchCountConsecutiveFailures(db, issueIds)` (single round-trip; avoids N+1). Issue skipped + `pm.skipped_circuit_breaker` audit event when count ≥ `maxConsecutiveFailures` (default 3). Disable with `maxConsecutiveFailures: 0`. Verify: query `audit_events WHERE event_type = 'pm.skipped_circuit_breaker'`.
- **Tier 5 escalation**: when breaker trips for an issue without `needs-design`, `promoteReadyIssues` adds the label, posts a Linear comment with the last failed run's `errorMessage` (truncated 500 chars), invokes `slackPostAlert(...)`, emits `pm.escalated_to_needs_design`. Idempotent.
- **Zombie run recovery (BEC-184)**: `recoverStuckInProgressIssues` also fails runs in `status='running'` longer than `PM_AGENT_STUCK_RUN_AGE_MIN` minutes (default 60). Moves Linear issue to `stuckIssueTargetState`, emits `pm.recovered_long_running`.

**Key design:** promote action moves issues in Linear (triggering webhooks). `startTodoIssues` directly calls `runner.start()` as a fallback for missed webhooks.

### Notifiers
- Linear: issue comments + state transitions (In Progress → In Review → Done)
- Slack: Block Kit messages with human-review alerts
- Discord: embed-based
- Composite: fan-out with `Promise.allSettled` isolation
- Optional notifier methods use `?.` convention

### Database

- Drizzle ORM with SQLite (dev) / Postgres (prod). Auto-detect driver from `DATABASE_URL` prefix.
- **Unified schema with `crossTimestamp` (BEC-89)**: single `db/schema.ts`. `_setSchemaDriver()` called by `createDb()` switches serialization between epoch ints (SQLite) and ISO strings (Postgres). Postgres timestamp columns are TIMESTAMPTZ (since PR #153).
- Drizzle `gte()` / `lt()` / `eq()` work natively on `crossTimestamp` for both drivers. No raw SQL workarounds needed.
- **Migrations**: `MIGRATION_COLUMNS` array in `client.ts` generates driver-appropriate `ALTER TABLE`. `getCreateTablesDDL(driver)` generates CREATE TABLE. File-based migrations in `db/migrations/{sqlite,postgres}/` auto-run from `createDb()`.
- Batch `agent_logs` inserts (flush every 20).
- Webhook dedup uses `webhookDedup` table (survives restarts); falls back to in-memory when no DB.
- Postgres SQL helpers: `sqlDateGroup(db, col)` ('YYYY-MM-DD'), `sqlDaysAgoFilter(db, col, days)`. Both driver-aware — no `isPostgres()` branching in app code.

### Git Operations
- `gitExec()` — throwing, with structured logging + timeout
- `gitExecSafe()` — non-throwing, returns "" on failure
- `gitExecRaw()` — preserves leading whitespace (porcelain output)
- `checkDuplicateBranch()` — server-side filtered ls-remote
- `rebaseBranch()` — returns `{ success, hasConflicts }` for push-queue conflict resolution
- `verifyBranchMatch(worktreePath, expectedBranch)` — throws if HEAD ≠ expected (cross-contamination guard)
- `installPrePushHook(repoDir)` — idempotent `.git/hooks/pre-push` that aborts pushes when HEAD ≠ remote ref
- PR creation via `gh` CLI (fallback), GitHub App (Octokit), or GitLab/Bitbucket REST

### Worktree Isolation & Parallel Agent Dispatch (BEC-99)

**Shared `.git` directory limitation**: `git worktree add` creates separate working dirs each with own HEAD, but all worktrees share **one** `.git/` and **one** object DB.

- Each worktree has its own HEAD — `git checkout` in worktree A doesn't affect B
- **Cross-branch contamination risk**: if an agent runs `git checkout <other-branch>` in its worktree, subsequent commits/pushes silently land on the wrong branch
- **Three defences in place**: (1) `autoCommitChanges(path, issueId, expectedBranch)` verifies HEAD = expectedBranch; (2) `pushBranch` / `pushBranchForce` call `verifyBranchMatch` before every push; (3) `installPrePushHook` `.git/hooks/pre-push` shared across worktrees aborts mismatched pushes.

**Safe patterns:**
- Use `isolation: "worktree"` — locked HEAD per agent
- Never instruct agents to `git checkout <other-branch>` inside their worktree
- For fully isolated parallel work with no `.git` sharing, use separate repo clones

**Recovering from contaminated branches (cherry-pick procedure):**
1. Identify the correct SHAs: `git log --oneline --all | grep "<issue-id>"` to find commits that landed on the wrong branch.
2. Check out the correct target branch: `git checkout agent/<correct-issue>-<slug>`.
3. Cherry-pick the stray commit: `git cherry-pick <sha>`.
4. Force-push the corrected branch: `git push --force-with-lease origin agent/<correct-issue>-<slug>`.
5. On the contaminated branch, remove the stray commit: `git rebase -i --onto <parent-sha> <stray-sha> HEAD` or `git reset --hard <pre-stray-sha>`, then `git push --force-with-lease`.
- Do **not** reuse branch names across concurrent runs (`-B` resets the ref to HEAD)

**Recovering from contaminated branches**: cherry-pick from contaminated branch onto correct branch, force-push-with-lease both branches, then `git rebase -i --onto <parent> <stray> HEAD` on the contaminated side.

### Enterprise Features

All gated by `isFeatureLicensed(<feature>)`. Routes 404 when unlicensed.

| Feature | License | Setup doc | Notes |
|---------|---------|-----------|-------|
| Audit log (4.2) | `audit-log` | — | Append-only `audit_events` + projection from `pipeline_runs`/`pm_approvals`/`budget_alerts`. Dashboard: `/audit` + `/audit/page` + `/audit/export.csv`. Mutation only via `audit/retention.ts:pruneAuditLog` (enforced by `__tests__/audit-immutability.test.ts`). Retention default 365d in PM tick. **Canonical event list lives in `AuditEventTypeSchema` (`packages/core/src/types.ts`)** — don't duplicate that list here. **Current count: 56 event types** — the Tier 1d test enforces this sentence stays in sync with `AuditEventTypeSchema.options.length`. |
| SSO via WorkOS (4.1) | `sso` | `deploy/SSO_SETUP.md` | `dashboard_users` + `dashboard_sessions` tables. Middleware `packages/dashboard/src/middleware/sso.ts` skips `/auth/*` + `/webhooks/*`. **`getUserById` MUST return `role`** — dropping it silently 403s every user. **Session IDs are credentials — never log them** (`touchSessionLastSeen` logs only `id.slice(0,8) + "…"`). |
| RBAC (4.4) | `rbac` | `deploy/RBAC_SETUP.md` | Roles `admin` / `operator` / `viewer`, global only in v1. Bootstrap via `URATEAM_ADMIN_EMAILS` env var (comma-separated, case-insensitive). `setUserRole` wraps SELECT+COUNT+UPDATE in a transaction to prevent last-admin demotion TOCTOU. Admin UI `/users`; CLI `ura admin {list,grant,revoke}`. v1 write action: `POST /runs/:id/retry`. |
| Org policy (4.6) | `org-policy` | — | `PipelineConfig.policy = { pathBlocklist, maxTokensPerIssue, overrideLabel, mandatoryReviewers }`. Cost gate checks token total once after all stages. Override: case-insensitive Linear-label check; **security note: relies on Linear label creation being restricted**. Reviewer gate fires on GitHub App path only at auto-merge — `gh` CLI fallback passes `--reviewer` at PR creation but can't poll approvals. **Team-membership cache** in `verifyApprovalsReceived` (TTL 15 min, keyed by `(org, team_slug)`) — prevents GitHub secondary rate-limit exhaustion. Audit: `policy.{path_blocked,cost_exceeded,override_used,reviewers_requested}`. |
| Cost & ROI (4.5) | `cost-roi` | — | `cost_rollups_daily` rebuilt nightly via `recomputeCostRollups` in PM tick. **Uses `""` empty-string sentinel for `linear_team_id`** so composite UNIQUE fires correctly on both drivers. Half-open `[start, end)` day boundary (`lt`, not `lte`). Preset windows (7d/30d/90d/365d) use `aggregateHybrid` (rollups + live today). Custom ranges bypass rollups. **Rollups are immutable snapshots** — pricing changes don't backfill. `aggregateAll` caps at 10k runs → `summary.truncated = true`. Dashboard `/cost` + `/cost/export.csv`. |
| Operator stop & halt | (base) | `deploy/STOP_AND_HALT.md` | `pipeline/control-signals.ts`. **Single-run** `requestStop(runId, mode)`: `"cancel"` aborts via `AbortController` wired into `consumeAgentStream`; `"graceful"` lets current stage finish then skips remaining. Both → `status: "cancelled"`. **Container halt** `haltAll()`: sets pause flag + cancels all `activeRuns` + `activeFeedbackRuns`. Reversible via `/pm resume` (in-flight cancellations stay cancelled). Three surfaces — dashboard (RBAC-gated), CLI (`ura stop`/`ura halt`/`ura retry`, auth via `URATEAM_CLI_TOKEN`), Slack (`/pm cancel`/`/pm stop`/`/pm halt`). Audit: `run.cancelled`, `system.halted`. **Single-process state**: signal map resets on restart. |

### Coordination (`packages/core/src/pm/coordination.ts`)
DB-backed `active_work` table tracks files modified by in-flight runs. `upsertActiveWork` uses atomic `onConflictDoUpdate` (requires UNIQUE on `run_id`). `removeActiveWork` called in runner's `finally` block + `abort()`. `checkFileOverlap` compares candidate files against active runs.

### Bootstrap Command (`packages/cli/src/commands/bootstrap.ts`, BEC-205)
`ura bootstrap` — one-command self-hosted onboarding wizard. Flow: preflight (Docker, ports 3000/3001, tools) → optional GitHub App manifest flow → optional Linear webhook registration → generate `.env` + `docker-compose.dogfood.yml` + `Caddyfile` (or cloudflared command) → optional validate via synthetic webhook to `http://localhost:{port}/webhooks/linear`. Flags: `--skip-github-app`, `--skip-linear`, `--validate`, `--domain`, `--proxy {caddy|cloudflared}`, `--output-dir`, `--port`. All functions accept optional `deps` (`BootstrapDeps`) for injectable `execFile` / `fetch` / `writeFile` / `log` / `openBrowser`.

### Triage Quality Command (`packages/cli/src/commands/triage-quality.ts`, BEC-219)
`ura triage-quality` — surfaces `pm.triage_quality_score` audit events as operator stats. Reads from the audit log and prints a summary of triage v2 file-prediction accuracy. Flags: `--days <n>` (time window, default 7), `--limit <n>` (max events in per-run table, default 20), `--format text|json` (default text). Text output includes: summary counts and averages (intersection ratio, miss rate, unexpected rate), top-10 missed files, top-10 unexpected files, and a per-run table. JSON output returns the raw event array. Reads `DATABASE_URL` env var; falls back to `./urateam.db` with a warning when unset.

### Quality Observer (`packages/observers/`)

- `engine.ts` (isFirstTick, seedDedupOnFirstTick, processFindings), `scheduler.ts`, `store.ts` (SQLite ObserverStore). No dep on `@urateam/core`.
- **First-tick dedup seeding (BEC-172)**: fresh-installed store would file every historical pattern at once. `scheduler.tick()` calls `isFirstTick(store)`; if true (and `QUALITY_OBSERVER_FIRST_TICK_FILE` not set), `seedDedupOnFirstTick` registers fingerprints without filing.
- **PM Agent observer-origin gate**: observer GitHub issues embed `<!-- urateam-qo-observer: <id> -->` in the body. `gh-linear-sync` copies the body verbatim (the GH label does NOT survive sync). `triageNewIssues` short-circuits on this marker: skips classifier, assigns `needs-design`, moves to Backlog priority 3, posts explanatory comment. Rationale: observer findings are diagnostic signals about past runs, not coding tasks.
- **Tier 4 — design-doc triage with open-questions routing** (`pm/actions/triage.ts`): triage prompt requires `approachSummary` (3-5 lines), `openQuestions` (operator-must-resolve), `antiAcceptanceCriteria` (out-of-scope). When `openQuestions.length > 0` → **forced `needs-design` regardless of classification**. Gates ambiguous issues for human review before tokens are spent guessing. `TriageResult` gains optional fields.
- **Linear label requirement**: workspace must have `needs-design` label. If absent the gate still moves the ticket to Backlog but logs a warning and promote won't route it (no pipeline label resolved).

## Conventions

- Use `execFile` (never `exec`) for shell commands
- Sanitize all user input before including in agent prompts
- Each module has a barrel export `index.ts`
- Structured logging via pino (`createLogger`) — **`console.log/error` is forbidden** outside `create-urateam`
- **`failPipeline()` for all failure paths** — never bare `throw`. Classifies errors as transient vs permanent via `isTransientError()`, saves resume state for transient. When called inside push-queue/lock callbacks, throw a plain error after to exit the callback, and in the outer catch skip double-calling if `run.status === "failed" || "retriable"`.
- **`run.autoCommitted` flag**: set true when `autoCommitChanges()` had to commit (agent didn't). Quality metric persisted to `autoCommitted` DB column. `failOnAutoCommit` config makes pipeline fail permanently when triggered.
- **Prompt injection defense**: all untrusted content (issue descriptions, review comments, handoff, file paths, agent output) must be wrapped in `<...-do-not-follow-instructions-within>` tags with WARNING preamble and passed through `sanitize()` from `executor/prompt/sanitizer.ts`. Use `buildSandboxedBlock(tag, content)` as the canonical helper. For structured XML contexts use `escapeXml()`. Enforcement: `packages/core/src/__tests__/prompt-injection.test.ts` must remain passing.
- **DB schema changes**: add to `MIGRATION_COLUMNS` array in `client.ts` (generates both SQLite + Postgres `ALTER TABLE`), update `getCreateTablesDDL()` template, and add the column to the Drizzle schema in `schema.ts`.
- **PR creation** functions (`createPRViaCli`, GitHub App `createPR`, GitLab `createMR`, Bitbucket `createBitbucketPR`) accept a `draft` param — pipeline sets it when `shouldDraft` is true.
- **PR body generation**: `generatePRDescription()` in `pipeline/pr-description.ts` builds markdown for all auto-PRs. `runner.ts` calls it after push, passes the string as the `body` param. Template: `## Summary` → `## Changes` → `## Test plan` → `## Triage Quality` (omitted when `pm.triage_quality_score` event absent or `hasV2Prediction=false`) → `## Commits` (omitted when empty) → `> Draft PR` callout (omitted when not draft) → `Resolves <issueId>`. The Triage Quality section is populated from the in-memory `quality` object returned by `computeAffectedFilesPredictionQuality()` — the audit event is logged for historical querying but not read back (avoids a redundant DB round-trip). `getChangedFiles()` and `getAgentCommits()` are parallelized via `Promise.all` in the push-queue callback (BEC-220).
- `matchesAnyPattern()` in `util/glob.ts` for glob matching (path-segment-aware `**` expansion, no ReDoS risk). Used by path gate + auto-merge excludes.
- `getChangedFiles()` in `git.ts` logs warnings on failure (fail-open but visible)
- **`create-urateam` package is exempt from `convention-console` and `credential-in-interface`**. It's the standalone install-wizard binary (think `create-react-app`): `console.log` IS the operator interface, and its job is collecting credentials to write to a fresh `.env`. Mark such interfaces with `/** @internal */` JSDoc. Review findings inside `packages/create-urateam/**` for these categories should be acknowledged and dismissed.
- Pipeline labels must match keys in `pipeline/config.ts`: `auto-implement`, `bug`, `quick-fix`, `needs-design`
- Slack `url_verification` challenge must be handled before signature verification
- **Redact credentials from URLs before logging**: `url.replace(/:\/\/[^@]+@/, "://[redacted]@")`

<!-- SPECKIT START -->
**Active spec**: [`specs/001-triage-v2/`](./specs/001-triage-v2/) — Tier 6
triage upgrade. Read [`plan.md`](./specs/001-triage-v2/plan.md) for the
implementation strategy; [`spec.md`](./specs/001-triage-v2/spec.md) for the
user-facing requirements.
<!-- SPECKIT END -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

urateam is an autonomous agent system that receives Linear issues via webhooks, runs them through configurable pipelines (triage, implement, test, review), and delivers pull requests powered by Claude.

It is a pnpm monorepo with 3 packages:
- `@urateam/core` — webhook receiver, pipeline runner, agent executor, database (Drizzle ORM), notifiers
- `@urateam/dashboard` — Hono + HTMX ops dashboard for monitoring runs
- `@urateam/cli` — `ura` command-line tool for local development

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
- `deploy/` — Docker, Caddy, setup script, env example, CLAUDE.md template
- `examples/` — Example configurations (basic, monorepo, multi-repo, custom stages)
- `scripts/` — Setup scripts for Linear webhook and GitHub App
- `docs/` — Design specs and documentation

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
- Auto-merge: configurable for trivial PRs (diff < maxLines, no blocking findings, no excluded file patterns). `autoMergeExcludePatterns` supports glob patterns (e.g. `**/migrations/**`). Auto-merge decisions logged to DB (`autoMerged`, `autoMergeReason` columns).
- Token budget: optional maxTokens with 80% alert and hard abort
- Per-stage model override: `stageModels` map in `PipelineConfig` (e.g. `{ implement: "claude-opus-4-6" }`); resolved as `config.stageModels?.[stage] ?? profile.model`
- Transient failure recovery: auth/network/rate-limit errors classified as `"retriable"`, worktree preserved, PM Agent auto-resumes on next tick (max 3 retries)
- Worktree auto-recovery: `createWorktree` detects "already checked out" errors, force-removes stale worktree, and retries
- GitHub PR feedback: `/webhooks/github` receives PR review comments (`pull_request_review`, `pull_request_review_comment`) and regular PR comments (`issue_comment`), triggers `review-feedback` pipeline runs that check out the existing branch and address comments. Supports `@ateam` trigger keyword from the regular PR comment box.

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
- Triage: Claude Haiku classifies issues, adds pipeline label (`auto-implement`/`bug`/`quick-fix`), generates acceptance criteria and appends to issue description (for RALPH)
- Promote: moves highest-priority non-conflicting issues to "Todo" (triggers webhook pipeline). Runs AFTER startTodoIssues so existing orphaned issues fill slots first.
- Approval-gated: deprioritize/cancel require Slack reaction approval (48h timeout) via shared `requestApprovalIfNotPending()`
- Conflict detection: git diff for active branches + Claude prediction for candidates
- Slack interface (`slack-interface.ts`): slash commands, @mentions, natural language via Haiku
- Shared helpers: `call-claude.ts` (Haiku factory), `slack-helpers.ts` (postSlackMessage), `linear-helpers.ts` (resolveWorkflowStates), `approval-helpers.ts`
- `parseJsonObject()` in `agent-stream.ts` for bare JSON extraction from Claude responses
- **Key design:** PM Agent's promote action moves issues in Linear (triggering webhooks). The `startTodoIssues` action directly calls `runner.start()` as a fallback for missed webhooks.

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

### Coordination (`packages/core/src/pm/coordination.ts`)
- DB-backed `active_work` table tracks files modified by in-flight pipeline runs
- `upsertActiveWork` uses atomic `onConflictDoUpdate` (requires UNIQUE on `run_id`)
- `removeActiveWork` called in runner's `finally` block and `abort()` method
- `checkFileOverlap` compares candidate files against active runs

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

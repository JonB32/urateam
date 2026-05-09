# CLAUDE.md

This file provides guidance to Claude Code when working on urateam.

## Build Commands
- `pnpm install` — install all dependencies
- `pnpm build` — build all packages
- `pnpm test` — run unit tests only (excludes heavy git integration tests; ~25s)
- `pnpm test:integration` — run BEC-99 cross-worktree and other heavy git integration tests (~30-40s)
- `cd packages/core && npx vitest run` — run core unit tests only
- `cd packages/core && npx vitest run src/__tests__/<file>.test.ts` — run specific test
- `cd packages/core && npx vitest --changed` — run only tests affected by uncommitted/recent changes (fast feedback during development)

## Architecture
pnpm monorepo with 4 packages:
- `@urateam/core` — webhook receiver, pipeline runner, agent executor, DB, notifiers, PM Agent
- `@urateam/dashboard` — Hono+HTMX ops dashboard (security-hardened: CSP, CSRF, rate limiting, credential redaction)
- `@urateam/cli` — `ura dev` for local development, `ura start` for production
- `@urateam/observers` — quality observer with first-tick dedup seeding (BEC-172); SQLite-backed fingerprint store, pluggable `computeFindings`/`fileGithubIssue` deps

## Key Patterns
- All types and Zod schemas in `packages/core/src/types.ts`
- Pipeline stages: triage, await-approval, reproduce, implement, test, review
- Agent prompts built via sanitizer -> templates -> assembler pipeline
- DB: Drizzle ORM, unified schema in `db/schema.ts` with `crossTimestamp` custom type — single schema for SQLite (dev) and Postgres (prod). `_setSchemaDriver()` called by `createDb()`. Drizzle `gte()`/`lt()` operators work natively on both drivers.
- File-based migrations in `db/migrations/{sqlite,postgres}/` — run automatically on startup via `runMigrationsPostgres()` / `runMigrationsSqlite()` called from `createDb()`
- Tests: Vitest, unit tests in `__tests__/`, integration tests in `__tests__/integration/`
- Structured logging: pino via `createLogger()` — never use `console.log/error`
- Shared helpers: `consumeAgentStream`, `parseJsonBlock`, `gitExecSafe`, `failPipeline`
- Agent SDK stream messages: `type="assistant"` with text in `message.message` (no-tool sessions) or `message.content` (tool sessions) — `consumeAgentStream` handles both
- **Pre-stream stall (BEC-183):** `consumeAgentStream` throws `StagePreStreamStalledError` if no message arrives within `firstMessageTimeoutMs` (default 5 min). `executor.ts` adds a second wall-clock cap via `Promise.race` (`WALL_CLOCK_STAGE_TIMEOUT_MS`: 60 min for implement, 30 min for others). Both paths result in `stage_runs.status = 'failed'`.
- **Linear SDK lazy relations:** All relation fields (`.team`, `.state`, `.project`) are Promise-like — always `await` them. `.labels` is a **method** — call `await issue.labels()`. Sync access returns `undefined` silently.
- **PR body generation**: `generatePRDescription()` in `pipeline/pr-description.ts` builds markdown body for all auto-generated PRs

## PM Agent
Autonomous backlog manager in `packages/core/src/pm/`:
- `scheduler.ts` — cron-based tick: budget → recover retriable → recover stuck → **startTodoIssues** → triage → resolve approvals → promote → deprioritize → cancel → digest
- `actions/start-todo.ts` — scans Linear for issues in "Todo" state with no active pipeline run, starts pipelines for orphaned issues (closes gap when webhooks are missed or process restarts)
- `actions/triage.ts` — classifies issues via Claude Haiku, adds pipeline label (auto-implement/bug/quick-fix), generates acceptance criteria
- `actions/promote.ts` — moves highest-priority non-conflicting issues Backlog → Todo
- `actions/recover-stuck.ts` — detects issues stuck in "In Progress" with no active run, moves to Backlog
- `actions/approval-helpers.ts` — shared `requestApprovalIfNotPending()` used by deprioritize + cancel
- `conflict.ts` — two-phase: git diff for active branches + Claude prediction
- `slack.ts` — digests, approval requests via reactions
- `slack-interface.ts` — bidirectional Slack bot: slash commands, @mentions, natural language via Haiku
- `coordination.ts` — DB-backed active work tracking for parallel conflict detection

## Webhooks
- **Linear webhook** (`/webhooks/linear`): state changes trigger pipeline actions (Todo→start, Approved→resume, Blocked→pause, Canceled→abort)
- **GitHub webhook** (`/webhooks/github`): handles three event categories:
  - PR review/inline comments (`pull_request_review`, `pull_request_review_comment`) → review-feedback pipeline
  - Regular PR comments (`issue_comment` on PRs) → review-feedback pipeline (supports `@ateam` trigger keyword)
  - CI/status events (`check_suite`, `status`, `pull_request` labeled/synchronize/opened) → automerge evaluation

## Auto-merge
- Configurable per pipeline: `autoMerge`, `autoMergeMaxLines` (default 200), `autoMergeExcludePatterns` (globs)
- Safety gates: no draft PRs, no blocking findings, diff size limit, file exclusion patterns
- Decision tracked in DB: `autoMerged` (boolean), `autoMergeReason` (text)
- When skipped, calls `notifier.onHumanReviewNeeded()` with reason

## Conventions
- Use `execFile` (never `exec`) for shell commands
- Sanitize all user input before including in agent prompts
- Each module has a barrel export `index.ts`
- Optional notifier methods use `?.` convention
- `failPipeline()` for all pipeline failure paths — never bare `throw`
- Pipeline labels (`auto-implement`, `bug`, `quick-fix`, `needs-design`) must match keys in `pipeline/config.ts`

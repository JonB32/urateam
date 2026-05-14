# Changelog

> **Per-version release notes for v0.1.7 and later live at
> [https://github.com/JonB32/urateam/releases](https://github.com/JonB32/urateam/releases).**
> GitHub Releases is the source of truth for all future versions. This file is preserved
> for historical reference (v0.1.0 – v0.1.6) and retains the accumulated entries from
> v0.1.7 – v0.1.30 that were never backfilled into individual sections. New releases no
> longer update this file.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions below refer to the workspace version published to npm. Per-package
notes call out when a change affects only a single package.

## [Unreleased]

### Added (BEC-206)
- **Complete GitLab parity**: `repo/gitlab.ts:addMRComment()` is now wired into all comment-posting code paths in `runner.ts`. The `repoConfig.provider !== "gitlab"` short-circuit guards on cost-summary and change-summary comments have been removed. GitLab users now receive per-PR cost summaries (opt-in via `URATEAM_PR_COST_SUMMARY=true`) and change-summary comments on review-feedback runs, identical to GitHub.
- **GitLab automerge** (`merge_when_pipeline_succeeds`): `runner.ts` now calls the new `mergeMRWhenPipelineSucceeds()` function when `autoMerge: true` and `repoConfig.provider === "gitlab"`. The GitLab API queues the MR for merge once all CI pipelines succeed.
- **`webhook/gitlab-handler.ts`**: New Hono handler at `/webhooks/gitlab`. Validates the `X-Gitlab-Token` shared-secret header (timing-safe comparison). MR comment (`Note Hook` with `noteable_type: "MergeRequest"`) events trigger `review-feedback` pipeline runs identically to the GitHub handler. MR merged events mark the pipeline run as merged and fire `Notifier.onPRMerged()`.
- **New `repo/bitbucket.ts`** module: `buildBitbucketAuthenticatedUrl()`, `createBitbucketPR()`, `addBitbucketPRComment()`, `mergeBitbucketPR()`, `parseBitbucketUrl()`, plus thin wrappers `cloneBitbucketRepo()` / `pushBitbucketCode()` (mirroring `repo/gitlab.ts`). Supports OAuth access tokens (Bearer) and App Passwords (Basic auth). Configurable `apiBaseUrl` for Bitbucket Data Center.
- **`webhook/bitbucket-handler.ts`**: New Hono handler at `/webhooks/bitbucket`. Validates `X-Hub-Signature-256` HMAC-SHA256 (same scheme as GitHub). `pullrequest:comment_created` events trigger review-feedback runs; `pullrequest:fulfilled` events mark pipeline runs as merged.
- **Bitbucket wired into `runner.ts`**: clone, PR creation, cost-summary/change-summary comment posting, and automerge (via Bitbucket merge API) all route through `repo/bitbucket.ts` when `repoConfig.provider === "bitbucket"`.
- **`feedback-pipeline.ts` updated**: Bitbucket clone URLs are now authenticated via `buildBitbucketAuthenticatedUrl()` when `bitbucketConfig` is configured.
- **`ServerConfig` additions**: `bitbucket?: BitbucketConfig`, `gitlabWebhookToken?: string`, `bitbucketWebhookSecret?: string`. Both new handlers are mounted automatically when their respective config fields are set.
- **Provider enum expanded**: `RepoConfig.provider` now accepts `"github" | "gitlab" | "bitbucket"`.

## [0.1.57] — 2026-05-14

Bumps:
- `@urateam/core`: 0.1.42 → 0.1.43
- `@urateam/cli`: 0.1.44 → 0.1.45
- `@urateam/dashboard`: 0.1.42 → 0.1.43
- `create-urateam`: 0.1.45 → 0.1.46

### Added (Triage v2 — Tier 6a + 6b, PR #310)

- **Anthropic-best-practices v2 triage prompt** (`packages/core/src/pm/actions/triage-prompt.ts`): XML-delineated sections (`<role>`, `<output_format>`, `<examples>`, `<issue>`, `<reasoning>`), role + audience priming, 12 multishot examples (2 positive + 1 anti-example per pipeline label), scratchpad CoT, JSON prefill. Prefix budget < 15K chars.
- **Five new optional `TriageResult` fields** (`packages/core/src/pm/types.ts`): `assumptions` (≤10), `examples` (≤3 `{scenario, expected}`), `affectedFiles` (≤20), `testStrategy` (`{unit?, integration?}`), `riskAssessment` (`{severity, areas≤5}`). Pre-zod truncation; malformed inner shapes dropped silently; severity-enum miss drops the entire `riskAssessment` block.
- **Linear comment + description rendering** (`pm/actions/triage-render.ts`): `renderTriageComment` adds 5 new `### Headed` sections with `(none)` placeholders; `appendTriageSectionsToDescription` is idempotent (re-triage doesn't duplicate sections).
- **Operator escape hatch**: `URATEAM_DISABLE_TRIAGE_V2=true` (strict equality on `"true"`) falls back to v1 prompt + schema. Read at call time — flipping takes effect on the next PM tick without daemon restart.
- **Tier 6e foundation**: `pm/triage-prediction-quality.ts:computeAffectedFilesPredictionQuality` — pure function comparing triage's predicted `affectedFiles` against the actual diff. Returns `{hasV2Prediction, predicted, actual, intersection, missed, unexpected}`.

### Chore

- **`TriageInput.linearClient`** tightened from `any` to `LinearClient` (`@linear/sdk`) per the CLAUDE.md new-code convention.
- **Spec-driven development discipline**: full spec-kit cycle (`/speckit-specify` → `/speckit-plan` → `/speckit-tasks` → TDD implementation) under `specs/001-triage-v2/`. Constitution v1.0.0 (7 principles) signed off in `plan.md`.

### Tests

- 57 new tests across `triage-v2-{schema,prompt,render,prediction,env-toggle}.test.ts`. Full sweep: 1948 core tests pass; `pnpm -w typecheck` clean.

## [0.1.56] — 2026-05-13

Bumps:
- `@urateam/core`: 0.1.41 → 0.1.42
- `@urateam/cli`: 0.1.43 → 0.1.44
- `@urateam/dashboard`: 0.1.41 → 0.1.42
- `create-urateam`: 0.1.44 → 0.1.45

### Added (OSS+)
- **`~/.urateam/config.json` hot-reload** ([#306](https://github.com/JonB32/urateam/pull/306)) — `ura start` now watches the user-level config file and applies changes from `ura repo add` / `ura repo remove` / hand-edits without a restart. Debounced (1s default). Safe fields (`labelPattern`, `testCommand`, `buildCommand`, `teamId`) apply in-place; unsafe fields (`url`, `path`, `defaultBranch`) log `restart required`. Removals delete the entry from the live `repoConfigs` immediately — in-flight pipeline runs hold their own snapshot of state and continue uninterrupted; only NEW work is blocked. Schema-validation failures keep the previous in-memory config and log a warning. `teamId` changes correctly re-key the entry under the new key (so webhook routing keeps working). New library: `packages/cli/src/lib/config-watcher.ts` (`ConfigWatcher`, `diffRepos`, `hashConfig`). Project-level (sidecar) installs are env-var driven and don't use hot-reload.

### Audit log
- One new event type: `config.reloaded`. Payload: `{ added, removed, modifiedSafe, modifiedUnsafe, sha256 }`. License-gated via `logAuditEvent`. CLAUDE.md count: 50 → 51.

### Closed
- This release completes the full deferred-list from the original user-level install PR (#296). All four follow-ups — `ura service install`, `ura self-auth-linear`, built-in tunnel manager, config.json hot-reload — are now shipped.

## [0.1.55] — 2026-05-13

Bumps:
- `@urateam/core`: 0.1.40 → 0.1.41
- `@urateam/cli`: 0.1.42 → 0.1.43
- `@urateam/dashboard`: 0.1.40 → 0.1.41
- `create-urateam`: 0.1.43 → 0.1.44

### Added (OSS+)
- **`ura start --tunnel <mode>`** ([#304](https://github.com/JonB32/urateam/pull/304)) — built-in Cloudflare tunnel manager. Three modes: `none` (default — daemon stays on local ports), `cloudflare-quick` (spawns `cloudflared tunnel --url http://localhost:<port>`, parses the `*.trycloudflare.com` URL from cloudflared's stderr — free, ephemeral), `cloudflare-token` (spawns `cloudflared tunnel --token <token> run` — requires `CLOUDFLARE_TUNNEL_TOKEN` + `URATEAM_PUBLIC_URL` env vars for a persistent named tunnel). New `TunnelManager` class in `packages/cli/src/lib/tunnel.ts` supervises cloudflared with exponential-backoff restart (1s → 30s capped, 10 attempts max) and graceful SIGTERM shutdown. On startup, the detected public URL is exported as `URATEAM_PUBLIC_URL` so OAuth callbacks and webhook handlers see it. When `cloudflared` isn't on `$PATH`, `CloudflaredMissingError` surfaces brew/apt/release-page install hints; tunnel failures never crash the daemon — it stays on local ports. Audit-event observability via `tunnel.started` and `tunnel.stopped`.

### Audit log
- Two new event types: `tunnel.started` (provider, publicUrl, restartCount), `tunnel.stopped` (provider, restartCount, exitCode, signal). CLAUDE.md count: 48 → 50.

## [0.1.54] — 2026-05-13

Bumps:
- `@urateam/core`: 0.1.39 → 0.1.40
- `@urateam/cli`: 0.1.41 → 0.1.42
- `@urateam/dashboard`: 0.1.39 → 0.1.40
- `create-urateam`: 0.1.42 → 0.1.43

### Added (OSS+)
- **`ura self-auth-linear`** ([#302](https://github.com/JonB32/urateam/pull/302)) — browser-based Linear OAuth flow. Spins up an ephemeral `127.0.0.1:9898` HTTP server (port configurable via `--port`), opens Linear's authorize URL in the operator's browser via `open` (macOS) / `xdg-open` (Linux) / printed-URL fallback, verifies the HMAC-signed `state` parameter (per-invocation 32-byte random secret; constant-time `timingSafeEqual`), exchanges the code at `https://api.linear.app/oauth/token`, fetches workspace metadata via Linear GraphQL, and writes `LINEAR_API_KEY=<access_token>` into `~/.urateam/.env` via the new atomic `upsertEnvFile()` helper (rename-after-write; preserves comments, blank lines, and unrelated keys). Flags: `--timeout-ms` (default 5min), `--scope` (default `read,write`), `--port` (default 9898). New library helpers: `lib/oauth-state.ts`, `lib/env-file.ts`, `lib/linear-oauth.ts` (DI-able orchestrator), `lib/linear-oauth-deps.ts` (default real-world fetch + browser-open shims). Token preservation: if Linear's GraphQL metadata endpoint hiccups after a successful token exchange, the success page still renders and the token is still written; workspace metadata falls back to a placeholder. Token NEVER appears in console output, the success-page HTML, or the audit payload.

### Audit log
- One new event type: `linear.oauth_completed`. Emitted opportunistically from the CLI when the daemon SQLite DB exists. Routed through license-gated `logAuditEvent` (Enterprise tier). Payload carries `workspaceId` + `workspaceName`, never the token. CLAUDE.md count: 47 → 48.

## [0.1.53] — 2026-05-13

Bumps:
- `@urateam/core`: 0.1.38 → 0.1.39
- `@urateam/cli`: 0.1.40 → 0.1.41
- `@urateam/dashboard`: 0.1.38 → 0.1.39
- `create-urateam`: 0.1.41 → 0.1.42

### Added (OSS+)
- **`ura service install` / `ura service uninstall`** ([#300](https://github.com/JonB32/urateam/pull/300)) — auto-generate and install a platform service unit so the user-level daemon auto-starts on login. Auto-detects platform: macOS → launchd plist at `~/Library/LaunchAgents/com.urateam.daemon.plist` + `launchctl load -w`; Linux → systemd-user unit at `~/.config/systemd/user/urateam.service` + `systemctl --user daemon-reload + enable --now`. Idempotent — refuses to overwrite an existing unit, prints "already exists" instead. `--dry-run` prints the unit content without writing. Other platforms fail with a clear pointer to the manual snippets in `deploy/USER_LEVEL_INSTALL.md`. Pure I/O-free unit-file generators live in `packages/cli/src/lib/service-unit.ts` (`renderLaunchdPlist`, `renderSystemdUserUnit`) and are snapshot-tested.

### Audit log
- Two new event types: `service.installed`, `service.uninstalled`. Emitted opportunistically from the CLI when the daemon SQLite DB exists. Routed through the license-gated `logAuditEvent` — Enterprise-tier `audit-log` deployments record them; OSS / Pro drop them silently. CLAUDE.md count: 45 → 47.

## [0.1.52] — 2026-05-13

Bumps:
- `@urateam/core`: 0.1.37 → 0.1.38
- `@urateam/cli`: 0.1.39 → 0.1.40
- `@urateam/dashboard`: 0.1.37 → 0.1.38
- `create-urateam`: 0.1.40 → 0.1.41

### Added (OSS+)
- **User-level install path (Cyrus-style)** ([#296](https://github.com/JonB32/urateam/pull/296)) — new minimum-effort onboarding for operators evaluating urateam on a single machine. Five new CLI commands: `ura init` (bootstraps `~/.urateam/{config.json,data/,repos/}`), `ura repo add <url>` (clones into `~/.urateam/repos/<slug>` and registers in `config.json` — options: `--branch`, `--test-command`, `--build-command`, `--team`, `--label-pattern`), `ura repo list`, `ura repo remove <slug> [--purge]` (with path-safety guard refusing to delete outside `URATEAM_HOME`), `ura uninstall --yes`. `ura start` now reads `~/.urateam/config.json` (or `$URATEAM_HOME/config.json`) as a fallback when no `REPO_*` env vars are set, and explicitly loads `~/.urateam/.env` regardless of cwd so secrets work without `cd ~/.urateam`. Project-level (sidecar / docker-compose) install is unchanged — env vars win when both are present. New schema lives in `packages/cli/src/lib/user-level-config.ts` (Zod, JSON file). Public API: `cloneRepo` is now re-exported from `@urateam/core`. Full operator doc: `deploy/USER_LEVEL_INSTALL.md`.

## [0.1.51] — 2026-05-12

Bumps:
- `@urateam/core`: 0.1.36 → 0.1.37
- `@urateam/cli`: 0.1.38 → 0.1.39
- `@urateam/dashboard`: 0.1.36 → 0.1.37
- `create-urateam`: 0.1.39 → 0.1.40

### Added (OSS+)
- **Tier 4: triage produces a real design doc + open-questions gate** ([#290](https://github.com/JonB32/urateam/pull/290)) — the PM Agent triage prompt is extended to produce `approachSummary` (3-5 line sanity-checkable plan), `openQuestions` (must-answer-before-implement), and `antiAcceptanceCriteria` (anti-scope). When `openQuestions.length > 0`, the ticket is forced to the `needs-design` pipeline label regardless of complexity — same routing mechanism as the observer-marker gate. Linear comment includes all three new sections when non-empty. `TriageResult` gains optional fields.
- **Tier 5: escalation on consecutive failures** ([#291](https://github.com/JonB32/urateam/pull/291)) — when `promoteReadyIssues` trips the circuit breaker for an issue that does NOT already carry `needs-design`, escalate: add the label (preserving existing), post a Linear comment summarizing the last failed run's `errorMessage` (truncated 500 chars), invoke the operator-supplied `slackPostAlert` callback, and emit a `pm.escalated_to_needs_design` audit event. Idempotent — subsequent ticks find the label already in place and skip re-escalation. The existing `pm.skipped_circuit_breaker` event still fires for observability. New `getLastFailureError(db, issueId)` helper in `pm/actions/db-queries.ts`.

### Audit log
- New event type `pm.escalated_to_needs_design` (Tier 5). Total audit event count: 44 → 45.

## [0.1.50] — 2026-05-12

Bumps:
- `@urateam/core`: 0.1.35 → 0.1.36
- `@urateam/cli`: 0.1.37 → 0.1.38
- `@urateam/dashboard`: 0.1.35 → 0.1.36
- `create-urateam`: 0.1.38 → 0.1.39

### Added (OSS+)
- **Tier 3: auto-deep-review thresholds** ([#288](https://github.com/JonB32/urateam/pull/288)) — new `packages/core/src/pipeline/auto-deep-review.ts` promotes the deep-review fanout from opt-in to default-on for non-trivial PRs. After the review-fix loop, the runner computes diff metrics (`changedFiles`, `totalLines`, `newPublicExports`). If any trips `autoDeepReviewThresholds` (defaults `{ changedFiles: 5, totalLines: 200, newPublicExports: 2 }`) AND the `deep-review` license is active, `deepReviewPasses` is bumped to ≥1 (so the agentic Claude reviewer always activates; OpenRouter fanout is the optional additional layer). New `deepReviewFindingsAreBlocking` (default `true`) upgrades deep-review finding severity to blocking so it forces draft. Escape hatches: `URATEAM_DISABLE_AUTO_DEEP_REVIEW=true` (global) or per-pipeline thresholds set high. `countNewPublicExports` parses `+export (default ?)(async ?)(function|class|const|let|interface|type|enum|{|*) ...` lines under monorepo `packages/<pkg>/src/` AND repo-root `src/`, excluding `__tests__/`. **BC note:** operators with existing `deepReviewPasses: 1` will see warnings/suggestions become blocking unless they set `deepReviewFindingsAreBlocking: false`.

### Audit log
- New event type `pipeline.auto_deep_review_bumped` (Tier 3). Total audit event count: 43 → 44.

## [0.1.49] — 2026-05-12

Bumps:
- `@urateam/core`: 0.1.34 → 0.1.35
- `@urateam/cli`: 0.1.36 → 0.1.37
- `@urateam/dashboard`: 0.1.34 → 0.1.35
- `create-urateam`: 0.1.37 → 0.1.38

### Added (OSS+)
- **Tier 2: convention-checklist review prompt** ([#285](https://github.com/JonB32/urateam/pull/285)) — new `PROJECT_CONVENTION_CHECKLIST` in `packages/core/src/security/review-checklist.ts` injected into both the main review-stage prompt (`reviewTemplate`) and the OpenRouter fanout system prompt (`buildReviewPrompt`). The 9 categories (`scratch-files`, `db-ddl-drift`, `audit-bypass-undocumented`, `credential-in-interface`, `spec-vs-impl`, `convention-execfile`, `convention-console`, `convention-throw`, `convention-as-any`) mirror the deterministic-gate vocabulary from Tier 1, so operators see one consistent set of `category` strings whether the finding came from a deterministic gate or from the AI review. Review stage runs on Sonnet (not Haiku) per the existing `DEFAULT_AGENT_PROFILES.review.model`. Adds defense in depth against the Tier 1 failure modes the static checks can't catch (e.g., bare `throw` outside the runner, schema-change drift across all three required sites, credential-shaped fields in newly exported interfaces).

## [0.1.48] — 2026-05-12

Bumps:
- `@urateam/core`: 0.1.33 → 0.1.34
- `@urateam/cli`: 0.1.35 → 0.1.36
- `@urateam/dashboard`: 0.1.33 → 0.1.34
- `create-urateam`: 0.1.36 → 0.1.37

### Added (OSS+)
- **Tier 1a: scratch-file denylist gate** ([#280](https://github.com/JonB32/urateam/pull/280)) — new `packages/core/src/pipeline/scratch-file-guard.ts` runs after all stages and the org-policy gate, before the push queue. Scans `git diff --diff-filter=A origin/<base>...HEAD` plus `git status --porcelain` for agent-added paths matching a denylist (`*.bak`, repo-root `TEST_*.md`/`TESTING_*.md`/`FINAL_*.md`/`*_REPORT.md`/`*_CHECKLIST.md`, repo-root `commit-*.sh`/`run-*.sh`, `*.tmp`/`*.log` anywhere, non-exempt repo-root `*.md`). On match: pushes blocking `category: "scratch-files"` `ReviewFinding`(s), forces draft, emits `pipeline.scratch_files_blocked` audit event. Catches the failure mode that shipped 5 scratch artifacts in #258 (BEC-187). Escape hatch: `URATEAM_DISABLE_SCRATCH_GUARD=true`.
- **Tier 1b: typecheck gate** ([#282](https://github.com/JonB32/urateam/pull/282)) — new `packages/core/src/pipeline/typecheck-gate.ts` runs `pnpm -w typecheck` (configurable) in the worktree before push. On parseable TS errors: blocking `category: "typecheck"` finding, force draft, emit `pipeline.typecheck_failed` audit event. Setup issues (no parseable errors, non-zero exit) warn-log and continue — a broken `pnpm install` does not block legitimate PRs. Output truncated at 50 KB; first 5 messages capped at 500 chars each. Escape hatch: `URATEAM_DISABLE_TYPECHECK_GATE=true`. Unit-testable via `TypecheckRunner` DI.
- **Tier 1c: spec-vs-impl JSDoc gate** ([#283](https://github.com/JonB32/urateam/pull/283)) — new `packages/core/src/pipeline/spec-vs-impl-gate.ts` scans the agent's added/modified TS/JS files for JSDoc references matching `\b(config|opts|env|deps|options)\.([A-Za-z_][A-Za-z0-9_]*)\b` and verifies each bare symbol exists in the worktree's tracked source corpus. On unresolved references: blocking `category: "spec-vs-impl"` findings, force draft, emit `pipeline.spec_vs_impl_failed` audit event (cap 20). Catches the PR #254 (BEC-201) failure mode where docs promised a non-existent config field. Heuristic — false positives accepted per the operator brief. Escape hatch: `URATEAM_DISABLE_SPEC_VS_IMPL_GATE=true`.
- **Tier 1d: audit-event count consistency test** ([#281](https://github.com/JonB32/urateam/pull/281)) — extends `audit-immutability.test.ts` with two regex-based checks that fail CI when the `(\d+) event types` / `(\d+) actor types` sentences in `CLAUDE.md` diverge from `AuditEventTypeSchema.options.length` / `AuditActorTypeSchema.options.length`. Closes the 17→41 drift (pre-existing) caught during Tier 1a review.

### Audit log
- New event types `pipeline.scratch_files_blocked`, `pipeline.typecheck_failed`, `pipeline.spec_vs_impl_failed` (Tiers 1a/1b/1c). Total audit event count: 41 → 43. CLAUDE.md updated to enumerate all 43 names; Tier 1d's test enforces the count consistency going forward.

## [0.1.47] — 2026-05-11

Bumps:
- `@urateam/core`: 0.1.32 → 0.1.33
- `@urateam/cli`: 0.1.34 → 0.1.35
- `@urateam/dashboard`: 0.1.32 → 0.1.33
- `create-urateam`: 0.1.35 → 0.1.36

### Added (OSS+)
- **BEC-207: first-class `CLAUDE_CODE_OAUTH_TOKEN` support + `AuthMonitor`** ([#274](https://github.com/JonB32/urateam/pull/274)) — three auth paths now resolved with documented precedence (`CLAUDE_CODE_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` → mounted CLI session). `resolveClaudeAuth()` logs the active method per stage. `isClaudeAuthValid()` and `preflightClaudeAuth()` short-circuit to true when either env var is set (no subprocess check needed for paths that don't expire). New `AuthMonitor` runs `claude auth status` every 6h on the session path, posts a Slack alert + emits `claude.auth_expired` audit event on expiry; no-ops when an env var is configured. Wired into the PM scheduler tick.
- **BEC-187: 5 missing hot-path indexes on `pipeline_runs` + `pm_approvals`** ([#271](https://github.com/JonB32/urateam/pull/271)) — `pr_url`, `branch`, `started_at`, `completed_at` on `pipeline_runs`; `issue_id` on `pm_approvals`. Cover webhook lookups (every check_suite/pull_request/review event), PM tick range scans, and approval batch fetches. Idempotent migrations for both SQLite and Postgres; `getCreateTablesDDL()` kept in sync so fresh installs converge on the same schema.

### Fixed (OSS+)
- **BEC-186: Linear stays "In Review" after manual PR merge / GitHub auto-merge-when-ready** ([#275](https://github.com/JonB32/urateam/pull/275)) — new `pull_request.closed` + `merged === true` webhook handler. Looks up the pipeline run by PR URL, marks `auto_merged = true` in the DB, and fires a new optional `Notifier.onPRMerged(run)` hook. `LinearNotifier.onPRMerged()` posts a "PR Merged ✅" comment and transitions the Linear issue to Done. Idempotent: replayed webhooks no-op when the run is already marked merged; PRs from non-agent sources are silently skipped.
- **Fanout: suppress upstream-provider failures from PR comments** ([#270](https://github.com/JonB32/urateam/pull/270)) — OpenRouter free-tier / community models (notably the nvidia free tier) regularly return 200 OK with `{ error: { message: "Provider returned error" } }` and no `choices`. The fanout was posting these as noisy "Status: failed" PR comments the operator can't act on. `postFanoutCommentsToPR` now recognises this specific error class via `isUpstreamProviderError()` and suppresses the per-model PR comment (DB row + audit event still fire). New `suppressedProviderFailureCount` field returned for observability.

### Refactor (OSS+)
- **BEC-196: split `release-manager/scheduler.ts` (566 lines) → `release-tick.ts` + `release-helpers.ts`** ([#273](https://github.com/JonB32/urateam/pull/273)) — no behavior change except one intentional improvement (`MAX_AUDITED_RUN_IDS = 10_000` cap on the previously-unbounded `auditedCompletedRunIds` set, with inline comment documenting the trade-off).

### Audit log
- New event type `claude.auth_expired` (BEC-207). Bypasses the `audit-log` feature gate via `logAuditEventUnchecked` because session expiry is a base-tier operational signal — `auth-monitor.ts` joins `license.ts` as the second authorised bypass call site outside the Pro-tier modules.
## [0.1.46] — 2026-05-11

Bumps:
- `@urateam/core`: 0.1.31 → 0.1.32
- `@urateam/cli`: 0.1.33 → 0.1.34
- `@urateam/dashboard`: 0.1.31 → 0.1.32
- `create-urateam`: 0.1.34 → 0.1.35

### Added (OSS+)
- **Operator stop & container halt** ([#268](https://github.com/JonB32/urateam/pull/268)) — three coordinated surfaces for stopping pipeline runs. Cancel a single run mid-stream via a new `AbortController` wired into `consumeAgentStream` (throws new `StageCancelledError`); graceful-stop a run between stages; halt the entire container (pauses the PM Agent + cancels every active pipeline + feedback run). Surfaces: dashboard (`POST /runs/:id/{cancel,stop}`, `/admin/halt-all`, RBAC-gated `runs.stop`/`system.halt`, CSRF via `HX-Request`, confirm dialogs on the run-detail page), Slack (`/pm cancel|stop|halt` with parser + Haiku NL classifier), CLI (`ura stop <runId> [--graceful]`, `ura halt`, talking to `/cli/*` guarded by `URATEAM_CLI_TOKEN` shared secret with constant-time `timingSafeEqual` compare). New audit events `run.cancelled` and `system.halted` record actor + mode. Runs land in new `status: "cancelled"` (distinct from system-initiated `"aborted"`). Setup doc: `deploy/STOP_AND_HALT.md`.
- **Slack thinking-emoji ack** ([#268](https://github.com/JonB32/urateam/pull/268)) — the bot now reacts with 🤔 on receipt of an `app_mention` / `message` event (swaps to ✅ / ⚠️ on completion), and slash commands return an immediate ephemeral "Working on it…" then post the real reply via `response_url` so slow commands don't trip Slack's 3-second slash-command timeout.

### Fixed (OSS+)
- **Quality Observer findings no longer burn implement-stage tokens** ([#268](https://github.com/JonB32/urateam/pull/268)) — Quality Observer files a fresh GH issue per pipeline run with >50 turns; the fingerprint includes the runId, so each flagged run became a new Linear ticket and the implement pipeline burned tokens trying to "fix" a non-actionable diagnostic. PM Agent triage now detects the observer body marker (`<!-- urateam-qo-observer:`, preserved by `gh-linear-sync`'s verbatim body copy) and routes the ticket to the `needs-design` pipeline, whose `await-approval` stage gates a human before any implement-stage work runs.

### Chore (OSS+)
- New env var `URATEAM_CLI_TOKEN` (documented in `.env.dogfood.example` and `deploy/STOP_AND_HALT.md`) — required for `ura stop` / `ura halt` to reach a running container's control plane.
## [0.1.45] — 2026-05-11

Bumps:
- `@urateam/core`: 0.1.30 → 0.1.31
- `@urateam/cli`: 0.1.32 → 0.1.33
- `@urateam/dashboard`: 0.1.30 → 0.1.31
- `create-urateam`: 0.1.33 → 0.1.34

### Fixed (OSS+)
- **OpenRouter fanout: defend against missing `choices` in 200 OK responses** ([#249](https://github.com/JonB32/urateam/pull/249)) — free-tier and community providers (observed: `nvidia/nemotron-3-super-120b-a12b:free`) sometimes return 200 OK with an error body and no `choices` field. The client's optional chaining only protected `[0]?.message` but not `choices` itself, so accessing `json.choices[0]` threw `TypeError: Cannot read properties of undefined (reading '0')`. The fanout caught it but surfaced the opaque JS error on the per-model PR comment. Now defensively validates `choices` is a non-empty array and throws a meaningful error including the provider's `error.message` when present.
- **BEC-185** ([#247](https://github.com/JonB32/urateam/pull/247)) — `gh-linear-sync`: multi-label `labelFilters` now use OR semantics. Previously, all labels were joined into a single comma-separated string and passed to the GitHub REST API, which treats this as AND (intersection) — so `["bug", "enhancement"]` returned only issues carrying *both* labels (zero in practice). Fix: when `labelFilters` has more than one entry, `runGhLinearSync` calls `listIssues` once per label and unions the results, deduplicating by issue number. Single-label and empty filters are unchanged.

### Docs (OSS+)
- **`deploy/CLAUDE_AUTH.md`** ([#248](https://github.com/JonB32/urateam/pull/248)) — new guide covering the three Claude auth paths (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` via `claude setup-token`, and the local CLI session) with a recommendation matrix. Surfaces the long-lived programmatic OAuth token flow that we weren't previously documenting.
- **CLAUDE.md additions** — new Claude Authentication subsection + new "Codebase Optimization Pass — In Flight" section enumerating BEC-187..207 and listing known limitations contributors should not compound.

<!-- TODO: replace with ### Added / ### Fixed / ### Chore sections describing this release. -->
## [0.1.44] — 2026-05-11

Bumps:
- `@urateam/core`: 0.1.29 → 0.1.30
- `@urateam/cli`: 0.1.31 → 0.1.32
- `@urateam/dashboard`: 0.1.29 → 0.1.30
- `create-urateam`: 0.1.32 → 0.1.33

### Added (OSS+)
- **PR change-summary comment for review-feedback runs** ([#243](https://github.com/JonB32/urateam/pull/243)) — after a successful PR-trigger pipeline run (`runType: "review-feedback"`), the bot posts a "🤖 Addressed PR feedback" comment with the HandoffArtifact summary, per-comment responses linking each triggering PR review comment to what was changed for it, files modified, and a run-link footer. Always-on (no env flag) — a review-feedback run only exists because a human asked for changes. Renderer falls back gracefully when the agent does not populate `context.addressedComments`. Best-effort posting — `addPRComment` failures log at level 40 and never fail pipeline completion. Run link respects `URATEAM_DASHBOARD_URL` (omits the link when unset). Extends `HandoffArtifact.context` schema with optional `addressedComments: { commentId, response }[]`; adds optional `htmlUrl` to `ReviewFeedbackComment`; updates the review-feedback implement-stage prompt to require agent-emitted per-comment responses.
## [0.1.43] — 2026-05-10

Bumps:
- `@urateam/core`: 0.1.28 → 0.1.29
- `@urateam/cli`: 0.1.30 → 0.1.31
- `@urateam/dashboard`: 0.1.28 → 0.1.29
- `create-urateam`: 0.1.31 → 0.1.32

### Fixed (OSS+)
- **Dashboard "Confirm retry" button** ([#240](https://github.com/JonB32/urateam/pull/240)) — the retry POST handler returned a plain 302, but the user-facing form is HTMX-driven (CSRF requires `HX-Request`). HTMX follows 302s via XHR and swaps the response into the originating form, leaving the `<dialog>` open with the run-detail page rendered inside the dialog's `<form>`. Fixed: when `HX-Request` is present, return 200 + `HX-Redirect: <url>` so HTMX does a full-page navigation. Plain 302 retained for non-HTMX callers.

### Added
- **BEC-184** ([#235](https://github.com/JonB32/urateam/pull/235)) — `recoverStuckInProgressIssues` now also detects long-`running` runs (previously only `failed`). Closes the visibility gap where a run that hung past its watchdog window stayed in `running` indefinitely with no recovery path. Configurable stall threshold via `PM_AGENT_RUNNING_STALL_HOURS` (default 4h).
## [0.1.42] — 2026-05-10

Bumps:
- `@urateam/core`: 0.1.27 → 0.1.28
- `@urateam/cli`: 0.1.29 → 0.1.30
- `@urateam/dashboard`: 0.1.27 → 0.1.28
- `create-urateam`: 0.1.30 → 0.1.31

### Added (OSS+)
- **BEC-173** ([#191](https://github.com/JonB32/urateam/pull/191)) — `runGhLinearSync` utility + `.github/workflows/gh-linear-sync.yml` hourly cron. Open GitHub issues are scanned and synced as Linear tickets in the Triage state, with idempotency via `<!-- gh-linear-sync:NNN -->` markers. Optional `bidirectionalClose` mode closes GH issues when their Linear counterpart reaches Done. DI for SDK clients keeps the engine testable.
- **BEC-177** ([#198](https://github.com/JonB32/urateam/pull/198)) — `selectRepoConfig(pipelineLabel, teamId, projectId, repoConfigs)` enables multi-repo PM routing. RepoConfigs can declare a `labelPattern`; tickets matching that label clone the corresponding repo. Backwards compatible — no labelPattern means the existing teamId/projectId key lookup. Wired in at the webhook handler `start` path and the PM scheduler's `start-todo` action.
## [0.1.41] — 2026-05-09

Bumps:
- `@urateam/core`: 0.1.26 → 0.1.27
- `@urateam/cli`: 0.1.28 → 0.1.29
- `@urateam/dashboard`: 0.1.26 → 0.1.27
- `create-urateam`: 0.1.29 → 0.1.30

### Added (OSS+)
- **BEC-168** ([#196](https://github.com/JonB32/urateam/pull/196)) — OpenRouter fanout per-model PR comments are now suppressed when a model returns empty findings and no raw output (i.e. the model legitimately found nothing to flag). Previously, trivial PRs received one "🔎 Review by … — No findings." comment per fanout model. Comments are still posted when: findings are present, the model emitted unparseable prose (BEC-158 rawOutput fallback), or the model call failed. `PostFanoutResult` gains a `suppressedEmptyCount` field. Audit events (`review.fanout_model_completed`) continue to fire for all models regardless of suppression.
- **BEC-169** ([#195](https://github.com/JonB32/urateam/pull/195)) — `findLoopingDeepReviews` and the package's main entry point `observeRunPatterns` in `@urateam/observers`. The looping-deep-review pattern now excludes runs that completed AND produced a PR. Driven by BEC-152's run `AUEHrV8TPvNF1PHB96mVt` hitting 77 turns legitimately via deep-review fanout and being misflagged.
- **BEC-170** ([#194](https://github.com/JonB32/urateam/pull/194)) — PM Agent env-var pause mechanism for no-Slack incident response. `PM_AGENT_PAUSED=true` causes `isPmPaused()` to return true on every PM tick, preventing promote / start-todo / recover-stuck — without stopping the container. OR'd with the existing Slack `/pm pause` path. Boot log emits the value so operators have an observable signal in `docker logs`.
- **BEC-171** ([#192](https://github.com/JonB32/urateam/pull/192)) — `validateReviewModels()` validates every model ID in `REVIEW_MODELS` against the public OpenRouter catalog at `ura start` / `ura dev` startup. Unknown IDs emit a `log.warn` with up to 3 Levenshtein-closest suggestions. Catalog unreachable → debug log only, never blocks startup. Surfaced from BEC-138 dogfood (PR #157 / #172 fanout 404s on `anthropic/claude-3.5-sonnet`).
- **BEC-172** ([#190](https://github.com/JonB32/urateam/pull/190)) — New `@urateam/observers` workspace package: SQLite-backed dedup store + first-tick seeding so a fresh deploy doesn't batch-flood GitHub Issues with every historical pattern from the 24h lookback. `QUALITY_OBSERVER_FIRST_TICK_FILE=true` bypasses for CI / deliberate-reset.

### Fixed (OSS+)
- **BEC-167** ([#197](https://github.com/JonB32/urateam/pull/197)) — Review-stage prompt now emits a `HandoffArtifact` JSON envelope with `reviewFindings` nested inside `context`. Eliminates the "Stage review completed — agent output was not parseable prose" placeholder summary on trivial no-finding PRs. Prompt change only; downstream consumers unchanged.
- **BEC-183** ([#234](https://github.com/JonB32/urateam/pull/234)) — Executor pre-stream stall fix: `query()` could hang before emitting the first message, leaving the watchdog inactive (the watchdog only ticks on first message). New pre-stream timeout in `executor.ts` + `agent-stream.ts` aborts the query if no message arrives within the configured stall window, surfaces a clear error, and unblocks the run.

### Deploy
- **BEC-137** ([#233](https://github.com/JonB32/urateam/pull/233)) — `quality-observer` sidecar service definition added to `docker-compose.dogfood.yml`. Build context defaults to `../urateam-quality-observer` (sibling clone); shares dogfood's sqlite + Claude OAuth volumes read-only. Operator-specific bits (Caddyfile, gh-app.pem, port mappings) remain on the host.
## [0.1.40] — 2026-05-09

Bumps:
- `@urateam/core`: 0.1.25 → 0.1.26
- `@urateam/cli`: 0.1.27 → 0.1.28
- `@urateam/dashboard`: 0.1.25 → 0.1.26
- `create-urateam`: 0.1.28 → 0.1.29

### Added
- **BEC-178 follow-up — cache telemetry on `stage_runs`** ([#206](https://github.com/JonB32/urateam/pull/206)) — captures `cache_creation_input_tokens` and `cache_read_input_tokens` from each Anthropic Agent SDK turn, persists to `stage_runs`, renders a per-stage `cache hit: X% — read X.XK / created X.XK` line in the BEC-175 PR cost summary. Prerequisite for any further caching tuning since the SDK already caches but the rate was previously invisible.
- **Low-yield review-model health check** ([#207](https://github.com/JonB32/urateam/pull/207)) — pre-fanout probe queries `review_model_runs` for rolling output ratio per model; emits a WARN log + `review.model_low_output_ratio` audit event for models below threshold. Advisory only — operator manually drops flagged models from `REVIEW_MODELS`. Configurable via `REVIEW_MODELS_MIN_OUTPUT_RATIO` (default `0.05`), `REVIEW_MODELS_HEALTH_LOOKBACK_HOURS` (default `168`), `REVIEW_MODELS_MIN_RUNS` (default `5`).
- **BEC-181 — `pm.skipped_circuit_breaker` audit event** ([#209](https://github.com/JonB32/urateam/pull/209)) — emitted from `promote.ts` and `start-todo.ts` whenever the BEC-161 consecutive-failure breaker engages. Closes the visibility gap where the breaker was working but invisible (only WARN log, no audit trail).

### Fixed
- **BEC-180 — worktree-prune skips non-git sibling dirs** ([#202](https://github.com/JonB32/urateam/pull/202)) — runner's pre-tick `git worktree prune` no longer iterates `.agent-sweep/` (BEC-174 sweep parent dir). Eliminates noisy `level: 50` ERROR logs every restart and every cleanup tick. Whitelists by `.git/` presence (file or directory).
- **BEC-182 — review-feedback runs no longer spelunk to max turns** ([#208](https://github.com/JonB32/urateam/pull/208)) — three coordinated fixes: (1) profile override caps `maxTurns: 30`, `maxInputTokens: 60_000` for the implement stage when `context.reviewFeedback` is set; (2) tighter prompt template (read diff first, address ONLY listed comments, conditional build/test, stop-and-report on failure instead of spelunking); (3) skip RALPH iterations entirely for `runType === "review-feedback"` runs (RALPH evaluates against issue ACs but feedback work is bounded to the comments). Driven by BEC-172 / BEC-181 stalls hitting the 100-turn cap.

## [0.1.39] — 2026-05-08

Bumps:
- `@urateam/core`: 0.1.24 → 0.1.25
- `@urateam/cli`: 0.1.26 → 0.1.27
- `@urateam/dashboard`: 0.1.24 → 0.1.25
- `create-urateam`: 0.1.27 → 0.1.28

### Added
- **BEC-178** — New `URATEAM_AUTO_MERGE=true|false` env override mirroring `URATEAM_DEEP_REVIEW_PASSES` (BEC-163). Operators can now opt every pipeline into auto-merge without forking the built-in pipeline configs. Case-insensitive; invalid values are ignored with a warn log. Auto-merge gates (diff size, blocking review findings, mandatory reviewers, exclude patterns, approving reviews) still apply when true. (#200)

## [0.1.38] — 2026-05-08

Bumps:
- `@urateam/core`: 0.1.23 → 0.1.24
- `@urateam/cli`: 0.1.25 → 0.1.26
- `@urateam/dashboard`: 0.1.23 → 0.1.24
- `create-urateam`: 0.1.26 → 0.1.27

### Added
- **BEC-174** — Periodic sweep of stale `origin/agent/*` branches with no open PR. Runs on the same hourly cadence as the worktree-cleanup cron. New env `PM_AGENT_AGENT_BRANCH_TTL_DAYS` (default `7`) controls the staleness cutoff; branches with open PRs are always preserved. Failures from the open-PR check are treated as "has PR" — a transient GitHub outage can never wipe a branch we couldn't verify. Emits one `pm.agent_branch_swept` audit event per delete. Per-repo sweep dirs (keyed by `sha256(repoUrl).slice(0,8)`) prevent cross-repo collisions in multi-repo deployments. (#185)
- **BEC-175** — Optional per-PR cost summary comment posted after `onPipelineComplete`, showing per-stage tokens (implement / test / review / fanout) and total dollar cost. Gated by `URATEAM_PR_COST_SUMMARY=true` (default off). Idempotent: a prior pipeline run on the same PR will not be duplicated — the new `prHasCommentStartingWith` helper checks for the `🤖 **Pipeline cost summary**` header before posting. Best-effort: failures never block pipeline completion. (#186)

## [0.1.37] — 2026-05-07

Bumps:
- `@urateam/core`: 0.1.22 → 0.1.23
- `@urateam/cli`: 0.1.24 → 0.1.25
- `@urateam/dashboard`: 0.1.22 → 0.1.23
- `create-urateam`: 0.1.25 → 0.1.26

### Fixed
- **BEC-165** — Pipeline runs that successfully open a PR now move Linear to "In Review" 100% of the time. Previously the transition was conditionally delegated to `onHumanReviewNeeded`, which not every PR-creating runner path called (e.g. auto-implement with `autoMerge:false`, no draft-flagging, no rebase conflict). Issues stayed on "In Progress" → recover-stuck moved them back to Backlog 30 min later → re-promote → re-run loop on shipped work, burning agent + OpenRouter tokens. Two-layer fix: (1) `onPipelineComplete` is the catch-all source of truth — sets `IN_REVIEW` when `prUrl` is set and not auto-merged. (2) `recover-stuck` is defense-in-depth — when recovering a stuck issue, redirects to `In Review` if the most recent run completed with a `pr_url` (catches the case where layer 1's transition itself failed). (#176)
- **BEC-152** — `REPO_CLONE_DIR` and `AGENT_RUN_DIR` defaults switched from `/var/agent-{repos,runs}` to `homedir()/{work/repos,data/runs}` so non-root containers (the dogfood `USER ura` setup) work without operator-side env overrides. Adds startup `preflightDirs` that `mkdir -p`s and write-tests both paths with an actionable error if either fails. Existing operators with explicit env-var overrides are unchanged. (#173)
- **BEC-153** — Dogfood Dockerfile installs the `sqlite3` CLI alongside the better-sqlite3 binding so the runbook queries documented in `docs/superpowers/runbooks/2026-05-04-bec-138-dogfood-soak.md` work without the `apk add --user 0` host workaround. (#172)

### Added
- **BEC-164** — New `REVIEW_MODELS_MAX_OUTPUT_TOKENS` env var caps the `max_tokens` forwarded to OpenRouter on every fanout request. Unset = today's behavior (the model's provider default applies, which can be 65536 for gemini-2.5-pro / 16384 for gpt-4o → 402 errors on accounts with limited credit). Validation rejects floats / non-integer strings; values below 256 emit a warn at boot pointing at 1024 as a sane minimum. (#174, #175)

## [0.1.36] — 2026-05-07

Bumps:
- `@urateam/core`: 0.1.21 → 0.1.22
- `@urateam/cli`: 0.1.23 → 0.1.24
- `@urateam/dashboard`: 0.1.21 → 0.1.22
- `create-urateam`: 0.1.24 → 0.1.25

### Added
- **BEC-163** — `URATEAM_DEEP_REVIEW_PASSES` env knob to opt into BEC-134's OpenRouter multi-model fanout without forking the built-in pipeline configs. When set to a non-negative integer, applies to every pipeline that has a `review` stage in its `stages` array (so `auto-implement`, `bug`, `needs-design` — `quick-fix` is correctly excluded since it has no review stage). Default unset preserves today's behavior (every pipeline keeps `deepReviewPasses=0`). Validation rejects floats / non-integer strings. (#169, #170)
- **BEC-158** — Multi-model review fanout now posts a fallback advisory comment with the raw model output when the structured-finding parse fails. Previously, OpenRouter calls were made (cost incurred) but the prose output was discarded if it didn't conform to the expected JSON schema. Operators now see *something* per model even when the model emits prose. Audit event `review.fanout_fallback_used` fires so deployments hitting this path are detectable. (#166)

### Fixed (OSS+)
- **BEC-152** — Default `AGENT_RUN_DIR` and `REPO_CLONE_DIR` now resolve to `$HOME/data/runs` and `$HOME/work/repos` respectively, instead of `/var/agent-runs` and `/var/agent-repos`. The old `/var/` defaults were not writable in non-root containers (e.g. the dogfood `USER ura` setup), causing silent `spawn git ENOENT` failures. A startup pre-flight check now creates both directories and verifies writability before the webhook server starts, with a clear operator-actionable error if either fails. Set `AGENT_RUN_DIR` / `REPO_CLONE_DIR` explicitly to override. Surfaced from BEC-138 dogfood deployment.
- **BEC-159** — RALPH evaluation agent turn cap raised from 6 to 15. The previous 6-turn cap was insufficient for acceptance criteria requiring shell-execution verification (e.g. "pnpm -r test must pass"), which requires ≥ 6 turns just to read the ticket, inspect the diff, run the command, and produce a verdict. RALPH would exhaust the cap before returning a verdict, causing correctly-implemented PRs to be incorrectly drafted for human review. Operators can override via the `RALPH_MAX_TURNS` environment variable for tickets whose acceptance criteria require more extensive shell verification. (#167)

### Chore
- `docker-compose.dogfood.yml` `args:` block sync'd to v0.1.35 versions (this got stale during BEC-138 bootstrap and silently pinned `npm install -g` to old packages until the v0.1.35 dogfood rebuild surfaced it). Future releases bump both Dockerfile ARG defaults and compose `args:` together. (#168)

## [0.1.35] — 2026-05-06

Bumps:
- `@urateam/core`: 0.1.20 → 0.1.21
- `@urateam/cli`: 0.1.22 → 0.1.23
- `@urateam/dashboard`: 0.1.20 → 0.1.21
- `create-urateam`: 0.1.23 → 0.1.24

### Added
- **BEC-161** — PM circuit breaker. After **3 consecutive failed pipeline runs** for the same Linear issue (with no successful run between), the `promote` and `start-todo` actions skip the issue with reason `circuit-breaker: N consecutive failed runs (threshold 3)` instead of re-promoting. Closes the recover-stuck → promote → start-todo → fail doom loop that burned agent + OpenRouter tokens on BEC-138 dogfood with zero PRs produced. New env knob `PM_AGENT_MAX_CONSECUTIVE_FAILURES` (default 3, set 0 to disable). (#161)
- **BEC-160** — Release Manager scheduler now emits a `log.info({ reason, ... }, "tick skip")` line on every skip-emit branch (`mergedPRsSince`/`qa_*`, `awaiting-approval`, `tag_exists`) AND a `log.info(..., "tick fire")` on the successful-fire branch. Prior behavior wrote audit-table rows but no stdout, so operators tailing `docker logs` couldn't tell whether RM was alive — `~3.8 hrs` of misdiagnosis on the 2026-05-06 dogfood before the audit table was queried directly. (#164)

### Changed
- **BEC-162** — Default `maxTurns` for the implement stage bumped 50 → 100, and for the test stage 25 → 50. Non-trivial sev-2 fixes on BEC-138 dogfood repeatedly hit the old caps. Other stages unchanged. Operators can still override per-stage via the existing `URATEAM_AGENT_PROFILES` env knob. Total spend remains bounded by `PM_AGENT_DAILY_TOKEN_BUDGET` and the BEC-161 circuit breaker. (#163)

### Fixed
- **BEC-154 / BEC-155** — Dockerfile now bakes a default `git config user.name`/`user.email` and the gh-cli credential helper that `gh auth setup-git` would otherwise have to write at runtime. Without these, every container rebuild silently broke autonomous git operations until an operator manually re-applied them. Operators retain full override via `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` env vars (those win over `git config`). (#162)

## [0.1.34] — 2026-05-06

Bumps:
- `@urateam/core`: 0.1.19 → 0.1.20
- `@urateam/cli`: 0.1.21 → 0.1.22
- `@urateam/dashboard`: 0.1.19 → 0.1.20
- `create-urateam`: 0.1.22 → 0.1.23

### Added
- **BEC-156** — Dashboard's basic-auth path on Enterprise tier now synthesizes an admin user after credentials verify, so RBAC's `requirePermission` middleware passes without requiring SSO. Operators using basic auth get full dashboard access (they already proved knowledge of the shared password); SSO remains the path for differentiated multi-user permissions. Surfaced from BEC-138 dogfood; basic-auth users on Enterprise were silently 401'd on every dashboard route. (#158)
- **BEC-157** — Pipeline auto-commit (`autoCommitChanges` in `packages/core/src/repo/git.ts`) now filters agent scratchpad files (`.claude/`, root-level `BEC-NNN-*.md`, root-level `verify-*.{mjs,ts,js,cjs}`, `BEC-NNN-*-VERIFICATION.md`) before committing. Bot-generated PRs no longer ship runner-specific paths or agent self-documentation. Includes a safety net: scratchpad paths already tracked in HEAD (operator committed pre-filter) are preserved as legit changes rather than silently deleted. New `isScratchpadPath` predicate exported for tests / debugging. (#159)
- **BEC-148** — `turbo.json` `test` task gets `dependsOn: ["^build"]` so `pnpm -r test` from the repo root no longer fails on `@urateam/core` resolution. Parallel to PR #145's `typecheck` fix. First fully-autonomous bot PR through the dogfood loop on the `quick-fix` pipeline. (#156)
- **BEC-147** — CHANGELOG conventions migrated to GitHub Releases as source of truth for v0.1.7+. CHANGELOG.md preserved for historical reference; new releases use auto-generated GH release notes going forward. (#155)

## [0.1.33] — 2026-05-05

Bumps:
- `@urateam/core`: 0.1.18 → 0.1.19
- `@urateam/cli`: 0.1.20 → 0.1.21
- `@urateam/dashboard`: 0.1.18 → 0.1.19
- `create-urateam`: 0.1.21 → 0.1.22

### Added
- **BEC-150** — `PM_AGENT_REQUIRE_PIPELINE_LABEL_FOR_PROMOTE` env var (default `false`, OSS+). When `true`, the PM agent's `promote` step skips Backlog issues whose labels don't resolve to a configured pipeline. Prevents Todo from accumulating items the agent would later refuse to start. Surfaced from BEC-138 dogfood (#153).
- **BEC-138 dogfood artifact** — Dockerfile + docker-compose.dogfood.yml + .env.dogfood.example + soak runbook for running urateam as a self-dogfood sidecar. Includes `claude-code` CLI for OAuth-subscription auth, `github-cli` for non-app gh auth, named volumes for data/work/.claude/.config persistence (#150, #151, #152).
- **CI** — `workflow_dispatch:` trigger added to ci.yml so the BEC-136 QA agent can fire release-readiness checks on demand (#150).

### Fixed
- BEC-138 deployment surfaced and resolved env-contract bugs in the original .env.dogfood.example: `URATEAM_LICENSE_JWT` → `URATEAM_LICENSE_KEY`, `RELEASE_MANAGER_TRIGGERS=joined-string` → individual `RELEASE_MANAGER_TRIGGER_*` vars, missing `LINEAR_WEBHOOK_SECRET` / `LINEAR_TEAM_ID` / `REPO_TEAM_ID` / `REPO_URL` / `DASHBOARD_USER` / `DASHBOARD_PASSWORD` / `AGENT_BYPASS_PERMISSIONS=true`. Dockerfile `CMD` corrected from `ura dev` to `ura start` (dev mode doesn't run PM/RM/QA agent loops) (#152).

## [Unreleased] — Historical (v0.1.7 – v0.1.30)

> **⚠️ Historical entries only — no longer updated.**
> The entries below accumulated since v0.1.7 (license JWT migration era) without being
> migrated into per-version sections as their corresponding versions shipped. They cover
> changes that landed in roughly v0.1.7 through v0.1.30. Backfilling 24 versions of
> per-version attribution would require reading ~24 PRs of git history and has been
> deferred in favour of moving to GitHub Releases (see the top-of-file note).
> **For release notes from v0.1.7 onward, see
> [https://github.com/JonB32/urateam/releases](https://github.com/JonB32/urateam/releases).**

### Added
- `@urateam/cli`: CLI version is now read from `package.json` instead of being hardcoded (#19, #25).
- `@urateam/cli`: new hidden `ura license issue` admin command for generating Ed25519-signed Enterprise license keys.
- `@urateam/core`: license keys are now Ed25519-signed JWTs validated offline against an embedded public key. Replaces the previous "any non-empty key grants Pro" placeholder.
- `@urateam/core`: new test helper `__tests__/helpers/license.ts` exports `installTestProLicense()` / `restoreLicense()` for downstream tests that need a valid signed JWT.
- `scripts/generate-license-keypair.ts`: operator helper that prints a fresh Ed25519 keypair for license signing.
- `@urateam/core`: per-team and per-repo daily token budgets via new `PmAgentConfig.budgets` block. Layers on top of the existing global `dailyTokenBudget` as an org-wide ceiling. Enterprise tier feature 4.3.
- `@urateam/core`: Slack budget alerts fire at 50%, 80%, and 100% of any scope's daily budget. Deduped once per `(date, scope, threshold)` via a new `budget_alerts` table. Cumulative thresholds — a scope that jumps from 0% to 85% in one tick posts both the 50% and 80% messages.
- `@urateam/core`: direct-webhook pipeline starts now respect the budget gate — at 100%, the run is refused with `{ runQueued: false, reason: "budget-exceeded" }` and logged. The PM Agent's `startTodoIssues` action on the next tick picks it up automatically after the budget resets (midnight UTC) or the cap is raised.
- `@urateam/core`: `startTodoIssues` short-circuits when the budget is blocked, so orphaned Todo issues don't bypass the cap.
- `pipeline_runs` table gains a `linear_team_id` column (nullable for legacy rows), populated from the Linear webhook payload at run creation time and from the parent run for review-feedback runs.
- New `budget_alerts` table with `UNIQUE(date, scope, threshold)` for persistent alert dedup.
- `@urateam/dashboard`: retry button on the run-detail view now opens a native `<dialog>` confirmation modal before submitting the POST. CSP-compliant via a small static `dialog.js` (BEC-133).
- `@urateam/dashboard`: retried runs now link back to their parent via `parentRunId` so the run-feed shows the lineage. Only applies to the `runner.start()` retry branch — `runner.resume()` continues to update the same row in place (BEC-133).

### Changed
- `pm/budget.ts`: `checkBudgetGuards` is replaced by `evaluateBudget`, which returns per-scope breakdowns (`ScopeBudget[]`) and a `worstTier` / `promoteBlocked` / `blockReason` verdict. Installs that don't configure `budgets` keep the existing single-global behavior with the addition of threshold alerts on the global scope. The previous silent 80% promotion-block gate is replaced with a 100% hard gate plus explicit 50/80 warnings. `checkBudgetGuards` remains as a thin backward-compat shim.
- In-flight pipeline runs are NOT aborted when the cap is crossed. Only new runs are refused. Operators resume by raising the cap (restart required) or waiting for midnight UTC.
- `percent` values now use `Math.floor` rather than `Math.round`, so thresholds trigger exactly at the integer boundary (99.9% → 99, not 100).
- **Breaking (license)**: tier enum renamed from `free | pro | team | enterprise` to `oss | pro | enterprise`. The `team` tier is removed. Code reading `LicenseStatus.tier` should expect `"oss"` where it previously expected `"free"`.
- **Breaking (license)**: `URATEAM_LICENSE_KEY` must now be a valid Ed25519-signed JWT issued by urateam. Existing placeholder keys will fail validation; the system falls back to OSS mode and logs a warning at startup.
- `LicenseStatus` interface gains `features: Set<string>`, `customerId`, `expiresAt`, `seats`, and `invalidReason` fields. The `key` field is removed.

### Fixed
- `@urateam/dashboard`: retry button is now hidden in unlicensed deployments. The route's 404 enforcement was already correct; the view's `canRetry` flag was inconsistently defaulting to `true` (BEC-133).
- `@urateam/core`: PR-comment-triggered review-feedback runs no longer fail with `Reached maximum number of turns (50)`. The runner was passing review comments as a `ralphContext` text suffix while the implement template fell through to the standard "create branch + implement issue from scratch" prompt — agent saw a contradictory prompt and burned all 50 turns. `executeFeedbackPipeline` now builds a structured `ReviewFeedbackContext` (via the new exported `buildReviewFeedbackContext()` helper) and routes it into the implement template's dedicated review-feedback branch (#137).
- `@urateam/core`: rebase-conflict resolution in the push-queue path no longer reuses the standard implement template. New `MergeConflictContext` type + dedicated template branch — focuses narrowly on `git status` / resolve markers / `git rebase --continue`; strips out issue data, INTEGRATION REQUIREMENT, acceptance-criteria verification, and build/test runs that were burning the agent's turn budget on irrelevant work (#137).
- `@urateam/core`: `reviewFeedbackBlock` now includes a `WARNING:` preamble inside `<review-feedback>`, matching the convention used by `<issue-data>` and `<previous-stage-context>`. Restores the in-band instruction-isolation defense that the previous text-form path provided (#137).
- `@urateam/core`: review-feedback implement template no longer instructs the agent to `git checkout` the PR branch. The worktree is already on the right branch via `createWorktreeFromRemote`, and per CLAUDE.md "Worktree Isolation Model", running `git checkout` inside a worktree can corrupt other concurrent runs sharing the same `.git`. Replaced with explicit "stay on current branch — do NOT run `git checkout`" (#137).

## [0.1.32] - 2026-05-04

### Added
- `@urateam/core`: **BEC-136 QA agent + release-readiness check** (Phase 1, OSS+ tier). New module at `packages/core/src/qa/` integrates as a 5th trigger field on `ReleaseManagerTriggers`. When configured, each Release Manager tick verifies a customer-defined GitHub Actions workflow has run green against the merge SHA before firing a release. Async fire-and-check across ticks: tick triggers a `workflow_dispatch`, observes an in-flight run, or files a Linear gap issue — never blocks. Spec + plan in `docs/superpowers/`. (#147)
- `@urateam/core`: 6-kind decision result (`pass | qa_failed | qa_running | qa_timed_out | qa_needs_trigger | qa_no_workflow`) drives different scheduler actions per kind. SHA-mismatch handling treats stale runs as "needs trigger" (fresh dispatch, old run abandoned). (#147)
- `@urateam/core`: gap-issue filing is rule-based (workflow-file-existence check) with a static Linear template — no LLM analysis in v1. Idempotent via new `qa_gap_issues` table with partial UNIQUE `WHERE resolved_at IS NULL`. (#147)
- `@urateam/core`: 3 new audit event types — `qa.run_triggered`, `qa.run_completed` (with synthetic flag for timeouts), `qa.gap_issue_filed`. All use `logAuditEventUnchecked` per the BEC-135 v2 Pro-tier audit-gating pattern. (#147)
- `@urateam/core`: 2 new columns on `release_decisions` (`qaRunId`, `qaRunSha`) + new `qa_gap_issues` table. Migrations sqlite 010+011, postgres 011+012. (#147)
- `@urateam/cli`: `RELEASE_MANAGER_TRIGGER_QA_*` env vars (workflow path, linearTeamId, timeoutMinutes) wired through `start.ts` with `LINEAR_API_KEY` validation. Documented in `.env.example`. (#147)
- New `dispatch_pending` result kind in `qa/github.ts` separates GitHub's eventual-consistency window (workflow_dispatch returned 204 but listWorkflowRuns hasn't indexed yet) from real dispatch failures — pending case does not consume the 3-attempt retry budget. (#147)

### Changed
- `@urateam/core`: `decide()` in `release-manager/decide.ts` accepts an optional 4th `qaState` parameter. Existing callers continue to work unchanged (3-arg form). The qaCheck evaluator slots in at position 4 (between `ciGreenForMinutes` and `requireSlackApproval`) so a QA failure produces a regular `skip` rather than the `awaiting-approval` terminal kind. (#147)
- `@urateam/core`: `CollectedState` gains a `qaRun: QaRunSnapshot | null` field populated by `collectState()` from the most-recent `release_decisions` row with non-null `qa_run_id`. (#147)
- `@urateam/core`: scheduler retry counter for `qa_dispatch_error` is now scoped to current `headSha` (was branch-wide) — prevents an old SHA's failure cycle from triggering immediate permanent-block on a new commit. (#147)
- `@urateam/core`: `qa.run_completed` audit events deduplicate by runId via in-memory Set in scheduler closure. (#147)
- `@urateam/core`: `markGapResolved` in `qa/gap.ts` is invoked by the scheduler whenever the workflow file is detected — sets `resolvedAt` on any open `qa_gap_issues` row, allowing future gaps for the same `(repo, branch, workflow)` to be re-filed. (#147)

### Fixed
- `@urateam/core`: `fileGapIssue` `linear_error` return is now handled with a 3-attempt retry counter (per spec §8). After 3 consecutive Linear API failures, the scheduler permanently skips with `reason="qa_gap_file_error"` instead of silently retrying forever. (#147)

## [0.1.31] - 2026-05-04

### Added
- `@urateam/core`: **BEC-135 Release Manager agent** (Pro tier). Cron-driven agent at `packages/core/src/release-manager/` that watches recently-merged PRs, evaluates configurable trigger rules each tick (`mergedPRsSince` / `timeSinceLastHours` / `ciGreenForMinutes` / `requireSlackApproval`), and cuts a GitHub release tag with auto-generated notes when conditions pass. Operator's existing CI/CD takes over for the actual deploy. Three-kind decision result (`fire | skip | awaiting-approval`) lets the dashboard distinguish "ready to ship, just needs approval" from cooldown skips. Spec + plan in `docs/superpowers/`. (#140)
- `@urateam/core`: `/release approve | skip <reason> | status` Slack subcommands routed via the existing `pm/slack-interface.ts` `/slack/commands` Hono router (dispatched by Slack's `command` form field). Approvals are one-shot tokens enforced by a partial UNIQUE index. (#140)
- `@urateam/core`: two new tables — `release_decisions` (one row per scheduler tick, with reason + trigger snapshot) and `release_approvals` (Slack-driven one-shot tokens consumed by the next eligible fire). Migration `009_release_manager.sql` (sqlite) + `010_release_manager.sql` (postgres). (#140)
- `@urateam/core`: 6 new audit event types — `release.fired`, `release.skipped`, `release.approved`, `release.tag_conflict`, `release.partial`, `slack.post_failed`. New actor type `release-manager`. (#140)
- `@urateam/core`: `release-manager` added to `PRO_FEATURES`. (#140)
- `@urateam/cli`: `RELEASE_MANAGER_*` env vars wired through `start.ts` with license + GitHub App credential gates. Documented in `.env.example`. (#140)
- New runtime dep: `croner@^9.0.0` for cron expression parsing. (#140)

### Changed
- `@urateam/core`: **Pro-tier audit events bypass the Enterprise `audit-log` license gate.** PM agent + Release Manager events (`pm.*` and `release.*`) now appear in the audit table whenever the Pro license is unlocked, regardless of whether the Enterprise audit-log dashboard is also licensed. Enterprise-only feature events (cost rollups, RBAC, SSO, org-policy) continue to use `logAuditEvent` and remain gated. The `audit-log` Enterprise feature now correctly refers only to retention sweep, dashboard reader, and CSV export — not to whether events are written. (#143)
- `@urateam/core`: SQLite `createDb()` now actually runs file-based migrations under `db/migrations/sqlite/` (was previously only running on Postgres). On existing SQLite deployments, all migrations 001–009 will be evaluated on first startup after upgrade. All scripts use `IF NOT EXISTS` / idempotent DDL, so this is safe. (#140)
- `@urateam/core`: `pm/slack-interface.ts` `/slack/commands` route now dispatches by Slack's `command` form field (`/pm` vs `/release`). Existing `/pm` behavior preserved exactly. (#140)

### Fixed
- `@urateam/core`: removed dead retry counter in `release-manager/scheduler.ts` for the `release_create_failed` branch. The retry was unreachable because `state.ts` `manualTagDetected` only considered `decision="fire"` rows — partial-fire's `fire-pending` row was excluded, so the next tick rebaselined via `manual_tag_detected` before reaching the retry path. Replaced with a single skip row + immediate `releasePartialEvent` audit. Operators clean up the orphaned tag manually. Proper retry-on-fire-pending sweep is queued as v2 (BEC-139). (#143)

### Known v1 simplifications (BEC-135)
- `/release status` renders only the recent decision rows, not the live trigger-state matrix from spec §7. Tracked as BEC-140.
- Single Release Manager instance per process (one configured repo). Tracked as BEC-141.
- No Slack interactive buttons (slash commands only). Tracked as BEC-142.
- No pre-release / RC tag support (e.g. `v1.2.3-beta.1`). Tracked as BEC-143.

## [0.1.6] - 2026-04-13

### Fixed
- `create-urateam`: re-running the scaffolder no longer overwrites an existing `.env` or `package.json`. Both files are preserved on subsequent runs (#16).

## [0.1.5] - 2026-04-13

### Fixed
- `create-urateam`: `.gitignore` is now generated inline instead of copied from `template/`. npm strips files literally named `.gitignore` from published tarballs, which caused an `ENOENT` crash in 0.1.4 (#15).

## [0.1.4] - 2026-04-13

### Changed
- Workspace version bump to align all packages.

### Known Issues
- `create-urateam@0.1.4` crashes on first run with `ENOENT: .gitignore` because npm excluded the template `.gitignore` from the tarball. Fixed in 0.1.5.

## [0.1.3] - 2026-04-12

### Fixed
- Publish workflow: use `npx npm@latest` for OIDC trusted publishing instead of attempting a global `npm install -g npm@latest` self-upgrade, which left the bundled install broken (#12, #13).

## [0.1.2] - 2026-04-12

### Fixed
- Publish: `pnpm pack` + `npm publish` flow resolves `workspace:*` to real versions in published tarballs, restoring OIDC provenance (#3).

## [0.1.1] - 2026-04-11

### Fixed
- Workspace dependency resolution in published packages.

## [0.1.0] - 2026-04-11

### Added
- Initial monorepo: `@urateam/core`, `@urateam/dashboard`, `@urateam/cli`, `create-urateam` scaffolder.
- Webhook → pipeline → PR flow (triage, implement, test, review stages).
- PM Agent for autonomous backlog management.
- License gate for commercial features (`URATEAM_LICENSE_KEY`).
- Linear, Slack, Discord, GitHub App, GitLab notifiers and integrations.
- Drizzle ORM with unified SQLite/Postgres schema.

## Release process

> **As of v0.1.7, GitHub Releases is the source of truth for release notes.**
> This CHANGELOG is no longer updated with new version sections. Per-version notes live at
> [https://github.com/JonB32/urateam/releases](https://github.com/JonB32/urateam/releases).

When cutting a new version:

1. Update the version in each package's `package.json` (or only the affected package for per-package releases).
2. Open a PR titled `chore: bump to vX.Y.Z`. After merge, tag the merge commit `vX.Y.Z` and push the tag — the publish workflow takes it from there.
3. Create a GitHub Release: `gh release create vX.Y.Z --generate-notes`. GitHub auto-generates release notes from PR titles and commit messages. This is the canonical per-version record going forward — do **not** add a new section to `CHANGELOG.md`.

**Note:** Steps 1–3 of this historical process previously included updating `CHANGELOG.md`. That step is retired. The file is preserved for its pre-v0.1.7 sections and the accumulated v0.1.7–v0.1.30 historical block.

[Unreleased]: https://github.com/JonB32/urateam/compare/v0.1.32...HEAD
[0.1.32]: https://github.com/JonB32/urateam/compare/v0.1.31...v0.1.32
[0.1.31]: https://github.com/JonB32/urateam/compare/v0.1.30...v0.1.31
[0.1.6]: https://github.com/JonB32/urateam/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/JonB32/urateam/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/JonB32/urateam/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/JonB32/urateam/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/JonB32/urateam/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/JonB32/urateam/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/JonB32/urateam/releases/tag/v0.1.0

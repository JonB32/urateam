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

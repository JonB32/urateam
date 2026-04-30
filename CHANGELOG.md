# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions below refer to the workspace version published to npm. Per-package
notes call out when a change affects only a single package.

## [Unreleased]

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

When cutting a new version:

1. Update the version in each package's `package.json` (or only the affected package for per-package releases).
2. Move the `[Unreleased]` entries into a new section with the version and date.
3. Open a PR titled `chore: bump to vX.Y.Z`. After merge, tag the merge commit `vX.Y.Z` and push the tag — the publish workflow takes it from there.
4. Add a fresh empty `[Unreleased]` block on top.

[Unreleased]: https://github.com/JonB32/urateam/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/JonB32/urateam/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/JonB32/urateam/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/JonB32/urateam/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/JonB32/urateam/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/JonB32/urateam/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/JonB32/urateam/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/JonB32/urateam/releases/tag/v0.1.0

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

### Changed
- **Breaking (license)**: tier enum renamed from `free | pro | team | enterprise` to `oss | pro | enterprise`. The `team` tier is removed. Code reading `LicenseStatus.tier` should expect `"oss"` where it previously expected `"free"`.
- **Breaking (license)**: `URATEAM_LICENSE_KEY` must now be a valid Ed25519-signed JWT issued by urateam. Existing placeholder keys will fail validation; the system falls back to OSS mode and logs a warning at startup.
- `LicenseStatus` interface gains `features: Set<string>`, `customerId`, `expiresAt`, `seats`, and `invalidReason` fields. The `key` field is removed.

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

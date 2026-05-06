# Contributing to urateam

## Development Setup

```bash
git clone https://github.com/JonB32/urateam.git
cd urateam
pnpm install
pnpm build
pnpm test
```

## Project Structure

```
packages/
  core/             @urateam/core — pipeline runner, DB, executor, webhooks, PM Agent
  dashboard/        @urateam/dashboard — Hono+HTMX ops dashboard
  cli/              @urateam/cli — CLI tool (ura dev, ura start)
  create-urateam/   create-urateam — project scaffolding
```

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with tests
3. Run `pnpm build && pnpm test` to verify
4. Open a PR — CI will run automatically

## Code Style

- TypeScript, ESM modules
- Vitest for testing
- pino for structured logging (`createLogger()` — never `console.log`)
- `execFile` (never `exec`) for shell commands
- Sanitize all untrusted input before including in agent prompts

## Release Notes Convention

Per-version release notes for v0.1.7 and later live on the **GitHub Releases** page:
[https://github.com/JonB32/urateam/releases](https://github.com/JonB32/urateam/releases)

`CHANGELOG.md` is preserved for historical reference only (v0.1.0 – v0.1.6 sections, plus
an accumulated block of v0.1.7 – v0.1.30 entries that were never backfilled). **Do not add
new version sections to `CHANGELOG.md`.**

### Cutting a release

1. Update versions in each affected `package.json`.
2. Open a PR titled `chore: bump to vX.Y.Z` and merge it.
3. Tag the merge commit: `git tag vX.Y.Z && git push origin vX.Y.Z` — the publish workflow handles npm publishing.
4. Create the GitHub Release: `gh release create vX.Y.Z --generate-notes` — this is the canonical per-version record.

## License

By contributing, you agree that your contributions will be licensed under the BSL 1.1 license.

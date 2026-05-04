# urateam

Autonomous software delivery framework. Connect Linear + GitHub, agents implement, test, review, and ship code — automatically.

## Quick Start

```bash
npx create-urateam my-project
cd my-project
ura dev
```

## Packages

| Package | Description |
|---------|-------------|
| `@urateam/core` | Pipeline runner, DB, executor, webhooks, PM Agent, audit log, license |
| `@urateam/dashboard` | Ops dashboard (Hono + HTMX) with cost/ROI, audit, users, coordination |
| `@urateam/cli` | CLI (`ura dev`, `ura start`, `ura run`, `ura admin`) |
| `create-urateam` | Project scaffolding |

## Tiers

| Tier | Pitch |
|---|---|
| **OSS** | Self-hosted, BYO Anthropic key. Free. Includes QA agent (orchestrate existing GitHub Actions workflow as a release-readiness gate; file Linear gap issues for missing harness). |
| **Pro** | Multi-repo, advanced auto-merge, deep review, PM Agent with Slack interface + conflict detection + approval workflows, Release Manager (cron-driven auto-tag + GitHub release on configurable triggers, Slack approval flow). |
| **Enterprise** | Adds SSO (WorkOS), audit log + export, spend caps & alerts, RBAC, cost & ROI dashboard, org policy / guardrails. Sales-led. |

See `docs/superpowers/specs/2026-04-13-enterprise-tier-design.md` for the full feature matrix.

## Development

```bash
pnpm install              # install all dependencies
pnpm build                # build all packages (via Turborepo)
pnpm test                 # unit tests only (~60s)
pnpm test:integration     # BEC-99 cross-worktree + other heavy git integration tests
```

Per-package tests:

```bash
cd packages/core && npx vitest run                            # core unit tests
cd packages/core && npx vitest run src/__tests__/<file>       # specific test
cd packages/core && npx vitest --changed                      # tests affected by uncommitted changes
```

## Documentation

- `CLAUDE.md` — architecture, conventions, module map. Kept current as features ship.
- `deploy/` — Docker, Caddy, setup scripts. Per-feature setup docs (`SSO_SETUP.md`, `RBAC_SETUP.md`).
- `docs/superpowers/specs/` — design specs, one per feature.
- `examples/` — basic, monorepo, multi-repo, custom stages configurations.

## License

BSL 1.1 — see [LICENSE](./LICENSE). Managed Service use requires a commercial license.

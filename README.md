# urateam

Autonomous software delivery framework. Connect Linear + GitHub, agents implement, test, review, and ship code — automatically.

## Self-Hosted Quickstart

```bash
npx @urateam/cli bootstrap
```

Or if you have `ura` installed:

```bash
ura bootstrap
```

This runs interactive pre-flight checks, creates a GitHub App, registers a Linear webhook, and generates a `docker-compose.yml` ready to `docker compose up`.

**Prerequisites:** Docker, curl, openssl, a GitHub account, a Linear workspace.

### Headless / SSH-only hosts

On a server with no graphical display the wizard auto-detects the environment
(no `DISPLAY` / `WAYLAND_DISPLAY`) and switches to a headless flow: it prints
the GitHub App creation URL, you open it in a browser on any machine, complete
the app creation, then paste the `code` query parameter from the redirect URL
back into the terminal.

You can also force headless mode explicitly:

```bash
ura bootstrap --headless
```

The OAuth callback timeout is configurable (default 5 minutes):

```bash
ura bootstrap --headless --oauth-timeout-ms 600000
# or via env var:
BOOTSTRAP_OAUTH_TIMEOUT_MS=600000 ura bootstrap
```

## Development Quickstart

```bash
npx create-urateam my-project
cd my-project
ura dev
```

You'll need a Claude credential. The three supported paths (and which to pick) are documented in [`deploy/CLAUDE_AUTH.md`](deploy/CLAUDE_AUTH.md). For production, use `ANTHROPIC_API_KEY` (pay-per-token) or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (Pro/Max subscription) — both are long-lived. Avoid mounting the local `claude login` session credentials in production; that path expires weekly.

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

## Releases

```bash
pnpm cut-release patch          # bump all 4 packages + Dockerfile + compose + CHANGELOG; commit on a release branch
pnpm cut-release patch --push   # also push the branch and open the PR via gh
pnpm cut-release patch --dry-run # show what would change, write nothing
```

After the release PR merges: `git tag vX.Y.Z <merge-sha> && git push origin vX.Y.Z` fires the npm OIDC publish workflow; then `gh release create vX.Y.Z` for the user-facing release page.

## Documentation

- `CLAUDE.md` — architecture, conventions, module map. Kept current as features ship.
- `deploy/` — Docker, Caddy, setup scripts. Per-feature setup docs (`SSO_SETUP.md`, `RBAC_SETUP.md`).
- `docs/superpowers/specs/` — design specs, one per feature.
- `examples/` — basic, monorepo, multi-repo, custom stages configurations.

## License

BSL 1.1 — see [LICENSE](./LICENSE). Managed Service use requires a commercial license.

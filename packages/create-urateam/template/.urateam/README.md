# urateam sidecar

This directory contains the [urateam](https://github.com/JonB32/urateam)
agent configuration for this project. urateam is a **sidecar** — it runs
alongside the project repo as an isolated utility and processes Linear issues
to implement features, fix bugs, and create PRs automatically.

## Setup

1. Copy `.env.example` to `.env` and fill in. NEVER commit `.env`.
2. Install dependencies: `pnpm install`
3. **Authenticate Claude** (OSS path only — see [Claude auth lifecycle](#claude-auth-lifecycle-oss-tier) below): `claude login`. Skip if you set `ANTHROPIC_API_KEY` (recommended for production / containerized deploys).
4. Start the agent: `pnpm dev` (SQLite, local dev) or `pnpm start` (production)

For VPS / containerized deployment, see [Production deploy](#production-deploy-via-docker-compose) below.

## Claude auth lifecycle (OSS tier)

The free / OSS tier of urateam runs against the local `claude` CLI session,
**not** an Anthropic API key. That session expires periodically (typically
weekly) and **`ura dev` will refuse to start when the session is invalid** —
this prevents the failure mode where webhooks fail mid-pipeline and Linear
issues get marked as failed before you notice.

If you see this banner at startup (the exact wording varies slightly between
`pnpm dev` and `pnpm start`):

```
⚠ Claude session auth check failed at startup.
  The local `claude` session is missing or expired.
  Run `claude login` and restart `ura dev`. Without this fix,
  webhooks will fail mid-pipeline and the agent will mark Linear issues
  as failed — requiring manual recovery.
```

…run `claude login` (interactive — opens a browser), then restart `pnpm dev`
or `pnpm start`. Once running, urateam re-checks the session before each
agent invocation, so a session that expires mid-day is caught before it
mutates Linear state.

**Production / containerized:** the production banner shown by `pnpm start`
mentions the docker-compose form: `docker compose exec <service> claude login`.
Use that variant when re-authing inside a running container.

**Upgrading off this:** the Anthropic API tier (long-lived API key) doesn't
have session-lifetime semantics, so this whole concern goes away. See the
[urateam docs](https://github.com/JonB32/urateam) for upgrade paths.

## Expose the webhook (local dev only)

The agent listens on `http://localhost:3000/webhooks/linear`. For local
development, expose via ngrok:

```bash
ngrok http 3000
```

Configure the ngrok URL as a webhook in Linear settings with the
`LINEAR_WEBHOOK_SECRET` from your `.env`. For production, see
[Production deploy](#production-deploy-via-docker-compose) — Caddy
handles HTTPS termination directly and you wire Linear to your real domain.

## Dashboard

The ops dashboard runs on `http://localhost:3001`. Credentials from
`DASHBOARD_USER` / `DASHBOARD_PASSWORD` in `.env`.

## Production deploy via docker compose

Compose template ships a hardened three-service stack:

- **caddy** — reverse proxy on :80/:443 with automatic Let's Encrypt certs.
  Routes `/webhooks/*` and `/slack/*` to the agent (:3000), everything else
  to the dashboard (:3001).
- **agent** — `ura start`. No public ports; reachable only via Caddy.
- **postgres** — internal-only network, no published ports. Password from
  `POSTGRES_PASSWORD` (compose refuses to start without it).

### Pre-flight

1. **Provision a VPS** (Hetzner, DigitalOcean, Hetzner, Linode, etc.). 4 GB RAM
   minimum for `MAX_CONCURRENT_RUNS=3`.
2. **Point a domain** (e.g. `urateam.your-domain.com`) at the VPS IP. Caddy needs
   ports 80 + 443 open for ACME challenges.
3. **Install Docker** and the Compose plugin on the box.

### Deploy

```bash
# 1. On the VPS, clone or scp this project
cd /opt/<project>/.urateam

# 2. Copy and fill in env
cp .env.example .env
# At minimum set: DOMAIN, POSTGRES_PASSWORD (openssl rand -base64 32),
# ANTHROPIC_API_KEY, URATEAM_LICENSE_KEY (for Pro), LINEAR_*, REPO_*,
# DASHBOARD_PASSWORD, GH_TOKEN.

# 3. Bring up the stack
docker compose up -d --build

# 4. Tail logs to verify license, webhooks, dashboard
docker compose logs -f agent
```

After the first run, Caddy will request and store a Let's Encrypt cert for
`$DOMAIN`. The dashboard is reachable at `https://$DOMAIN`, webhooks at
`https://$DOMAIN/webhooks/linear`.

### Wiring Linear

In Linear → Workspace settings → API → Webhooks → Create:

- URL: `https://$DOMAIN/webhooks/linear`
- Secret: paste `LINEAR_WEBHOOK_SECRET` from `.env`
- Subscribe to: Issue state changes (and any others your pipelines key off of).

### Re-deploy

```bash
git pull && docker compose up -d --build
```

### Backups

`pgdata` and `agent-runs` are named docker volumes. For backups, snapshot the
host volume directory or use `docker run --rm -v pgdata:/data … pg_dump` style
sidecars. Workspace dirs (`/var/agent-runs`, `/var/agent-repos`) auto-clean
older than `WORKTREE_TTL_HOURS` (default 24h).

## How it works

1. Move a Linear issue to the `Todo` state with an appropriate pipeline label
   (e.g., `auto-implement`, `bug`, `quick-fix`, `needs-design`)
2. The urateam agent picks it up, clones the repo, executes the pipeline stages
   (implement → test → review), and opens a PR
3. You review the PR in GitHub

See the project root `CLAUDE.md` for project-specific conventions that the
agent reads when implementing features.

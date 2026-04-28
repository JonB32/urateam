# urateam sidecar

This directory contains the [urateam](https://github.com/JonB32/urateam)
agent configuration for this project. urateam is a **sidecar** — it runs
alongside the project repo as an isolated utility and processes Linear issues
to implement features, fix bugs, and create PRs automatically.

## Setup

Two paths: pick one.

### Local dev (your laptop)

1. Copy `.env.example` to `.env` and fill in. NEVER commit `.env`.
2. Install dependencies: `pnpm install`
3. **Authenticate Claude** (OSS path only — see [Claude auth lifecycle](#claude-auth-lifecycle-oss-tier) below): `claude login`. Skip if you set `ANTHROPIC_API_KEY`.
4. Start the agent: `pnpm dev`

### Production VPS

Skip the `pnpm install` / `pnpm dev` steps and jump straight to [Production deploy](#production-deploy-via-docker-compose) — Docker Compose handles everything.

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

1. **Provision a VPS** (Hetzner, DigitalOcean, Linode, Fly, etc.). 4 GB RAM
   minimum for `MAX_CONCURRENT_RUNS=3`.
2. **Point a domain** (e.g. `urateam.your-domain.com`) at the VPS IP. Caddy needs
   ports 80 + 443 open for ACME challenges.
3. **Install Docker** and the Compose plugin on the box.

### Deploy

The order matters: `claude login` runs against the **host's** `~/.claude/`
directory, which is bind-mounted into the agent container. The credentials
file must exist on the host before `docker compose up`, otherwise compose
creates an empty *directory* at the bind-mount path and Claude Code's
preflight will fail.

```bash
# 1. On the VPS, clone or scp this project
cd /opt/<project>/.urateam

# 2. Copy and fill in env
cp .env.example .env
# At minimum set: DOMAIN, CADDY_EMAIL, POSTGRES_PASSWORD (openssl rand -base64 32),
# URATEAM_LICENSE_KEY (for Pro), LINEAR_*, REPO_*, DASHBOARD_PASSWORD.
# If you'll use ANTHROPIC_API_KEY (headless API auth), set it now and skip step 3.

# 3. (Subscription Anthropic auth only) Run `claude login` once against the
#    host's ~/.claude/. Uses the agent image as a one-off container so you
#    don't need claude-code installed on the host.
mkdir -p ~/.claude
docker compose run --rm -it --entrypoint "" \
  -v ~/.claude:/root/.claude \
  agent claude login
# Device flow — paste URL into laptop browser, enter code. The login writes
# ~/.claude/.credentials.json on the host, which docker-compose.yml then
# bind-mounts into the agent container.

# 4. Build + bring up the stack
docker compose up -d --build

# 5. Authenticate gh CLI inside the running container. Required for git
#    clone of private repos and PR creation. Persisted in the gh-config
#    volume — combined with the system-wide credential helper baked into
#    the Dockerfile, git operations Just Work after this one-time login.
docker compose exec agent gh auth login
# Pick: GitHub.com → HTTPS → "Authenticate Git? Yes" → web browser device flow

# 6. Tail logs to verify license, webhooks, dashboard
docker compose logs -f agent
```

After the first run, Caddy will request and store a Let's Encrypt cert for
`$DOMAIN`. The dashboard is reachable at `https://$DOMAIN`, webhooks at
`https://$DOMAIN/webhooks/linear` (NOT under `DASHBOARD_BASE_PATH` — webhook
routes are server-level, not dashboard-level, even if the dashboard is
mounted under a path prefix like `/ateam`).

### Wiring Linear

In Linear → Workspace settings → API → Webhooks → Create:

- URL: `https://$DOMAIN/webhooks/linear`  ⚠ NOT `https://$DOMAIN/$DASHBOARD_BASE_PATH/webhooks/linear` — webhook routes are server-level, not dashboard-level. Even if your dashboard is mounted under `/ateam`, the webhook stays at root.
- Secret: paste `LINEAR_WEBHOOK_SECRET` from `.env`
- Subscribe to: Issue state changes (and any others your pipelines key off of).

### Postgres password gotcha

Postgres only honors `POSTGRES_PASSWORD` on **first init** when its data
directory is empty. If you change the password in `.env` after the first
`docker compose up`, the agent will fail with `password authentication
failed for user "urateam"` because the password baked into the existing
`pgdata` volume is the original one.

To recover (destructive — wipes pipeline run history):
```bash
docker compose down -v   # -v drops pgdata + agent-runs + agent-repos
docker compose up -d
```

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

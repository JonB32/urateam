# urateam sidecar

This directory contains the [urateam](https://github.com/JonB32/urateam)
agent configuration for this project. urateam is a **sidecar** — it runs
alongside the project repo as an isolated utility and processes Linear issues
to implement features, fix bugs, and create PRs automatically.

## Setup

1. Fill in `.env` with your Linear API key, webhook secret, team ID, and repo URL
2. Install dependencies: `pnpm install`
3. **Authenticate Claude** (OSS path only — see [Claude auth lifecycle](#claude-auth-lifecycle-oss-tier) below): `claude login`
4. Start the agent: `pnpm dev` (SQLite, local dev) or `pnpm start` (production)

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

## Expose the webhook

The agent listens on `http://localhost:3000/webhooks/linear`. To receive
webhooks from Linear, expose this port via ngrok or a reverse proxy:

```bash
ngrok http 3000
```

Configure the ngrok URL as a webhook in Linear settings with the
`LINEAR_WEBHOOK_SECRET` from your `.env`.

## Dashboard

The ops dashboard runs on `http://localhost:3001`. Credentials from
`DASHBOARD_USER` / `DASHBOARD_PASSWORD` in `.env`.

## How it works

1. Move a Linear issue to the `Todo` state with an appropriate pipeline label
   (e.g., `auto-implement`, `bug`, `quick-fix`, `needs-design`)
2. The urateam agent picks it up, clones the repo, executes the pipeline stages
   (implement → test → review), and opens a PR
3. You review the PR in GitHub

See the project root `CLAUDE.md` for project-specific conventions that the
agent reads when implementing features.

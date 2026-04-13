# urateam sidecar

This directory contains the [urateam](https://github.com/JonB32/urateam)
agent configuration for this project. urateam is a **sidecar** — it runs
alongside the project repo as an isolated utility and processes Linear issues
to implement features, fix bugs, and create PRs automatically.

## Setup

1. Fill in `.env` with your Linear API key, webhook secret, team ID, and repo URL
2. Install dependencies: `pnpm install`
3. Start the agent: `pnpm dev` (SQLite, local dev) or `pnpm start` (production)

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

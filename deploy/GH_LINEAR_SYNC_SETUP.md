# GitHub Issues → Linear Sync Setup Guide

## Overview

The `gh-linear-sync` utility bridges GitHub Issues and Linear, enabling a fully
autonomous change-management and incident-management workflow:

```
Public / user files GitHub Issue
        ↓  (hourly sync)
Linear ticket created in Triage state
        ↓  (PM Agent triage + autonomous pipeline)
Implemented, reviewed, and closed via urateam
        ↓  (optional bidirectional close)
GitHub Issue closed automatically
```

**Operator mental model:**

| System   | Purpose                                                             |
|----------|---------------------------------------------------------------------|
| GitHub   | **Inbound** — public issue filing, Quality Observer findings        |
| Linear   | **Triage / work-tracking** — prioritisation, autonomous pipeline routing |

---

## Deployment Decision

**Selected approach: GitHub Action** (`.github/workflows/gh-linear-sync.yml`)

Rationale:
- Zero host infrastructure — runs on GitHub's compute, free for public repos.
- Trivially scheduled via the `schedule.cron` trigger (hourly by default).
- Manual re-trigger via `workflow_dispatch` for immediate sync or dry-run testing.
- All configuration lives in repo secrets / variables — no separate deploy needed.
- Larger features (comment sync, webhook-driven sync) can graduate to a sidecar later.

---

## Quick Start

### 1. Create a Linear API Key

1. Go to **Linear → Settings → API → Personal API Keys**.
2. Create a key and note the value.

### 2. Find Your Linear Team ID

Run the following in the Linear API playground or via `curl`:

```bash
curl -H "Authorization: YOUR_LINEAR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"query": "{ teams { nodes { id name } } }"}' \
     https://api.linear.app/graphql
```

Copy the `id` for your team.

### 3. Configure GitHub Secrets

In your repo go to **Settings → Secrets and variables → Actions → Secrets** and add:

| Secret name                       | Value                              |
|-----------------------------------|------------------------------------|
| `GH_LINEAR_SYNC_LINEAR_API_KEY`   | Linear Personal API key            |
| `GH_LINEAR_SYNC_LINEAR_TEAM_ID`   | Linear team UUID                   |

> **Note:** `GH_LINEAR_SYNC_GITHUB_TOKEN` defaults to the built-in `github.token`
> which has read/write access to issues on the same repo. You only need to set it
> as a secret if you want to sync issues from a *different* repo.

### 4. Configure Optional Variables

In **Settings → Secrets and variables → Actions → Variables** (optional):

| Variable name                        | Default                                    | Description                                          |
|--------------------------------------|--------------------------------------------|------------------------------------------------------|
| `GH_LINEAR_SYNC_LABEL_FILTERS`       | `urateam-quality-observer,bug,enhancement` | Comma-separated GitHub labels to filter              |
| `GH_LINEAR_SYNC_TRIAGE_STATE`        | `Triage`                                   | Linear workflow state name for new tickets           |
| `GH_LINEAR_SYNC_BIDIRECTIONAL_CLOSE` | `false`                                    | Set `true` to close GH issues when Linear is Done    |

### 5. Verify with a Dry Run

Trigger the workflow manually:

1. Go to **Actions → GitHub Issues → Linear Sync → Run workflow**.
2. Set **Dry-run** to `true`.
3. Review the logs — you should see `[dry-run] would create Linear ticket` for each
   unsynced GitHub issue.

### 6. Enable the Sync

The scheduled workflow runs every hour automatically once the secrets are set.
No further action is needed.

---

## Idempotency

The sync is **idempotent**: running it multiple times for the same GitHub issue
creates exactly one Linear ticket.

**How it works:**

1. For each open GitHub issue, the sync searches Linear for a ticket whose title
   starts with `[GH#NNN]` (where `NNN` is the GitHub issue number).
2. If a match is found, the issue is skipped.
3. If no match is found, a new Linear ticket is created with:
   - **Title:** `[GH#NNN] <original GitHub title>`
   - **Description:** original body + a permalink + an HTML idempotency marker
     (`<!-- gh-linear-sync:NNN -->`).
   - **State:** the configured Triage state (default: `"Triage"`).

---

## Bidirectional Close-Out

When `GH_LINEAR_SYNC_BIDIRECTIONAL_CLOSE=true`:

- During each sync run, if a GitHub issue already has a Linear ticket **and** that
  ticket is in a completed state (`type: completed` or name `Done`), the
  corresponding GitHub issue is automatically closed.
- This is a **one-way close**: GitHub → closed. It does not reopen issues.
- This feature is gated behind the environment variable so it can be enabled
  incrementally without risk.

---

## Local Development

```bash
# Build the core package (required — scripts/gh-linear-sync.ts imports @urateam/core)
pnpm build

# Dry-run against a real repo (reads but does not write)
GH_LINEAR_SYNC_GITHUB_TOKEN=ghp_...         \
GH_LINEAR_SYNC_GITHUB_REPO=owner/repo       \
GH_LINEAR_SYNC_LINEAR_API_KEY=lin_api_...   \
GH_LINEAR_SYNC_LINEAR_TEAM_ID=team-uuid     \
GH_LINEAR_SYNC_DRY_RUN=true                 \
pnpm exec tsx scripts/gh-linear-sync.ts

# Live sync with label filter
GH_LINEAR_SYNC_LABEL_FILTERS=urateam-quality-observer \
pnpm exec tsx scripts/gh-linear-sync.ts
```

---

## Architecture

```
.github/workflows/gh-linear-sync.yml   — Scheduled GH Action (hourly)
scripts/gh-linear-sync.ts              — Entry point: reads env vars, creates clients
packages/core/src/sync/gh-linear-sync.ts  — Core logic (pure functions, mockable clients)
packages/core/src/sync/index.ts         — Barrel export from @urateam/core
packages/core/src/__tests__/gh-linear-sync.test.ts  — Unit tests
```

The core module (`packages/core/src/sync/gh-linear-sync.ts`) exposes:
- `runGhLinearSync(config, { github, linear })` — main orchestrator
- `findLinearTicketForGhIssue(...)` — idempotency check
- `createLinearTicketForGhIssue(...)` — ticket creation
- `makeIdempotencyMarker(n)` — produces `<!-- gh-linear-sync:N -->`
- `createGitHubSyncClientFromToken(token)` — Octokit-backed GitHub client factory
- `createLinearSyncClientFromApiKey(apiKey)` — LinearClient-backed factory

All clients implement thin interfaces (`GitHubSyncClient`, `LinearSyncClient`) so
the unit tests can inject mocks without network access.

---

## Roadmap

| Feature                             | Status       |
|-------------------------------------|--------------|
| GH → Linear ticket creation          | ✅ Shipped   |
| Idempotency via title prefix          | ✅ Shipped   |
| Label filter support                  | ✅ Shipped   |
| Bidirectional close-out               | ✅ Shipped (opt-in) |
| One-way comment sync (GH → Linear)   | Planned      |
| Webhook-driven sync (sub-minute)      | Planned      |
| Per-label pipeline label override     | Planned      |

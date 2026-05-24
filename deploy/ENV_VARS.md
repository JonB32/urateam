# Environment Variables Reference

All variables consumed by `ura start` and `ura dev` are validated at boot time by
`packages/cli/src/lib/load-env-config.ts`. Missing required variables and invalid
values are reported together in a single error before any server starts.

**Legend**
- **Required (prod)** — must be set for `ura start`; optional/ignored in `ura dev`
- **Required (always)** — must be set in both modes
- **Required if** — conditionally required based on another var
- **Optional** — may be omitted; column shows default value when one exists

---

## Core

| Variable | Type | Mode | Default | Description |
|---|---|---|---|---|
| `LINEAR_WEBHOOK_SECRET` | string | Required (prod) | — | Secret for verifying Linear webhook signatures |
| `LINEAR_API_KEY` | string | Optional | `""` | Linear API key for PM Agent and Release Manager operations |
| `DASHBOARD_USER` | string | Required (prod) | — | Basic-auth username for the dashboard |
| `DASHBOARD_PASSWORD` | string | Required (prod) | — | Basic-auth password for the dashboard |
| `DATABASE_URL` | string | Optional | SQLite | Postgres connection URL. Omit to use embedded SQLite. Prefix: `postgres://` |
| `URATEAM_LICENSE_KEY` | string | Optional | — | License key unlocking Enterprise features (SSO, audit log, RBAC, cost, policy) |
| `ANTHROPIC_API_KEY` | string | Optional | — | Anthropic API key for Claude. One of this or `CLAUDE_CODE_OAUTH_TOKEN` is required for agent execution |
| `CLAUDE_CODE_OAUTH_TOKEN` | string | Optional | — | Long-lived OAuth token from `claude setup-token`. Alternative to `ANTHROPIC_API_KEY` |

---

## Repo Config

| Variable | Type | Mode | Default | Description |
|---|---|---|---|---|
| `REPO_TEAM_ID` | string | Required (always) | — | Linear team ID (UUID). Used as the key in the repo-config map |
| `REPO_URL` | string | Required (always) | — | Git remote URL (HTTPS or SSH) |
| `REPO_DEFAULT_BRANCH` | string | Optional | `main` | Default branch for PRs |
| `REPO_TEST_CMD` | string | Optional | `pnpm test` | Test command run in the agent worktree |
| `REPO_BUILD_CMD` | string | Optional | `pnpm build` | Build command run in the agent worktree |
| `REPO_EXCLUDE_PLUGINS` | string (csv) | Optional | — | Comma-separated plugin paths to exclude from auto-detection (e.g. `superpowers`) |
| `REPO_EXCLUDE_MCP_SERVERS` | string (csv) | Optional | — | Comma-separated MCP server names to exclude from auto-detection |
| `REPO_DISABLE_PLUGIN_AUTODETECT` | boolean | Optional | `false` | Set `true` to disable all plugin auto-detection |

---

## GitHub App

Required to use GitHub App features (PR creation via App, mandatory reviewers, Release Manager).

| Variable | Type | Mode | Default | Description |
|---|---|---|---|---|
| `GITHUB_APP_ID` | string | Optional | — | GitHub App ID. Both this and `GITHUB_PRIVATE_KEY_PATH` must be set together |
| `GITHUB_PRIVATE_KEY_PATH` | string | Optional | — | Path to the `.pem` private key file for the GitHub App |
| `GITHUB_INSTALLATION_ID` | integer | Optional | — | Installation ID. Required for some multi-org setups |
| `GITHUB_WEBHOOK_SECRET` | string | Optional | — | Secret for verifying GitHub webhook signatures. Enables PR feedback pipeline |
| `GITHUB_FEEDBACK_AUTO_TRIGGER` | boolean | Optional | `true` | Set `false` to require explicit `@ateam` keyword on all PR comments |
| `GITHUB_FEEDBACK_TRIGGER_KEYWORD` | string | Optional | — | Keyword that activates the review-feedback pipeline in PR comments |
| `GITHUB_FEEDBACK_ALLOWED_REVIEWERS` | string (csv) | Optional | — | Comma-separated GitHub usernames whose review comments trigger the pipeline |
| `GITHUB_FEEDBACK_BOT_LOGINS` | string (csv) | Optional | — | Comma-separated bot login names to ignore in PR comment processing |

---

## Server / Infrastructure

| Variable | Type | Mode | Default | Description |
|---|---|---|---|---|
| `PORT` | integer | Optional | `3000` | Webhook server port |
| `DASHBOARD_PORT` | integer | Optional | `3001` | Dashboard server port |
| `AGENT_RUN_DIR` | string | Optional | `~/data/runs` | Directory where agent worktrees are created |
| `REPO_CLONE_DIR` | string | Optional | `~/work/repos` | Directory where repos are cloned |
| `MAX_CONCURRENT_RUNS` | integer | Optional | `3` | Maximum number of pipeline runs executing in parallel |
| `WORKTREE_TTL_HOURS` | integer | Optional | `24` | Hours before stale worktrees are garbage-collected |

---

## Notifications

| Variable | Type | Mode | Default | Description |
|---|---|---|---|---|
| `SLACK_BOT_TOKEN` | string | Required if PM | — | Slack bot OAuth token (`xoxb-…`). Required when `PM_AGENT_ENABLED=true` |
| `SLACK_SIGNING_SECRET` | string | Optional | — | Slack signing secret. Enables bidirectional Slack bot (slash commands, @mentions) |
| `SLACK_WEBHOOK_URL` | string | Optional | — | Incoming Webhook URL for pipeline notifications |
| `SLACK_ERROR_ALERTS` | boolean | Optional | `false` | Set `true` to forward error-level log events to Slack |
| `DISCORD_WEBHOOK_URL` | string | Optional | — | Discord Webhook URL for pipeline notifications |

---

## PM Agent

Set `PM_AGENT_ENABLED=true` to activate the autonomous backlog manager.

| Variable | Type | Mode | Default | Description |
|---|---|---|---|---|
| `PM_AGENT_ENABLED` | boolean | Optional | `false` | Enable the PM Agent |
| `PM_AGENT_CRON_INTERVAL_MS` | integer | Optional | `1800000` | Tick interval in milliseconds (default 30 min) |
| `PM_AGENT_MAX_IN_FLIGHT` | integer | Optional | `3` | Maximum issues being processed simultaneously |
| `PM_AGENT_DAILY_TOKEN_BUDGET` | integer | Required if PM | — | Daily token budget limit across all PM Agent activity |
| `PM_AGENT_SLACK_CHANNEL_ID` | string | Required if PM | — | Slack channel ID for PM Agent digests and approval requests |
| `PM_AGENT_TEAM_IDS` | string (csv) | Required if PM | — | Comma-separated Linear team IDs the PM Agent manages |
| `PM_AGENT_REQUIRE_PIPELINE_LABEL_FOR_PROMOTE` | boolean | Optional | `false` | Only promote Backlog issues that have a pipeline label (BEC-150) |
| `PM_AGENT_MAX_CONSECUTIVE_FAILURES` | integer | Optional | `3` | Circuit-breaker threshold: skip issues with this many consecutive failures. `0` disables |
| `PM_AGENT_PAUSED` | boolean | Optional | `false` | Set `true` to pause promote/start-todo/recover-stuck without stopping the container |
| `PM_AGENT_AGENT_BRANCH_TTL_DAYS` | integer | Optional | `7` | Days before merged/stale `agent/*` branches are deleted |
| `PM_AGENT_STUCK_RUN_AGE_MIN` | integer | Optional | `60` | Minutes before a running pipeline run is considered stuck and recovered |

---

## Release Manager

Requires `GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY_PATH` and a Pro license (`release-manager` feature).

| Variable | Type | Mode | Default | Description |
|---|---|---|---|---|
| `RELEASE_MANAGER_ENABLED` | boolean | Optional | `false` | Enable the Release Manager |
| `RELEASE_MANAGER_SCHEDULE` | string | Optional | `*/30 * * * *` | Cron schedule for release evaluation |
| `RELEASE_MANAGER_VERSION_BUMP` | string | Optional | `patch` | Version bump type: `patch`, `minor`, or `major` |
| `RELEASE_MANAGER_SLACK_CHANNEL` | string | Optional | — | Slack channel ID for release notifications |
| `RELEASE_MANAGER_BRANCH` | string | Optional | `main` | Branch to create releases from |
| `RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE` | integer | Optional | — | Trigger a release after this many PRs merged since last release |
| `RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS` | integer | Optional | — | Trigger a release after this many hours since the last release |
| `RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES` | integer | Optional | — | Trigger a release after CI has been green for this many minutes |
| `RELEASE_MANAGER_TRIGGER_REQUIRE_SLACK_APPROVAL` | boolean | Optional | `false` | Require Slack approval before creating a release |
| `RELEASE_MANAGER_TRIGGER_QA_WORKFLOW` | string | Optional | — | GitHub Actions workflow name to run as QA gate before release |
| `RELEASE_MANAGER_TRIGGER_QA_LINEAR_TEAM_ID` | string | Required if QA | — | Linear team ID for filing QA gap issues. Required when `RELEASE_MANAGER_TRIGGER_QA_WORKFLOW` is set |
| `RELEASE_MANAGER_TRIGGER_QA_TIMEOUT_MINUTES` | integer | Optional | — | Minutes to wait for the QA workflow before timing out |

---

## SSO (Enterprise — `sso` feature)

See `deploy/SSO_SETUP.md` for full setup instructions.

| Variable | Type | Mode | Default | Description |
|---|---|---|---|---|
| `URATEAM_SSO_ENABLED` | boolean | Optional | `false` | Enable WorkOS SSO for the dashboard |
| `URATEAM_WORKOS_API_KEY` | string | Required if SSO | — | WorkOS API key |
| `URATEAM_WORKOS_CLIENT_ID` | string | Required if SSO | — | WorkOS OAuth Client ID |
| `URATEAM_WORKOS_REDIRECT_URI` | string | Required if SSO | — | OAuth callback URI (e.g. `https://dash.example.com/auth/callback`) |
| `URATEAM_SSO_STATE_SECRET` | string | Required if SSO | — | HMAC secret for OAuth state parameter (32+ random bytes) |
| `URATEAM_SSO_ALLOWED_DOMAIN` | string | Optional | — | Restrict login to this email domain (e.g. `acme.com`) |
| `URATEAM_SSO_SESSION_HOURS` | integer | Optional | `24` | Session cookie lifetime in hours |
| `URATEAM_SSO_COOKIE_NAME` | string | Optional | `urateam_session` | Name of the session cookie |
| `URATEAM_SSO_COOKIE_SECURE` | boolean | Optional | `true` | Set `false` only for HTTP-only dev/test deployments |

---

## Review Models (OpenRouter fanout — BEC-134)

Enables parallel review by multiple models via OpenRouter.

| Variable | Type | Mode | Default | Description |
|---|---|---|---|---|
| `REVIEW_MODELS` | string (csv) | Optional | — | Comma-separated OpenRouter model IDs to use for deep review fanout |
| `OPENROUTER_BASE_URL` | string | Optional | OpenRouter default | OpenRouter API base URL override |
| `REVIEW_MODELS_MAX_OUTPUT_TOKENS` | integer | Optional | — | Per-model output token cap |
| `REVIEW_MODELS_TIMEOUT_MS` | integer | Optional | — | Per-model request timeout in milliseconds |
| `REVIEW_MODELS_MAX_INPUT_TOKENS` | integer | Optional | — | Per-model input token cap |
| `REVIEW_MODELS_MIN_OUTPUT_RATIO` | float | Optional | `0.05` | Minimum output/input token ratio before a model is flagged as low-yield |
| `REVIEW_MODELS_HEALTH_LOOKBACK_HOURS` | integer | Optional | `168` | Lookback window (hours) for model health scoring |
| `REVIEW_MODELS_MIN_RUNS` | integer | Optional | `5` | Minimum runs before a model is included in health evaluation |

---

## Pipeline Overrides

| Variable | Type | Mode | Default | Description |
|---|---|---|---|---|
| `URATEAM_DEEP_REVIEW_PASSES` | integer | Optional | — | Override `deepReviewPasses` on every pipeline with a `review` stage. `0` disables |
| `URATEAM_AUTO_MERGE` | boolean | Optional | — | Override `autoMerge` on every pipeline. `true` or `false`; unset = per-pipeline default |

---

## RBAC / Admin (Enterprise — `rbac` feature)

| Variable | Type | Mode | Default | Description |
|---|---|---|---|---|
| `URATEAM_ADMIN_EMAILS` | string (csv) | Optional | — | Comma-separated email addresses that are automatically granted the `admin` role on first login |

---

## Related Documentation

- `deploy/CLAUDE_AUTH.md` — Claude authentication options (`ANTHROPIC_API_KEY` vs `CLAUDE_CODE_OAUTH_TOKEN`)
- `deploy/SSO_SETUP.md` — WorkOS SSO configuration walkthrough
- `deploy/RBAC_SETUP.md` — Role-based access control setup
- `deploy/GH_LINEAR_SYNC_SETUP.md` — GitHub Issues → Linear sync

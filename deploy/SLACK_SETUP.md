# Slack Setup for urateam

Two distinct Slack integrations, each with a different setup path.

## 1. Pipeline notifications (free)

Posts pipeline events (start, stage complete, PR ready, failures, daily token rollup) to a channel.

**Setup (~3 min):**

1. Create an app at <https://api.slack.com/apps> → "Create New App" → "From scratch" → name it `urateam-notifications` → pick your workspace.
2. **Incoming Webhooks** → toggle **On** → **Add New Webhook to Workspace** → pick the channel → copy the URL (`https://hooks.slack.com/services/T.../B.../...`).
3. Add to `.env`:
   ```bash
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
   ```
4. Restart the agent.

Source: `packages/core/src/notifier/slack.ts`.

## 2. PM Agent + Slack interface (Pro: `slack-interface` license)

Two-way integration: `/pm` slash commands, `@urateam` mentions, automated digests, and **approval-via-reaction** for deprioritize / cancel requests.

### Required Bot Token Scopes

Go to **OAuth & Permissions** → **Bot Token Scopes** and add all of the following:

| Scope | Purpose |
|---|---|
| `chat:write` | Post messages to the PM channel |
| `reactions:read` | **Required** — read approval reactions on deprioritize/cancel requests. Without this scope, operator reactions are silently ignored and approvals expire after 48h. |
| `commands` | Handle the `/pm` slash command |
| `app_mentions:read` | Listen for `@urateam` mentions |
| `channels:history` | Receive `message.channels` events (natural-language messages in the PM channel) |

> **Note on `reactions:read`:** The PM Agent polls this scope every tick to check whether an operator has reacted ✅ or ❌ to a deprioritize/cancel approval request. If the scope is absent, `reactions.get` returns `missing_scope` and every approval silently times out. The daemon logs an `error`-level message at startup if this scope is missing — check your logs for:
> ```
> "Slack bot token is missing the reactions:read scope — approval-via-reaction will not work."
> ```

### Setup (~10 min)

1. **Create a separate Slack app** — don't reuse the notification webhook app.
   <https://api.slack.com/apps> → "Create New App" → name `urateam-pm` → your workspace.

2. **OAuth & Permissions** → add all Bot Token Scopes from the table above.

3. **Event Subscriptions** → toggle **Enable**.
   - Request URL: `https://<your-domain>/slack/events`
   - Bot events: `message.channels`, `app_mention`, `reaction_added`

4. **Slash Commands** → "Create New Command":
   - Command: `/pm`
   - Request URL: `https://<your-domain>/slack/commands`
   - Short description: `urateam project manager`

5. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-…`).

6. **Basic Information** → copy the **Signing Secret**.

7. **Invite the bot** to a dedicated PM channel (e.g. `#urateam-pm`). Copy the channel ID (right-click → View channel details → bottom of panel — looks like `C0123456789`).

8. **Add to `.env`**:
   ```bash
   PM_AGENT_ENABLED=true
   PM_AGENT_TEAM_IDS=<your-linear-team-uuid>
   PM_AGENT_SLACK_CHANNEL_ID=C0123456789
   PM_AGENT_DAILY_TOKEN_BUDGET=5000000
   PM_AGENT_MAX_IN_FLIGHT=3
   PM_AGENT_CRON_INTERVAL_MS=1800000   # 30 min
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_SIGNING_SECRET=<from Basic Information>
   ```

9. **Restart the agent.** Expect in logs:
   - `pm-agent: scheduler started, tick interval 1800000ms`
   - `slack-interface: routes mounted at /slack/commands + /slack/events`

10. **Sanity-check** — in the PM channel, type `/pm status`. Bot replies with current in-flight runs + budget usage.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Startup log: `missing the reactions:read scope` | Bot token lacks `reactions:read` | Add `reactions:read` in OAuth & Permissions and reinstall the app to the workspace |
| Approval reactions ignored / always expire | `reactions:read` missing (see above) | Same fix |
| `/pm status` returns "dispatch failed" | Signing-secret mismatch | Recheck `SLACK_SIGNING_SECRET` against the Basic Information page |
| Events never arrive | URL changed (ngrok rotates on restart) | Update Event Subscriptions URL in the Slack app |
| `feature 'approval-workflows' not licensed` | License doesn't include the feature | Re-issue license with `--features pro,slack-interface,approval-workflows,…` |
| `pm-agent: paused — skipping tick` | `/pm pause` was run | Run `/pm resume` |

### Tuning

- **`PM_AGENT_CRON_INTERVAL_MS`** — 30 min default. Production: 5–10 min for snappier triage.
- **`PM_AGENT_DAILY_TOKEN_BUDGET`** — start at 1–2M for the first day, raise once you've seen triage behavior.
- **`PM_AGENT_MAX_IN_FLIGHT`** — 3 is conservative; raise to 5–10 for many small issues.

### Source files

- PM scheduler + scope probe: `packages/core/src/pm/scheduler.ts`, `packages/core/src/pm/slack.ts`
- Slack interface (slash commands + events): `packages/core/src/pm/slack-interface.ts`
- Full narrative setup: `docs/slack-setup.md`

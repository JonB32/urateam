# Slack setup for urateam

Two distinct Slack integrations, with different setup paths and licensing requirements.

## 1. Pipeline notifications (free, no Pro license needed)

Posts pipeline events (start, stage complete, PR ready, failures, daily token rollup) to a Slack channel.

**Setup (~3 min):**

1. Create an app at <https://api.slack.com/apps> → "Create New App" → "From scratch" → name it `urateam-notifications` → pick your workspace.
2. In the app sidebar: **Incoming Webhooks** → toggle **On** → click **Add New Webhook to Workspace** → pick the channel → copy the URL (`https://hooks.slack.com/services/T.../B.../...`).
3. Add to `.urateam/.env`:
   ```bash
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
   ```
4. Restart the agent.

That's it. Pipeline events post to that channel. Source: `packages/core/src/notifier/slack.ts`.

## 2. PM Agent + Slack interface (Pro feature: `slack-interface`)

Two-way Slack integration:

- `/pm` slash commands (`status`, `prioritize`, `assign`, `create`, `pause`, `resume`)
- Natural-language messages in the PM channel (AI-interpreted)
- Automated digests + approval requests posted by the PM agent every cron tick (default 30 min)

**Prereqs:**

- Pro license with the `slack-interface` feature in its decoded `features` list (run `npx create-urateam@latest`'s License decode step or read your license JWT manually)
- A **public HTTPS URL** for Slack to call (Slack only supports HTTPS for slash commands and Events API). For local dev, use ngrok. For production, you already have this from the Caddy auto-HTTPS in the deploy template.

**Setup (~10 min):**

1. **Create a separate Slack app** (don't reuse the notification webhook one — this needs more permissions).
   <https://api.slack.com/apps> → "Create New App" → name `urateam-pm` → your workspace.

2. **OAuth & Permissions** → Bot Token Scopes → add:
   - `chat:write` — post messages to the PM channel
   - `reactions:read` — read approval reactions on PM messages
   - `commands` — handle the `/pm` slash command
   - `app_mentions:read` — listen for `@urateam` mentions
   - `channels:history` — required to receive `message.channels` events (the
     bot reads natural-language messages in the PM channel)

3. **Event Subscriptions** → toggle **Enable**.
   - Request URL: `https://<your-domain>/slack/events`
   - Subscribe to bot events: `message.channels`, `app_mention`, `reaction_added`

4. **Slash Commands** → "Create New Command":
   - Command: `/pm`
   - Request URL: `https://<your-domain>/slack/commands`
   - Short description: "urateam project manager"

5. **Install to Workspace** → click the install button → copy the **Bot User OAuth Token** (`xoxb-…`).

6. **Basic Information** → copy the **Signing Secret**.

7. **Invite the bot to a dedicated PM channel** (e.g. `#urateam-pm`). Copy the channel ID — right-click channel → View channel details → bottom of the panel — looks like `C0123456789`.

8. **Add to `.urateam/.env`** (or run `npx create-urateam@latest` again and answer "yes" to the PM setup prompt):
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

9. **Restart the agent.** You should see in logs:
   - `pm-agent: scheduler started, tick interval 1800000ms`
   - `slack-interface: routes mounted at /slack/commands + /slack/events`
   - License log line: `tier: pro, features: [..., slack-interface, ...]`

10. **Sanity-check** — in the PM channel, type `/pm status`. Bot replies with current in-flight runs + budget usage.

## Common gotchas

| Symptom | Cause |
|---|---|
| `/pm status` returns "dispatch failed" | Signing-secret mismatch — recheck `SLACK_SIGNING_SECRET` against the Basic Information page |
| Events never arrive | URL changed (ngrok rotates on every restart) — update Slack app's Event Subscriptions URL |
| `pm-agent: feature 'approval-workflows' not licensed` | License doesn't include the feature — re-issue with `--features pro,slack-interface,approval-workflows,…` |
| `pm-agent: paused — skipping tick` | Someone ran `/pm pause` — run `/pm resume` |
| `Linear team ID wrong` | `PM_AGENT_TEAM_IDS` is the Linear UUID, not the team key. Get from Linear → Settings → Teams → click team → URL UUID |

## Tuning

- **`PM_AGENT_CRON_INTERVAL_MS`** — 30 min default is fine for testing. Production probably 5–10 min for snappier triage.
- **`PM_AGENT_DAILY_TOKEN_BUDGET`** — start tight (1–2M) for the first day, raise once you've seen how aggressive the triage is.
- **`PM_AGENT_MAX_IN_FLIGHT`** — 3 is conservative. Raise to 5–10 if you have many small issues and your Anthropic quota allows.

## Source files (if you want to read the code)

- Pipeline notifier: `packages/core/src/notifier/slack.ts`
- PM scheduler: `packages/core/src/pm/scheduler.ts`
- Slack interface (slash commands + events): `packages/core/src/pm/slack-interface.ts`
- PM config types: `packages/core/src/pm/types.ts`
- License gate for `slack-interface`: `packages/core/src/license.ts`

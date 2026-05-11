# deploy/

This directory contains deployment artifacts for urateam.

## Files

| File | Purpose |
|---|---|
| `CLAUDE_AUTH.md` | **Start here** — Claude authentication guide (three supported paths) |
| `GH_LINEAR_SYNC_SETUP.md` | GitHub → Linear bidirectional sync setup |
| `RBAC_SETUP.md` | Role-based access control (Enterprise feature 4.4) |
| `SSO_SETUP.md` | Single sign-on via WorkOS (Enterprise feature 4.1) |

---

## Quick-start: recommended deploy (subscription users)

**Step 1 — Generate a long-lived OAuth token**

Run this **once** on any machine with the Claude Code CLI installed:

```bash
claude setup-token
```

Copy the resulting `sk-ant-oat-...` token.

**Step 2 — Add to your deploy env**

```env
# .env (or .env.dogfood / docker compose env_file)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-...
```

**Step 3 — Deploy without a `~/.config/claude/` volume mount**

The token is long-lived. You do **not** need to:
- Mount `~/.config/claude/` as a Docker volume
- Run `claude login` interactively
- Plan for weekly re-auth

```yaml
# docker-compose.yml — CLAUDE_CODE_OAUTH_TOKEN replaces the volume mount
services:
  urateam:
    env_file: .env   # contains CLAUDE_CODE_OAUTH_TOKEN
    # volumes:
    #   - ~/.config/claude:/home/urateam/.config/claude:ro  # NOT NEEDED
```

**Step 4 — Verify**

Start the stack and move a Linear issue to "Todo" with a pipeline label. A successful pipeline run (visible in the dashboard's Runs view) confirms auth is working.

---

## Alternative: ANTHROPIC_API_KEY (pay-per-token)

If you bill through an Anthropic API account instead of a subscription:

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Get a key at https://console.anthropic.com/. Also long-lived, no expiry.

---

## Legacy: mounted `claude login` session

Only for local development. See `CLAUDE_AUTH.md` for details and the risks
(expires weekly, requires manual re-auth).

---

## AuthMonitor (defence-in-depth)

For operators still on the mounted-session path, the PM Agent runs an
`AuthMonitor` check every **6 hours**:

- When `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is set → no-op.
- Otherwise → runs `claude auth status`. On failure:
  - Logs a `claude.auth_expired` audit event (visible in the dashboard's
    Audit log when the `audit-log` Enterprise feature is licensed).
  - Sends a Slack alert to `PM_AGENT_SLACK_CHANNEL_ID` when `SLACK_ERROR_ALERTS=true`.

The audit event type is `claude.auth_expired`.

---

## Environment variables

| Variable | Auth path | Notes |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token | **Primary recommendation** for subscription users. Generate with `claude setup-token`. Long-lived, no weekly expiry. |
| `ANTHROPIC_API_KEY` | API key | Recommended for API-account users. Long-lived, pay-per-token. |
| *(neither)* | Mounted session | Legacy / local dev. Requires `claude login` + `~/.config/claude/` volume. Expires ~weekly. |

Precedence: `CLAUDE_CODE_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` → mounted session.

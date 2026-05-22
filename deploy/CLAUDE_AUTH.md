# Claude Authentication

urateam supports three Claude authentication paths. **Choose one based on how you bill Claude and how you deploy.**

## Recommendation matrix

| Your situation | Use this | Why |
|---|---|---|
| Anthropic API account (pay-per-token) | `ANTHROPIC_API_KEY` | Long-lived, no expiry, deploys cleanly to any container |
| Claude Pro / Max subscription, headless deploy | `CLAUDE_CODE_OAUTH_TOKEN` | Subscription billing, long-lived, no weekly re-auth |
| Local dev only, interactive | local `claude login` session | Convenient but **expires weekly** — not for production |

---

## Option 1 — `ANTHROPIC_API_KEY` (recommended for production)

```bash
# In your .env or compose env_file:
ANTHROPIC_API_KEY=sk-ant-api03-...
```

- Get a key at https://console.anthropic.com/
- Bills to your Anthropic API account (pay-per-token)
- No expiry. Survives container restarts. Recommended default for any long-running deploy.

---

## Option 2 — `CLAUDE_CODE_OAUTH_TOKEN` (recommended for subscription users)

Use this if you want urateam to bill against an existing Claude Pro or Max subscription instead of an API account.

```bash
# 1. On any machine with the Claude Code CLI installed:
claude setup-token

# 2. Copy the resulting token (starts with sk-ant-oat-...) into your deploy env:
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-...
```

- `claude setup-token` produces a **long-lived programmatic OAuth token** designed for CI / automation / containers
- Bills to the Pro/Max subscription on the Claude.ai account you authenticated with
- No expiry, no refresh cycle, no volume mounts needed
- This is different from `claude login` — that creates an interactive session credential that expires weekly

> **Why not just mount `~/.config/claude/` like before?**
> That directory holds the interactive-session credential from `claude login`. It silently expires every ~7 days. Your next webhook hits a 401, the pipeline fails, the Linear ticket gets marked failed, and you have to manually re-auth. The `setup-token` flow exists specifically to avoid this for headless deployments.

### Monitoring — expiry detection (BEC-237)

Unlike `ANTHROPIC_API_KEY` (a static key that never expires on its own), OAuth tokens **can be revoked or expire**. The AuthMonitor probes `CLAUDE_CODE_OAUTH_TOKEN` validity every 6 hours via `claude auth status`:

- **On expiry/revocation**: a `claude.auth_expired` audit event fires with `authMethod: "oauth-token"` in the payload, and a Slack alert posts to your error channel (if configured).
- The alert instructs the operator to run `claude setup-token` and restart the container — since the token lives in an env var, a new value requires a container restart.
- To fix: regenerate with `claude setup-token`, update `CLAUDE_CODE_OAUTH_TOKEN` in your `.env`, and restart the container.

---

## Option 3 — Local `claude login` session (dev only)

Only recommended for local development. Run `claude login` in the same shell or container where `ura dev` runs. The credentials are stored in `~/.config/claude/`.

This path is gated by `preflightClaudeAuth` (`packages/cli/src/lib/preflight-claude-auth.ts`), which checks `claude auth status` at startup and refuses to boot if expired. It does **not** monitor mid-run expiry — if the session expires while a pipeline is running, that run will fail.

If you must use this path in production (e.g., legacy deployment), mount the credentials directory as a Docker volume:

```yaml
volumes:
  - ~/.config/claude:/home/urateam/.config/claude:ro
```

…and plan to re-auth weekly via `docker compose exec <container> claude login`.

---

## Precedence

If multiple env vars are set, urateam uses them in this order:

1. `CLAUDE_CODE_OAUTH_TOKEN` (if present)
2. `ANTHROPIC_API_KEY` (if present)
3. Local `claude` CLI session (mounted credentials)

The first one found wins. Mixing is fine for migration scenarios.

---

## Verifying

After deploy, check the runner logs for a successful Claude call (any pipeline run logs `model_id` + `input_tokens` per stage). Or use the dashboard's Runs view — a successful run end-to-end confirms the auth works.

If something's wrong:
- API key invalid → `401 Unauthorized` errors with the key visible (redacted) in logs
- OAuth token invalid → same `401` shape; regenerate with `claude setup-token`
- Session expired → `preflightClaudeAuth` should have caught this at boot; if it didn't, file an issue

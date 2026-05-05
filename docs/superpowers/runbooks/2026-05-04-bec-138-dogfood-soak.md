# BEC-138 Dogfood Soak — Operations Runbook

**Spec:** `docs/superpowers/specs/2026-05-04-bec-138-self-dogfood-1-0-cut-design.md`
**Plan:** `docs/superpowers/plans/2026-05-04-bec-138-self-dogfood-1-0-cut.md`

## Pre-flight (do before starting the container)

Captures + values needed in `.env.dogfood`:

- [ ] Slack channel `#urateam-dogfood` exists; Slack app installed; **bot token** AND **channel ID** captured (channel ID is `C…`, found in Slack channel "About" panel — NOT the same as the channel name)
- [ ] Enterprise license JWT for `dogfood@urateams.com` minted via `worker/scripts/issue-license.ts` in the urateam-licensing repo; valid ≥1 year; pasted into `URATEAM_LICENSE_KEY` (note: the var is `_KEY`, not `_JWT`)
- [ ] Fine-grained GitHub PAT scoped to `JonB32/urateam` (Contents r/w, Pull requests r/w, Workflows r/w, Issues r/w) — used for `gh auth login --with-token` after boot
- [ ] Linear API key under dogfood-bot account; pasted into `LINEAR_API_KEY`
- [ ] Linear webhook secret (any random string for dogfood; production would set up a real webhook): `LINEAR_WEBHOOK_SECRET` — generate with `openssl rand -base64 32`
- [ ] Dashboard password: `DASHBOARD_PASSWORD` — generate with `openssl rand -base64 32`
- [ ] `OPENROUTER_API_KEY` present in `.env.dogfood`. `ANTHROPIC_API_KEY` is optional (see "One-time: authenticate Claude Code OAuth" below — default is OAuth via the bundled `claude` CLI)
- [ ] PR with Dockerfile + compose + env example + soak runbook is merged to `main`

Pre-filled in `.env.dogfood.example` (no action needed unless you want to override):

- `LINEAR_TEAM_ID`, `REPO_TEAM_ID` = `3a6010b3-7a06-4c35-921c-d39080c1629d` (Beckerspace)
- `REPO_URL` = `https://github.com/JonB32/urateam`
- `PM_AGENT_ENABLED=true`, `PM_AGENT_TEAM_IDS` = same team UUID
- `RELEASE_MANAGER_ENABLED=true` + conservative trigger config + QA gate against `.github/workflows/ci.yml`
- `AGENT_BYPASS_PERMISSIONS=true` (required for non-root container)
- `REVIEW_MODELS` pre-set to claude-3.5-sonnet + gpt-4o + gemini-2.5-pro for OpenRouter fanout

## Deploy

SSH to the urateams.com Docker host. From the urateam repo checkout (host-side):

```bash
git pull
docker compose -f docker-compose.dogfood.yml up -d --build
docker logs -f urateam-dogfood       # tail to verify boot
```

Boot success indicators in the log:
- `License loaded: tier=enterprise expires=…`
- `Quality Observer enabled (env flag)`
- `Watching Linear project 4c638018-… every Ns`
- Dashboard listening on `:3001`

If any are missing, fix the env file, then `docker compose -f docker-compose.dogfood.yml up -d --force-recreate`.

## One-time: authenticate Claude Code OAuth

Required when `ANTHROPIC_API_KEY` is unset (the default). The dogfood image installs `@anthropic-ai/claude-code`; OAuth tokens persist in the `urateam-dogfood-claude` named volume across restarts.

```bash
docker compose -f docker-compose.dogfood.yml exec -it urateam-dogfood claude login
```

Follow the OAuth flow (URL → browser → paste returned token). After login, verify:

```bash
docker compose -f docker-compose.dogfood.yml exec urateam-dogfood claude auth status
```
Expected: `Authenticated as <your account>`. If this fails, the executor's `auth-check` will reject runs with `"Claude auth credentials are invalid or expired"` and no agent work will happen.

**Subscription quota note:** every dogfood agent run (PM, review, RM, QA) counts against your Claude Max/Team quota. If quota saturates mid-soak, set `ANTHROPIC_API_KEY` in `.env.dogfood`, recreate the container, and the SDK will switch to billed API.

**Volume preservation warning:** `docker compose down` preserves the named volume `urateam-dogfood-claude` (intentional — keeps OAuth credentials across restarts). `docker compose down --volumes` (or `-v`) deletes it, which silently wipes the OAuth tokens. If auth suddenly breaks after a teardown, re-run `claude login`. The same applies to `urateam-dogfood-config` (gh CLI auth).

## One-time: authenticate gh CLI

Required because the env example uses the `gh auth login --with-token` path rather than GitHub App credentials. The Dockerfile installs `github-cli`; gh's auth persists in `/home/ura/.config` (the `urateam-dogfood-config` named volume) across restarts.

On the host, with the captured fine-grained PAT in your shell as `$GH_PAT`:

```bash
echo "$GH_PAT" | docker compose -f docker-compose.dogfood.yml exec -T urateam-dogfood gh auth login --with-token
docker compose -f docker-compose.dogfood.yml exec urateam-dogfood gh auth status
```
Expected: `Logged in to github.com as <you> (oauth_token)` — confirms gh can authenticate.

## Verify boot (run these from your laptop after deploy)

```bash
# SSH tunnel to dashboard
ssh -L 3001:127.0.0.1:3001 user@urateams.com -N &
open http://localhost:3001                                  # dashboard reachable
open http://localhost:3001/admin/audit                      # Enterprise audit log page renders
open http://localhost:3001/admin/cost-roi                   # Enterprise cost & ROI page renders
```

## Seed the first ticket

In Linear, move **BEC-147** (CHANGELOG GH-releases migration) from `Backlog` → `Todo`. Within ~5 min, expect:
- audit row `pm.ticket_picked` for BEC-147
- A new branch on `JonB32/urateam` from the dogfood-bot account
- A PR opened with the implementation

If this doesn't happen within 15 min, check `docker logs urateam-dogfood --tail 200` for errors.

## Soak observation cadence

### Daily

```bash
ssh user@urateams.com 'docker exec urateam-dogfood sqlite3 /home/ura/data/dogfood.db \
  "SELECT event_type, COUNT(*) FROM audit_events WHERE created_at >= datetime(\"now\",\"-1 day\") GROUP BY event_type;"'
```

Post the output to `#urateam-dogfood` (manual or cron-driven).

Check the bot's PR list:

```bash
gh pr list --repo JonB32/urateam --author urateam-dogfood-bot --state all --limit 10
```

### Triage rubric

File every dogfood-found issue as a Linear ticket under "Ateam Monetization", label `dogfood-found`, severity in title prefix.

| Severity | Definition | Action |
|---|---|---|
| sev-1 | Broken/unsafe — license rejected, container crashes, agent corrupts repo, security issue | Halt soak; fix; restart from boot-verify |
| sev-2 | Degrades autonomy — agent loops, RM never fires, QA never reaches green, dashboard broken | Fix-and-merge before 1.0.0 cut |
| sev-3 | Cosmetic, observability gap, performance, ergonomics | Label `defer-to-1.0.x`; ship in patch line |

### Backlog escalation

Once BEC-147/148/149 (tech debt) have at least one full Linear → PR → merge → release loop, move v2 follow-ups (BEC-139..146) one at a time, smallest first.

### Calendar checkpoints

- 2026-05-11 — soak day 7. Pre-cut checklist evaluation.
- 2026-05-18 — scheduled soak-checks fire (RM `trig_01QosUVARKKPSRcU3KA8GYcK`, QA `trig_01KUvT4hb6j4w1yKzkyPkACd`). Read both reports; classify findings into severity buckets.

## Pre-cut checklist (gates the cut)

- [ ] Sidecar has run continuously ≥7 calendar days
- [ ] ≥1 PR went through full autonomous loop (Linear → bot-PR → Sonnet review → human merge → bot release)
- [ ] All `[sev-1]` and `[sev-2]` dogfood-found Linear tickets are closed
- [ ] 2026-05-18 scheduled soak-checks reported (or findings classified sev-3 / fixed)
- [ ] CI green on `main`
- [ ] CHANGELOG `[Unreleased]` drafted with everything since v0.1.32

## Cut sequence

See plan tasks 18–22.

## Post-cut

Rebuild dogfood image with `--build-arg URATEAM_*_VERSION=1.0.0` and `docker compose -f docker-compose.dogfood.yml up -d --build`. Container now runs the released artifact.

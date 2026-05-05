# BEC-138 Self-Dogfood + 1.0.0 Cut — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the urateam sidecar inside a Docker container on the existing urateams.com Docker host (sibling to the existing urateam container), let it self-process the urateam product backlog under an Enterprise license for ≥7 days, then cut all four packages to 1.0.0.

**Architecture:** Single sibling Docker container running `ura dev` against `JonB32/urateam` itself. Build artifacts (Dockerfile, compose entry, env-var contract, ci.yml `workflow_dispatch:` trigger, soak runbook) ship via one PR. External provisioning (Slack, Linear key, GitHub bot, Enterprise JWT) happens out-of-band. Deployment is `docker compose up`. Soak is calendar-bound observation. Cut follows the standard bump-PR → tag → OIDC publish → `gh release create` workflow.

**Tech Stack:** Docker (multistage Alpine + Node 22), docker-compose, GitHub Actions (OIDC trusted publish), npm OIDC provenance, SQLite, Slack, Linear, GitHub PATs.

**Spec:** `docs/superpowers/specs/2026-05-04-bec-138-self-dogfood-1-0-cut-design.md`

---

## File Structure

| Path | Type | Purpose |
|---|---|---|
| `Dockerfile` | Create | Sidecar runtime image; npm-installs pinned `@urateam/{cli,core,dashboard}`; non-root; entrypoint `tini -- ura dev` |
| `docker-compose.dogfood.yml` | Create | Sibling-to-existing compose entry; volumes, env_file, port mapping |
| `.env.dogfood.example` | Create | Fully-commented env-var contract (no real secrets) |
| `.github/workflows/ci.yml` | Modify | Add `workflow_dispatch:` trigger so QA agent can fire it |
| `docs/superpowers/runbooks/2026-05-04-bec-138-dogfood-soak.md` | Create | Operations runbook: deploy, observe, triage, cut |
| `CHANGELOG.md` | Modify (cut phase) | Add `## [1.0.0]` section above `[Unreleased]` |
| `packages/{core,cli,dashboard,create-urateam}/package.json` | Modify (cut phase) | Bump version → `1.0.0` |

External resources provisioned (not in repo): `#urateam-dogfood` Slack channel + bot app, `urateam-dogfood-bot` GitHub account + PAT (or fine-grained PAT under your account), Linear API key, Enterprise license JWT, host-side `/opt/urateam/.env.dogfood` real-secret file.

---

## Phase 1 — Build the artifact (in this branch, ship via PR)

### Task 1: Add `workflow_dispatch:` trigger to `ci.yml`

**Files:**
- Modify: `.github/workflows/ci.yml:3-7`

- [ ] **Step 1: Edit the trigger block**

Replace:
```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

with:
```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:
```

- [ ] **Step 2: Validate the YAML parses**

Run:
```bash
cd /tmp/urateam-fresh/.worktrees/bec-138
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ok')"
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add workflow_dispatch trigger so QA agent can fire CI

BEC-138 dogfood sidecar's QA agent (per BEC-136) requires
workflow_dispatch to fire release-readiness checks. Adding the
trigger to existing ci.yml keeps the gate identical to PR CI for
v1.0; a dedicated qa-check.yml is filed as a v2 follow-up."
```

### Task 2: Write the `Dockerfile`

**Files:**
- Create: `Dockerfile` (root)

- [ ] **Step 1: Write the file**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS runtime
WORKDIR /app

# Runtime deps:
# - git: PM agent clones target repo
# - openssh-client: SSH-based git operations + remote tunnels
# - tini: PID 1 signal handling for clean shutdown
# - python3, make, g++: better-sqlite3 native build fallback if no prebuild matches alpine-musl
RUN apk add --no-cache git openssh-client tini python3 make g++

# Pinned versions — image is reproducible per build.
ARG URATEAM_CORE_VERSION=0.1.18
ARG URATEAM_CLI_VERSION=0.1.20
ARG URATEAM_DASHBOARD_VERSION=0.1.18
RUN npm install -g \
      @urateam/cli@${URATEAM_CLI_VERSION} \
      @urateam/core@${URATEAM_CORE_VERSION} \
      @urateam/dashboard@${URATEAM_DASHBOARD_VERSION}

# Non-root runtime user
RUN addgroup -S ura && adduser -S -G ura ura
USER ura
WORKDIR /home/ura

VOLUME ["/home/ura/data", "/home/ura/work"]
EXPOSE 3001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["ura", "dev"]
```

- [ ] **Step 2: Build locally to verify**

Run:
```bash
cd /tmp/urateam-fresh/.worktrees/bec-138
docker build -t urateam-dogfood:test . 2>&1 | tail -20
```
Expected: `Successfully tagged urateam-dogfood:test` (or equivalent buildkit success line). If `better-sqlite3` build fails on alpine-musl, the `python3 make g++` deps are why they're included.

- [ ] **Step 3: Smoke-test the entrypoint**

Run:
```bash
docker run --rm --entrypoint=ura urateam-dogfood:test --help | head -5
```
Expected: usage banner showing `ura dev`, `ura start`, `ura run`, `ura admin` subcommands. Confirms the npm-installed CLI is on PATH inside the image.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "feat(docker): Dockerfile for BEC-138 dogfood sidecar

Multistage alpine image; npm-installs pinned @urateam/{cli,core,dashboard}
at v0.1.32; runs as non-root ura user; tini PID 1 for clean shutdown.
Build args control version pinning so the image is reproducible per
build during the soak."
```

### Task 3: Write `docker-compose.dogfood.yml`

**Files:**
- Create: `docker-compose.dogfood.yml` (root)

- [ ] **Step 1: Write the file**

```yaml
services:
  urateam-dogfood:
    build:
      context: .
      args:
        URATEAM_CORE_VERSION: 0.1.18
        URATEAM_CLI_VERSION: 0.1.20
        URATEAM_DASHBOARD_VERSION: 0.1.18
    container_name: urateam-dogfood
    restart: unless-stopped
    env_file: .env.dogfood
    volumes:
      - urateam-dogfood-data:/home/ura/data
      - urateam-dogfood-work:/home/ura/work
    ports:
      # localhost-only — remote access via SSH tunnel during soak
      - "127.0.0.1:3001:3001"

volumes:
  urateam-dogfood-data:
  urateam-dogfood-work:
```

- [ ] **Step 2: Validate compose syntax**

Run:
```bash
docker compose -f docker-compose.dogfood.yml config --quiet && echo "ok"
```
Expected: `ok` (exits 0 silently if valid). May warn `WARN[0000] The "..." variable is not set` for env-file vars — acceptable, env-file is on host only.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.dogfood.yml
git commit -m "feat(docker): docker-compose.dogfood.yml for sibling deployment

Drop-in compose service for BEC-138 dogfood. Sibling to existing
urateam container on the urateams.com Docker host. SQLite + work-tree
volumes; localhost-only port binding; restart unless-stopped."
```

### Task 4: Write `.env.dogfood.example`

**Files:**
- Create: `.env.dogfood.example` (root)

- [ ] **Step 1: Write the file**

```bash
# BEC-138 dogfood sidecar — environment variables.
# Copy to .env.dogfood on the host and fill with real values.
# .env.dogfood MUST NOT be committed (already covered by .gitignore: *.env).

# === License (Enterprise tier per BEC-138 design Decision 1) ===
# Mint via the urateam-licensing service /admin/recover flow for dogfood@urateams.com.
# Valid 1 year — refresh before expiry.
URATEAM_LICENSE_JWT=

# === Internal flags ===
# Per BEC-137 Quality Observer design: env-flag, internal-only, never in .env.example.
URATEAM_QUALITY_OBSERVER_ENABLED=true

# === Linear ===
# Personal API key under the dogfood-bot Linear account (or your account if no bot).
LINEAR_API_KEY=
# "Ateam Monetization" project — where BEC-138/139..149 live.
LINEAR_PROJECT_ID=4c638018-bd58-4e4a-81ce-232832678c03

# === GitHub ===
# PAT for urateam-dogfood-bot GitHub account (or fine-grained PAT under your account).
# Scopes: repo, workflow.
GITHUB_TOKEN=
GITHUB_REPO=JonB32/urateam

# === Slack ===
# Bot token from #urateam-dogfood Slack app (single-channel scope).
SLACK_BOT_TOKEN=
SLACK_CHANNEL=#urateam-dogfood

# === Model providers ===
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=

# === Release Manager triggers ===
# Conservative: 3 merged PRs OR 72h since last release; CI green ≥30 min;
# Slack approval required; QA gate green. Tighten if dogfood loop is too slow.
RELEASE_MANAGER_TRIGGERS=mergedPRsSince=3,timeSinceLastHours=72,ciGreenForMinutes=30,requireSlackApproval=true,qaCheck=true

# === QA agent ===
# Per Decision 4: workflow_dispatch on existing ci.yml.
QA_CHECK_WORKFLOW=ci.yml

# === Dashboard ===
# 3001 to avoid collision with any existing urateam container on :3000.
DASHBOARD_PORT=3001

# === Database ===
DATABASE_URL=sqlite:///home/ura/data/dogfood.db
```

- [ ] **Step 2: Verify .gitignore covers .env.dogfood**

Run:
```bash
grep -E '^\*?\.env|^\.env' .gitignore || echo "MISSING — add .env entry"
```
Expected: a line that matches `.env*` patterns. If missing, add `.env*` to `.gitignore` in this same task.

- [ ] **Step 3: Commit**

```bash
git add .env.dogfood.example
git commit -m "feat(docker): .env.dogfood.example contract for BEC-138 sidecar

Fully-commented env-var contract. URATEAM_LICENSE_JWT (Enterprise),
URATEAM_QUALITY_OBSERVER_ENABLED (internal flag), Linear/GitHub/Slack/
model creds, RELEASE_MANAGER_TRIGGERS (conservative), QA_CHECK_WORKFLOW,
dashboard port and SQLite path."
```

### Task 5: Write the soak runbook

**Files:**
- Create: `docs/superpowers/runbooks/2026-05-04-bec-138-dogfood-soak.md`

- [ ] **Step 1: Create runbooks directory if missing**

Run:
```bash
mkdir -p docs/superpowers/runbooks
```

- [ ] **Step 2: Write the runbook**

```markdown
# BEC-138 Dogfood Soak — Operations Runbook

**Spec:** `docs/superpowers/specs/2026-05-04-bec-138-self-dogfood-1-0-cut-design.md`
**Plan:** `docs/superpowers/plans/2026-05-04-bec-138-self-dogfood-1-0-cut.md`

## Pre-flight (do before starting the container)

- [ ] Slack channel `#urateam-dogfood` exists; Slack app installed; bot token captured
- [ ] Enterprise JWT for `dogfood@urateams.com` minted; valid ≥1 year; copied to `.env.dogfood`
- [ ] GitHub `urateam-dogfood-bot` account (or fine-grained PAT) has `repo` + `workflow` on `JonB32/urateam`
- [ ] Linear API key under dogfood-bot account; copied to `.env.dogfood`
- [ ] OpenRouter + Anthropic keys present in `.env.dogfood`
- [ ] PR with Dockerfile + compose + ci.yml workflow_dispatch is merged to `main`

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
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/runbooks/2026-05-04-bec-138-dogfood-soak.md
git commit -m "docs(bec-138): soak runbook — deploy, observe, triage, cut

Operations runbook for the BEC-138 dogfood soak. Pre-flight checklist,
deploy command, boot indicators, daily observation cadence, severity
rubric, backlog escalation, calendar checkpoints, pre-cut checklist."
```

### Task 6: Open PR for Phase 1 build artifacts

**Files:** all of the above committed; opening the PR.

- [ ] **Step 1: Push the branch**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-138
git push -u origin jonb3232/bec-138-v10-66-self-dogfood-and-1-0-cut
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --title "feat(bec-138): dogfood sidecar Docker artifact + ci workflow_dispatch + soak runbook" --body "$(cat <<'EOF'
## Summary
- Dockerfile + docker-compose.dogfood.yml for the BEC-138 self-dogfood sidecar (sibling container on existing urateams.com Docker host)
- .env.dogfood.example contract (Enterprise tier; conservative RM triggers)
- ci.yml: \`workflow_dispatch:\` trigger added so QA agent can fire it
- Soak runbook for operations during the ≥7-day soak

## Spec
\`docs/superpowers/specs/2026-05-04-bec-138-self-dogfood-1-0-cut-design.md\`

## Test plan
- [ ] \`docker build -t urateam-dogfood:test .\` succeeds
- [ ] \`docker run --rm --entrypoint=ura urateam-dogfood:test --help\` shows CLI banner
- [ ] \`docker compose -f docker-compose.dogfood.yml config --quiet\` exits 0
- [ ] \`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"\` succeeds
- [ ] CI run on the PR passes (validates the workflow_dispatch addition didn't break anything)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Run Sonnet review on the PR**

Per the standard urateam workflow (memory: `feedback_release_workflow`), wait for or trigger Sonnet review. Address any findings as fix-up commits on this branch.

- [ ] **Step 4: User merges the PR**

(The user — not the agent — merges. This is the "manual final approval" gate per BEC-138 acceptance criteria.)

---

## Phase 2 — Provision external resources

These are out-of-band actions in external UIs (Slack, Linear, GitHub, urateam-licensing dashboard). Each task records the captured value into a local notes file (NOT committed) so the deploy step has them ready.

### Task 7: Create `#urateam-dogfood` Slack channel + bot app

- [ ] **Step 1: Create the channel**

In Slack workspace: create new private channel `#urateam-dogfood`. Add yourself as the only member for now.

- [ ] **Step 2: Create the Slack app**

Visit `https://api.slack.com/apps` → "Create New App" → "From scratch":
- Name: `urateam-dogfood`
- Workspace: your workspace

- [ ] **Step 3: Configure bot scopes**

In OAuth & Permissions: add scopes `chat:write`, `chat:write.public`, `commands` (for `/release approve|skip|status` slash commands), `channels:read`.

- [ ] **Step 4: Install to workspace + invite bot to channel**

Install the app to the workspace; copy the Bot User OAuth Token (starts `xoxb-…`). In Slack, run `/invite @urateam-dogfood` in `#urateam-dogfood`.

- [ ] **Step 5: Capture token**

Save the `xoxb-…` token to your local secrets store (not in git). You'll paste it into `.env.dogfood` on the host in Phase 3.

### Task 8: Mint Enterprise license JWT

- [ ] **Step 1: Use the licensing service**

The urateam-licensing repo (current cwd `/Users/jonb/projects/urateam-licensing`) has the recover flow. From a browser logged into the admin UI, mint a license for:
- Email: `dogfood@urateams.com`
- Tier: `enterprise`
- Validity: 1 year

OR run the licensing CLI directly (see `urateam-licensing/docs/OPERATIONS.md` for the exact command).

- [ ] **Step 2: Verify the JWT decodes**

Run (locally with the JWT):
```bash
echo "<JWT>" | cut -d. -f2 | base64 -d 2>/dev/null
```
Expected: JSON with `tier: "enterprise"`, `email: "dogfood@urateams.com"`, `exp` ~1 year out.

- [ ] **Step 3: Capture token**

Save the JWT to local secrets store; ready for `.env.dogfood`.

### Task 9: Create GitHub bot (or fine-grained PAT) for dogfood

**Choose ONE:**

#### Option A — Dedicated `urateam-dogfood-bot` GitHub account (cleaner, more setup)

- [ ] **Step A1**: Create new GitHub account `urateam-dogfood-bot` with a `+dogfood-bot` email alias
- [ ] **Step A2**: Add the bot as a collaborator on `JonB32/urateam` with `Write` permission
- [ ] **Step A3**: Sign in as the bot; create a classic PAT with scopes `repo`, `workflow`. Capture the token.

#### Option B — Fine-grained PAT under your account (faster, less defensible)

- [ ] **Step B1**: Visit `https://github.com/settings/personal-access-tokens/new`
- [ ] **Step B2**: Configure: repository access → only `JonB32/urateam`; permissions → Contents: read+write, Pull requests: read+write, Workflows: read+write, Issues: read+write, Metadata: read
- [ ] **Step B3**: Generate; capture the `github_pat_…` token.

(File a v2 follow-up in Linear: "BEC-138 follow-up: migrate dogfood from PAT to dedicated bot account" if you chose B.)

- [ ] **Step 4: Verify token**

Run:
```bash
GH_TOKEN=<token> gh repo view JonB32/urateam --json name,url
```
Expected: returns repo metadata, no auth error.

### Task 10: Create dogfood Linear API key

- [ ] **Step 1: Generate the key**

In Linear (signed in as the dogfood-bot account if using one, otherwise your account):
- Settings → API → Personal API keys → "New API key"
- Label: `urateam-dogfood-sidecar`

Capture the `lin_api_…` key.

- [ ] **Step 2: Verify**

Run:
```bash
curl -s -H "Authorization: <key>" -H "Content-Type: application/json" \
  --data '{"query":"query{viewer{id email}}"}' \
  https://api.linear.app/graphql | jq .
```
Expected: returns the bot/your `viewer.id` and `viewer.email`.

---

## Phase 3 — Deploy container

Run on the urateams.com Docker host. SSH in first.

### Task 11: Pull latest urateam repo + write `.env.dogfood`

- [ ] **Step 1: SSH and pull**

```bash
ssh user@urateams.com
cd /opt/urateam     # or wherever the existing urateam clone lives
git pull
ls -la              # verify Dockerfile and docker-compose.dogfood.yml are present
```

- [ ] **Step 2: Create `.env.dogfood` from the example**

```bash
cp .env.dogfood.example .env.dogfood
chmod 600 .env.dogfood
```

- [ ] **Step 3: Fill in real values**

Edit `.env.dogfood` and paste the values captured in Phase 2 tasks 7–10:
- `URATEAM_LICENSE_JWT` — Enterprise JWT
- `LINEAR_API_KEY` — `lin_api_…`
- `GITHUB_TOKEN` — bot PAT
- `SLACK_BOT_TOKEN` — `xoxb-…`
- `OPENROUTER_API_KEY` — existing
- `ANTHROPIC_API_KEY` — existing

Leave all other values as-is from the example.

- [ ] **Step 4: Verify .env.dogfood is NOT tracked by git**

```bash
git status --ignored .env.dogfood
```
Expected: shows as ignored (per `.env*` gitignore pattern).

### Task 12: Build and start the container

- [ ] **Step 1: Build**

```bash
docker compose -f docker-compose.dogfood.yml build
```
Expected: image builds; final line `Successfully tagged …`.

- [ ] **Step 2: Start detached**

```bash
docker compose -f docker-compose.dogfood.yml up -d
```
Expected: `Container urateam-dogfood Started`.

- [ ] **Step 3: Verify it's running**

```bash
docker ps --filter name=urateam-dogfood --format '{{.Names}}\t{{.Status}}'
```
Expected: `urateam-dogfood   Up X seconds`.

### Task 13: Verify boot signals

- [ ] **Step 1: Tail logs**

```bash
docker logs urateam-dogfood --tail 100 -f
```

Look for (within ~30 seconds of boot):
- `License loaded: tier=enterprise expires=…`
- `Quality Observer enabled (env flag)`
- `Watching Linear project 4c638018-… every Ns`
- `Dashboard listening on :3001`

If any are missing, exit the tail (Ctrl-C) and investigate the env file. Fix and re-run `docker compose -f docker-compose.dogfood.yml up -d --force-recreate`.

- [ ] **Step 2: Tunnel to dashboard from your laptop**

(Run on your laptop, not the host.)

```bash
ssh -L 3001:127.0.0.1:3001 user@urateams.com -N &
curl -s http://localhost:3001 | head -5
```
Expected: HTML response (dashboard layout).

Then open in browser:
- `http://localhost:3001` — main dashboard
- `http://localhost:3001/admin/audit` — Enterprise audit log
- `http://localhost:3001/admin/cost-roi` — Enterprise cost & ROI

All three should render without 401/403/500.

---

## Phase 4 — Soak (≥7 calendar days)

### Task 14: Seed first ticket (BEC-147)

- [ ] **Step 1: Move BEC-147 to Todo**

In Linear: open BEC-147 (CHANGELOG GH-releases migration), set status `Backlog → Todo`.

- [ ] **Step 2: Watch for pickup**

Within ~5 min:

```bash
docker logs urateam-dogfood --tail 50 | grep -i "BEC-147\|ticket_picked"
```
Expected: `pm.ticket_picked` event for BEC-147.

```bash
gh pr list --repo JonB32/urateam --author urateam-dogfood-bot --state open
```
Expected: a PR for BEC-147 within ~15 min (depending on PM agent run cadence).

If neither happens within 30 min, file a `[sev-1]` Linear ticket "dogfood: PM agent did not pick up BEC-147" and triage logs.

### Task 15: Set up daily digest cron

- [ ] **Step 1: Create digest script on host**

```bash
ssh user@urateams.com 'cat > ~/dogfood-digest.sh' <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DIGEST=$(docker exec urateam-dogfood sqlite3 /home/ura/data/dogfood.db \
  "SELECT event_type, COUNT(*) AS n FROM audit_events
   WHERE created_at >= datetime('now','-1 day') GROUP BY event_type ORDER BY n DESC;")
PRS=$(gh pr list --repo JonB32/urateam --author urateam-dogfood-bot --state all --limit 5 --json number,title,state | jq -r '.[] | "  #\(.number) [\(.state)] \(.title)"')
MSG="Dogfood 24h digest:\n\`\`\`\n${DIGEST}\n\`\`\`\nRecent bot PRs:\n${PRS}"
curl -s -X POST -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"channel\":\"#urateam-dogfood\",\"text\":\"${MSG}\"}" \
  https://slack.com/api/chat.postMessage > /dev/null
EOF
ssh user@urateams.com 'chmod +x ~/dogfood-digest.sh'
```

- [ ] **Step 2: Add cron entry**

```bash
ssh user@urateams.com 'crontab -l 2>/dev/null | { cat; echo "0 9 * * * SLACK_BOT_TOKEN=<token> ~/dogfood-digest.sh"; } | crontab -'
```
(Replace `<token>` with the real bot token. Posts daily at 09:00 host time.)

- [ ] **Step 3: Test manually**

```bash
ssh user@urateams.com 'SLACK_BOT_TOKEN=<token> ~/dogfood-digest.sh'
```
Expected: digest posted to `#urateam-dogfood`.

### Task 16: Soak observation cadence (≥7 days)

This is calendar-bound. No code changes during soak unless triaging a sev-1/2 bug.

- [ ] **Step 1: Daily** — read the 9am digest in `#urateam-dogfood`. Skim for: license validation failures (sev-1), PM agent failure rate >50%, RM stuck in `awaiting_approval`, QA gap issues filed unexpectedly.
- [ ] **Step 2: Daily** — `gh pr list --repo JonB32/urateam --author urateam-dogfood-bot --state open` — review any open PRs from the bot. If one looks ready, run Sonnet review on it; merge if clean.
- [ ] **Step 3: Per backlog escalation** — once a tech-debt PR has been merged and released by the bot, move the next ticket to Todo (BEC-148, then BEC-149). Once all three tech-debt tickets have closed loops, start v2 follow-ups smallest-first.
- [ ] **Step 4: Per dogfood-found bug** — file Linear ticket with sev prefix; sev-1 halts the soak (fix immediately), sev-2 fix-and-merge before cut, sev-3 label `defer-to-1.0.x`.
- [ ] **Step 5: 2026-05-18** — read the two scheduled soak-check reports (`trig_01QosUVARKKPSRcU3KA8GYcK` for RM, `trig_01KUvT4hb6j4w1yKzkyPkACd` for QA). Classify findings into sev buckets.

### Task 17: Pre-cut checklist verification

- [ ] **Step 1: Run the checklist**

In a notes file (or directly in this task), verify each item:
- [ ] Sidecar has been running ≥7 calendar days continuously (`docker inspect urateam-dogfood --format '{{.State.StartedAt}}'` and compare to today)
- [ ] ≥1 PR went through full autonomous loop end-to-end (find it in `gh pr list ... --state merged` cross-referenced with a tag created by the bot via `gh release list --repo JonB32/urateam | grep dogfood-bot`)
- [ ] All `[sev-1]` and `[sev-2]` dogfood-found Linear tickets are `Done` (`linear search` or via the Linear UI)
- [ ] 2026-05-18 scheduled soak-check reports have fired (or findings classified)
- [ ] CI green on `main` (`gh run list --workflow=ci.yml --branch=main --limit 1`)
- [ ] CHANGELOG `[Unreleased]` drafted

If ANY box is unchecked, do not proceed to Phase 5. Either fix the underlying issue or extend the soak.

---

## Phase 5 — 1.0.0 cut

Single sitting, ~90 min. Follows the standard urateam release workflow (`feedback_release_workflow` memory).

### Task 18: Open `chore/release-v1.0.0` bump PR

**Files:**
- Modify: `packages/core/package.json` (version → `1.0.0`)
- Modify: `packages/cli/package.json` (version → `1.0.0`)
- Modify: `packages/dashboard/package.json` (version → `1.0.0`)
- Modify: `packages/create-urateam/package.json` (version → `1.0.0`)
- Modify: `CHANGELOG.md` (add `## [1.0.0] — YYYY-MM-DD` section)

- [ ] **Step 1: Branch from main**

```bash
cd /tmp/urateam-fresh
git checkout main && git pull
git worktree add .worktrees/release-v1.0.0 -b chore/release-v1.0.0
cd .worktrees/release-v1.0.0
```

- [ ] **Step 2: Bump versions**

```bash
for p in core cli dashboard create-urateam; do
  cd packages/$p
  npm version 1.0.0 --no-git-tag-version --allow-same-version
  cd ../..
done
```

- [ ] **Step 3: Update CHANGELOG**

Edit `CHANGELOG.md`. Insert above `## [Unreleased]`:

```markdown
## [1.0.0] — YYYY-MM-DD

**urateam 1.0.0 — first stable release.**

Six v1.0 gating features shipped:
- BEC-133: Retry button in dashboard run-detail
- BEC-134: OpenRouter multi-model fanout on review stage
- BEC-137: Quality Observer agent (internal-only)
- BEC-135: Release Manager agent (Pro)
- BEC-136: QA agent + release-readiness check (OSS+)
- BEC-138: Self-dogfood validation — urateam built, reviewed, and released its own backlog

### Bumped
- `@urateam/core`: 0.1.18 → 1.0.0
- `@urateam/cli`: 0.1.20 → 1.0.0
- `@urateam/dashboard`: 0.1.18 → 1.0.0
- `create-urateam`: 0.1.21 → 1.0.0
```

(Replace `YYYY-MM-DD` with cut date.)

- [ ] **Step 4: Verify pnpm-lock.yaml updates if needed**

```bash
cd /tmp/urateam-fresh/.worktrees/release-v1.0.0
pnpm install
git status   # check whether pnpm-lock.yaml changed
```
If lockfile changed, include it in the commit.

- [ ] **Step 5: Commit and push**

```bash
git add packages/*/package.json CHANGELOG.md pnpm-lock.yaml 2>/dev/null
git commit -m "chore(release): v1.0.0 — first stable; self-dogfood validated

All four packages bumped 0.1.x → 1.0.0. Six v1.0 features shipped
(BEC-133..138). Self-dogfood (BEC-138) validated the full v1.0
surface against the urateam product repo itself for ≥7 days."
git push -u origin chore/release-v1.0.0
```

- [ ] **Step 6: Open the PR**

```bash
gh pr create --base main --title "chore(release): v1.0.0 — first stable; self-dogfood validated" --body "$(cat <<'EOF'
## Summary
- Bump @urateam/core, @urateam/cli, @urateam/dashboard, create-urateam from 0.1.x → 1.0.0
- CHANGELOG: add 1.0.0 section summarizing six v1.0 features (BEC-133..138)

## Cut sequence
After merge:
1. \`git tag v1.0.0 <merge-sha>\`
2. \`git push origin v1.0.0\` (fires publish.yml — OIDC trusted publish to npm)
3. \`gh release create v1.0.0 --title "..." --notes "..."\`

## Pre-cut checklist (per BEC-138 spec)
- [x] Sidecar ≥7 days continuous
- [x] ≥1 fully-autonomous PR loop completed
- [x] All sev-1/2 dogfood-found tickets closed
- [x] 2026-05-18 soak-checks classified
- [x] CI green on main

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Sonnet review on the bump PR**

Trigger and address review feedback as fix-up commits.

- [ ] **Step 8: User merges**

(User merges the bump PR. Capture the merge commit SHA for the next task.)

### Task 19: Tag and push `v1.0.0`

- [ ] **Step 1: Sync main**

```bash
cd /tmp/urateam-fresh
git checkout main && git pull
git log --oneline -3   # confirm bump merge is HEAD
```

- [ ] **Step 2: Tag and push**

```bash
git tag v1.0.0
git push origin v1.0.0
```

(NOTE: Don't push tag before bump PR is merged — `publish.yml` would publish 0.1.x as 1.0.0 by accident. Per `feedback_release_workflow` memory.)

### Task 20: Watch publish workflow + verify on npm

- [ ] **Step 1: Watch the run**

```bash
gh run list --workflow=publish.yml --limit 3
gh run watch
```
Expected: green check after ~3-5 min; all 4 packages published with provenance.

- [ ] **Step 2: Verify on npm**

```bash
for pkg in @urateam/core @urateam/cli @urateam/dashboard create-urateam; do
  echo -n "$pkg@1.0.0: "
  npm view $pkg@1.0.0 version 2>&1 | head -1
done
```
Expected: each prints `1.0.0`. Any that error means the publish failed for that package — check `gh run view <run-id> --log` for that job.

- [ ] **Step 3: Verify provenance**

```bash
npm view @urateam/core@1.0.0 dist.signatures
npm view @urateam/core@1.0.0 dist.attestations
```
Expected: signatures and attestations present (OIDC provenance).

### Task 21: Create GitHub release page

- [ ] **Step 1: Draft release notes**

In a local file `release-notes-v1.0.0.md`:

```markdown
**urateam 1.0.0 — first stable release.**

urateam is the autonomous SDLC framework that built itself.

## What shipped in v1.0

| BEC | Feature | Tier |
|---|---|---|
| BEC-133 | Retry button in dashboard run-detail | OSS+ |
| BEC-134 | OpenRouter multi-model fanout on review stage | Pro |
| BEC-137 | Quality Observer agent (internal-only env flag) | Internal |
| BEC-135 | Release Manager agent (cron + auto-tag + GH release) | Pro |
| BEC-136 | QA agent + release-readiness check (Phase 1) | OSS+ |
| BEC-138 | Self-dogfood validation | — |

## Self-dogfood

For ≥7 days before this cut, urateam ran as a sidecar against its own backlog:
- N PRs opened by the bot from Linear tickets (BEC-147..149 + …)
- M autonomous releases cut by the bot
- K dogfood-found bugs surfaced; all sev-1/2 fixed before cut

(Replace N/M/K with real counts from the soak.)

## Install

\`\`\`bash
npx create-urateam@1.0.0 my-project
cd my-project
ura dev
\`\`\`

## Migration from 0.1.x

No breaking API changes. Bump your `package.json`:
- `@urateam/core`: `^1.0.0`
- `@urateam/cli`: `^1.0.0`
- `@urateam/dashboard`: `^1.0.0`

## Tier table

| Tier | Pitch |
|---|---|
| OSS | Self-hosted, BYO Anthropic key. Free. Includes QA agent. |
| Pro | Multi-repo, advanced auto-merge, deep review, PM Agent + Slack, Release Manager. |
| Enterprise | Adds SSO, audit log + retention + export, spend caps, RBAC, cost & ROI dashboard, org policy. Sales-led. |

## License

BSL 1.1. Managed Service use requires a commercial license.
```

- [ ] **Step 2: Create the release**

(Don't pass tag as trailing positional arg — per `feedback_release_workflow` memory.)

```bash
gh release create v1.0.0 \
  --title "v1.0.0 — first stable; self-dogfood validated" \
  --notes-file release-notes-v1.0.0.md
```

Expected: prints the release URL. Open it to verify it renders correctly.

### Task 22: Post-cut — update memory, file v2 follow-ups, redeploy dogfood on v1.0.0

- [ ] **Step 1: Update memory**

Edit `/Users/jonb/.claude/projects/-Users-jonb-projects-urateam-licensing/memory/project_v1_release_roadmap.md`:
- Mark BEC-138 as ✅ done with cut date
- Note 6/6 complete; BEC-132 Phase 2 (announce) now unblocked

Edit `/Users/jonb/.claude/projects/-Users-jonb-projects-urateam-licensing/memory/MEMORY.md`:
- Update the v1.0 roadmap line description from "5 of 6 shipped" to "6/6 shipped — v1.0.0 cut"

- [ ] **Step 2: File v2 follow-ups in Linear**

Create tickets:
- "BEC-138 follow-up: publish Fly.io distribution image for OSS sidecar" — captures Decision 3's deferred Option C
- "BEC-138 follow-up: dedicated qa-check.yml workflow for release-readiness" — captures Decision 4's deferred Option B
- "BEC-138 follow-up: migrate dogfood from PAT to dedicated bot account" (only if Phase 2 Task 9 chose Option B)
- "BEC-138 follow-up: Caddy reverse proxy for dogfood dashboard at dogfood.urateams.com"
- One ticket per `defer-to-1.0.x`-labeled dogfood-found bug — re-label as `1.0.x` patch line

- [ ] **Step 3: Rebuild dogfood container on v1.0.0**

SSH to the urateams.com host:

```bash
cd /opt/urateam
git pull   # picks up v1.0.0 tag-time main
# Update build args inline OR edit docker-compose.dogfood.yml to set new versions
docker compose -f docker-compose.dogfood.yml build \
  --build-arg URATEAM_CORE_VERSION=1.0.0 \
  --build-arg URATEAM_CLI_VERSION=1.0.0 \
  --build-arg URATEAM_DASHBOARD_VERSION=1.0.0
docker compose -f docker-compose.dogfood.yml up -d --force-recreate
docker logs urateam-dogfood --tail 50 | grep -i "version\|license"
```
Expected: container restarts with v1.0.0 packages; license still loads (`tier=enterprise`); watch loop resumes.

- [ ] **Step 4: Close BEC-138 in Linear**

Move BEC-138 status to `Done`. Add a closing comment summarizing: cut date, soak duration in days, autonomous-PR count, sev-1/2 bugs fixed count, sev-3 deferrals count.

- [ ] **Step 5: Announce-readiness handoff**

BEC-132 Phase 2 (announce + monetization) is now unblocked. Next session can pick up there.

---

## Out of scope (filed during Task 22)

- Fly.io distribution image
- Dedicated `qa-check.yml`
- Bot-account hygiene migration (if PAT used)
- Caddy reverse proxy on `dogfood.urateams.com`
- All `defer-to-1.0.x` dogfood-found bugs

---

## Self-review checklist

- [x] Spec coverage: every spec section has tasks (Phase 1 = build, Phase 2 = configure, Phase 3 = deploy, Phase 4 = soak instrumentation, Phase 5 = cut)
- [x] No placeholders (TBD/TODO/etc — verified by `grep -n -E "TBD|TODO|FIXME"`)
- [x] Type/path consistency: all package paths and env-var names match between spec, runbook, and plan
- [x] All commands have expected output
- [x] Each task is bite-sized (2-5 min per step; calendar-bound steps explicitly marked)

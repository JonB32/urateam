# BEC-138 — Self-dogfood + 1.0.0 cut

**Linear:** [BEC-138](https://linear.app/beckerspace/issue/BEC-138/v10-66-run-urateam-sidecar-on-the-urateam-repo-cut-100)
**Status:** design
**Author:** Jon Becker (with Claude)
**Date:** 2026-05-04

## Summary

Final v1.0 gate. Install the urateam sidecar inside a Docker container running on the existing urateams.com Docker host, sibling to the existing urateam container. Configure it to consume the urateam product repo's own Linear backlog under an Enterprise license, escalate from tech-debt tickets up to v2 follow-ups, soak ≥7 calendar days, then cut all four packages to `1.0.0`.

This is **operational deployment**, not feature implementation. The build is small (Dockerfile, compose entry, env-var contract, a one-line workflow change, runbook). The soak is calendar-bound and cannot be compressed.

## Why

Per the v1.0 release roadmap (memory: `project_v1_release_roadmap.md`), BEC-138 is the sixth and final v1.0 gating requirement before BEC-132 Phase 2 (announce) unblocks. Five of six items have shipped:

- ✅ BEC-133 — retry button (v0.1.29)
- ✅ BEC-134 — OpenRouter multi-model fanout (v0.1.30)
- ✅ BEC-137 — Quality Observer (private repo)
- ✅ BEC-135 — Release Manager (v0.1.32)
- ✅ BEC-136 — QA agent + release-readiness check (v0.1.32)
- ⏳ **BEC-138 — Self-dogfood + 1.0.0 cut** (this spec)

The dogfood validates the full v1.0 surface against a non-trivial real codebase (urateam itself), surfaces dogfood bugs no customer has hit, and establishes the announce story: *"urateam is the autonomous SDLC framework that built itself."*

## Locked decisions (recorded inputs)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | License tier for the dogfood sidecar | **Enterprise** | Maximum surface validation. Acceptance criterion needs Pro at minimum (PM agent + RM); running Enterprise on top costs nothing operationally and exercises audit-log retention/reader/CSV export, RBAC, cost & ROI dashboard, org-policy — features that have shipped but never been exercised on a real codebase. |
| 2 | Backlog strategy | **Mixed escalating on real main** — tech debt first (BEC-147/148/149), then v2 follow-ups (BEC-139..146) as trust builds | PR review gate ("no manual intervention beyond final approval") bounds blast radius. Tech-debt-first builds trust before letting the agent near the v2 features it'll be judged on. Strongest announce story: "urateam built and shipped its own v2 backlog." |
| 3 | Deployment | **Docker container, sibling to existing urateam container on the same Docker host** (urateams.com infra) | Reuses existing infra; container provides isolation; no new infrastructure to manage during soak. Fly.io Machines distribution image is filed as a v2 follow-up for the OSS-distributable path. |
| 4 | qaCheck workflow target | **Add `workflow_dispatch:` trigger to existing `.github/workflows/ci.yml`** | One-line change. Lets the QA agent fire the same gate everyone already trusts. A dedicated `qa-check.yml` with heavier release-readiness checks is a v2 follow-up; v1.0 doesn't need it. |
| 5 | 1.0.0 cut criteria | **Pragmatic — sev-1/2 block; sev-3 → 1.0.x patch line; ≥7-day soak; ≥1 autonomous PR merged** | Version 1.0.x patch line is the right pressure-relief valve for sev-3. The 7-day soak + sev-1/2 gate naturally lines up with the 2026-05-18 scheduled soak-checks (RM + QA), so the cut window becomes 2026-05-13 → 2026-05-18 depending on what surfaces. |

## Architecture

```
Existing Docker host (urateams.com infra)
├── existing urateam container         ← whatever it does today, untouched
└── NEW: urateam-dogfood container     ← BEC-138
        │
        ├── ura dev (watch Linear)
        ├── PM agent              (BEC tickets → PRs on JonB32/urateam)
        ├── Sonnet review on PRs
        ├── Release Manager       (cron: cut tag + GH release on triggers)
        ├── QA agent              (workflow_dispatch ci.yml; file gap issues)
        ├── OpenRouter fanout     (review stage)
        ├── Quality Observer      (BEC-137; runs out-of-process from private repo)
        └── Enterprise audit-log  (retention sweep, dashboard reader, CSV export)
```

The sidecar container runs `ura dev` as PID 1 (under tini for signal handling). It mounts a SQLite data volume and a work-tree volume. Its dashboard binds to `127.0.0.1:3001` on the host (avoid collision with any existing urateam container on `:3000`); remote viewing happens via SSH tunnel during soak.

## Components

### Things being built

1. **`Dockerfile`** at repo root — multistage; pins Node 22; npm-installs `@urateam/cli`, `@urateam/core`, `@urateam/dashboard` from public npm at the just-published `v0.1.32`; runs as non-root `ura` user; entrypoint `tini -- ura dev`. Image is reproducible via build args; rebuilt on each version bump.

2. **`docker-compose.dogfood.yml`** — sibling-to-existing compose entry. Volumes for `/home/ura/data` (SQLite) and `/home/ura/work` (cloned repos). `restart: unless-stopped`. Port `127.0.0.1:3001:3001` (localhost-only).

3. **`.env.dogfood.example`** — fully-commented env-var contract (see [Configuration](#configuration) below).

4. **One-line PR**: add `workflow_dispatch:` trigger to `.github/workflows/ci.yml`.

5. **Soak runbook** at `docs/superpowers/runbooks/2026-05-04-bec138-dogfood-soak.md` — what to watch, where to look, daily/weekly check cadence, triage workflow.

### Things being configured (not built)

- **Linear**: source backlog = "Ateam Monetization" project (`4c638018-bd58-4e4a-81ce-232832678c03`). Tickets are unblocked manually by moving them from `Backlog` → `Todo`. The PM agent only picks up `Todo` items.
- **GitHub**: new `urateam-dogfood-bot` GitHub account (or a fine-grained PAT scoped to `JonB32/urateam` if a bot account is too much overhead). Scopes: `repo`, `workflow`.
- **Slack**: new private `#urateam-dogfood` channel; new Slack app token scoped to that single channel for RM `/release approve|skip|status` and QA `gap_issue_filed` notifications.
- **Enterprise license JWT**: minted from the urateam-licensing service for `dogfood@urateams.com`, valid 1 year.
- **Dogfood database**: fresh SQLite at `/home/ura/data/dogfood.db`, never touched by the existing urateam container.

## Configuration

`.env.dogfood.example` env-var contract:

| Var | Value | Source / notes |
|---|---|---|
| `URATEAM_LICENSE_JWT` | Enterprise JWT for `dogfood@urateams.com` | Mint via licensing-service `/admin/recover` flow; valid 1 yr |
| `URATEAM_QUALITY_OBSERVER_ENABLED` | `true` | Internal-only flag from BEC-137; not in `.env.example` |
| `LINEAR_API_KEY` | dogfood-bot key | New Linear personal API key under bot account |
| `LINEAR_PROJECT_ID` | `4c638018-bd58-4e4a-81ce-232832678c03` | "Ateam Monetization" project |
| `GITHUB_TOKEN` | dogfood-bot PAT | New `urateam-dogfood-bot` GitHub account; `repo` + `workflow` scopes |
| `GITHUB_REPO` | `JonB32/urateam` | Self |
| `SLACK_BOT_TOKEN` | new `urateam-dogfood` app token | New Slack app, single-channel scope |
| `SLACK_CHANNEL` | `#urateam-dogfood` | New private channel |
| `OPENROUTER_API_KEY` | existing | For BEC-134 fanout |
| `ANTHROPIC_API_KEY` | existing | Sonnet review |
| `RELEASE_MANAGER_TRIGGERS` | `mergedPRsSince=3,timeSinceLastHours=72,ciGreenForMinutes=30,requireSlackApproval=true,qaCheck=true` | Conservative trigger set: 3 merged PRs OR 72h since last release; CI green ≥30 min; Slack approval required; QA gate green |
| `QA_CHECK_WORKFLOW` | `ci.yml` | Per Decision 4 |
| `DASHBOARD_PORT` | `3001` | Avoid collision with existing urateam container |
| `DATABASE_URL` | `sqlite:///home/ura/data/dogfood.db` | Mounted volume |

## Deployment artifact

### Dockerfile (root of `JonB32/urateam`)

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache git openssh-client tini

# Pinned versions — image is reproducible per build.
ARG URATEAM_CORE_VERSION=0.1.18
ARG URATEAM_CLI_VERSION=0.1.20
ARG URATEAM_DASHBOARD_VERSION=0.1.18
RUN npm install -g \
      @urateam/cli@${URATEAM_CLI_VERSION} \
      @urateam/core@${URATEAM_CORE_VERSION} \
      @urateam/dashboard@${URATEAM_DASHBOARD_VERSION}

RUN addgroup -S ura && adduser -S -G ura ura
USER ura
WORKDIR /home/ura

VOLUME ["/home/ura/data", "/home/ura/work"]
EXPOSE 3001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["ura", "dev"]
```

### docker-compose.dogfood.yml (sibling entry)

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
      - "127.0.0.1:3001:3001"

volumes:
  urateam-dogfood-data:
  urateam-dogfood-work:
```

### Build + run sequence on the host

```bash
git pull
docker compose -f docker-compose.dogfood.yml up -d --build
docker logs -f urateam-dogfood       # tail to verify boot
```

When a new urateam version ships during the soak, rebuild with new `--build-arg` values and recreate the container. Version-pinning is intentional — soak validates a specific published artifact, not "whatever's on main."

## Soak instrumentation

### Primary signal — the autonomous loop closes

- **Source**: GitHub PR list on `JonB32/urateam`, filtered by author `urateam-dogfood-bot`
- **Success metric**: ≥1 PR opened-by-bot, reviewed-by-bot, merged-by-human, released-by-bot (cycle time captured)
- **Where checked**: `gh pr list --author urateam-dogfood-bot --state all`

### Secondary signals — Enterprise audit log

The Enterprise tier writes audit rows for every agent action. Soak queries (run from dashboard `/admin/audit` or directly against `dogfood.db`):

| Event family | What it tells us |
|---|---|
| `pm.ticket_picked`, `pm.pr_opened`, `pm.pr_failed` | PM agent throughput; failure rate |
| `release.decided`, `release.fired`, `release.skipped`, `release.awaiting_approval` | RM trigger semantics under real load |
| `qa.run_triggered`, `qa.completed`, `qa.gap_issue_filed` | QA Phase 1 against real CI |
| `audit.retention_swept`, `audit.export_requested` | Enterprise audit-log features actually exercised |
| `license.validation_failed` | Should be zero — any non-zero is sev-1 |

Daily digest cron on the host posts to `#urateam-dogfood`:

```sql
SELECT event_type, COUNT(*) FROM audit_events
WHERE created_at >= datetime('now','-1 day') GROUP BY event_type;
```

### Dashboard panels exercised

- Cost & ROI (`/admin/cost-roi`) — Enterprise; should populate with PM/RM/QA spend during the soak
- Audit log (`/admin/audit`) — Enterprise; should be browsable and exportable to CSV
- Run detail with retry button (`/runs/:id`) — BEC-133; tested implicitly when the bot retries

### Quality Observer signal

QO runs out-of-process from the private repo `JonB32/urateam-quality-observer`. Its findings post to `#urateam-dogfood` (channel routing confirmed during deployment). Any QO finding flagged sev-1 or sev-2 is a dogfood bug.

### Two existing scheduled checks fire 2026-05-18 (already booked)

- `trig_01QosUVARKKPSRcU3KA8GYcK` — BEC-135 audit-unchecked + vitest timeout
- `trig_01KUvT4hb6j4w1yKzkyPkACd` — BEC-136 qa.* audit + qaCheck integration

These reports are independent of BEC-138's soak; their findings feed the same severity classification.

### Bug triage workflow

- File every dogfood-found issue as a Linear ticket under "Ateam Monetization", label `dogfood-found`, severity in title prefix `[sev-1]` / `[sev-2]` / `[sev-3]`
- Sev-1/2 → fix-and-merge before 1.0.0 cut (per Decision 5)
- Sev-3 → keep open, label `defer-to-1.0.x`, ship in patch line

## Cut sequence (the 1.0.0 release path)

### Pre-cut checklist (gates the cut, all must hold)

- [ ] Sidecar has run continuously ≥7 calendar days from first boot
- [ ] ≥1 PR went through full autonomous loop (Linear → bot-PR → Sonnet review → human merge approval → bot-cut release)
- [ ] All `[sev-1]` and `[sev-2]` dogfood-found Linear tickets are closed
- [ ] The two 2026-05-18 scheduled soak-checks have fired and reported clean (or their findings classified sev-3 / fixed)
- [ ] CI green on `main`
- [ ] CHANGELOG `[Unreleased]` section drafted with everything since v0.1.32

### Cut sequence (single sitting, ~90 min)

1. **Open bump PR** `chore/release-v1.0.0` from `main`. Change all 4 package.json versions to `1.0.0`:
   - `packages/core/package.json`: `0.1.18` → `1.0.0`
   - `packages/cli/package.json`: `0.1.20` → `1.0.0`
   - `packages/dashboard/package.json`: `0.1.18` → `1.0.0`
   - `packages/create-urateam/package.json`: `0.1.21` → `1.0.0`
   - `CHANGELOG.md` — add `## [1.0.0] — YYYY-MM-DD` section above `[Unreleased]`, summary block: "v1.0 — autonomous SDLC. Fully self-dogfooded."
   - PR title: `chore(release): v1.0.0 — first stable; self-dogfood validated`

2. **Sonnet review** on the bump PR (per workflow convention from `feedback_release_workflow` memory).

3. **User merges** the bump PR.

4. **Tag and push:**
   ```bash
   git tag v1.0.0 <merge-commit-sha>
   git push origin v1.0.0
   ```
   This fires `.github/workflows/publish.yml` — OIDC trusted publishing of all 4 packages to npm with provenance.

5. **Watch the publish workflow:**
   ```bash
   gh run list --workflow=publish.yml --limit 3
   gh run watch
   ```

6. **Verify on npm:**
   ```bash
   npm view @urateam/core@1.0.0 version
   npm view @urateam/cli@1.0.0 version
   npm view @urateam/dashboard@1.0.0 version
   npm view create-urateam@1.0.0 version
   ```

7. **Create GitHub release page** with announcement-ready notes. Don't pass tag as trailing positional arg (per release-workflow memory gotcha):
   ```bash
   gh release create v1.0.0 \
     --title "v1.0.0 — first stable; self-dogfood validated" \
     --notes "$(cat <<'EOF'
   ...
   EOF
   )"
   ```

8. **Update memory**: mark v1.0 release roadmap as 6/6 complete; unblock BEC-132 Phase 2 (announce); file v2 follow-ups for the deferred items (Fly.io distribution image, dedicated `qa-check.yml` workflow, anything else surfaced during soak).

9. **Rebuild + redeploy the dogfood container** with `--build-arg URATEAM_*_VERSION=1.0.0` — the dogfood now runs the released artifact, not a 0.1.x.

### v1.0.0 release notes draft (skeleton)

> urateam 1.0.0 — first stable. Six v1.0 gating features shipped: retry button (BEC-133), OpenRouter multi-model fanout (BEC-134), Quality Observer (BEC-137, internal-only), Release Manager (BEC-135), QA agent (BEC-136), and self-dogfood validation (BEC-138 — urateam built, reviewed, and released its own backlog).
>
> What this means: urateam is the autonomous SDLC framework that built itself.
>
> [Tier table; install commands; migration notes from 0.1.x]

Final wording shaped by what dogfood reveals.

## Out of scope (filed as v2 follow-ups during the cut)

- **Fly.io Machines distribution image** — published Docker image OSS users can pull and run on managed-container infra
- **Dedicated `qa-check.yml` workflow** — separate release-readiness gate distinct from PR CI; can include heavier checks
- **Bot account hygiene** — if the dogfood uses your PAT in v1.0, file a follow-up to migrate to a dedicated `urateam-dogfood-bot` account
- **Dashboard remote viewing** — Caddy reverse proxy on `dogfood.urateams.com` (during soak, SSH tunnel is fine)
- **Whatever sev-3 dogfood-found bugs surface** — each filed as `[sev-3]` ticket labeled `defer-to-1.0.x`

## References

- Memory: `project_v1_release_roadmap.md` — sequence + decisions for v1.0
- Memory: `feedback_release_workflow.md` — bump PR → tag → publish → gh release
- Memory: `feedback_audit_gating_pattern.md` — Pro-tier audit events use `logAuditEventUnchecked`
- BEC-135 spec: `docs/superpowers/specs/2026-05-01-bec-135-release-manager-design.md`
- BEC-136 spec: `docs/superpowers/specs/2026-05-04-bec-136-qa-agent-design.md`

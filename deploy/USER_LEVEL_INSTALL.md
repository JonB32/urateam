# User-level install

A single `ura` daemon on your machine, managing N repos from one config — no per-project Docker setup. Closest analogy: `gh` CLI or `cyrus`.

If you need a multi-operator, server-hosted install with SSO and a public dashboard, see the **[project-level (sidecar) install](../packages/create-urateam/template/README.md)** instead.

---

## Quick start

```bash
# 1. Install the CLI
npm install -g @urateam/cli

# 2. Bootstrap state directory
ura init                              # creates ~/.urateam/{config.json,data/,repos/}

# 3. Add the secrets the daemon needs (~/.urateam/.env is auto-loaded by `ura start`)
cat > ~/.urateam/.env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...          # or CLAUDE_CODE_OAUTH_TOKEN=...
LINEAR_API_KEY=lin_api_...
LINEAR_WEBHOOK_SECRET=lin_whs_...
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=$(openssl rand -hex 16)
EOF

# 4. Register a repo (clones into ~/.urateam/repos/<slug>)
ura repo add https://github.com/your-org/your-repo.git \
  --branch main \
  --team team-uuid-from-linear

# 5. Start the daemon (reads ~/.urateam/config.json automatically)
cd ~/.urateam && ura start
```

The daemon listens on `:3000` for the webhook receiver and `:3001` for the dashboard by default.

---

## State directory layout

`~/.urateam/` (override with `URATEAM_HOME=/some/other/path`):

```
~/.urateam/
├── config.json     # repo list, pipeline config (managed by `ura repo {add,list,remove}`)
├── .env            # secrets (you create this — `ura start` auto-loads via Node's loadEnvFile)
├── data/           # SQLite DB
└── repos/
    └── <slug>/     # cloned by `ura repo add <url>`, one dir per repo
```

`config.json` is JSON for now (no YAML toolchain dependency). Schema:

```json
{
  "version": 1,
  "repos": [
    {
      "url": "https://github.com/org/repo.git",
      "path": "/home/you/.urateam/repos/repo",
      "defaultBranch": "main",
      "testCommand": "pnpm test",
      "buildCommand": "pnpm build",
      "teamId": "team-uuid-from-linear",
      "labelPattern": "auto-implement"
    }
  ]
}
```

`teamId` is optional — when omitted, the repo is keyed by a slug derived from its URL. Routing by team only works when `teamId` is set.

`labelPattern` is optional and follows BEC-177 (label-based repo routing). When set, tickets whose pipeline label matches the pattern are routed to this repo.

---

## CLI

| Command | What it does |
|---|---|
| `ura init` | Creates `~/.urateam/{config.json,data/,repos/}` with an empty `repos` array. Idempotent. |
| `ura repo add <url>` | Clones `<url>` into `~/.urateam/repos/<slug>` and appends to `config.json`. Options: `--branch`, `--test-command`, `--build-command`, `--team`, `--label-pattern`. |
| `ura repo list` | Prints the configured repos. |
| `ura repo remove <slug>` | Removes a repo from `config.json`. Pass `--purge` to also delete the clone on disk. |
| `ura uninstall --yes` | Deletes `~/.urateam/`. Run `npm uninstall -g @urateam/cli` afterwards to remove the binary. |

---

## Project-level vs user-level

| | Project-level (sidecar) | User-level |
|---|---|---|
| Install footprint | `.urateam/` inside each target repo | `~/.urateam/` once per machine |
| Daemon runtime | Docker container per project | Native `node` process |
| Webhook URL | One per project (subdomain or path-prefix) | One shared URL via tunnel |
| Dashboard | Public-routable via Caddy | `localhost:3001` |
| SSO / RBAC | First-class | Disabled by default |
| Multi-operator | Yes (Caddy + SSO) | One operator |
| Removability | `docker compose down && rm -rf .urateam/` per project | `ura uninstall --yes` |

Rule of thumb: project-level if you're running urateam as production infra for a team or org. User-level if you're an indie dev or consultant running it against your own backlog.

---

## Webhook setup

Linear (and GitHub, if enabled) need a public URL to reach the daemon. On a laptop or non-public server, use a tunnel:

| Tunnel | Best for | Cost |
|---|---|---|
| Cloudflare Tunnel | Production / always-on | Free with a Cloudflare account; permanent URL |
| ngrok | Dev / evaluation | Free tier includes one static domain |
| Tailscale Funnel | Always-on on a Tailnet device | Free with a Tailscale account |

Once you have a public URL, register it in Linear's webhook settings as `<URL>/webhooks/linear`. The `LINEAR_WEBHOOK_SECRET` you put in `~/.urateam/.env` must match what Linear shows after you create the webhook.

---

## Running as a service

`ura start` runs in the foreground. For an always-on install you have a few options.

### macOS — launchd

Save to `~/Library/LaunchAgents/com.urateam.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.urateam.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/ura</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/.urateam</string>
  <key>EnvironmentVariables</key>
  <dict><key>URATEAM_HOME</key><string>/Users/YOU/.urateam</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/.urateam/data/daemon.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/.urateam/data/daemon.err.log</string>
</dict>
</plist>
```

Then `launchctl load ~/Library/LaunchAgents/com.urateam.daemon.plist`.

### Linux — systemd user service

Save to `~/.config/systemd/user/urateam.service`:

```ini
[Unit]
Description=urateam user-level daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.urateam
EnvironmentFile=%h/.urateam/.env
Environment=URATEAM_HOME=%h/.urateam
ExecStart=/usr/bin/ura start
Restart=always

[Install]
WantedBy=default.target
```

Then `systemctl --user enable --now urateam.service`.

### pm2 (any platform)

```bash
pm2 start ura --name urateam -- start
pm2 save
pm2 startup
```

---

## Troubleshooting

**`ura start` exits with "Set REPO_TEAM_ID and REPO_URL"** — you skipped `ura repo add`. The daemon's fallback to `~/.urateam/config.json` only kicks in when no `REPO_*` env vars are set; check that the env vars aren't lurking in your shell.

**Linear webhook never fires** — check the public URL is reachable from the internet (`curl https://your-url/webhooks/linear`); make sure `LINEAR_WEBHOOK_SECRET` in `~/.urateam/.env` matches the value Linear shows.

**Dashboard 401** — set `DASHBOARD_USER` + `DASHBOARD_PASSWORD` in `~/.urateam/.env`; both are required.

**Multiple isolated installs** — set `URATEAM_HOME=/some/path` per process. Lets you run, e.g., one daemon for personal repos and one for client repos without state collisions.

---

## What's deferred

The MVP user-level path covers `init`, `repo {add,list,remove}`, `uninstall`, and the daemon-side config fallback. Planned follow-ups (each its own PR):

- `ura self-auth-linear` — browser-based OAuth flow (Cyrus-style), replaces hand-rolling the webhook secret.
- Built-in tunnel manager — auto-launch Cloudflare Tunnel from `ura start`.
- Hot-reload of `config.json` without restart.
- Service-unit generators (`ura service install`) for launchd / systemd.

For now those steps are manual per the sections above.

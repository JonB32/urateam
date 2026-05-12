# ura bootstrap — One-Command Self-Hosted Setup

`ura bootstrap` is an interactive wizard that takes you from zero to a running
urateam stack in a single command. It handles:

1. **Pre-flight checks** — Docker, required ports (3000/3001), and CLI tools.
2. **GitHub App creation** — manifest flow: opens your browser, captures
   credentials via a local callback server, no manual copy-paste.
3. **Linear webhook registration** — registers the webhook via GraphQL.
4. **File generation** — writes `.env` and `docker-compose.dogfood.yml`.
5. **Reverse-proxy config** — writes a `Caddyfile` or prints the `cloudflared` command.
6. **Validation** — optionally POSTs a synthetic webhook to confirm the stack is live.

## Prerequisites

- **Docker** — install from <https://docs.docker.com/get-docker/>
- **curl**, **openssl**, **jq** — available on most Linux/macOS systems
- A **GitHub** account with permission to create Apps
- A **Linear** workspace with a Personal API key

## Usage

```bash
# If you have ura installed globally:
ura bootstrap

# Or without installing:
npx @urateam/cli bootstrap
```

### Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--skip-github-app` | Skip App creation; read `GITHUB_APP_ID`/`GITHUB_PRIVATE_KEY` from env or prompt | `false` |
| `--skip-linear` | Skip Linear webhook registration | `false` |
| `--validate` | POST a synthetic webhook after setup to confirm the stack is healthy | `false` |
| `--domain <domain>` | Public domain for reverse-proxy config (e.g. `hooks.example.com`) | interactive prompt |
| `--proxy <type>` | Reverse-proxy type: `caddy` or `cloudflared` | `caddy` |
| `--output-dir <dir>` | Directory to write generated files | current directory |
| `--port <port>` | Webhook server port for validation | `3000` |

## What Gets Generated

### `.env`

Contains all credentials the stack needs:

```
GITHUB_APP_ID=<app-id>
GITHUB_PRIVATE_KEY="<pem-with-escaped-newlines>"
GITHUB_WEBHOOK_SECRET=<secret>
LINEAR_API_KEY=<key>
LINEAR_WEBHOOK_SECRET=<secret>
WEBHOOK_URL=https://<domain>/webhooks/linear
DATABASE_URL=file:/data/urateam.db
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=changeme
```

**After generation:** add your Claude credential to `.env`:

```
# Pay-per-token API key:
ANTHROPIC_API_KEY=sk-ant-...

# OR subscription (run: claude setup-token):
CLAUDE_CODE_OAUTH_TOKEN=...
```

See [`deploy/CLAUDE_AUTH.md`](./CLAUDE_AUTH.md) for details on which path to choose.

### `docker-compose.dogfood.yml`

Two services sharing the `.env` file:

- **`app`** — webhook receiver on port 3000
- **`dashboard`** — ops dashboard on port 3001

Start the stack:

```bash
docker compose -f docker-compose.dogfood.yml up -d
```

### `Caddyfile` (when `--proxy caddy`)

Automatic HTTPS via Caddy:

```
hooks.example.com {
  reverse_proxy localhost:3000
}
```

Start Caddy:

```bash
caddy run --config Caddyfile
```

### cloudflared (when `--proxy cloudflared`)

No file is written. The wizard prints the command to run:

```bash
cloudflared tunnel --url http://localhost:3000
```

Then configure your domain in the Cloudflare Zero Trust dashboard.

## After Bootstrap

1. Edit `.env` and add your Claude credential (see above).
2. `docker compose -f docker-compose.dogfood.yml up -d`
3. Set your Linear webhook URL to `https://<domain>/webhooks/linear`.
4. Move a Linear issue to **Todo** — the pipeline runs automatically.

## Skipping Individual Steps

If you already have a GitHub App:

```bash
ura bootstrap --skip-github-app
```

The wizard will prompt for `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, and
`GITHUB_WEBHOOK_SECRET` (or read them from environment variables).

If you already have a Linear webhook:

```bash
ura bootstrap --skip-linear
```

## Validation

Pass `--validate` to confirm the webhook server is responding after you bring
the stack up:

```bash
docker compose -f docker-compose.dogfood.yml up -d
ura bootstrap --skip-github-app --skip-linear --validate
```

The validator POSTs a synthetic webhook payload to `http://localhost:3000/webhooks/linear`
and waits up to 30 seconds for a `2xx` response.

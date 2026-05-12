/**
 * `ura bootstrap` — one-command self-hosted onboarding wizard.
 *
 * Walks the operator through:
 *   1. Pre-flight checks (Docker, ports, tools)
 *   2. GitHub App creation via manifest flow
 *   3. Linear webhook registration
 *   4. .env + docker-compose.dogfood.yml generation
 *   5. Reverse-proxy config (Caddyfile or cloudflared command)
 *   6. Optional first-run validation (POST synthetic webhook)
 *
 * All exported functions accept a `deps` parameter so unit tests can inject
 * mocked implementations of I/O, network, and child-process calls.
 */

import { Command } from "commander";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as childProcess from "node:child_process";
import * as readline from "node:readline";
import * as crypto from "node:crypto";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Simplified execFile signature used for dependency injection.
 * Matches the `(file, args, callback)` overload of child_process.execFile
 * with a simplified callback type so tests can easily provide mocks.
 */
export type ExecFileFn = (
  file: string,
  args: string[],
  callback: (error: Error | null, stdout?: string | Buffer, stderr?: string | Buffer) => void,
) => void;

/** Dependencies injectable for testing. */
export interface BootstrapDeps {
  /** Replaces child_process.execFile. */
  execFile?: ExecFileFn;
  /** Replaces global fetch. */
  fetch?: typeof fetch;
  /** Replaces fs.writeFile. */
  writeFile?: typeof fs.writeFile;
  /** Replaces fs.mkdir. */
  mkdir?: typeof fs.mkdir;
  /** Replaces process.stdout.write (for console output). */
  log?: (msg: string) => void;
  /** Replaces opening the browser. */
  openBrowser?: (url: string) => void;
  /** Replaces the TCP port-free check (returns true when port is available). */
  isPortFree?: (port: number) => Promise<boolean>;
}

/** Result from a successful GitHub App manifest flow. */
export interface GitHubAppCredentials {
  appId: number;
  appName: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  htmlUrl: string;
}

/** Options for createGitHubApp. */
export interface CreateGitHubAppOpts {
  /** GitHub organisation name. Leave blank for a personal account. */
  org?: string;
  /** Pre-assigned callback port; defaults to a random available port. */
  callbackPort?: number;
  /** Timeout (ms) to wait for the OAuth callback. Default: 30 000. */
  timeoutMs?: number;
  deps?: BootstrapDeps;
}

/** Everything needed to render output files. */
export interface BootstrapContext {
  /** GitHub App ID. */
  appId: number;
  /** PEM-encoded GitHub App private key (raw string). */
  privateKey: string;
  /** GitHub App webhook secret. */
  githubWebhookSecret: string;
  /** Linear API key. */
  linearApiKey: string;
  /** Linear webhook secret (from registration response). */
  linearWebhookSecret: string;
  /** Public webhook URL (e.g. https://hooks.example.com). */
  webhookUrl: string;
  /** Optional Postgres DATABASE_URL; defaults to a SQLite path. */
  databaseUrl?: string;
  /** Dashboard basic-auth username. */
  dashboardUser?: string;
  /** Dashboard basic-auth password. */
  dashboardPassword?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the actual `execFile` to use, applying an optional dep override.
 * When no dep is provided, wraps `childProcess.execFile` in a compatible shape.
 * @internal
 */
function getExecFile(deps?: BootstrapDeps): ExecFileFn {
  if (deps?.execFile) return deps.execFile;
  // Wrap the overloaded child_process.execFile in our simpler signature.
  return (file, args, callback) => {
    childProcess.execFile(file, args, (err, stdout, stderr) => {
      callback(err, stdout, stderr);
    });
  };
}

/**
 * Resolves the `fetch` function to use, applying an optional dep override.
 * @internal
 */
function getFetch(deps?: BootstrapDeps): typeof fetch {
  return deps?.fetch ?? globalThis.fetch;
}

/**
 * Resolves the `writeFile` function to use.
 * @internal
 */
function getWriteFile(deps?: BootstrapDeps): typeof fs.writeFile {
  return deps?.writeFile ?? fs.writeFile;
}

/**
 * Promisified execFile that respects the `deps` override.
 * @internal
 */
async function execFileP(
  deps: BootstrapDeps | undefined,
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const ef = getExecFile(deps);
  return new Promise((resolve, reject) => {
    ef(file, args, (err, stdout, stderr) => {
      if (err) {
        reject(err);
      } else {
        const outStr = stdout == null ? "" : typeof stdout === "string" ? stdout : stdout.toString();
        const errStr = stderr == null ? "" : typeof stderr === "string" ? stderr : stderr.toString();
        resolve({ stdout: outStr, stderr: errStr });
      }
    });
  });
}

/**
 * Checks whether a TCP port is free on 0.0.0.0.
 * Returns true if free, false if in use.
 */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

/**
 * Opens a URL in the default browser using platform-appropriate commands.
 * @internal
 */
function openBrowserDefault(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  // Fire-and-forget; if the browser fails to open the user can copy the URL.
  childProcess.execFile(cmd, args, () => {});
}

// ---------------------------------------------------------------------------
// Step 1: Pre-flight checks
// ---------------------------------------------------------------------------

/**
 * Verifies that the local environment is ready for a bootstrap run:
 *   - Docker daemon is reachable (`docker info`)
 *   - Ports 3000 and 3001 are free
 *   - Required CLI tools are present: curl, openssl, jq
 *
 * Throws a descriptive `Error` on the first failure. The bootstrap action
 * calls `process.exit(1)` after logging the error.
 *
 * @param deps - Optional injectable dependencies (for testing).
 */
export async function preflightChecks(deps?: BootstrapDeps): Promise<void> {
  // --- Docker ----------------------------------------------------------------
  try {
    await execFileP(deps, "docker", ["info"]);
  } catch {
    throw new Error(
      "Docker is not running or not installed.\n" +
        "Install Docker Desktop from https://docs.docker.com/get-docker/ and " +
        "ensure the daemon is running before retrying.",
    );
  }

  // --- Ports -----------------------------------------------------------------
  const portCheck = deps?.isPortFree ?? isPortFree;
  const requiredPorts = [3000, 3001];
  for (const port of requiredPorts) {
    const free = await portCheck(port);
    if (!free) {
      throw new Error(
        `Port ${port} is already in use.\n` +
          `Stop the process occupying port ${port} and re-run bootstrap.\n` +
          `You can identify it with: lsof -i :${port}`,
      );
    }
  }

  // --- Tools -----------------------------------------------------------------
  const tools: Array<{ name: string; checkArgs: string[] }> = [
    { name: "curl", checkArgs: ["--version"] },
    { name: "openssl", checkArgs: ["version"] },
    { name: "jq", checkArgs: ["--version"] },
  ];

  for (const tool of tools) {
    try {
      await execFileP(deps, tool.name, tool.checkArgs);
    } catch {
      throw new Error(
        `Required tool "${tool.name}" is not installed or not on PATH.\n` +
          `Install it before running bootstrap:\n` +
          `  macOS:  brew install ${tool.name}\n` +
          `  Linux:  apt-get install ${tool.name}  (or equivalent)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2: GitHub App manifest flow
// ---------------------------------------------------------------------------

/**
 * Creates a GitHub App via the manifest flow:
 *   1. Starts a temporary HTTP server on a local port to capture the OAuth code.
 *   2. Opens the browser to GitHub's manifest endpoint.
 *   3. Waits for GitHub to redirect back with `?code=`.
 *   4. Exchanges the code for full app credentials via the GitHub API.
 *
 * Returns the app credentials (`appId`, `privateKey`, `webhookSecret`, etc.).
 * Throws if the callback times out or the exchange fails.
 *
 * @param opts - Options including org name, timeout, and injectable deps.
 */
export async function createGitHubApp(
  opts: CreateGitHubAppOpts = {},
): Promise<GitHubAppCredentials> {
  const {
    org,
    timeoutMs = 30_000,
    deps,
  } = opts;

  const fetchFn = getFetch(deps);
  const openFn = deps?.openBrowser ?? openBrowserDefault;
  const portCheck = deps?.isPortFree ?? isPortFree;

  // Find a free port for the callback server.
  let callbackPort = opts.callbackPort;
  if (!callbackPort) {
    // Try ports in the range 9876-9896 until one is free.
    for (let p = 9876; p <= 9896; p++) {
      if (await portCheck(p)) {
        callbackPort = p;
        break;
      }
    }
    if (!callbackPort) {
      throw new Error(
        "Could not find a free port for the GitHub App callback server (tried 9876-9896).",
      );
    }
  }

  const state = crypto.randomBytes(16).toString("hex");
  const callbackUrl = `http://localhost:${callbackPort}/callback`;

  // Build the GitHub App manifest.
  const manifest = {
    name: "urateam",
    url: "https://github.com/JonB32/urateam",
    hook_attributes: { url: "https://placeholder.invalid/webhooks/github" },
    redirect_url: callbackUrl,
    callback_urls: [callbackUrl],
    public: false,
    default_permissions: {
      issues: "read",
      pull_requests: "write",
      contents: "write",
      metadata: "read",
    },
    default_events: [
      "push",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "issue_comment",
      "check_suite",
      "check_run",
      "status",
    ],
  };

  const manifestJson = encodeURIComponent(JSON.stringify(manifest));
  const baseUrl = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  const githubUrl = `${baseUrl}?state=${state}&manifest=${manifestJson}`;

  return new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(
        new Error(
          `Timed out waiting for GitHub App OAuth callback after ${timeoutMs}ms.\n` +
            "If the browser did not open, visit:\n" +
            `  ${githubUrl}`,
        ),
      );
    }, timeoutMs);

    const server = http.createServer(async (req, res) => {
      if (settled) {
        res.end();
        return;
      }

      const reqUrl = new URL(req.url ?? "/", `http://localhost:${callbackPort}`);
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }

      const code = reqUrl.searchParams.get("code");
      const receivedState = reqUrl.searchParams.get("state");

      if (receivedState !== state) {
        res.writeHead(400).end("State mismatch — possible CSRF. Please retry.");
        return;
      }

      if (!code) {
        res.writeHead(400).end("Missing code parameter.");
        return;
      }

      // Acknowledge the callback immediately.
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        "<html><body><h1>urateam bootstrap</h1>" +
          "<p>GitHub App created! You can close this tab and return to the terminal.</p>" +
          "</body></html>",
      );

      settled = true;
      clearTimeout(timeout);
      server.close();

      // Exchange code for credentials.
      try {
        const exchangeResp = await fetchFn(
          `https://api.github.com/app-manifests/${code}/conversions`,
          {
            method: "POST",
            headers: {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
        );

        if (!exchangeResp.ok) {
          const body = await exchangeResp.text();
          reject(
            new Error(
              `GitHub App manifest exchange failed (HTTP ${exchangeResp.status}): ${body}`,
            ),
          );
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (await exchangeResp.json()) as any;
        resolve({
          appId: data.id as number,
          appName: (data.name as string) ?? "urateam",
          privateKey: data.pem as string,
          webhookSecret: (data.webhook_secret as string) ?? "",
          clientId: data.client_id as string,
          clientSecret: data.client_secret as string,
          htmlUrl: (data.html_url as string) ?? "",
        });
      } catch (err) {
        reject(err);
      }
    });

    server.listen(callbackPort, "127.0.0.1", () => {
      openFn(githubUrl);
    });

    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Callback server failed to start: ${err.message}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Step 3: Linear webhook registration
// ---------------------------------------------------------------------------

/**
 * Registers a webhook in the Linear workspace via the GraphQL API.
 *
 * The webhook is registered for `Issue` resource type events. If `teamId` is
 * supplied the webhook is scoped to that team; otherwise it applies
 * workspace-wide (requires admin privileges).
 *
 * @param apiKey     - Linear API key (starts with `lin_api_`).
 * @param webhookUrl - Publicly reachable URL for the webhook endpoint.
 * @param teamId     - Optional Linear team ID to scope the webhook.
 * @param deps       - Optional injectable dependencies (for testing).
 */
export async function registerLinearWebhook(
  apiKey: string,
  webhookUrl: string,
  teamId?: string,
  deps?: BootstrapDeps,
): Promise<void> {
  const fetchFn = getFetch(deps);

  const query = `
    mutation CreateWebhook($url: String!, $enabled: Boolean!, $teamId: String, $resourceTypes: [String!]!) {
      webhookCreate(input: {
        url: $url
        enabled: $enabled
        teamId: $teamId
        resourceTypes: $resourceTypes
      }) {
        success
        webhook {
          id
          url
        }
      }
    }
  `;

  const variables: Record<string, unknown> = {
    url: webhookUrl,
    enabled: true,
    resourceTypes: ["Issue"],
  };
  if (teamId) variables.teamId = teamId;

  const resp = await fetchFn("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Linear GraphQL request failed (HTTP ${resp.status}): ${body}`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await resp.json()) as any;

  if (data.errors?.length) {
    throw new Error(
      `Linear webhook registration failed: ${JSON.stringify(data.errors)}`,
    );
  }

  if (!data.data?.webhookCreate?.success) {
    throw new Error(
      `Linear webhook registration returned success=false: ${JSON.stringify(data.data)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Step 4: .env generation
// ---------------------------------------------------------------------------

/**
 * Generates a `.env` file in `outputDir` (default: `process.cwd()`) with all
 * required environment variables populated from `ctx`.
 *
 * @param ctx       - Bootstrap context containing all credential values.
 * @param outputDir - Directory to write `.env` to. Defaults to `process.cwd()`.
 * @param deps      - Optional injectable dependencies (for testing).
 */
export async function generateEnvFile(
  ctx: BootstrapContext,
  outputDir?: string,
  deps?: BootstrapDeps,
): Promise<void> {
  const writeFn = getWriteFile(deps);
  const dir = outputDir ?? process.cwd();

  // Escape private key newlines for a single-line .env value.
  const privateKeyEscaped = ctx.privateKey.replace(/\n/g, "\\n");

  const envContent = [
    "# urateam — generated by `ura bootstrap`",
    `# Generated: ${new Date().toISOString()}`,
    "",
    "# ── GitHub App ───────────────────────────────────────────────────────────",
    `GITHUB_APP_ID=${ctx.appId}`,
    `GITHUB_PRIVATE_KEY="${privateKeyEscaped}"`,
    `GITHUB_WEBHOOK_SECRET=${ctx.githubWebhookSecret}`,
    "",
    "# ── Linear ───────────────────────────────────────────────────────────────",
    `LINEAR_API_KEY=${ctx.linearApiKey}`,
    `LINEAR_WEBHOOK_SECRET=${ctx.linearWebhookSecret}`,
    "",
    "# ── Webhook URL ──────────────────────────────────────────────────────────",
    `WEBHOOK_URL=${ctx.webhookUrl}`,
    "",
    "# ── Database ─────────────────────────────────────────────────────────────",
    `DATABASE_URL=${ctx.databaseUrl ?? "file:/data/urateam.db"}`,
    "",
    "# ── Dashboard auth ───────────────────────────────────────────────────────",
    `DASHBOARD_USER=${ctx.dashboardUser ?? "admin"}`,
    `DASHBOARD_PASSWORD=${ctx.dashboardPassword ?? "changeme"}`,
    "",
    "# ── Claude ───────────────────────────────────────────────────────────────",
    "# Set ONE of the following:",
    "# ANTHROPIC_API_KEY=sk-ant-...",
    "# CLAUDE_CODE_OAUTH_TOKEN=...",
    "",
  ].join("\n");

  await writeFn(path.join(dir, ".env"), envContent, "utf8");
}

// ---------------------------------------------------------------------------
// Step 5: docker-compose generation
// ---------------------------------------------------------------------------

/**
 * Generates a `docker-compose.dogfood.yml` in `outputDir` with two services:
 *   - `app`       — webhook server on port 3000
 *   - `dashboard` — ops dashboard on port 3001
 *
 * Both services reference `env_file: .env` for all credentials.
 *
 * @param ctx       - Bootstrap context (used for documentation/comments only).
 * @param outputDir - Directory to write the compose file. Defaults to `process.cwd()`.
 * @param deps      - Optional injectable dependencies (for testing).
 */
export async function generateDockerCompose(
  ctx: BootstrapContext,
  outputDir?: string,
  deps?: BootstrapDeps,
): Promise<void> {
  const writeFn = getWriteFile(deps);
  const dir = outputDir ?? process.cwd();

  const composeContent = [
    "# urateam docker-compose — generated by `ura bootstrap`",
    `# Generated: ${new Date().toISOString()}`,
    "# Usage: docker compose -f docker-compose.dogfood.yml up -d",
    "",
    "services:",
    "  app:",
    "    image: ghcr.io/jonb32/urateam:latest",
    "    restart: unless-stopped",
    "    ports:",
    '      - "3000:3000"',
    "    env_file: .env",
    "    environment:",
    "      - PORT=3000",
    "    volumes:",
    '      - urateam_data:/data',
    "",
    "  dashboard:",
    "    image: ghcr.io/jonb32/urateam-dashboard:latest",
    "    restart: unless-stopped",
    "    ports:",
    '      - "3001:3001"',
    "    env_file: .env",
    "    environment:",
    "      - DASHBOARD_PORT=3001",
    `      - WEBHOOK_URL=${ctx.webhookUrl}`,
    "    volumes:",
    '      - urateam_data:/data',
    "    depends_on:",
    "      - app",
    "",
    "volumes:",
    "  urateam_data:",
    "",
  ].join("\n");

  await writeFn(path.join(dir, "docker-compose.dogfood.yml"), composeContent, "utf8");
}

// ---------------------------------------------------------------------------
// Step 6: Reverse-proxy config
// ---------------------------------------------------------------------------

/**
 * Generates reverse-proxy configuration for the given domain.
 *
 * For `"caddy"`:   writes a `Caddyfile` in `outputDir`.
 * For `"cloudflared"`: prints the `cloudflared tunnel` command to stdout
 *                       (no file is written — cloudflared uses its own config store).
 *
 * @param domain    - Fully-qualified domain name (e.g. `hooks.example.com`).
 * @param choice    - Proxy type: `"caddy"` or `"cloudflared"`.
 * @param outputDir - Directory to write generated files. Defaults to `process.cwd()`.
 * @param deps      - Optional injectable dependencies (for testing).
 */
export async function generateReverseProxyConfig(
  domain: string,
  choice: "caddy" | "cloudflared",
  outputDir?: string,
  deps?: BootstrapDeps,
): Promise<void> {
  const writeFn = getWriteFile(deps);
  const log = deps?.log ?? ((msg: string) => process.stdout.write(msg + "\n"));
  const dir = outputDir ?? process.cwd();

  if (choice === "caddy") {
    const caddyfile = [
      `# Caddyfile — generated by \`ura bootstrap\``,
      `# Usage: caddy run --config Caddyfile`,
      "",
      `${domain} {`,
      "  reverse_proxy localhost:3000",
      "}",
      "",
    ].join("\n");

    await writeFn(path.join(dir, "Caddyfile"), caddyfile, "utf8");
    log(`Caddyfile written to ${path.join(dir, "Caddyfile")}`);
  } else {
    // cloudflared: just print the command — no file to write.
    log("To expose port 3000 via Cloudflare Tunnel, run:");
    log(`  cloudflared tunnel --url http://localhost:3000`);
    log(
      "Then register your domain in the Cloudflare Zero Trust dashboard and " +
        "point it to the tunnel.",
    );
  }
}

// ---------------------------------------------------------------------------
// Step 7: Validation
// ---------------------------------------------------------------------------

/**
 * Validates the running stack by POSTing a synthetic Linear webhook to the
 * local webhook server. Polls every 2 seconds for up to `timeoutMs`
 * (default: 30 000 ms). Resolves on a 2xx response; throws on timeout.
 *
 * @param port      - Local webhook server port (default: 3000).
 * @param timeoutMs - Total time to wait in milliseconds (default: 30 000).
 * @param deps      - Optional injectable dependencies (for testing).
 */
export async function validateSetup(
  port = 3000,
  timeoutMs = 30_000,
  deps?: BootstrapDeps,
): Promise<void> {
  const fetchFn = getFetch(deps);
  const url = `http://localhost:${port}/webhooks/linear`;

  const syntheticPayload = JSON.stringify({
    action: "bootstrap-validation",
    type: "Issue",
    data: { id: "bootstrap-check", title: "bootstrap validation" },
  });

  const deadline = Date.now() + timeoutMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const resp = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: syntheticPayload,
      });

      if (resp.status >= 200 && resp.status < 300) {
        return; // Success!
      }
    } catch {
      // Connection refused — server not up yet, keep polling.
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Validation timed out after ${timeoutMs}ms.\n` +
          `The webhook server on port ${port} did not respond with a 2xx status.\n` +
          `Check 'docker compose logs app' for startup errors.`,
      );
    }

    // Wait 2 seconds before retrying.
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

// ---------------------------------------------------------------------------
// Interactive prompts helper
// ---------------------------------------------------------------------------

/**
 * Creates a readline interface and asks a single question.
 * Returns the trimmed answer. Closes the interface after.
 * @internal
 */
async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    const displayQuestion = defaultValue
      ? `${question} [${defaultValue}]: `
      : `${question}: `;
    rl.question(displayQuestion, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

/**
 * `ura bootstrap` — the Commander.js command object.
 *
 * Orchestrates the full self-hosted onboarding sequence in interactive mode.
 */
export const bootstrapCommand = new Command("bootstrap")
  .description(
    "One-command self-hosted onboarding: creates a GitHub App, registers a " +
      "Linear webhook, generates .env + docker-compose.dogfood.yml, and " +
      "optionally validates the running stack.",
  )
  .option("--skip-github-app", "Skip GitHub App creation (use APP_ID/PRIVATE_KEY from env)", false)
  .option("--skip-linear", "Skip Linear webhook registration", false)
  .option("--validate", "POST a synthetic webhook to confirm the stack is healthy", false)
  .option("--domain <domain>", "Domain for reverse-proxy config (e.g. hooks.example.com)")
  .option("--proxy <type>", "Reverse-proxy type: caddy or cloudflared", "caddy")
  .option("--output-dir <dir>", "Directory for generated files (default: cwd)")
  .option("--port <port>", "Webhook server port for validation", "3000")
  .action(async (opts: {
    skipGithubApp?: boolean;
    skipLinear?: boolean;
    validate?: boolean;
    domain?: string;
    proxy?: string;
    outputDir?: string;
    port?: string;
  }) => {
    const log = (msg: string) => console.log(msg);

    log("");
    log("╔══════════════════════════════════════════════════════════╗");
    log("║         urateam — Self-Hosted Bootstrap Wizard           ║");
    log("╚══════════════════════════════════════════════════════════╝");
    log("");

    // ── Step 1: Pre-flight checks ──────────────────────────────────────────
    log("[ 1/7 ] Running pre-flight checks...");
    try {
      await preflightChecks();
      log("        Pre-flight checks passed.");
    } catch (err) {
      console.error(`\nPre-flight check failed:\n  ${(err as Error).message}\n`);
      process.exit(1);
    }

    // ── Step 2: Interactive prompts ────────────────────────────────────────
    log("\n[ 2/7 ] Gathering configuration...");

    const org = await prompt(
      "GitHub organisation (leave blank for personal account)",
    );

    const linearApiKey =
      process.env.LINEAR_API_KEY ||
      (await prompt("Linear API key (lin_api_...)"));

    const linearTeamId =
      process.env.LINEAR_TEAM_ID ||
      (await prompt("Linear team ID (optional, leave blank for workspace-wide)")) ||
      undefined;

    let domain = opts.domain;
    if (!domain) {
      domain = await prompt(
        "Public domain for reverse-proxy config (leave blank to skip)",
      );
      if (!domain) domain = undefined;
    }

    let proxyType = opts.proxy as "caddy" | "cloudflared";
    if (domain && !opts.proxy) {
      const choice = await prompt("Reverse-proxy type (caddy/cloudflared)", "caddy");
      proxyType = choice === "cloudflared" ? "cloudflared" : "caddy";
    }

    // ── Step 3: GitHub App ─────────────────────────────────────────────────
    let appCredentials: GitHubAppCredentials | null = null;

    if (opts.skipGithubApp) {
      log("\n[ 3/7 ] Skipping GitHub App creation (--skip-github-app set).");
      const appIdStr =
        process.env.GITHUB_APP_ID ||
        (await prompt("GITHUB_APP_ID"));
      const privateKey =
        process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n") ||
        (await prompt("GITHUB_PRIVATE_KEY (PEM, newlines as \\n)"));
      const webhookSecret =
        process.env.GITHUB_WEBHOOK_SECRET ||
        (await prompt("GITHUB_WEBHOOK_SECRET"));

      appCredentials = {
        appId: parseInt(appIdStr, 10),
        appName: "urateam",
        privateKey,
        webhookSecret,
        clientId: process.env.GITHUB_CLIENT_ID ?? "",
        clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
        htmlUrl: "",
      };
    } else {
      log("\n[ 3/7 ] Creating GitHub App via manifest flow...");
      log("        A browser window will open. Complete the GitHub App creation there.");
      try {
        appCredentials = await createGitHubApp({ org: org || undefined });
        log(`        GitHub App "${appCredentials.appName}" created (ID: ${appCredentials.appId}).`);
      } catch (err) {
        console.error(`\nGitHub App creation failed:\n  ${(err as Error).message}\n`);
        process.exit(1);
      }
    }

    // ── Step 4: Linear webhook ─────────────────────────────────────────────
    const webhookUrl =
      domain ? `https://${domain}/webhooks/linear` : "https://PLACEHOLDER/webhooks/linear";

    const linearWebhookSecret = crypto.randomBytes(32).toString("hex");

    if (opts.skipLinear) {
      log("\n[ 4/7 ] Skipping Linear webhook registration (--skip-linear set).");
    } else {
      log(`\n[ 4/7 ] Registering Linear webhook at ${webhookUrl}...`);
      try {
        await registerLinearWebhook(linearApiKey, webhookUrl, linearTeamId);
        log("        Linear webhook registered.");
      } catch (err) {
        console.error(`\nLinear webhook registration failed:\n  ${(err as Error).message}\n`);
        process.exit(1);
      }
    }

    // ── Step 5: .env file ──────────────────────────────────────────────────
    log("\n[ 5/7 ] Generating .env...");
    // appCredentials is always set here — both branches of the skip/create flow
    // either assign it or call process.exit(1).
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const resolvedCreds = appCredentials!;
    const ctx: BootstrapContext = {
      appId: resolvedCreds.appId,
      privateKey: resolvedCreds.privateKey,
      githubWebhookSecret: resolvedCreds.webhookSecret,
      linearApiKey,
      linearWebhookSecret,
      webhookUrl,
    };
    try {
      await generateEnvFile(ctx, opts.outputDir);
      const envPath = path.join(opts.outputDir ?? process.cwd(), ".env");
      log(`        Written: ${envPath}`);
    } catch (err) {
      console.error(`\nFailed to write .env:\n  ${(err as Error).message}\n`);
      process.exit(1);
    }

    // ── Step 6: docker-compose ─────────────────────────────────────────────
    log("\n[ 6/7 ] Generating docker-compose.dogfood.yml...");
    try {
      await generateDockerCompose(ctx, opts.outputDir);
      const composePath = path.join(opts.outputDir ?? process.cwd(), "docker-compose.dogfood.yml");
      log(`        Written: ${composePath}`);
    } catch (err) {
      console.error(`\nFailed to write docker-compose.dogfood.yml:\n  ${(err as Error).message}\n`);
      process.exit(1);
    }

    // Reverse-proxy config.
    if (domain) {
      log(`\n        Generating ${proxyType} config for ${domain}...`);
      try {
        await generateReverseProxyConfig(domain, proxyType, opts.outputDir);
      } catch (err) {
        console.error(`\nFailed to generate proxy config:\n  ${(err as Error).message}\n`);
        // Non-fatal — user can set up proxy manually.
      }
    }

    // ── Step 7: Validation ─────────────────────────────────────────────────
    const port = parseInt(opts.port ?? "3000", 10);
    if (opts.validate) {
      log(`\n[ 7/7 ] Validating stack on port ${port}...`);
      log("        Waiting for the webhook server to start (up to 30s)...");
      try {
        await validateSetup(port);
        log("        Validation passed — the webhook server is healthy.");
      } catch (err) {
        console.error(`\nValidation failed:\n  ${(err as Error).message}\n`);
        // Non-fatal — stack may just need a moment.
      }
    } else {
      log("\n[ 7/7 ] Skipping validation (pass --validate to enable).");
    }

    // ── Success banner ─────────────────────────────────────────────────────
    log("");
    log("╔══════════════════════════════════════════════════════════╗");
    log("║                   Bootstrap complete!                    ║");
    log("╚══════════════════════════════════════════════════════════╝");
    log("");
    log("Next steps:");
    log("  1. Review .env and add your Claude credential:");
    log("       ANTHROPIC_API_KEY=sk-ant-...  (API key, pay-per-token)");
    log("       CLAUDE_CODE_OAUTH_TOKEN=...   (subscription, run: claude setup-token)");
    log("");
    log("  2. Start the stack:");
    log("       docker compose -f docker-compose.dogfood.yml up -d");
    log("");
    if (domain) {
      log(`  3. Set your webhook URL in Linear to:`);
      log(`       https://${domain}/webhooks/linear`);
    } else {
      log("  3. Expose port 3000 via ngrok or your proxy, then update WEBHOOK_URL");
      log("     in .env and your Linear webhook settings.");
    }
    log("");
    log("  4. Move a Linear issue to 'Todo' to trigger your first pipeline run.");
    log("");
  });

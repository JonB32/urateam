/**
 * End-to-end tests for `ura bootstrap`.
 *
 * These tests use real temp directories and real file-system writes, but mock
 * all external APIs (GitHub, Linear) and child-process calls so no network
 * traffic or Docker is required.
 *
 * The "e2e" label reflects that we test the full bootstrap flow (all steps
 * chained together) rather than individual functions in isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  preflightChecks,
  registerLinearWebhook,
  generateEnvFile,
  generateDockerCompose,
  generateReverseProxyConfig,
  validateSetup,
  type BootstrapContext,
  type ExecFileFn,
} from "../commands/bootstrap.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCtx(): BootstrapContext {
  return {
    appId: 99999,
    privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n",
    githubWebhookSecret: "gh_webhook_secret",
    linearApiKey: "lin_api_e2e_test",
    linearWebhookSecret: "linear_webhook_secret_e2e",
    webhookUrl: "https://hooks.e2e.example.com",
    databaseUrl: "file:/data/urateam.db",
    dashboardUser: "admin",
    dashboardPassword: "testpassword",
  };
}

// ---------------------------------------------------------------------------
// Full flow — file generation
// ---------------------------------------------------------------------------

describe("Bootstrap e2e — file generation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ura-e2e-bootstrap-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("generateEnvFile writes a well-formed .env to the temp directory", async () => {
    const ctx = makeCtx();
    await generateEnvFile(ctx, tmpDir);

    const content = await fs.readFile(path.join(tmpDir, ".env"), "utf8");
    expect(content).toContain("GITHUB_APP_ID=99999");
    expect(content).toContain("LINEAR_API_KEY=lin_api_e2e_test");
    expect(content).toContain("LINEAR_WEBHOOK_SECRET=linear_webhook_secret_e2e");
    expect(content).toContain("GITHUB_WEBHOOK_SECRET=gh_webhook_secret");
    expect(content).toContain("WEBHOOK_URL=https://hooks.e2e.example.com");
    expect(content).toContain("DATABASE_URL=file:/data/urateam.db");
    expect(content).toContain("DASHBOARD_USER=admin");
    expect(content).toContain("DASHBOARD_PASSWORD=testpassword");
    // Private key newlines should be escaped.
    expect(content).toContain("GITHUB_PRIVATE_KEY=");
    expect(content).toContain("\\n");
  });

  it("generateDockerCompose writes a valid docker-compose.yml in consumer mode (default)", async () => {
    const ctx = makeCtx();
    await generateDockerCompose(ctx, tmpDir);

    const content = await fs.readFile(
      path.join(tmpDir, "docker-compose.yml"),
      "utf8",
    );

    expect(content).toContain("services:");
    expect(content).toContain("app:");
    expect(content).toContain("dashboard:");
    expect(content).toContain("3000:3000");
    expect(content).toContain("3001:3001");
    expect(content).toContain("PORT=3000");
    expect(content).toContain("DASHBOARD_PORT=3001");
    expect(content).toContain("env_file: .env");
    expect(content).toContain("urateam_data:");
    expect(content).toContain("depends_on:");
    // Consumer mode uses plain docker compose up -d, no -f flag needed.
    expect(content).toContain("docker compose up -d");
  });

  it("generateDockerCompose writes docker-compose.dogfood.yml in dogfood mode", async () => {
    const ctx = makeCtx();
    await generateDockerCompose(ctx, tmpDir, undefined, true);

    const content = await fs.readFile(
      path.join(tmpDir, "docker-compose.dogfood.yml"),
      "utf8",
    );

    expect(content).toContain("services:");
    expect(content).toContain("docker-compose.dogfood.yml");
  });

  it("generateDockerCompose uses custom ports from ctx", async () => {
    const ctx = { ...makeCtx(), appPort: 3010, dashboardPort: 3011 };
    await generateDockerCompose(ctx, tmpDir);

    const content = await fs.readFile(
      path.join(tmpDir, "docker-compose.dogfood.yml"),
      "utf8",
    );

    expect(content).toContain("3010:3000");
    expect(content).toContain("3011:3001");
    expect(content).toContain("PORT=3010");
    expect(content).toContain("DASHBOARD_PORT=3011");
    // Must NOT use defaults in host-side mappings.
    expect(content).not.toContain('"3000:3000"');
    expect(content).not.toContain('"3001:3001"');
  });

  it("generateReverseProxyConfig writes a Caddyfile for 'caddy' with default port", async () => {
    await generateReverseProxyConfig("hooks.example.com", "caddy", tmpDir);

    const content = await fs.readFile(path.join(tmpDir, "Caddyfile"), "utf8");
    expect(content).toContain("hooks.example.com");
    expect(content).toContain("reverse_proxy localhost:3000");
  });

  it("generateReverseProxyConfig writes Caddyfile with custom appPort", async () => {
    await generateReverseProxyConfig("hooks.example.com", "caddy", tmpDir, undefined, 3010);

    const content = await fs.readFile(path.join(tmpDir, "Caddyfile"), "utf8");
    expect(content).toContain("reverse_proxy localhost:3010");
    expect(content).not.toContain("localhost:3000");
  });

  it("generateReverseProxyConfig does not write a file for 'cloudflared'", async () => {
    const logs: string[] = [];
    await generateReverseProxyConfig("hooks.example.com", "cloudflared", tmpDir, {
      log: (m) => logs.push(m),
    });

    // No Caddyfile.
    await expect(
      fs.access(path.join(tmpDir, "Caddyfile")),
    ).rejects.toThrow();

    // But the cloudflared command is printed with the default port.
    const allLogs = logs.join("\n");
    expect(allLogs).toContain("cloudflared");
    expect(allLogs).toContain("localhost:3000");
  });

  it("generateReverseProxyConfig prints custom port for 'cloudflared'", async () => {
    const logs: string[] = [];
    await generateReverseProxyConfig("hooks.example.com", "cloudflared", tmpDir, {
      log: (m) => logs.push(m),
    }, 3010);

    const allLogs = logs.join("\n");
    expect(allLogs).toContain("localhost:3010");
    expect(allLogs).not.toContain("localhost:3000");
  });

  it("all three output files coexist in the same output directory (consumer mode)", async () => {
    const ctx = makeCtx();
    const logs: string[] = [];

    await generateEnvFile(ctx, tmpDir);
    await generateDockerCompose(ctx, tmpDir);
    await generateReverseProxyConfig("hooks.example.com", "caddy", tmpDir, {
      log: (m) => logs.push(m),
    });

    const files = await fs.readdir(tmpDir);
    expect(files).toContain(".env");
    expect(files).toContain("docker-compose.yml");
    expect(files).not.toContain("docker-compose.dogfood.yml");
    expect(files).toContain("Caddyfile");
  });
});

// ---------------------------------------------------------------------------
// Pre-flight checks — with mocked execFile
// ---------------------------------------------------------------------------

describe("Bootstrap e2e — preflightChecks with mocked execFile", () => {
  /** Avoids real TCP port checks so the test is not sensitive to port availability. */
  const portsAlwaysFree = async (_port: number): Promise<boolean> => true;

  it("passes with all tools mocked as present", async () => {
    const ef: ExecFileFn = (_file, _args, callback) => {
      callback(null, "ok", "");
    };
    await expect(preflightChecks({ execFile: ef, isPortFree: portsAlwaysFree })).resolves.toBeUndefined();
  });

  it("fails fast when docker is unavailable", async () => {
    const ef: ExecFileFn = (file, _args, callback) => {
      if (file === "docker") {
        callback(new Error("docker: command not found"), "", "");
      } else {
        callback(null, "ok", "");
      }
    };
    await expect(preflightChecks({ execFile: ef, isPortFree: portsAlwaysFree })).rejects.toThrow(/docker/i);
  });
});

// ---------------------------------------------------------------------------
// Linear webhook registration — with mocked fetch
// ---------------------------------------------------------------------------

describe("Bootstrap e2e — registerLinearWebhook with mocked fetch", () => {
  it("sends correct Authorization header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { webhookCreate: { success: true, webhook: { id: "wh-e2e", url: "https://x.com" } } },
      }),
      text: async () => "",
    });

    await registerLinearWebhook(
      "lin_api_e2e",
      "https://hooks.e2e.example.com/webhooks/linear",
      "team_e2e",
      undefined,
      { fetch: mockFetch as typeof fetch },
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("lin_api_e2e");
  });

  it("includes the webhookUrl and teamId in the GraphQL variables", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { webhookCreate: { success: true, webhook: { id: "wh-e2e", url: "https://x.com" } } },
      }),
      text: async () => "",
    });

    await registerLinearWebhook(
      "lin_api_e2e",
      "https://hooks.e2e.example.com/webhooks/linear",
      "team_e2e",
      undefined,
      { fetch: mockFetch as typeof fetch },
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.variables.url).toBe("https://hooks.e2e.example.com/webhooks/linear");
    expect(body.variables.teamId).toBe("team_e2e");
    expect(body.variables.resourceTypes).toContain("Issue");
  });
});

// ---------------------------------------------------------------------------
// validateSetup — e2e with mocked fetch
// ---------------------------------------------------------------------------

describe("Bootstrap e2e — validateSetup", () => {
  it("resolves immediately when the server is healthy", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    await expect(
      validateSetup(3000, 5_000, { fetch: mockFetch as typeof fetch }),
    ).resolves.toBeUndefined();
  });

  it("throws with a helpful message on timeout", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      validateSetup(3000, 50, { fetch: mockFetch as typeof fetch }),
    ).rejects.toThrow(/timed out/i);
  });
});

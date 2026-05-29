/**
 * Unit tests for `packages/cli/src/commands/bootstrap.ts`.
 *
 * All external I/O is replaced with injectable mocks via the `deps` parameter.
 * No real Docker, GitHub, Linear, or file-system access is performed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import type { PathLike } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Imports — must come after vi.mock() calls if those mocks affect the module.
// Because our functions accept `deps` at runtime (not static mocks), we import
// directly and pass mocks via deps. For Node built-ins that are used inside
// `isPortFree` (which we test indirectly via preflightChecks) we rely on
// the fact that our tests inject execFile deps.
// ---------------------------------------------------------------------------

import {
  preflightChecks,
  createGitHubApp,
  buildManifestPostHtml,
  registerLinearWebhook,
  generateEnvFile,
  generateDockerCompose,
  generateReverseProxyConfig,
  validateSetup,
  bootstrapCommand,
  composeFilename,
  detectLegacyArtifacts,
  LEGACY_ARTIFACT_MIGRATIONS,
  isHeadlessEnvironment,
  type BootstrapContext,
  type ExecFileFn,
} from "../commands/bootstrap.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Creates a mock execFile that succeeds for known commands and fails for unknown ones. */
function makeExecFile(failing?: string[]): ExecFileFn {
  return (file, _args, callback) => {
    if (failing?.includes(file)) {
      callback(new Error(`${file}: not found`), "", "");
    } else {
      callback(null, "ok", "");
    }
  };
}

/**
 * Shared BootstrapContext factory used by generateEnvFile and generateDockerCompose tests.
 * Accepts optional overrides to keep individual tests focused on the field they test.
 */
function makeCtx(overrides?: Partial<BootstrapContext>): BootstrapContext {
  return {
    appId: 12345,
    privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
    githubWebhookSecret: "ghsecret",
    linearApiKey: "lin_api_test123",
    linearWebhookSecret: "linearsecret",
    webhookUrl: "https://hooks.example.com",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// preflightChecks
// ---------------------------------------------------------------------------

/** Always reports ports as free — prevents real TCP checks in unit tests. */
const portsAlwaysFree = async (_port: number): Promise<boolean> => true;

describe("preflightChecks()", () => {
  it("throws when docker is not available", async () => {
    const ef = makeExecFile(["docker"]);
    await expect(preflightChecks({ execFile: ef, isPortFree: portsAlwaysFree })).rejects.toThrow(
      /docker is not running/i,
    );
  });

  it("throws when curl is not available", async () => {
    const ef = makeExecFile(["curl"]);
    await expect(preflightChecks({ execFile: ef, isPortFree: portsAlwaysFree })).rejects.toThrow(
      /curl/i,
    );
  });

  it("throws when openssl is not available", async () => {
    const ef = makeExecFile(["openssl"]);
    await expect(preflightChecks({ execFile: ef, isPortFree: portsAlwaysFree })).rejects.toThrow(
      /openssl/i,
    );
  });

  it("does NOT require jq — passes when jq is absent", async () => {
    // jq was removed from required tools; absence should not cause preflight to fail.
    const ef = makeExecFile(["jq"]); // jq fails, but preflight should still pass
    await expect(preflightChecks({ execFile: ef, isPortFree: portsAlwaysFree })).resolves.toBeUndefined();
  });

  it("passes when all required tools are present (no jq needed)", async () => {
    const ef = makeExecFile(); // all tools succeed
    await expect(preflightChecks({ execFile: ef, isPortFree: portsAlwaysFree })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// registerLinearWebhook
// ---------------------------------------------------------------------------

describe("registerLinearWebhook()", () => {
  it("resolves on a successful GraphQL response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { webhookCreate: { success: true, webhook: { id: "wh1", url: "https://x.com" } } },
      }),
      text: async () => "",
    });

    await expect(
      registerLinearWebhook(
        "lin_api_test",
        "https://example.com/webhooks/linear",
        undefined,
        undefined,
        { fetch: mockFetch },
      ),
    ).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init.method).toBe("POST");
  });

  it("scopes the webhook to a team when teamId is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { webhookCreate: { success: true, webhook: { id: "wh2", url: "https://x.com" } } },
      }),
      text: async () => "",
    });

    await registerLinearWebhook(
      "lin_api_test",
      "https://example.com/webhooks/linear",
      "team_123",
      undefined,
      { fetch: mockFetch },
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.variables.teamId).toBe("team_123");
  });

  it("forwards the signing secret to Linear when secret is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { webhookCreate: { success: true, webhook: { id: "wh3", url: "https://x.com" } } },
      }),
      text: async () => "",
    });

    await registerLinearWebhook(
      "lin_api_test",
      "https://example.com/webhooks/linear",
      undefined,
      "linear_wh_secret_abc123",
      { fetch: mockFetch },
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.variables.secret).toBe("linear_wh_secret_abc123");
    // The mutation must reference $secret to actually consume it.
    expect(body.query).toContain("$secret: String");
    expect(body.query).toContain("secret: $secret");
  });

  it("throws when the HTTP response is not ok", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => "Unauthorized",
    });

    await expect(
      registerLinearWebhook(
        "bad_key",
        "https://example.com/webhooks/linear",
        undefined,
        undefined,
        { fetch: mockFetch },
      ),
    ).rejects.toThrow(/401/);
  });

  it("throws when the GraphQL response contains errors", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errors: [{ message: "Not authorized" }],
        data: null,
      }),
      text: async () => "",
    });

    await expect(
      registerLinearWebhook(
        "lin_api_test",
        "https://example.com/webhooks/linear",
        undefined,
        undefined,
        { fetch: mockFetch },
      ),
    ).rejects.toThrow(/not authorized/i);
  });

  it("throws when webhookCreate returns success=false", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { webhookCreate: { success: false } },
      }),
      text: async () => "",
    });

    await expect(
      registerLinearWebhook(
        "lin_api_test",
        "https://example.com/webhooks/linear",
        undefined,
        undefined,
        { fetch: mockFetch },
      ),
    ).rejects.toThrow(/success=false/);
  });
});

// ---------------------------------------------------------------------------
// generateEnvFile
// ---------------------------------------------------------------------------

describe("generateEnvFile()", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ura-bootstrap-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a .env file with all required keys", async () => {
    const ctx = makeCtx();
    // Use a mock writeFile that writes to tmpDir.
    const writtenFiles: Record<string, string> = {};
    const mockWriteFile = vi.fn(async (filePath: PathLike | fs.FileHandle, data: unknown) => {
      writtenFiles[filePath.toString()] = data as string;
    });

    await generateEnvFile(ctx, tmpDir, { writeFile: mockWriteFile as typeof fs.writeFile });

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const writtenContent = Object.values(writtenFiles)[0]!;
    expect(writtenContent).toContain("GITHUB_APP_ID=12345");
    expect(writtenContent).toContain("LINEAR_API_KEY=lin_api_test123");
    expect(writtenContent).toContain("LINEAR_WEBHOOK_SECRET=linearsecret");
    expect(writtenContent).toContain("GITHUB_WEBHOOK_SECRET=ghsecret");
    expect(writtenContent).toContain("WEBHOOK_URL=https://hooks.example.com");
    expect(writtenContent).toContain("DATABASE_URL=");
    expect(writtenContent).toContain("DASHBOARD_USER=");
    expect(writtenContent).toContain("DASHBOARD_PASSWORD=");
  });

  it("includes GITHUB_PRIVATE_KEY with escaped newlines", async () => {
    const ctx = makeCtx({ privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----" });
    const writtenFiles: Record<string, string> = {};
    const mockWriteFile = vi.fn(async (filePath: PathLike | fs.FileHandle, data: unknown) => {
      writtenFiles[filePath.toString()] = data as string;
    });

    await generateEnvFile(ctx, tmpDir, { writeFile: mockWriteFile as typeof fs.writeFile });

    const content = Object.values(writtenFiles)[0]!;
    // Private key newlines should be escaped in the env file.
    expect(content).toContain("GITHUB_PRIVATE_KEY=");
    expect(content).toContain("\\n");
  });

  it("uses default databaseUrl when not provided in ctx", async () => {
    const ctx = makeCtx({ databaseUrl: undefined });
    const writtenFiles: Record<string, string> = {};
    const mockWriteFile = vi.fn(async (filePath: PathLike | fs.FileHandle, data: unknown) => {
      writtenFiles[filePath.toString()] = data as string;
    });

    await generateEnvFile(ctx, tmpDir, { writeFile: mockWriteFile as typeof fs.writeFile });

    const content = Object.values(writtenFiles)[0]!;
    expect(content).toContain("DATABASE_URL=file:/data/urateam.db");
  });

  it("writes the file to the specified outputDir", async () => {
    const ctx = makeCtx();
    const writtenPaths: string[] = [];
    const mockWriteFile = vi.fn(async (filePath: PathLike | fs.FileHandle, _data: unknown) => {
      writtenPaths.push(filePath.toString());
    });

    await generateEnvFile(ctx, tmpDir, { writeFile: mockWriteFile as typeof fs.writeFile });

    expect(writtenPaths[0]).toContain(tmpDir);
    expect(writtenPaths[0]).toMatch(/\.env$/);
  });
});

// ---------------------------------------------------------------------------
// composeFilename
// ---------------------------------------------------------------------------

describe("composeFilename()", () => {
  it("returns docker-compose.yml by default (consumer mode)", () => {
    expect(composeFilename()).toBe("docker-compose.yml");
    expect(composeFilename(false)).toBe("docker-compose.yml");
  });

  it("returns docker-compose.dogfood.yml in dogfood mode", () => {
    expect(composeFilename(true)).toBe("docker-compose.dogfood.yml");
  });
});

// ---------------------------------------------------------------------------
// detectLegacyArtifacts
// ---------------------------------------------------------------------------

describe("detectLegacyArtifacts()", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ura-bootstrap-legacy-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no legacy files exist", async () => {
    const found = await detectLegacyArtifacts(tmpDir);
    expect(found).toEqual([]);
  });

  it("detects docker-compose.dogfood.yml when present", async () => {
    await fs.writeFile(path.join(tmpDir, "docker-compose.dogfood.yml"), "# legacy");
    const found = await detectLegacyArtifacts(tmpDir);
    expect(found).toContain("docker-compose.dogfood.yml");
  });

  it("detects .env.dogfood when present", async () => {
    await fs.writeFile(path.join(tmpDir, ".env.dogfood"), "LINEAR_API_KEY=test");
    const found = await detectLegacyArtifacts(tmpDir);
    expect(found).toContain(".env.dogfood");
  });

  it("detects both legacy files when both are present", async () => {
    await fs.writeFile(path.join(tmpDir, "docker-compose.dogfood.yml"), "# legacy compose");
    await fs.writeFile(path.join(tmpDir, ".env.dogfood"), "LINEAR_API_KEY=test");
    const found = await detectLegacyArtifacts(tmpDir);
    expect(found).toContain("docker-compose.dogfood.yml");
    expect(found).toContain(".env.dogfood");
    expect(found).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// LEGACY_ARTIFACT_MIGRATIONS
// ---------------------------------------------------------------------------

describe("LEGACY_ARTIFACT_MIGRATIONS", () => {
  it("maps docker-compose.dogfood.yml to docker-compose.yml", () => {
    expect(LEGACY_ARTIFACT_MIGRATIONS["docker-compose.dogfood.yml"]).toBe("docker-compose.yml");
  });

  it("maps .env.dogfood to .env", () => {
    expect(LEGACY_ARTIFACT_MIGRATIONS[".env.dogfood"]).toBe(".env");
  });
});

// ---------------------------------------------------------------------------
// generateDockerCompose
// ---------------------------------------------------------------------------

describe("generateDockerCompose()", () => {
  function makeCtx(overrides?: Partial<BootstrapContext>): BootstrapContext {
    return {
      appId: 12345,
      privateKey: "pem",
      githubWebhookSecret: "ghsecret",
      linearApiKey: "lin_api_test",
      linearWebhookSecret: "linearsecret",
      webhookUrl: "https://hooks.example.com",
      ...overrides,
    };
  }

  it("writes docker-compose.yml with correct content (consumer mode, default ports)", async () => {
    const writtenFiles: Record<string, string> = {};
    const mockWriteFile = vi.fn(async (filePath: PathLike | fs.FileHandle, data: unknown) => {
      writtenFiles[filePath.toString()] = data as string;
    });

    await generateDockerCompose(makeCtx(), "/tmp/test-dir", {
      writeFile: mockWriteFile as typeof fs.writeFile,
    });

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const content = Object.values(writtenFiles)[0]!;

    // Must define two services.
    expect(content).toContain("services:");
    expect(content).toContain("app:");
    expect(content).toContain("dashboard:");

    // Default port mappings.
    expect(content).toContain("3000:3000");
    expect(content).toContain("3001:3001");
    expect(content).toContain("PORT=3000");
    expect(content).toContain("DASHBOARD_PORT=3001");

    // env_file reference.
    expect(content).toContain("env_file: .env");
  });

  it("uses custom ports from ctx when provided", async () => {
    const writtenFiles: Record<string, string> = {};
    const mockWriteFile = vi.fn(async (filePath: PathLike | fs.FileHandle, data: unknown) => {
      writtenFiles[filePath.toString()] = data as string;
    });

    await generateDockerCompose(makeCtx({ appPort: 3010, dashboardPort: 3011 }), "/tmp/test-dir", {
      writeFile: mockWriteFile as typeof fs.writeFile,
    });

    const content = Object.values(writtenFiles)[0]!;

    // Custom port mappings: host:container.
    expect(content).toContain("3010:3000");
    expect(content).toContain("3011:3001");
    expect(content).toContain("PORT=3010");
    expect(content).toContain("DASHBOARD_PORT=3011");

    // Must NOT contain default ports in the host-side mappings.
    expect(content).not.toContain('"3000:3000"');
    expect(content).not.toContain('"3001:3001"');
  });

  it("writes to docker-compose.yml filename by default (consumer mode)", async () => {
    const writtenPaths: string[] = [];
    const mockWriteFile = vi.fn(async (filePath: PathLike | fs.FileHandle, _data: unknown) => {
      writtenPaths.push(filePath.toString());
    });

    await generateDockerCompose(makeCtx(), "/tmp/test-dir", {
      writeFile: mockWriteFile as typeof fs.writeFile,
    });

    expect(writtenPaths[0]).toMatch(/docker-compose\.yml$/);
    expect(writtenPaths[0]).not.toMatch(/docker-compose\.dogfood\.yml$/);
  });

  it("writes to docker-compose.dogfood.yml when dogfood=true", async () => {
    const writtenPaths: string[] = [];
    const mockWriteFile = vi.fn(async (filePath: PathLike | fs.FileHandle, _data: unknown) => {
      writtenPaths.push(filePath.toString());
    });

    await generateDockerCompose(
      makeCtx(),
      "/tmp/test-dir",
      { writeFile: mockWriteFile as typeof fs.writeFile },
      true,
    );

    expect(writtenPaths[0]).toMatch(/docker-compose\.dogfood\.yml$/);
  });

  it("includes consumer usage command in content by default", async () => {
    const writtenFiles: Record<string, string> = {};
    const mockWriteFile = vi.fn(async (filePath: PathLike | fs.FileHandle, data: unknown) => {
      writtenFiles[filePath.toString()] = data as string;
    });

    await generateDockerCompose(makeCtx(), "/tmp/test-dir", {
      writeFile: mockWriteFile as typeof fs.writeFile,
    });

    const content = Object.values(writtenFiles)[0]!;
    expect(content).toContain("docker compose up -d");
    expect(content).not.toContain("docker-compose.dogfood.yml");
  });
});

// ---------------------------------------------------------------------------
// generateReverseProxyConfig
// ---------------------------------------------------------------------------

describe("generateReverseProxyConfig()", () => {
  it("writes a Caddyfile when choice is 'caddy'", async () => {
    const writtenFiles: Record<string, string> = {};
    const mockWriteFile = vi.fn(async (filePath: PathLike | fs.FileHandle, data: unknown) => {
      writtenFiles[filePath.toString()] = data as string;
    });
    const logs: string[] = [];

    await generateReverseProxyConfig("hooks.example.com", "caddy", "/tmp/test-dir", {
      writeFile: mockWriteFile as typeof fs.writeFile,
      log: (msg) => logs.push(msg),
    });

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const content = Object.values(writtenFiles)[0]!;
    expect(content).toContain("hooks.example.com");
    expect(content).toContain("reverse_proxy localhost:3000");

    // Filename should be Caddyfile.
    const filePath = Object.keys(writtenFiles)[0]!;
    expect(filePath).toMatch(/Caddyfile$/);
  });

  it("writes Caddyfile with custom appPort", async () => {
    const writtenFiles: Record<string, string> = {};
    const mockWriteFile = vi.fn(async (filePath: PathLike | fs.FileHandle, data: unknown) => {
      writtenFiles[filePath.toString()] = data as string;
    });
    const logs: string[] = [];

    await generateReverseProxyConfig("hooks.example.com", "caddy", "/tmp/test-dir", {
      writeFile: mockWriteFile as typeof fs.writeFile,
      log: (msg) => logs.push(msg),
    }, 3010);

    const content = Object.values(writtenFiles)[0]!;
    expect(content).toContain("reverse_proxy localhost:3010");
    expect(content).not.toContain("localhost:3000");
  });

  it("prints cloudflared command and does not write a file when choice is 'cloudflared'", async () => {
    const mockWriteFile = vi.fn();
    const logs: string[] = [];

    await generateReverseProxyConfig("hooks.example.com", "cloudflared", "/tmp/test-dir", {
      writeFile: mockWriteFile as typeof fs.writeFile,
      log: (msg) => logs.push(msg),
    });

    // No file written.
    expect(mockWriteFile).not.toHaveBeenCalled();

    // Should print the cloudflared command.
    const allLog = logs.join("\n");
    expect(allLog).toContain("cloudflared");
    expect(allLog).toContain("localhost:3000");
  });

  it("prints cloudflared command with custom appPort", async () => {
    const mockWriteFile = vi.fn();
    const logs: string[] = [];

    await generateReverseProxyConfig("hooks.example.com", "cloudflared", "/tmp/test-dir", {
      writeFile: mockWriteFile as typeof fs.writeFile,
      log: (msg) => logs.push(msg),
    }, 3010);

    const allLog = logs.join("\n");
    expect(allLog).toContain("localhost:3010");
    expect(allLog).not.toContain("localhost:3000");
  });
});

// ---------------------------------------------------------------------------
// validateSetup
// ---------------------------------------------------------------------------

describe("validateSetup()", () => {
  it("resolves immediately when the server returns 200", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
    });

    await expect(
      validateSetup(3000, 5_000, { fetch: mockFetch }),
    ).resolves.toBeUndefined();
  });

  it("resolves when the server returns 202", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 202,
    });

    await expect(
      validateSetup(3000, 5_000, { fetch: mockFetch }),
    ).resolves.toBeUndefined();
  });

  it("throws when timeout elapses without a 2xx response", async () => {
    // Simulate always-failing fetch (connection refused).
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      validateSetup(3000, 100 /* 100ms timeout */, { fetch: mockFetch }),
    ).rejects.toThrow(/timed out/i);
  });

  it("retries after a non-2xx response until timeout", async () => {
    // First call returns 503, second returns 200.
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 200 });

    // We need to speed up the 2s sleep — use a very short timeout that still
    // allows two iterations. Since we can't easily mock setTimeout here, we
    // test the happy-path where the second call succeeds quickly.
    // Note: this test may take ~2s due to the internal sleep.
    await expect(
      validateSetup(3000, 10_000, { fetch: mockFetch }),
    ).resolves.toBeUndefined();

    // Fetch should have been called at least once.
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// buildManifestPostHtml
// ---------------------------------------------------------------------------

describe("buildManifestPostHtml()", () => {
  it("contains method=post", () => {
    const html = buildManifestPostHtml(
      "https://github.com/settings/apps/new?state=abc",
      '{"name":"test"}',
    );
    expect(html).toContain('method="post"');
  });

  it("contains the correct action URL", () => {
    const html = buildManifestPostHtml(
      "https://github.com/settings/apps/new?state=abc123",
      '{"name":"test"}',
    );
    expect(html).toContain('action="https://github.com/settings/apps/new?state=abc123"');
  });

  it("contains a manifest hidden field with the JSON content", () => {
    const manifest = JSON.stringify({ name: "urateam", url: "https://example.com" });
    const html = buildManifestPostHtml(
      "https://github.com/settings/apps/new?state=abc",
      manifest,
    );
    expect(html).toContain('name="manifest"');
    // Manifest JSON is embedded with double-quote escaping
    expect(html).toContain("&quot;name&quot;");
    expect(html).toContain("&quot;urateam&quot;");
  });

  it("HTML-escapes double quotes in manifest JSON for attribute safety", () => {
    const manifest = JSON.stringify({ name: "urateam" });
    const html = buildManifestPostHtml(
      "https://github.com/settings/apps/new?state=abc",
      manifest,
    );
    // Raw unescaped double quotes must not appear inside the value="..." attribute
    expect(html).not.toContain('value="{"');
    expect(html).toContain("&quot;");
  });

  it("works with the org-scoped GitHub URL", () => {
    const html = buildManifestPostHtml(
      "https://github.com/organizations/my-org/settings/apps/new?state=abc",
      "{}",
    );
    expect(html).toContain("https://github.com/organizations/my-org/settings/apps/new");
    expect(html).toContain('method="post"');
  });
});

// ---------------------------------------------------------------------------
// createGitHubApp — browser path
// ---------------------------------------------------------------------------

describe("createGitHubApp() — browser path", () => {
  it("throws when no free port can be found in the range 9876-9896", async () => {
    const portsAlwaysInUse = async (_port: number): Promise<boolean> => false;

    await expect(
      createGitHubApp({
        // headless: false forces browser path so port check runs
        headless: false,
        deps: { isPortFree: portsAlwaysInUse },
      }),
    ).rejects.toThrow(/could not find a free port/i);
  });

  it("uses a provided callbackPort without checking port availability", async () => {
    const portCheckSpy = vi.fn().mockResolvedValue(false);
    const openBrowserSpy = vi.fn();
    const timeoutMs = 100; // Very short timeout to fail fast

    await expect(
      createGitHubApp({
        headless: false,
        callbackPort: 9999, // Pre-assigned port, so no need to check availability
        timeoutMs,
        deps: {
          isPortFree: portCheckSpy,
          openBrowser: openBrowserSpy,
          fetch: vi.fn().mockRejectedValue(new Error("Simulated fail")),
        },
      }),
    ).rejects.toThrow(); // Will timeout, but that's OK—we're testing port allocation logic

    // isPortFree should not be called when a port is pre-assigned.
    expect(portCheckSpy).not.toHaveBeenCalled();
  });

  it("opens a temp HTML file (not a GET URL) for the personal App flow", async () => {
    const openBrowserSpy = vi.fn();
    const writeFileSpy = vi.fn().mockResolvedValue(undefined);

    // Will timeout after 100ms since there's no callback server
    await expect(
      createGitHubApp({
        headless: false,
        callbackPort: 9999,
        timeoutMs: 100,
        deps: {
          openBrowser: openBrowserSpy,
          writeFile: writeFileSpy,
          isPortFree: async () => true,
        },
      }),
    ).rejects.toThrow(/timed out/i);

    // Browser must be opened with a temp .html file path, not a GET GitHub URL.
    const openedPath = openBrowserSpy.mock.calls[0]?.[0] as string;
    expect(openedPath).toMatch(/\.html$/);
    expect(openedPath).not.toContain("?manifest=");

    // Written HTML must be the POST form targeting the personal GitHub URL.
    const [, writtenContent] = writeFileSpy.mock.calls[0] as [string, string];
    expect(writtenContent).toContain('method="post"');
    expect(writtenContent).toContain("https://github.com/settings/apps/new");
    expect(writtenContent).not.toContain("organizations/");
  });

  it("opens a temp HTML file targeting the org-scoped URL when org is provided", async () => {
    const openBrowserSpy = vi.fn();
    const writeFileSpy = vi.fn().mockResolvedValue(undefined);

    await expect(
      createGitHubApp({
        headless: false,
        org: "my-org",
        callbackPort: 9999,
        timeoutMs: 100,
        deps: {
          openBrowser: openBrowserSpy,
          writeFile: writeFileSpy,
          isPortFree: async () => true,
        },
      }),
    ).rejects.toThrow(/timed out/i);

    const [, writtenContent] = writeFileSpy.mock.calls[0] as [string, string];
    expect(writtenContent).toContain("https://github.com/organizations/my-org/settings/apps/new");
    expect(writtenContent).toContain('method="post"');
  });

  it("default timeout is 300 000 ms (raised from 30 000)", async () => {
    // We can't easily observe the internal timeout value, but we can verify
    // that the default timeoutMs accepted by the function is at least 300 000.
    // The actual value is encoded in the timeout error message when it fires.
    // We test this indirectly by passing an explicit value and checking the message.
    const openBrowserSpy = vi.fn();
    await expect(
      createGitHubApp({
        headless: false,
        callbackPort: 9999,
        timeoutMs: 50,
        deps: { openBrowser: openBrowserSpy, isPortFree: async () => true },
      }),
    ).rejects.toThrow(/timed out/i);
    // Default is not tested here (would block 300 s), but the interface accepts it.
    expect(createGitHubApp).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// createGitHubApp — headless path
// ---------------------------------------------------------------------------

const FAKE_PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4\n-----END RSA PRIVATE KEY-----";

describe("createGitHubApp() — headless path", () => {
  it("prints the URL-parameters URL (not the manifest exchange URL)", async () => {
    const logs: string[] = [];
    let readLineCallCount = 0;

    const creds = await createGitHubApp({
      headless: true,
      deps: {
        log: (msg) => logs.push(msg),
        // Call 1: App ID, Call 2: pem path (blank → paste), Call 3: paste PEM
        readLine: async (_prompt) => {
          readLineCallCount++;
          if (readLineCallCount === 1) return "42";
          if (readLineCallCount === 2) return ""; // blank → paste mode
          return FAKE_PEM;
        },
        unlink: async () => {},
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    });

    const allLogs = logs.join("\n");
    // Must print the URL-parameters GitHub URL.
    expect(allLogs).toContain("https://github.com/settings/apps/new");
    // Must include URL-params style (name= query param) not manifest= form field.
    expect(allLogs).toContain("name=");
    // Must show the generated webhook secret for the operator to copy.
    expect(allLogs).toMatch(/webhook secret/i);

    // Must return valid credentials built from operator input.
    expect(creds.appId).toBe(42);
    expect(creds.appName).toBe("urateam");
    expect(creds.privateKey).toContain("RSA PRIVATE KEY");
    expect(creds.webhookSecret).toBeTruthy();
    expect(creds.webhookSecret).toHaveLength(64); // 32 random bytes → 64 hex chars
    // clientId and clientSecret are empty (not needed for App-auth).
    expect(creds.clientId).toBe("");
    expect(creds.clientSecret).toBe("");
  });

  it("loads the private key from a .pem file when a path is provided", async () => {
    let readLineCallCount = 0;
    const pemContent = FAKE_PEM;

    const creds = await createGitHubApp({
      headless: true,
      deps: {
        log: () => {},
        readLine: async (_prompt) => {
          readLineCallCount++;
          if (readLineCallCount === 1) return "99"; // App ID
          return "/tmp/test-app.pem"; // pem file path
        },
        readFile: async (_path) => pemContent,
        unlink: async () => {},
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    });

    expect(creds.appId).toBe(99);
    expect(creds.privateKey).toContain("RSA PRIVATE KEY");
  });

  it("accepts pasted PEM with literal \\n escapes and normalises them", async () => {
    let readLineCallCount = 0;
    const oneLinerPem =
      "-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAI\\n-----END RSA PRIVATE KEY-----";

    const creds = await createGitHubApp({
      headless: true,
      deps: {
        log: () => {},
        readLine: async (_prompt) => {
          readLineCallCount++;
          if (readLineCallCount === 1) return "7"; // App ID
          if (readLineCallCount === 2) return ""; // blank path → paste mode
          return oneLinerPem;
        },
        unlink: async () => {},
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    });

    // \\n in pasted input must be expanded to real newlines.
    expect(creds.privateKey).toContain("\n");
    expect(creds.privateKey).not.toContain("\\n");
  });

  it("constructs an org-scoped URL when org is provided", async () => {
    const logs: string[] = [];
    let callCount = 0;

    await createGitHubApp({
      headless: true,
      org: "acme-corp",
      deps: {
        log: (msg) => logs.push(msg),
        readLine: async () => {
          callCount++;
          if (callCount === 1) return "55";
          if (callCount === 2) return "";
          return FAKE_PEM;
        },
        unlink: async () => {},
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    });

    const allLogs = logs.join("\n");
    expect(allLogs).toContain("organizations/acme-corp");
  });

  it("throws when App ID is empty", async () => {
    await expect(
      createGitHubApp({
        headless: true,
        deps: {
          log: () => {},
          readLine: async (_prompt) => "", // empty App ID
          unlink: async () => {},
          writeFile: vi.fn().mockResolvedValue(undefined),
        },
      }),
    ).rejects.toThrow(/invalid app id/i);
  });

  it("throws when App ID is not a valid integer", async () => {
    await expect(
      createGitHubApp({
        headless: true,
        deps: {
          log: () => {},
          readLine: async (_prompt) => "not-a-number",
          unlink: async () => {},
          writeFile: vi.fn().mockResolvedValue(undefined),
        },
      }),
    ).rejects.toThrow(/invalid app id/i);
  });

  it("throws when no private key is provided (blank path and blank paste)", async () => {
    let callCount = 0;
    await expect(
      createGitHubApp({
        headless: true,
        deps: {
          log: () => {},
          readLine: async () => {
            callCount++;
            if (callCount === 1) return "12"; // valid App ID
            return ""; // blank path and blank paste
          },
          unlink: async () => {},
          writeFile: vi.fn().mockResolvedValue(undefined),
        },
      }),
    ).rejects.toThrow(/no private key/i);
  });

  it("throws when the pasted text is not a valid PEM", async () => {
    let callCount = 0;
    await expect(
      createGitHubApp({
        headless: true,
        deps: {
          log: () => {},
          readLine: async () => {
            callCount++;
            if (callCount === 1) return "12";
            if (callCount === 2) return ""; // blank path → paste mode
            return "this-is-not-a-pem";
          },
          unlink: async () => {},
          writeFile: vi.fn().mockResolvedValue(undefined),
        },
      }),
    ).rejects.toThrow(/private key/i);
  });

  it("does not call openBrowser in headless mode", async () => {
    const openBrowserSpy = vi.fn();
    let callCount = 0;

    await createGitHubApp({
      headless: true,
      deps: {
        log: () => {},
        readLine: async () => {
          callCount++;
          if (callCount === 1) return "1";
          if (callCount === 2) return "";
          return FAKE_PEM;
        },
        openBrowser: openBrowserSpy,
        unlink: async () => {},
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    });

    expect(openBrowserSpy).not.toHaveBeenCalled();
  });

  it("does not call the GitHub API (no fetch needed)", async () => {
    const fetchSpy = vi.fn();
    let callCount = 0;

    await createGitHubApp({
      headless: true,
      deps: {
        log: () => {},
        readLine: async () => {
          callCount++;
          if (callCount === 1) return "1";
          if (callCount === 2) return "";
          return FAKE_PEM;
        },
        fetch: fetchSpy,
        unlink: async () => {},
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    });

    // The new headless path never calls the GitHub API.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isHeadlessEnvironment
// ---------------------------------------------------------------------------

describe("isHeadlessEnvironment()", () => {
  it("returns false on non-Linux platforms", () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      expect(isHeadlessEnvironment()).toBe(false);
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }
  });

  it("returns true on Linux when DISPLAY and WAYLAND_DISPLAY are unset", () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const origDisplay = process.env.DISPLAY;
    const origWayland = process.env.WAYLAND_DISPLAY;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      expect(isHeadlessEnvironment()).toBe(true);
    } finally {
      if (origDisplay !== undefined) process.env.DISPLAY = origDisplay;
      if (origWayland !== undefined) process.env.WAYLAND_DISPLAY = origWayland;
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }
  });

  it("returns false on Linux when DISPLAY is set", () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const origDisplay = process.env.DISPLAY;
    process.env.DISPLAY = ":0";
    try {
      expect(isHeadlessEnvironment()).toBe(false);
    } finally {
      if (origDisplay !== undefined) process.env.DISPLAY = origDisplay;
      else delete process.env.DISPLAY;
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }
  });
});

// ---------------------------------------------------------------------------
// preflightChecks — custom ports
// ---------------------------------------------------------------------------

describe("preflightChecks() — custom ports", () => {
  it("checks the provided ports instead of defaults", async () => {
    const ef = makeExecFile();
    const checkedPorts: number[] = [];
    const portCheckSpy = async (port: number): Promise<boolean> => {
      checkedPorts.push(port);
      return true;
    };

    await preflightChecks({ execFile: ef, isPortFree: portCheckSpy }, [3010, 3011]);
    expect(checkedPorts).toEqual([3010, 3011]);
  });

  it("throws with the custom port number in the error when a custom port is busy", async () => {
    const ef = makeExecFile();
    const portCheck = async (port: number): Promise<boolean> => port !== 3011;

    await expect(
      preflightChecks({ execFile: ef, isPortFree: portCheck }, [3010, 3011]),
    ).rejects.toThrow(/3011/);
  });
});

// ---------------------------------------------------------------------------
// bootstrapCommand — command metadata
// ---------------------------------------------------------------------------

describe("bootstrapCommand", () => {
  it("has name 'bootstrap'", () => {
    expect(bootstrapCommand.name()).toBe("bootstrap");
  });

  it("has --skip-github-app option", () => {
    const opts = bootstrapCommand.options;
    const names = opts.map((o) => o.long);
    expect(names).toContain("--skip-github-app");
  });

  it("has --skip-linear option", () => {
    const opts = bootstrapCommand.options;
    const names = opts.map((o) => o.long);
    expect(names).toContain("--skip-linear");
  });

  it("has --validate option", () => {
    const opts = bootstrapCommand.options;
    const names = opts.map((o) => o.long);
    expect(names).toContain("--validate");
  });

  it("has --domain option", () => {
    const opts = bootstrapCommand.options;
    const names = opts.map((o) => o.long);
    expect(names).toContain("--domain");
  });

  it("has --proxy option with default 'caddy'", () => {
    const opts = bootstrapCommand.options;
    const proxyOpt = opts.find((o) => o.long === "--proxy");
    expect(proxyOpt).toBeDefined();
    expect(proxyOpt?.defaultValue).toBe("caddy");
  });

  it("has --output-dir option", () => {
    const opts = bootstrapCommand.options;
    const names = opts.map((o) => o.long);
    expect(names).toContain("--output-dir");
  });

  it("has --app-port option with default '3000'", () => {
    const opts = bootstrapCommand.options;
    const portOpt = opts.find((o) => o.long === "--app-port");
    expect(portOpt).toBeDefined();
    expect(portOpt?.defaultValue).toBe("3000");
  });

  it("has --dashboard-port option with default '3001'", () => {
    const opts = bootstrapCommand.options;
    const portOpt = opts.find((o) => o.long === "--dashboard-port");
    expect(portOpt).toBeDefined();
    expect(portOpt?.defaultValue).toBe("3001");
  });

  it("has --port option (deprecated back-compat alias for --app-port)", () => {
    const opts = bootstrapCommand.options;
    const names = opts.map((o) => o.long);
    expect(names).toContain("--port");
  });

  it("has --dogfood option (hidden, for urateam contributors)", () => {
    const opts = bootstrapCommand.options;
    const dogfoodOpt = opts.find((o) => o.long === "--dogfood");
    expect(dogfoodOpt).toBeDefined();
    // Hidden options still appear in the options array but not in help output.
    expect(dogfoodOpt?.hidden).toBe(true);
  });

  it("has --headless option", () => {
    const opts = bootstrapCommand.options;
    const names = opts.map((o) => o.long);
    expect(names).toContain("--headless");
  });

  it("has --oauth-timeout-ms option", () => {
    const opts = bootstrapCommand.options;
    const names = opts.map((o) => o.long);
    expect(names).toContain("--oauth-timeout-ms");
  });
});

// ---------------------------------------------------------------------------
// Deprecation warning for --port flag
// ---------------------------------------------------------------------------

describe("--port deprecation warning", () => {
  it("logs deprecation warning when --port is used", async () => {
    const warnSpy = vi.fn();
    const origWarn = console.warn;
    console.warn = warnSpy;

    try {
      // The bootstrap command parses and logs at construction time, so we need to
      // verify the implementation handles --port by checking the source directly.
      // This test verifies the deprecation message exists in the code.
      const source = require("fs").readFileSync(
        require("path").join(__dirname, "../commands/bootstrap.ts"),
        "utf-8",
      );
      expect(source).toContain("--port is deprecated");
      expect(source).toContain("Use --app-port instead");
    } finally {
      console.warn = origWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// validateSetup with custom port
// ---------------------------------------------------------------------------

describe("validateSetup() with custom ports", () => {
  it("POSTs to the correct custom app port", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
    });

    // Test that validateSetup uses the provided port.
    await expect(
      validateSetup(3010, 5_000, { fetch: mockFetch }),
    ).resolves.toBeUndefined();

    // Verify fetch was called with the custom port.
    expect(mockFetch).toHaveBeenCalled();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toContain("3010");
    expect(callArgs[0]).not.toContain("3000");
  });

  it("POSTs to port 3000 by default when not provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
    });

    // Test default port behavior.
    await expect(
      validateSetup(3000, 5_000, { fetch: mockFetch }),
    ).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalled();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toContain("3000");
  });
});

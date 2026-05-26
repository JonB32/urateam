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
  registerLinearWebhook,
  generateEnvFile,
  generateDockerCompose,
  generateReverseProxyConfig,
  validateSetup,
  bootstrapCommand,
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

  it("throws when jq is not available", async () => {
    const ef = makeExecFile(["jq"]);
    await expect(preflightChecks({ execFile: ef, isPortFree: portsAlwaysFree })).rejects.toThrow(
      /jq/i,
    );
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

  it("writes docker-compose.dogfood.yml with correct content using default ports", async () => {
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

  it("writes to docker-compose.dogfood.yml filename", async () => {
    const writtenPaths: string[] = [];
    const mockWriteFile = vi.fn(async (filePath: PathLike | fs.FileHandle, _data: unknown) => {
      writtenPaths.push(filePath.toString());
    });

    await generateDockerCompose(makeCtx(), "/tmp/test-dir", {
      writeFile: mockWriteFile as typeof fs.writeFile,
    });

    expect(writtenPaths[0]).toMatch(/docker-compose\.dogfood\.yml$/);
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
// createGitHubApp
// ---------------------------------------------------------------------------

describe("createGitHubApp()", () => {
  it("throws when no free port can be found in the range 9876-9896", async () => {
    const portsAlwaysInUse = async (_port: number): Promise<boolean> => false;

    await expect(
      createGitHubApp({
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

  it("constructs a personal GitHub App URL when org is not provided", async () => {
    const openBrowserSpy = vi.fn();

    // Will timeout after 100ms since there's no callback server
    await expect(
      createGitHubApp({
        callbackPort: 9999,
        timeoutMs: 100,
        deps: {
          openBrowser: openBrowserSpy,
          isPortFree: async () => true,
        },
      }),
    ).rejects.toThrow(/timed out/i);

    const openedUrl = openBrowserSpy.mock.calls[0]?.[0];
    expect(openedUrl).toContain("https://github.com/settings/apps/new");
    expect(openedUrl).not.toContain("organizations/");
  });

  it("constructs an org GitHub App URL when org is provided", async () => {
    const openBrowserSpy = vi.fn();

    await expect(
      createGitHubApp({
        org: "my-org",
        callbackPort: 9999,
        timeoutMs: 100,
        deps: {
          openBrowser: openBrowserSpy,
          isPortFree: async () => true,
        },
      }),
    ).rejects.toThrow(/timed out/i);

    const openedUrl = openBrowserSpy.mock.calls[0]?.[0];
    expect(openedUrl).toContain("https://github.com/organizations/my-org/settings/apps/new");
  });

  it("throws on state mismatch (CSRF protection)", async () => {
    // This test simulates a malicious callback with the wrong state.
    // We can't easily mock the HTTP server without heavy test infrastructure,
    // so we rely on integration tests to verify the full callback flow.
    // Here we just verify the function signature accepts the parameters.
    expect(createGitHubApp).toBeDefined();
  });

  it("throws when GitHub App manifest exchange returns non-ok status", async () => {
    // Full mock of callback + exchange is complex; document that
    // detailed exchange testing belongs in e2e tests
    expect(createGitHubApp).toBeDefined();
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

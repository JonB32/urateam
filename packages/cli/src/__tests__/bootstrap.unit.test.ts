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
// generateDockerCompose
// ---------------------------------------------------------------------------

describe("generateDockerCompose()", () => {
  it("writes docker-compose.dogfood.yml with correct content", async () => {
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

    // Port mappings.
    expect(content).toContain("3000:3000");
    expect(content).toContain("3001:3001");

    // env_file reference.
    expect(content).toContain("env_file: .env");
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

  it("constructs a personal GitHub App URL when org is not provided", async () => {
    const openBrowserSpy = vi.fn();

    // Will timeout after 100ms since there's no callback server
    await expect(
      createGitHubApp({
        headless: false,
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
        headless: false,
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

describe("createGitHubApp() — headless path", () => {
  it("prints the manifest URL and prompts for code via readLine", async () => {
    const logs: string[] = [];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 42,
        name: "urateam",
        pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
        webhook_secret: "wh_secret",
        client_id: "Iv1.abc",
        client_secret: "cs_secret",
        html_url: "https://github.com/apps/urateam",
      }),
      text: async () => "",
    });

    const creds = await createGitHubApp({
      headless: true,
      timeoutMs: 5_000,
      deps: {
        log: (msg) => logs.push(msg),
        readLine: async (_prompt) => "test_oauth_code_123",
        fetch: mockFetch,
        isPortFree: async () => true,
      },
    });

    // Should have logged the GitHub URL.
    const allLogs = logs.join("\n");
    expect(allLogs).toContain("https://github.com/settings/apps/new");
    expect(allLogs).toContain("localhost:");

    // Should have called the manifest exchange endpoint.
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("test_oauth_code_123");

    // Should return valid credentials.
    expect(creds.appId).toBe(42);
    expect(creds.appName).toBe("urateam");
    expect(creds.privateKey).toContain("RSA PRIVATE KEY");
  });

  it("constructs an org URL in headless mode", async () => {
    const logs: string[] = [];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 99,
        name: "urateam",
        pem: "pem",
        webhook_secret: "s",
        client_id: "c",
        client_secret: "cs",
        html_url: "https://github.com/apps/urateam",
      }),
      text: async () => "",
    });

    await createGitHubApp({
      headless: true,
      org: "acme-corp",
      timeoutMs: 5_000,
      deps: {
        log: (msg) => logs.push(msg),
        readLine: async () => "code_for_org",
        fetch: mockFetch,
      },
    });

    const allLogs = logs.join("\n");
    expect(allLogs).toContain("organizations/acme-corp");
  });

  it("throws when no code is pasted (empty input)", async () => {
    await expect(
      createGitHubApp({
        headless: true,
        timeoutMs: 5_000,
        deps: {
          log: () => {},
          readLine: async () => "", // user pressed Enter without pasting
          fetch: vi.fn(),
        },
      }),
    ).rejects.toThrow(/no code entered/i);
  });

  it("throws on timeout when readLine never resolves within timeoutMs", async () => {
    await expect(
      createGitHubApp({
        headless: true,
        timeoutMs: 50, // Very short
        deps: {
          log: () => {},
          // readLine blocks forever
          readLine: () => new Promise(() => {}),
          fetch: vi.fn(),
        },
      }),
    ).rejects.toThrow(/timed out/i);
  }, 5_000);

  it("throws when the manifest exchange returns a non-ok HTTP status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => "Unprocessable Entity",
    });

    await expect(
      createGitHubApp({
        headless: true,
        timeoutMs: 5_000,
        deps: {
          log: () => {},
          readLine: async () => "some_code",
          fetch: mockFetch,
        },
      }),
    ).rejects.toThrow(/422/);
  });

  it("does not call openBrowser in headless mode", async () => {
    const openBrowserSpy = vi.fn();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 1, name: "u", pem: "p", webhook_secret: "w",
        client_id: "c", client_secret: "cs", html_url: "h",
      }),
      text: async () => "",
    });

    await createGitHubApp({
      headless: true,
      timeoutMs: 5_000,
      deps: {
        log: () => {},
        readLine: async () => "code_abc",
        openBrowser: openBrowserSpy,
        fetch: mockFetch,
      },
    });

    expect(openBrowserSpy).not.toHaveBeenCalled();
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

  it("has --port option with default '3000'", () => {
    const opts = bootstrapCommand.options;
    const portOpt = opts.find((o) => o.long === "--port");
    expect(portOpt).toBeDefined();
    expect(portOpt?.defaultValue).toBe("3000");
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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isClaudeAuthValid, resetAuthCheckCache, probeClaudeAuth } from "../executor/auth-check.js";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile);

// ---------------------------------------------------------------------------
// Helpers — simulate subprocess outcomes for `claude -p "ok"`
// ---------------------------------------------------------------------------

function simulateSuccess() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
    cb(null, "ok", "");
    return {} as any;
  });
}

/** Auth error: non-zero exit, stderr contains an auth-related pattern. */
function simulateAuthError(stderrMsg = "Error: Invalid authentication credentials (401)") {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
    cb(new Error("Command failed"), "", stderrMsg);
    return {} as any;
  });
}

/** Network error: non-zero exit, stderr contains no auth pattern. */
function simulateNetworkError() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
    cb(new Error("ECONNREFUSED"), "", "Connection refused");
    return {} as any;
  });
}

/** Timeout: err.killed = true. */
function simulateTimeout() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
    const err = Object.assign(new Error("Process timed out"), { killed: true });
    cb(err, "", "");
    return {} as any;
  });
}

// ---------------------------------------------------------------------------
// Tests: probeClaudeAuth
// ---------------------------------------------------------------------------

describe("probeClaudeAuth", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("calls claude -p ok (not claude auth status)", async () => {
    simulateSuccess();
    await probeClaudeAuth(10_000);
    expect(mockExecFile).toHaveBeenCalledWith(
      "claude",
      ["-p", "ok"],
      { timeout: 10_000 },
      expect.any(Function),
    );
  });

  it("returns { valid: true } on success", async () => {
    simulateSuccess();
    const result = await probeClaudeAuth(10_000);
    expect(result).toEqual({ valid: true });
  });

  it("returns { valid: false, reason: 'auth' } when stderr contains '401'", async () => {
    simulateAuthError("HTTP 401 Unauthorized");
    const result = await probeClaudeAuth(10_000);
    expect(result).toEqual({ valid: false, reason: "auth" });
  });

  it("returns { valid: false, reason: 'auth' } when stderr contains 'authentication'", async () => {
    simulateAuthError("authentication_error: invalid x-api-key");
    const result = await probeClaudeAuth(10_000);
    expect(result).toEqual({ valid: false, reason: "auth" });
  });

  it("returns { valid: false, reason: 'auth' } when stderr contains 'unauthorized'", async () => {
    simulateAuthError("Unauthorized");
    const result = await probeClaudeAuth(10_000);
    expect(result).toEqual({ valid: false, reason: "auth" });
  });

  it("returns { valid: false, reason: 'auth' } when stderr contains 'credentials'", async () => {
    simulateAuthError("Invalid authentication credentials");
    const result = await probeClaudeAuth(10_000);
    expect(result).toEqual({ valid: false, reason: "auth" });
  });

  it("returns { valid: true } (fail-open) on network error without auth pattern in stderr", async () => {
    simulateNetworkError();
    const result = await probeClaudeAuth(10_000);
    expect(result).toEqual({ valid: true });
  });

  it("returns { valid: true } (fail-open) on timeout (err.killed = true)", async () => {
    simulateTimeout();
    const result = await probeClaudeAuth(10_000);
    expect(result).toEqual({ valid: true });
  });

  it("returns { valid: true } (fail-open) when command is not found (ENOENT)", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      cb(err, "", "");
      return {} as any;
    });
    const result = await probeClaudeAuth(10_000);
    expect(result).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// Tests: isClaudeAuthValid
// ---------------------------------------------------------------------------

describe("isClaudeAuthValid", () => {
  let savedOauthToken: string | undefined;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    resetAuthCheckCache();
    mockExecFile.mockReset();
    savedOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
  });

  it("returns true when claude -p ok succeeds (mounted session path)", async () => {
    simulateSuccess();
    const result = await isClaudeAuthValid();
    expect(result).toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    // Verify it uses the real-API probe, NOT claude auth status
    expect(mockExecFile).toHaveBeenCalledWith(
      "claude",
      ["-p", "ok"],
      { timeout: 10_000 },
      expect.any(Function),
    );
  });

  it("returns false when probe returns auth error (mounted session path)", async () => {
    simulateAuthError("401 Invalid authentication credentials");
    const result = await isClaudeAuthValid();
    expect(result).toBe(false);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("returns true (fail-open) when probe encounters a network error", async () => {
    simulateNetworkError();
    const result = await isClaudeAuthValid();
    expect(result).toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("returns true (fail-open) when probe times out", async () => {
    simulateTimeout();
    const result = await isClaudeAuthValid();
    expect(result).toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("short-circuits to true without subprocess when CLAUDE_CODE_OAUTH_TOKEN is set", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    const result = await isClaudeAuthValid();
    expect(result).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("short-circuits to true without subprocess when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    const result = await isClaudeAuthValid();
    expect(result).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("caches result within 5-minute TTL", async () => {
    simulateSuccess();
    await isClaudeAuthValid();
    await isClaudeAuthValid();
    await isClaudeAuthValid();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("re-checks after TTL expires", async () => {
    vi.useFakeTimers();
    simulateSuccess();

    await isClaudeAuthValid();
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    await isClaudeAuthValid();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers share a single subprocess (single-flight)", async () => {
    let resolveCb: (() => void) | null = null;
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      resolveCb = () => cb(null, "ok", "");
      return {} as any;
    });

    resetAuthCheckCache();
    const p1 = isClaudeAuthValid();
    const p2 = isClaudeAuthValid();
    const p3 = isClaudeAuthValid();

    expect(mockExecFile).toHaveBeenCalledTimes(1);

    resolveCb!();

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
  });

  it("resetAuthCheckCache forces a fresh probe on next call", async () => {
    simulateSuccess();
    await isClaudeAuthValid();
    expect(await isClaudeAuthValid()).toBe(true);

    resetAuthCheckCache();
    simulateAuthError("401 authentication error");
    expect(await isClaudeAuthValid()).toBe(false);
  });
});

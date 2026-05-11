import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isClaudeAuthValid, resetAuthCheckCache } from "../executor/auth-check.js";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile);

function simulateSuccess() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
    cb(null);
    return {} as any;
  });
}

function simulateFailure() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
    cb(new Error("auth failed"));
    return {} as any;
  });
}

describe("isClaudeAuthValid", () => {
  // BEC-207: save/restore env vars so the new short-circuit (which returns
  // true immediately when CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is set)
  // doesn't interfere with these subprocess-path tests.
  let savedOauthToken: string | undefined;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    resetAuthCheckCache();
    mockExecFile.mockReset();
    // Clear env vars so tests exercise the subprocess (mounted-session) path.
    savedOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore env vars.
    if (savedOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
    }
    if (savedApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
  });

  it("returns true when claude auth status succeeds", async () => {
    simulateSuccess();
    const result = await isClaudeAuthValid();
    expect(result).toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith(
      "claude",
      ["auth", "status"],
      { timeout: 10_000 },
      expect.any(Function),
    );
  });

  it("returns false when claude auth status fails", async () => {
    simulateFailure();
    const result = await isClaudeAuthValid();
    expect(result).toBe(false);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("caches result within 5 minute TTL", async () => {
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

    // Advance past 5 minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    await isClaudeAuthValid();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers share a single subprocess (single-flight)", async () => {
    let resolveCb: (() => void) | null = null;
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      // Delay the callback so concurrent callers overlap
      resolveCb = () => cb(null);
      return {} as any;
    });

    resetAuthCheckCache();
    const p1 = isClaudeAuthValid();
    const p2 = isClaudeAuthValid();
    const p3 = isClaudeAuthValid();

    // Only one execFile call should have been made
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    // Resolve the single subprocess
    resolveCb!();

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
  });

  it("resetAuthCheckCache sets result to false (unknown)", async () => {
    simulateSuccess();
    await isClaudeAuthValid();
    expect(await isClaudeAuthValid()).toBe(true);

    resetAuthCheckCache();
    simulateFailure();
    expect(await isClaudeAuthValid()).toBe(false);
  });
});

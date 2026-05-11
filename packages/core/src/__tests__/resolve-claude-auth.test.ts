/**
 * Tests for resolveClaudeAuth() and the updated isClaudeAuthValid() env-var
 * short-circuit (BEC-207).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveClaudeAuth, isClaudeAuthValid, resetAuthCheckCache } from "../executor/auth-check.js";

// Mock child_process.execFile to control subprocess behaviour
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
const mockExecFile = vi.mocked(execFile);

function simulateCliSuccess() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
    cb(null);
    return {} as any;
  });
}

function simulateCliFailure() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
    cb(new Error("auth failed"));
    return {} as any;
  });
}

// --- resolveClaudeAuth ---

describe("resolveClaudeAuth", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore env between tests
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
      if (origEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = origEnv[k];
      }
    }
  });

  it("returns oauth-token method when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-testtoken";
    delete process.env.ANTHROPIC_API_KEY;
    const result = resolveClaudeAuth();
    expect(result.method).toBe("oauth-token");
    // The credential value is intentionally NOT exposed in the result struct
    // (see ClaudeAuthCredentials JSDoc for rationale).
    expect((result as any).oauthToken).toBeUndefined();
  });

  it("returns api-key method when ANTHROPIC_API_KEY is set (and no oauth token)", () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-testkey";
    const result = resolveClaudeAuth();
    expect(result.method).toBe("api-key");
  });

  it("CLAUDE_CODE_OAUTH_TOKEN takes precedence over ANTHROPIC_API_KEY", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-higher-priority";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-lower-priority";
    const result = resolveClaudeAuth();
    expect(result.method).toBe("oauth-token");
  });

  it("returns session method when neither env var is set", () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    const result = resolveClaudeAuth();
    expect(result.method).toBe("session");
  });

  it("precedence order: CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_API_KEY > session", () => {
    // All set — oauth token wins
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-x";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-y";
    expect(resolveClaudeAuth().method).toBe("oauth-token");

    // Only API key — api-key wins
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(resolveClaudeAuth().method).toBe("api-key");

    // Neither — session
    delete process.env.ANTHROPIC_API_KEY;
    expect(resolveClaudeAuth().method).toBe("session");
  });
});

// --- isClaudeAuthValid env-var short-circuit ---

describe("isClaudeAuthValid env-var short-circuit", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    resetAuthCheckCache();
    mockExecFile.mockReset();
  });

  afterEach(() => {
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
      if (origEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = origEnv[k];
      }
    }
  });

  it("returns true immediately when CLAUDE_CODE_OAUTH_TOKEN is set — no subprocess", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    delete process.env.ANTHROPIC_API_KEY;
    const result = await isClaudeAuthValid();
    expect(result).toBe(true);
    // Must NOT have spawned a subprocess
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("returns true immediately when ANTHROPIC_API_KEY is set — no subprocess", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    const result = await isClaudeAuthValid();
    expect(result).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("runs subprocess only when both env vars are absent", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    simulateCliSuccess();
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

  it("returns false and runs subprocess when session is invalid and no env vars set", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    simulateCliFailure();
    const result = await isClaudeAuthValid();
    expect(result).toBe(false);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});

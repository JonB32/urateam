import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoist the mock fn so it's defined before vi.mock's factory runs.
const { mockIsClaudeAuthValid } = vi.hoisted(() => ({
  mockIsClaudeAuthValid: vi.fn<() => Promise<boolean>>(),
}));

// Minimal mock: only `isClaudeAuthValid` is touched by preflightClaudeAuth,
// so we don't need vi.importActual (which is slow + introduces a startup
// race where the first test can resolve before the mocked module is fully
// populated).
vi.mock("@urateam/core", () => ({
  isClaudeAuthValid: mockIsClaudeAuthValid,
}));

import { preflightClaudeAuth } from "../lib/preflight-claude-auth.js";

describe("preflightClaudeAuth", () => {
  let exitSpy: any;
  let errorSpy: any;
  // Track original env vars so we can restore them between tests
  let origOauthToken: string | undefined;
  let origApiKey: string | undefined;

  beforeEach(() => {
    mockIsClaudeAuthValid.mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__EXIT__");
    }) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Save and clear env vars so each test starts clean
    origOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    origApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    // Restore env vars
    if (origOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = origOauthToken;
    }
    if (origApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = origApiKey;
    }
  });

  // --- Mounted-session path (neither env var set) ---

  it("returns silently when isClaudeAuthValid resolves true", async () => {
    mockIsClaudeAuthValid.mockResolvedValue(true);
    await preflightClaudeAuth({ command: "ura dev" });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("exits 1 with an actionable banner when isClaudeAuthValid resolves false", async () => {
    mockIsClaudeAuthValid.mockResolvedValue(false);
    await expect(preflightClaudeAuth({ command: "ura dev" })).rejects.toThrow(
      "__EXIT__",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    const banner = errorSpy.mock.calls[0]![0] as string;
    expect(banner).toContain("Claude session auth check failed");
    expect(banner).toContain("claude login");
    expect(banner).toContain("ura dev");
    expect(banner).toContain("manual recovery");
  });

  it("includes the docker-compose hint when containerized=true", async () => {
    mockIsClaudeAuthValid.mockResolvedValue(false);
    await expect(
      preflightClaudeAuth({ command: "ura start", containerized: true }),
    ).rejects.toThrow("__EXIT__");
    const banner = errorSpy.mock.calls[0]![0] as string;
    expect(banner).toContain("docker compose exec");
    expect(banner).toContain("ura start");
  });

  it("omits the docker-compose hint by default", async () => {
    mockIsClaudeAuthValid.mockResolvedValue(false);
    await expect(preflightClaudeAuth({ command: "ura dev" })).rejects.toThrow(
      "__EXIT__",
    );
    const banner = errorSpy.mock.calls[0]![0] as string;
    expect(banner).not.toContain("docker compose exec");
  });

  it("calls isClaudeAuthValid (subprocess path) only when both env vars are absent", async () => {
    // Neither var is set (cleared in beforeEach)
    mockIsClaudeAuthValid.mockResolvedValue(true);
    await preflightClaudeAuth({ command: "ura dev" });
    expect(mockIsClaudeAuthValid).toHaveBeenCalledTimes(1);
  });

  // --- BEC-207: env-var short-circuit (no subprocess) ---

  it("returns immediately when CLAUDE_CODE_OAUTH_TOKEN is set — no subprocess", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    await preflightClaudeAuth({ command: "ura start" });
    // isClaudeAuthValid must NOT have been called
    expect(mockIsClaudeAuthValid).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("returns immediately when ANTHROPIC_API_KEY is set — no subprocess", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    await preflightClaudeAuth({ command: "ura dev" });
    expect(mockIsClaudeAuthValid).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("CLAUDE_CODE_OAUTH_TOKEN takes precedence — no subprocess even if API key also set", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-also-set";
    await preflightClaudeAuth({ command: "ura start" });
    expect(mockIsClaudeAuthValid).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

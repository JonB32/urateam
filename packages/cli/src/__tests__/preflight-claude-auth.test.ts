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

  beforeEach(() => {
    mockIsClaudeAuthValid.mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__EXIT__");
    }) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

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
});

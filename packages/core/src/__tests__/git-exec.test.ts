import { describe, it, expect, vi, beforeEach } from "vitest";

// Spy handles must be hoisted so the vi.mock factory can reference them.
const { mockLogError, mockLogDebug } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockLogDebug: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: mockLogDebug,
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    child: vi.fn(() => ({
      debug: mockLogDebug,
      info: vi.fn(),
      warn: vi.fn(),
      error: mockLogError,
    })),
  })),
  getLogContext: vi.fn(() => undefined),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { gitExec } from "../repo/git.js";

const mockExecFile = vi.mocked(execFile);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function simulateFailure(stderr = "fatal: not a git repository"): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
    cb(new Error("Command failed"), "", stderr);
    return { on: vi.fn() } as any;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function simulateSuccess(stdout = "abc123"): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
    cb(null, stdout, "");
    return { on: vi.fn() } as any;
  });
}

describe("gitExec — log-level routing (BEC-265)", () => {
  beforeEach(() => {
    mockLogError.mockClear();
    mockLogDebug.mockClear();
    mockExecFile.mockReset();
  });

  it("logs at error level on failure when expectFailure is omitted (default)", async () => {
    simulateFailure();
    await expect(gitExec(["rev-parse", "HEAD"], "/tmp/repo")).rejects.toThrow("rev-parse failed");
    expect(mockLogError).toHaveBeenCalledOnce();
  });

  it("logs at error level on failure when expectFailure is explicitly false", async () => {
    simulateFailure();
    await expect(gitExec(["rev-parse", "HEAD"], "/tmp/repo", 120_000, false)).rejects.toThrow();
    expect(mockLogError).toHaveBeenCalledOnce();
  });

  it("logs at debug level (not error) on failure when expectFailure is true", async () => {
    simulateFailure();
    await expect(
      gitExec(["rev-parse", "--verify", "--quiet", "origin/agent/BEC-243"], "/tmp/repo", undefined, true),
    ).rejects.toThrow("rev-parse failed");
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("still rejects the promise even when expectFailure is true", async () => {
    simulateFailure("fatal: ambiguous argument 'HEAD'");
    await expect(
      gitExec(["rev-parse", "HEAD"], "/tmp/repo", undefined, true),
    ).rejects.toThrow("rev-parse failed");
  });

  it("does not log error on success regardless of expectFailure", async () => {
    simulateSuccess();
    const result = await gitExec(["rev-parse", "HEAD"], "/tmp/repo");
    expect(result).toBe("abc123");
    expect(mockLogError).not.toHaveBeenCalled();
  });
});

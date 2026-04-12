import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:fs/promises before importing the module under test
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
}));

// Mock node:child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import {
  shouldUseDevcontainer,
  devcontainerUp,
} from "../repo/devcontainer.js";

const mockAccess = vi.mocked(access);
const mockExecFile = vi.mocked(execFile);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("shouldUseDevcontainer", () => {
  it('returns false when mode is "never"', async () => {
    const result = await shouldUseDevcontainer("/repo", { mode: "never" });
    expect(result).toBe(false);
    // Should not check filesystem at all
    expect(mockAccess).not.toHaveBeenCalled();
  });

  it('returns true when mode is "always"', async () => {
    const result = await shouldUseDevcontainer("/repo", { mode: "always" });
    expect(result).toBe(true);
    expect(mockAccess).not.toHaveBeenCalled();
  });

  it('returns true in "auto" mode when .devcontainer/devcontainer.json exists', async () => {
    mockAccess.mockResolvedValueOnce(undefined);

    const result = await shouldUseDevcontainer("/repo", { mode: "auto" });
    expect(result).toBe(true);
    expect(mockAccess).toHaveBeenCalledWith("/repo/.devcontainer/devcontainer.json");
  });

  it('returns false in "auto" mode when config file is missing', async () => {
    mockAccess.mockRejectedValueOnce(new Error("ENOENT"));

    const result = await shouldUseDevcontainer("/repo", { mode: "auto" });
    expect(result).toBe(false);
    expect(mockAccess).toHaveBeenCalledWith("/repo/.devcontainer/devcontainer.json");
  });

  it('defaults to "auto" when no config is provided', async () => {
    mockAccess.mockRejectedValueOnce(new Error("ENOENT"));

    const result = await shouldUseDevcontainer("/repo");
    expect(result).toBe(false);
    expect(mockAccess).toHaveBeenCalled();
  });
});

describe("devcontainerUp", () => {
  it("rejects with a clear error message on failure", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      // execFile callback signature: (error, stdout, stderr)
      (callback as Function)(null, "", "Docker daemon not running");
      // Actually, to trigger the reject path we need an error:
      return undefined as any;
    });

    // Re-mock to trigger the error path
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("command failed");
      (callback as Function)(err, "", "Docker daemon not running");
      return undefined as any;
    });

    await expect(devcontainerUp("/repo")).rejects.toThrow(
      "devcontainer up failed: Docker daemon not running",
    );
  });

  it("returns session with parsed workspace folder on success", async () => {
    const upOutput = JSON.stringify({
      outcome: "success",
      containerId: "abc123",
      remoteWorkspaceFolder: "/workspaces/my-project",
    });

    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, upOutput, "");
      return undefined as any;
    });

    const session = await devcontainerUp("/repo");
    expect(session.worktreePath).toBe("/repo");
    expect(session.workspaceFolder).toBe("/workspaces/my-project");
  });

  it("falls back to default workspace folder when stdout is not JSON", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, "not json", "");
      return undefined as any;
    });

    const session = await devcontainerUp("/repo");
    expect(session.worktreePath).toBe("/repo");
    expect(session.workspaceFolder).toBe("/workspaces/worktree");
  });
});

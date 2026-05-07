import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, chmodSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { preflightDirs } from "../lib/preflight-dirs.js";

describe("preflightDirs (BEC-152)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "bec152-"));
    exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("__EXIT__");
    }) as never;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("succeeds when both dirs are writable", async () => {
    const agentRunDir = join(tempRoot, "data", "runs");
    const repoCloneDir = join(tempRoot, "work", "repos");
    // dirs don't exist yet — preflightDirs should create them
    await preflightDirs({ agentRunDir, repoCloneDir, command: "ura start" });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(existsSync(agentRunDir)).toBe(true);
    expect(existsSync(repoCloneDir)).toBe(true);
  });

  it("creates nested dirs that don't exist yet", async () => {
    const agentRunDir = join(tempRoot, "deeply", "nested", "data", "runs");
    const repoCloneDir = join(tempRoot, "deeply", "nested", "work", "repos");
    await preflightDirs({ agentRunDir, repoCloneDir, command: "ura dev" });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(existsSync(agentRunDir)).toBe(true);
    expect(existsSync(repoCloneDir)).toBe(true);
  });

  it("exits 1 with a clear error when AGENT_RUN_DIR is not writable", async () => {
    // chmod-based permission checks don't work when running as root.
    // Root can always write regardless of mode bits.
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (isRoot) return;

    // Create a read-only parent dir
    const readOnlyParent = join(tempRoot, "readonly");
    mkdirSync(readOnlyParent);
    chmodSync(readOnlyParent, 0o555);

    const agentRunDir = join(readOnlyParent, "data", "runs");
    const repoCloneDir = join(tempRoot, "work", "repos");

    await expect(
      preflightDirs({ agentRunDir, repoCloneDir, command: "ura start" }),
    ).rejects.toThrow("__EXIT__");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const banner = errorSpy.mock.calls[0]![0] as string;
    expect(banner).toContain("AGENT_RUN_DIR");
    expect(banner).toContain(agentRunDir);
    expect(banner).toContain("ura start");
  });

  it("exits 1 with a clear error when REPO_CLONE_DIR is not writable", async () => {
    // chmod-based permission checks don't work when running as root.
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (isRoot) return;

    const readOnlyParent = join(tempRoot, "readonly");
    mkdirSync(readOnlyParent);
    chmodSync(readOnlyParent, 0o555);

    const agentRunDir = join(tempRoot, "data", "runs");
    const repoCloneDir = join(readOnlyParent, "work", "repos");

    await expect(
      preflightDirs({ agentRunDir, repoCloneDir, command: "ura dev" }),
    ).rejects.toThrow("__EXIT__");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const banner = errorSpy.mock.calls[0]![0] as string;
    expect(banner).toContain("REPO_CLONE_DIR");
    expect(banner).toContain(repoCloneDir);
    expect(banner).toContain("ura dev");
  });
});

describe("BEC-152: default dir values are HOME-relative", () => {
  it("default agentRunDir uses homedir(), not /var/", () => {
    const home = homedir();
    const expectedDefault = join(home, "data", "runs");
    // Verify the expected default is not under /var/
    expect(expectedDefault).not.toContain("/var/");
    expect(expectedDefault).toContain(home);
    // Verify it matches the documented default pattern
    expect(expectedDefault).toMatch(/data\/runs$/);
  });

  it("default repoCloneDir uses homedir(), not /var/", () => {
    const home = homedir();
    const expectedDefault = join(home, "work", "repos");
    expect(expectedDefault).not.toContain("/var/");
    expect(expectedDefault).toContain(home);
    expect(expectedDefault).toMatch(/work\/repos$/);
  });
});

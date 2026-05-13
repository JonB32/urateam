/**
 * `ura uninstall` — remove the user-level install at ~/.urateam (or
 * $URATEAM_HOME).
 *
 * Destructive, so gated on `--yes`. Without `--yes`, prints what would be
 * deleted and exits 0. With `--yes`, recursively removes the directory.
 * No-op if the directory doesn't exist (so re-running after a manual
 * `rm -rf ~/.urateam` doesn't error).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uninstallCommand } from "../commands/uninstall.js";

describe("ura uninstall", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-uninst-"));
    process.env.URATEAM_HOME = tmp;
    mkdirSync(join(tmp, "data"), { recursive: true });
    mkdirSync(join(tmp, "repos"), { recursive: true });
    writeFileSync(join(tmp, "config.json"), '{"version":1,"repos":[]}');
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
  });

  it("removes URATEAM_HOME when --yes is passed", async () => {
    await uninstallCommand.parseAsync(["--yes"], { from: "user" });
    expect(existsSync(tmp)).toBe(false);
  });

  it("aborts without --yes (no destructive action)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await uninstallCommand.parseAsync([], { from: "user" });
    expect(existsSync(tmp)).toBe(true);
    expect(spy.mock.calls.flat().join("\n")).toMatch(/--yes/i);
    spy.mockRestore();
    // Test-cleanup: remove the directory manually since uninstall didn't.
    rmSync(tmp, { recursive: true, force: true });
  });

  it("is a no-op when URATEAM_HOME does not exist", async () => {
    rmSync(tmp, { recursive: true, force: true });
    await expect(
      uninstallCommand.parseAsync(["--yes"], { from: "user" }),
    ).resolves.not.toThrow();
  });

  it("prints an npm-uninstall hint after a successful removal", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await uninstallCommand.parseAsync(["--yes"], { from: "user" });
    expect(spy.mock.calls.flat().join("\n")).toContain(
      "npm uninstall -g @urateam/cli",
    );
    spy.mockRestore();
  });
});

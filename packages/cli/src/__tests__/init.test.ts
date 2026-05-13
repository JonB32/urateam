/**
 * `ura init` — bootstrap a user-level urateam install.
 *
 * Creates `~/.urateam/` (or `$URATEAM_HOME`) with an empty `config.json`,
 * a `data/` directory for the SQLite DB, and a `repos/` directory for
 * managed clones. Idempotent: re-running on an already-initialized
 * directory leaves the existing config untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initCommand } from "../commands/init.js";

describe("ura init", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-init-"));
    process.env.URATEAM_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates config.json, data/, repos/ under URATEAM_HOME", async () => {
    await initCommand.parseAsync([], { from: "user" });
    expect(existsSync(join(tmp, "config.json"))).toBe(true);
    expect(existsSync(join(tmp, "data"))).toBe(true);
    expect(existsSync(join(tmp, "repos"))).toBe(true);
  });

  it("seeds config.json with version=1 and an empty repos array", async () => {
    await initCommand.parseAsync([], { from: "user" });
    const raw = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.repos).toEqual([]);
  });

  it("is idempotent: re-running does not overwrite an existing config", async () => {
    await initCommand.parseAsync([], { from: "user" });
    const path = join(tmp, "config.json");
    const mutated = {
      version: 1,
      repos: [
        {
          url: "https://github.com/o/r.git",
          path: "/tmp/r",
          defaultBranch: "main",
          testCommand: "pnpm test",
          buildCommand: "pnpm build",
        },
      ],
    };
    writeFileSync(path, JSON.stringify(mutated));
    await initCommand.parseAsync([], { from: "user" });
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.repos).toHaveLength(1);
  });

  it("prints the location it created on first run", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await initCommand.parseAsync([], { from: "user" });
    const out = spy.mock.calls.flat().join("\n");
    expect(out).toContain(tmp);
    expect(out).toMatch(/ura repo add/);
    spy.mockRestore();
  });
});

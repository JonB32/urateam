/**
 * `ura repo {add,list,remove}` — manage repos in the user-level config.
 *
 * `add`: clones the repo into `~/.urateam/repos/<slug>` and appends to
 *        `config.json`. Slug derived from the URL's trailing path
 *        (foo/bar.git → bar).
 * `list`: prints each configured repo.
 * `remove`: filters the repo out of `config.json`. The clone on disk is
 *           preserved by default — `--purge` deletes it.
 *
 * Tests stub `cloneRepo` (from `@urateam/core`) so they don't touch the
 * network or git.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoCommand } from "../commands/repo.js";
import {
  readUserLevelConfig,
  writeUserLevelConfig,
} from "../lib/user-level-config.js";

vi.mock("@urateam/core", async () => {
  const actual: any = await vi.importActual("@urateam/core");
  return {
    ...actual,
    cloneRepo: vi.fn(async (url: string, dest: string) => {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, ".cloned"), url);
    }),
  };
});

describe("ura repo add", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-repo-"));
    process.env.URATEAM_HOME = tmp;
    writeUserLevelConfig({ version: 1, repos: [] });
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("clones into ~/.urateam/repos/<slug> and appends to config.json", async () => {
    await repoCommand.parseAsync(
      ["add", "https://github.com/foo/bar.git"],
      { from: "user" },
    );
    const cfg = readUserLevelConfig();
    expect(cfg?.repos).toHaveLength(1);
    expect(cfg?.repos[0]!.url).toBe("https://github.com/foo/bar.git");
    expect(cfg?.repos[0]!.path).toBe(join(tmp, "repos", "bar"));
    expect(cfg?.repos[0]!.defaultBranch).toBe("main");
  });

  it("rejects duplicate URLs", async () => {
    await repoCommand.parseAsync(
      ["add", "https://github.com/foo/bar.git"],
      { from: "user" },
    );
    await expect(
      repoCommand.parseAsync(
        ["add", "https://github.com/foo/bar.git"],
        { from: "user" },
      ),
    ).rejects.toThrow(/already configured/i);
  });

  it("derives slug from .git URL trailing path (foo/bar.git → bar)", async () => {
    await repoCommand.parseAsync(
      ["add", "git@github.com:org/awesome-tool.git"],
      { from: "user" },
    );
    expect(readUserLevelConfig()?.repos[0]!.path).toContain("awesome-tool");
  });

  it("accepts --branch override", async () => {
    await repoCommand.parseAsync(
      [
        "add",
        "https://github.com/foo/bar.git",
        "--branch",
        "develop",
      ],
      { from: "user" },
    );
    expect(readUserLevelConfig()?.repos[0]!.defaultBranch).toBe("develop");
  });

  it("accepts --team and --label-pattern", async () => {
    await repoCommand.parseAsync(
      [
        "add",
        "https://github.com/foo/bar.git",
        "--team",
        "team-abc",
        "--label-pattern",
        "auto-implement",
      ],
      { from: "user" },
    );
    const repo = readUserLevelConfig()?.repos[0]!;
    expect(repo?.teamId).toBe("team-abc");
    expect(repo?.labelPattern).toBe("auto-implement");
  });

  it("errors when 'ura init' has not been run", async () => {
    // Wipe the seeded config so the next call sees a clean slate.
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    await expect(
      repoCommand.parseAsync(
        ["add", "https://github.com/foo/bar.git"],
        { from: "user" },
      ),
    ).rejects.toThrow(/ura init/i);
  });
});

describe("ura repo list", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-list-"));
    process.env.URATEAM_HOME = tmp;
    writeUserLevelConfig({
      version: 1,
      repos: [
        {
          url: "https://github.com/a/x.git",
          path: "/p/x",
          defaultBranch: "main",
          testCommand: "pnpm test",
          buildCommand: "pnpm build",
        },
        {
          url: "https://github.com/a/y.git",
          path: "/p/y",
          defaultBranch: "main",
          testCommand: "pnpm test",
          buildCommand: "pnpm build",
        },
      ],
    });
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prints each repo's url + path on its own line", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await repoCommand.parseAsync(["list"], { from: "user" });
    const lines = spy.mock.calls.flat().join("\n");
    expect(lines).toContain("https://github.com/a/x.git");
    expect(lines).toContain("https://github.com/a/y.git");
    spy.mockRestore();
  });

  it("prints an empty-state message when no repos are configured", async () => {
    writeUserLevelConfig({ version: 1, repos: [] });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await repoCommand.parseAsync(["list"], { from: "user" });
    expect(spy.mock.calls.flat().join("\n")).toMatch(/no repos/i);
    spy.mockRestore();
  });
});

describe("ura repo remove", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-remove-"));
    process.env.URATEAM_HOME = tmp;
    writeUserLevelConfig({
      version: 1,
      repos: [
        {
          url: "https://github.com/a/x.git",
          path: join(tmp, "repos", "x"),
          defaultBranch: "main",
          testCommand: "pnpm test",
          buildCommand: "pnpm build",
        },
      ],
    });
    mkdirSync(join(tmp, "repos", "x"), { recursive: true });
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("removes the matching entry from config.json", async () => {
    await repoCommand.parseAsync(["remove", "x"], { from: "user" });
    expect(readUserLevelConfig()?.repos).toHaveLength(0);
  });

  it("preserves the clone on disk by default (no --purge)", async () => {
    await repoCommand.parseAsync(["remove", "x"], { from: "user" });
    expect(existsSync(join(tmp, "repos", "x"))).toBe(true);
  });

  it("deletes the clone when --purge is passed", async () => {
    await repoCommand.parseAsync(["remove", "x", "--purge"], {
      from: "user",
    });
    expect(existsSync(join(tmp, "repos", "x"))).toBe(false);
  });

  it("errors when the slug does not match any configured repo", async () => {
    await expect(
      repoCommand.parseAsync(["remove", "nonexistent"], { from: "user" }),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses to --purge a path outside URATEAM_HOME (hand-edited config safety)", async () => {
    // Simulate a hand-edited config.json with a dangerous path. The path's
    // basename ("etc-fake-sensitive") must match the slug arg so the entry
    // is found; the test exercises the path-safety guard, not the
    // slug-lookup path.
    writeUserLevelConfig({
      version: 1,
      repos: [
        {
          url: "https://github.com/a/etc-fake-sensitive.git",
          path: "/tmp/SAFETY_TEST_DO_NOT_DELETE/etc-fake-sensitive",
          defaultBranch: "main",
          testCommand: "pnpm test",
          buildCommand: "pnpm build",
        },
      ],
    });
    await expect(
      repoCommand.parseAsync(
        ["remove", "etc-fake-sensitive", "--purge"],
        { from: "user" },
      ),
    ).rejects.toThrow(/refusing to delete/i);
  });
});

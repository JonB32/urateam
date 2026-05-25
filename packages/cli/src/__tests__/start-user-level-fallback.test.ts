/**
 * `buildRepoConfigsFromEnv` — user-level config fallback.
 *
 * When no `REPO_*` env vars produce a RepoConfig, the function should fall
 * back to reading `~/.urateam/config.json` (or `$URATEAM_HOME/config.json`).
 * Env vars win when both are present so the existing project-level
 * `ura start` deploys are unaffected.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeUserLevelConfig } from "../lib/user-level-config.js";
import { buildRepoConfigsFromEnv } from "../lib/build-repo-configs.js";

describe("buildRepoConfigsFromEnv — user-level fallback", () => {
  let tmp: string;
  const envBackup: Record<string, string | undefined> = {};
  const ENV_KEYS_TO_STRIP = [
    "REPO_TEAM_ID",
    "REPO_URL",
    "REPO_DEFAULT_BRANCH",
    "REPO_TEST_CMD",
    "REPO_BUILD_CMD",
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-fallback-"));
    process.env.URATEAM_HOME = tmp;
    for (const k of ENV_KEYS_TO_STRIP) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete envBackup[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an empty map when no env vars and no user-level config", () => {
    expect(buildRepoConfigsFromEnv()).toEqual({});
  });

  it("loads from ~/.urateam/config.json when no REPO_* env vars are set", () => {
    writeUserLevelConfig({
      version: 1,
      repos: [
        {
          url: "https://github.com/o/r.git",
          path: "/tmp/r",
          defaultBranch: "main",
          testCommand: "pnpm test",
          buildCommand: "pnpm build",
          teamId: "team-1",
        },
      ],
    });
    const configs = buildRepoConfigsFromEnv();
    expect(configs["team-1"]).toBeDefined();
    expect(configs["team-1"]!.url).toBe("https://github.com/o/r.git");
    expect(configs["team-1"]!.defaultBranch).toBe("main");
  });

  it("propagates labelPattern when present (BEC-177 routing)", () => {
    writeUserLevelConfig({
      version: 1,
      repos: [
        {
          url: "https://github.com/o/r.git",
          path: "/tmp/r",
          defaultBranch: "main",
          testCommand: "pnpm test",
          buildCommand: "pnpm build",
          teamId: "team-1",
          labelPattern: "auto-implement",
        },
      ],
    });
    const configs = buildRepoConfigsFromEnv();
    expect(configs["team-1"]!.labelPattern).toBe("auto-implement");
  });

  it("keys repos by url-slug when teamId is omitted", () => {
    writeUserLevelConfig({
      version: 1,
      repos: [
        {
          url: "https://github.com/o/no-team.git",
          path: "/tmp/no-team",
          defaultBranch: "main",
          testCommand: "pnpm test",
          buildCommand: "pnpm build",
        },
      ],
    });
    const configs = buildRepoConfigsFromEnv();
    expect(Object.keys(configs)).toHaveLength(1);
    const key = Object.keys(configs)[0]!;
    expect(key).toContain("no-team");
  });

  it("env vars win over user-level config (project-level back-compat)", () => {
    writeUserLevelConfig({
      version: 1,
      repos: [
        {
          url: "https://github.com/user-level/r.git",
          path: "/p",
          defaultBranch: "main",
          testCommand: "pnpm test",
          buildCommand: "pnpm build",
          teamId: "team-userlevel",
        },
      ],
    });
    process.env.REPO_TEAM_ID = "team-env";
    process.env.REPO_URL = "https://github.com/env-var/r.git";
    const configs = buildRepoConfigsFromEnv();
    expect(configs["team-env"]).toBeDefined();
    expect(configs["team-env"]!.url).toBe("https://github.com/env-var/r.git");
    expect(configs["team-userlevel"]).toBeUndefined();
  });

  it("handles multiple repos in the user-level config", () => {
    writeUserLevelConfig({
      version: 1,
      repos: [
        {
          url: "https://github.com/o/a.git",
          path: "/tmp/a",
          defaultBranch: "main",
          testCommand: "pnpm test",
          buildCommand: "pnpm build",
          teamId: "team-a",
        },
        {
          url: "https://github.com/o/b.git",
          path: "/tmp/b",
          defaultBranch: "main",
          testCommand: "pnpm test",
          buildCommand: "pnpm build",
          teamId: "team-b",
        },
      ],
    });
    const configs = buildRepoConfigsFromEnv();
    expect(Object.keys(configs).sort()).toEqual(["team-a", "team-b"]);
  });
});

describe("requireRepoConfigs — branched error messages", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-req-"));
    process.env.URATEAM_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prints a 'ura repo add' hint when ~/.urateam/config.json exists but has no repos", async () => {
    writeUserLevelConfig({ version: 1, repos: [] });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    const { requireRepoConfigs } = await import("../lib/build-repo-configs.js");
    expect(() => requireRepoConfigs({}, "ura start")).toThrow();
    const msg = errSpy.mock.calls.flat().join("\n");
    expect(msg).toContain("ura repo add");
    expect(msg).not.toContain("REPO_TEAM_ID and REPO_URL in .urateam/.env"); // user-level branch
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("prints both install paths when no ~/.urateam/config.json exists yet", async () => {
    // Don't write a config — exercises the `userConfig === null` branch
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    const { requireRepoConfigs } = await import("../lib/build-repo-configs.js");
    expect(() => requireRepoConfigs({}, "ura start")).toThrow();
    const msg = errSpy.mock.calls.flat().join("\n");
    expect(msg).toContain("REPO_TEAM_ID");
    expect(msg).toContain("ura init");
    expect(msg).toContain("ura repo add");
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// vi needs to be available — re-import at top-level for the new tests
import { vi } from "vitest";

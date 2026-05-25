/**
 * User-level config — schema + read/write/path helpers.
 *
 * The user-level install path stores its state at `~/.urateam/` (or
 * `$URATEAM_HOME` when set). This module is the source of truth for the
 * schema, the on-disk locations, and the round-trip read/write contract.
 *
 * Tests use a temp-dir override via `URATEAM_HOME` to keep them hermetic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveUserLevelHome,
  readUserLevelConfig,
  writeUserLevelConfig,
  UserLevelConfigSchema,
  type UserLevelConfig,
} from "../lib/user-level-config.js";

describe("resolveUserLevelHome", () => {
  const envBefore = process.env.URATEAM_HOME;
  afterEach(() => {
    if (envBefore === undefined) delete process.env.URATEAM_HOME;
    else process.env.URATEAM_HOME = envBefore;
  });

  it("returns ~/.urateam by default", () => {
    delete process.env.URATEAM_HOME;
    const home = resolveUserLevelHome();
    expect(home.endsWith("/.urateam")).toBe(true);
  });

  it("honors URATEAM_HOME override", () => {
    process.env.URATEAM_HOME = "/tmp/test-urateam";
    expect(resolveUserLevelHome()).toBe("/tmp/test-urateam");
  });
});

describe("readUserLevelConfig / writeUserLevelConfig", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-test-"));
    process.env.URATEAM_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips an empty config", () => {
    const config: UserLevelConfig = { version: 1, repos: [] };
    writeUserLevelConfig(config);
    expect(readUserLevelConfig()).toEqual(config);
  });

  it("returns null when the config file does not exist", () => {
    expect(readUserLevelConfig()).toBeNull();
  });

  it("validates repo entries against the zod schema (rejects malformed)", () => {
    writeFileSync(
      join(tmp, "config.json"),
      JSON.stringify({ version: 1, repos: [{ url: 42 }] }),
    );
    expect(() => readUserLevelConfig()).toThrow();
  });

  it("schema accepts minimum repo fields (url + defaultBranch + paths + commands)", () => {
    const result = UserLevelConfigSchema.safeParse({
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
    });
    expect(result.success).toBe(true);
  });

  it("schema accepts optional teamId and labelPattern", () => {
    const result = UserLevelConfigSchema.safeParse({
      version: 1,
      repos: [
        {
          url: "https://github.com/o/r.git",
          path: "/tmp/r",
          defaultBranch: "main",
          testCommand: "pnpm test",
          buildCommand: "pnpm build",
          teamId: "team-abc",
          labelPattern: "auto-implement",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repos[0]!.teamId).toBe("team-abc");
      expect(result.data.repos[0]!.labelPattern).toBe("auto-implement");
    }
  });
});

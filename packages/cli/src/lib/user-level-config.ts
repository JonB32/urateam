/**
 * User-level install — config schema, on-disk locations, read/write helpers.
 *
 * The user-level path stores everything under `~/.urateam/` (or
 * `$URATEAM_HOME` when set). Layout:
 *
 *   ~/.urateam/
 *   ├── config.json       # this module's schema
 *   ├── .env              # secrets (ANTHROPIC_API_KEY, etc.)
 *   ├── data/             # SQLite DB lives here
 *   └── repos/            # cloned repos managed by `ura repo add`
 *
 * The schema intentionally mirrors the existing `RepoConfig` shape (`url`,
 * `defaultBranch`, `testCommand`, `buildCommand`, optional `labelPattern`)
 * plus a `path` field that records WHERE the clone lives — that's the
 * field the daemon needs to actually find the worktree.
 *
 * `URATEAM_HOME` env-var override exists for two reasons:
 *   1. Tests (hermetic temp dir per test)
 *   2. Operators who want to run multiple isolated user-level installs on
 *      one machine (e.g., one per Linear workspace) without touching
 *      `~/.urateam/`.
 */
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

export const UserLevelRepoSchema = z.object({
  /** Source URL (https / git@ — anything `git clone` accepts). */
  url: z.string().min(1),
  /** Absolute filesystem path where the clone lives. */
  path: z.string().min(1),
  /** Default branch — the daemon uses this for diff/rebase targets. */
  defaultBranch: z.string().min(1),
  /** Test command invoked in the worktree. */
  testCommand: z.string().default("pnpm test"),
  /** Build command invoked in the worktree. */
  buildCommand: z.string().default("pnpm build"),
  /** Linear team ID (optional — required when promote routes by team). */
  teamId: z.string().optional(),
  /** BEC-177: label-based routing. When set, this repo handles tickets
   *  whose pipeline label matches the pattern. */
  labelPattern: z.string().optional(),
});
export type UserLevelRepo = z.infer<typeof UserLevelRepoSchema>;

export const UserLevelConfigSchema = z.object({
  /** Schema version — bumped if/when the file format changes. */
  version: z.literal(1),
  /** Configured repos. `ura repo add` appends; `ura repo remove` filters. */
  repos: z.array(UserLevelRepoSchema).default([]),
});
export type UserLevelConfig = z.infer<typeof UserLevelConfigSchema>;

/**
 * Resolve the user-level state directory. Returns `$URATEAM_HOME` when set,
 * otherwise `~/.urateam`.
 */
export function resolveUserLevelHome(): string {
  return process.env.URATEAM_HOME ?? join(homedir(), ".urateam");
}

export function userLevelConfigPath(): string {
  return join(resolveUserLevelHome(), "config.json");
}

export function userLevelReposDir(): string {
  return join(resolveUserLevelHome(), "repos");
}

export function userLevelDataDir(): string {
  return join(resolveUserLevelHome(), "data");
}

/**
 * Read and validate the user-level config. Returns `null` when the file
 * doesn't exist (so callers can distinguish "not initialized" from "empty
 * config"). Throws on schema-validation failure — operators should see the
 * Zod error explicitly rather than silently get an unconfigured daemon.
 */
export function readUserLevelConfig(): UserLevelConfig | null {
  const path = userLevelConfigPath();
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return UserLevelConfigSchema.parse(raw);
}

/**
 * Write the user-level config, creating `~/.urateam/` if missing.
 * Idempotent: callers are expected to read-modify-write to preserve any
 * fields the writer doesn't know about (the schema is forward-compatible
 * within version 1).
 */
export function writeUserLevelConfig(config: UserLevelConfig): void {
  const home = resolveUserLevelHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(userLevelConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

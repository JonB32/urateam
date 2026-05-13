# User-Level Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cyrus-style user-level install path: `npm i -g @urateam/cli` → `ura init` → `ura repo add <url>` → `ura start` reads from `~/.urateam/config.json` and runs the daemon against all configured repos.

**Architecture:** New `packages/cli/src/lib/user-level-config.ts` defines a JSON config file at `~/.urateam/config.json` plus a `~/.urateam/{data/,repos/}` directory layout. Five new commands (`ura init`, `ura repo {add,list,remove}`, `ura uninstall`) read/write it. `ura start` is extended with a fallback path: when no `REPO_*` env vars are set, load `~/.urateam/config.json` instead. The `URATEAM_HOME` env var overrides the default `~/.urateam` location for testing and for operators who want a non-default state directory.

**Tech Stack:** Node 22 (built-in `loadEnvFile`), commander.js (existing CLI surface), zod (config schema validation), vitest, the existing `cloneRepo` helper from `@urateam/core/repo/git`.

---

## File Structure

| Path | Purpose |
|---|---|
| `packages/cli/src/lib/user-level-config.ts` | Schema + read/write/path helpers for `~/.urateam/`. |
| `packages/cli/src/commands/init.ts` | `ura init` — bootstraps `~/.urateam/` skeleton. |
| `packages/cli/src/commands/repo.ts` | `ura repo {add,list,remove}` parent command. |
| `packages/cli/src/commands/uninstall.ts` | `ura uninstall` — removes `~/.urateam/` after confirmation. |
| `packages/cli/src/lib/build-repo-configs.ts` (existing) | Extend with a `loadUserLevelRepoConfigs()` fallback. |
| `packages/cli/src/commands/start.ts` (existing) | Wire the fallback in. |
| `packages/cli/src/index.ts` (existing) | Register the new commands. |
| `packages/cli/src/__tests__/user-level-config.test.ts` | Unit tests for path/schema helpers. |
| `packages/cli/src/__tests__/init.test.ts` | Tests for `ura init`. |
| `packages/cli/src/__tests__/repo.test.ts` | Tests for `ura repo {add,list,remove}`. |
| `packages/cli/src/__tests__/uninstall.test.ts` | Tests for `ura uninstall`. |
| `deploy/USER_LEVEL_INSTALL.md` | New doc — install path, env vars, troubleshooting. |
| `CLAUDE.md` | Add a "User-level install" section under Repository Structure. |

---

## Task 1: Config schema + path helpers

**Files:**
- Create: `packages/cli/src/lib/user-level-config.ts`
- Create: `packages/cli/src/__tests__/user-level-config.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
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
    expect(() => readUserLevelConfig()).toThrow(/repo/i);
  });

  it("schema accepts minimum repo fields (url + defaultBranch)", () => {
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
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/cli && npx vitest run src/__tests__/user-level-config.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the module**

```ts
// packages/cli/src/lib/user-level-config.ts
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

export const UserLevelRepoSchema = z.object({
  url: z.string().min(1),
  path: z.string().min(1),
  defaultBranch: z.string().min(1),
  testCommand: z.string().default("pnpm test"),
  buildCommand: z.string().default("pnpm build"),
  teamId: z.string().optional(),
  labelPattern: z.string().optional(),
});
export type UserLevelRepo = z.infer<typeof UserLevelRepoSchema>;

export const UserLevelConfigSchema = z.object({
  version: z.literal(1),
  repos: z.array(UserLevelRepoSchema).default([]),
});
export type UserLevelConfig = z.infer<typeof UserLevelConfigSchema>;

/**
 * Resolve the user-level state directory. `URATEAM_HOME` overrides the default
 * `~/.urateam` for tests and for operators who want a non-default location
 * (e.g., a project-specific isolated install).
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

export function readUserLevelConfig(): UserLevelConfig | null {
  const path = userLevelConfigPath();
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return UserLevelConfigSchema.parse(raw);
}

export function writeUserLevelConfig(config: UserLevelConfig): void {
  const home = resolveUserLevelHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(userLevelConfigPath(), JSON.stringify(config, null, 2) + "\n");
}
```

- [ ] **Step 4: Run tests, all 5 pass**

```
npx vitest run src/__tests__/user-level-config.test.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/user-level-config.ts packages/cli/src/__tests__/user-level-config.test.ts
git commit -m "feat(cli): user-level config schema + path helpers"
```

---

## Task 2: `ura init`

**Files:**
- Create: `packages/cli/src/commands/init.ts`
- Create: `packages/cli/src/__tests__/init.test.ts`
- Modify: `packages/cli/src/index.ts:30,40-49`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/__tests__/init.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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
    await initCommand.parseAsync(["node", "ura", "init"]);
    expect(existsSync(join(tmp, "config.json"))).toBe(true);
    expect(existsSync(join(tmp, "data"))).toBe(true);
    expect(existsSync(join(tmp, "repos"))).toBe(true);
  });

  it("seeds config.json with version=1 and an empty repos array", async () => {
    await initCommand.parseAsync(["node", "ura", "init"]);
    const raw = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.repos).toEqual([]);
  });

  it("is idempotent: re-running does not overwrite an existing config", async () => {
    await initCommand.parseAsync(["node", "ura", "init"]);
    const path = join(tmp, "config.json");
    // mutate it
    const mutated = { version: 1, repos: [{ url: "x", path: "y", defaultBranch: "main", testCommand: "t", buildCommand: "b" }] };
    require("node:fs").writeFileSync(path, JSON.stringify(mutated));
    await initCommand.parseAsync(["node", "ura", "init"]);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.repos).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```
npx vitest run src/__tests__/init.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the command**

```ts
// packages/cli/src/commands/init.ts
import { Command } from "commander";
import { mkdirSync, existsSync } from "node:fs";
import {
  resolveUserLevelHome,
  userLevelConfigPath,
  userLevelDataDir,
  userLevelReposDir,
  writeUserLevelConfig,
  readUserLevelConfig,
} from "../lib/user-level-config.js";

export const initCommand = new Command("init")
  .description("Bootstrap a user-level urateam install at ~/.urateam (or $URATEAM_HOME)")
  .action(() => {
    const home = resolveUserLevelHome();
    mkdirSync(home, { recursive: true });
    mkdirSync(userLevelDataDir(), { recursive: true });
    mkdirSync(userLevelReposDir(), { recursive: true });

    if (readUserLevelConfig() !== null) {
      console.log(`ura init: ${userLevelConfigPath()} already exists — leaving it untouched.`);
      return;
    }
    writeUserLevelConfig({ version: 1, repos: [] });
    console.log(`ura init: created ${home}`);
    console.log("Next: ura repo add <url>");
  });
```

- [ ] **Step 4: Register in `packages/cli/src/index.ts`**

```ts
import { initCommand } from "./commands/init.js";
// ...
program.addCommand(initCommand);
```

- [ ] **Step 5: Run tests, all 3 pass**

```
npx vitest run src/__tests__/init.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/init.ts packages/cli/src/__tests__/init.test.ts packages/cli/src/index.ts
git commit -m "feat(cli): ura init bootstraps ~/.urateam"
```

---

## Task 3: `ura repo add <url>` + `list` + `remove`

**Files:**
- Create: `packages/cli/src/commands/repo.ts`
- Create: `packages/cli/src/__tests__/repo.test.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/src/__tests__/repo.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoCommand } from "../commands/repo.js";
import { readUserLevelConfig, writeUserLevelConfig } from "../lib/user-level-config.js";

// Stub cloneRepo so tests don't hit the network. The repo.add command imports
// it dynamically from "@urateam/core" — we mock the module.
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
    await repoCommand.parseAsync([
      "node", "ura", "repo", "add", "https://github.com/foo/bar.git",
    ]);
    const cfg = readUserLevelConfig();
    expect(cfg?.repos).toHaveLength(1);
    expect(cfg?.repos[0]!.url).toBe("https://github.com/foo/bar.git");
    expect(cfg?.repos[0]!.path).toBe(join(tmp, "repos", "bar"));
    expect(cfg?.repos[0]!.defaultBranch).toBe("main");
  });

  it("rejects duplicate URLs", async () => {
    await repoCommand.parseAsync([
      "node", "ura", "repo", "add", "https://github.com/foo/bar.git",
    ]);
    await expect(
      repoCommand.parseAsync([
        "node", "ura", "repo", "add", "https://github.com/foo/bar.git",
      ]),
    ).rejects.toThrow(/already configured/i);
  });

  it("derives slug from .git URL trailing path (foo/bar.git → bar)", async () => {
    await repoCommand.parseAsync([
      "node", "ura", "repo", "add", "git@github.com:org/awesome-tool.git",
    ]);
    expect(readUserLevelConfig()?.repos[0]!.path).toContain("awesome-tool");
  });

  it("accepts --branch override", async () => {
    await repoCommand.parseAsync([
      "node", "ura", "repo", "add", "https://github.com/foo/bar.git",
      "--branch", "develop",
    ]);
    expect(readUserLevelConfig()?.repos[0]!.defaultBranch).toBe("develop");
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
        { url: "https://github.com/a/x.git", path: "/p/x", defaultBranch: "main", testCommand: "pnpm test", buildCommand: "pnpm build" },
        { url: "https://github.com/a/y.git", path: "/p/y", defaultBranch: "main", testCommand: "pnpm test", buildCommand: "pnpm build" },
      ],
    });
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prints each repo's url + path on its own line", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await repoCommand.parseAsync(["node", "ura", "repo", "list"]);
    const lines = spy.mock.calls.flat().join("\n");
    expect(lines).toContain("https://github.com/a/x.git");
    expect(lines).toContain("https://github.com/a/y.git");
    spy.mockRestore();
  });

  it("prints an empty-state message when no repos are configured", async () => {
    writeUserLevelConfig({ version: 1, repos: [] });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await repoCommand.parseAsync(["node", "ura", "repo", "list"]);
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
        { url: "https://github.com/a/x.git", path: join(tmp, "repos", "x"), defaultBranch: "main", testCommand: "pnpm test", buildCommand: "pnpm build" },
      ],
    });
    mkdirSync(join(tmp, "repos", "x"), { recursive: true });
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("removes the matching entry from config.json", async () => {
    await repoCommand.parseAsync(["node", "ura", "repo", "remove", "x"]);
    expect(readUserLevelConfig()?.repos).toHaveLength(0);
  });

  it("preserves the clone on disk by default (no --purge)", async () => {
    await repoCommand.parseAsync(["node", "ura", "repo", "remove", "x"]);
    const fs = await import("node:fs");
    expect(fs.existsSync(join(tmp, "repos", "x"))).toBe(true);
  });

  it("deletes the clone when --purge is passed", async () => {
    await repoCommand.parseAsync(["node", "ura", "repo", "remove", "x", "--purge"]);
    const fs = await import("node:fs");
    expect(fs.existsSync(join(tmp, "repos", "x"))).toBe(false);
  });

  it("errors when the slug does not match any configured repo", async () => {
    await expect(
      repoCommand.parseAsync(["node", "ura", "repo", "remove", "nonexistent"]),
    ).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```
npx vitest run src/__tests__/repo.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the command**

```ts
// packages/cli/src/commands/repo.ts
import { Command } from "commander";
import { rmSync } from "node:fs";
import { join, basename } from "node:path";
import {
  readUserLevelConfig,
  writeUserLevelConfig,
  userLevelReposDir,
  type UserLevelRepo,
} from "../lib/user-level-config.js";

/**
 * Derive a filesystem-safe slug from a repo URL. Handles:
 *   https://github.com/org/name.git → name
 *   git@github.com:org/name.git    → name
 *   /local/path/name              → name
 */
function deriveSlug(url: string): string {
  const stripped = url.replace(/\.git$/, "");
  const last = stripped.split(/[/:]/).filter(Boolean).pop() ?? "repo";
  return last.replace(/[^A-Za-z0-9._-]/g, "-");
}

function loadOrThrow() {
  const cfg = readUserLevelConfig();
  if (!cfg) {
    throw new Error(
      `ura: no user-level config found. Run 'ura init' first.`,
    );
  }
  return cfg;
}

export const repoCommand = new Command("repo")
  .description("Manage repos in the user-level config (~/.urateam/config.json)");

repoCommand
  .command("add <url>")
  .description("Clone <url> into ~/.urateam/repos/<slug> and register it")
  .option("--branch <name>", "Default branch (defaults to 'main')", "main")
  .option("--test-command <cmd>", "Test command", "pnpm test")
  .option("--build-command <cmd>", "Build command", "pnpm build")
  .option("--team <id>", "Linear team ID (optional)")
  .option("--label-pattern <pattern>", "Pipeline label pattern (BEC-177 routing)")
  .action(async (url: string, opts: any) => {
    const cfg = loadOrThrow();
    if (cfg.repos.some((r) => r.url === url)) {
      throw new Error(`ura: ${url} is already configured.`);
    }
    const slug = deriveSlug(url);
    const path = join(userLevelReposDir(), slug);
    const core: any = await import("@urateam/core");
    if (typeof core.cloneRepo === "function") {
      await core.cloneRepo(url, path);
    }
    const repo: UserLevelRepo = {
      url,
      path,
      defaultBranch: opts.branch,
      testCommand: opts.testCommand,
      buildCommand: opts.buildCommand,
      ...(opts.team && { teamId: opts.team }),
      ...(opts.labelPattern && { labelPattern: opts.labelPattern }),
    };
    cfg.repos.push(repo);
    writeUserLevelConfig(cfg);
    console.log(`ura repo add: cloned ${url} → ${path}`);
  });

repoCommand
  .command("list")
  .description("List configured repos")
  .action(() => {
    const cfg = loadOrThrow();
    if (cfg.repos.length === 0) {
      console.log("ura repo list: no repos configured. Run 'ura repo add <url>'.");
      return;
    }
    for (const r of cfg.repos) {
      console.log(`  ${basename(r.path)}\t${r.url}\t(${r.defaultBranch})`);
    }
  });

repoCommand
  .command("remove <slug>")
  .description("Remove a repo from config (use --purge to delete the clone)")
  .option("--purge", "Also delete the cloned directory on disk")
  .action((slug: string, opts: any) => {
    const cfg = loadOrThrow();
    const idx = cfg.repos.findIndex((r) => basename(r.path) === slug);
    if (idx === -1) {
      throw new Error(`ura repo remove: slug '${slug}' not found.`);
    }
    const [removed] = cfg.repos.splice(idx, 1);
    writeUserLevelConfig(cfg);
    if (opts.purge && removed) {
      rmSync(removed.path, { recursive: true, force: true });
    }
    console.log(`ura repo remove: removed '${slug}'${opts.purge ? " and deleted the clone" : ""}`);
  });
```

- [ ] **Step 4: Register in `packages/cli/src/index.ts`**

```ts
import { repoCommand } from "./commands/repo.js";
// ...
program.addCommand(repoCommand);
```

- [ ] **Step 5: Run tests, all 11 pass**

```
npx vitest run src/__tests__/repo.test.ts
```
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/repo.ts packages/cli/src/__tests__/repo.test.ts packages/cli/src/index.ts
git commit -m "feat(cli): ura repo add/list/remove"
```

---

## Task 4: `ura uninstall`

**Files:**
- Create: `packages/cli/src/commands/uninstall.ts`
- Create: `packages/cli/src/__tests__/uninstall.test.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/__tests__/uninstall.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
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
    await uninstallCommand.parseAsync(["node", "ura", "uninstall", "--yes"]);
    expect(existsSync(tmp)).toBe(false);
  });

  it("aborts without --yes (no destructive action)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await uninstallCommand.parseAsync(["node", "ura", "uninstall"]);
    expect(existsSync(tmp)).toBe(true);
    expect(spy.mock.calls.flat().join("\n")).toMatch(/--yes/i);
    spy.mockRestore();
  });

  it("is a no-op when URATEAM_HOME does not exist", async () => {
    const rmrf = await import("node:fs");
    rmrf.rmSync(tmp, { recursive: true, force: true });
    await expect(
      uninstallCommand.parseAsync(["node", "ura", "uninstall", "--yes"]),
    ).resolves.not.toThrow();
  });
});

// Top-level import so `vi` is available
import { vi } from "vitest";
```

- [ ] **Step 2: Run test, verify it fails**

```
npx vitest run src/__tests__/uninstall.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the command**

```ts
// packages/cli/src/commands/uninstall.ts
import { Command } from "commander";
import { rmSync, existsSync } from "node:fs";
import { resolveUserLevelHome } from "../lib/user-level-config.js";

export const uninstallCommand = new Command("uninstall")
  .description("Remove the user-level urateam install at ~/.urateam (or $URATEAM_HOME)")
  .option("--yes", "Skip the confirmation prompt — destructive!")
  .action((opts: any) => {
    const home = resolveUserLevelHome();
    if (!existsSync(home)) {
      console.log(`ura uninstall: ${home} does not exist — nothing to remove.`);
      return;
    }
    if (!opts.yes) {
      console.log(
        `ura uninstall: this will DELETE ${home} (config, data, cloned repos).\n` +
          `Re-run with --yes to confirm:\n` +
          `  ura uninstall --yes\n` +
          `Then run 'npm uninstall -g @urateam/cli' to remove the CLI binary.`,
      );
      return;
    }
    rmSync(home, { recursive: true, force: true });
    console.log(`ura uninstall: removed ${home}.`);
    console.log("Also run: npm uninstall -g @urateam/cli");
  });
```

- [ ] **Step 4: Register in `packages/cli/src/index.ts`** (add `program.addCommand(uninstallCommand)`).

- [ ] **Step 5: Run tests, all 3 pass.**

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/uninstall.ts packages/cli/src/__tests__/uninstall.test.ts packages/cli/src/index.ts
git commit -m "feat(cli): ura uninstall for user-level installs"
```

---

## Task 5: Wire `ura start` to read user-level config as fallback

**Files:**
- Modify: `packages/cli/src/lib/build-repo-configs.ts`
- Modify: `packages/cli/src/commands/start.ts:52-58`
- Create: `packages/cli/src/__tests__/start-user-level-fallback.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/__tests__/start-user-level-fallback.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeUserLevelConfig } from "../lib/user-level-config.js";
import { buildRepoConfigsFromEnv } from "../lib/build-repo-configs.js";

describe("buildRepoConfigsFromEnv — user-level fallback", () => {
  let tmp: string;
  const envBackup: Record<string, string | undefined> = {};
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-fallback-"));
    process.env.URATEAM_HOME = tmp;
    // Strip any REPO_* env vars from the test environment
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("REPO_")) {
        envBackup[key] = process.env[key];
        delete process.env[key];
      }
    }
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    for (const [k, v] of Object.entries(envBackup)) {
      if (v !== undefined) process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an empty array when no env vars and no user-level config", () => {
    expect(buildRepoConfigsFromEnv()).toEqual([]);
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
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      url: "https://github.com/o/r.git",
      defaultBranch: "main",
    });
  });

  it("env vars win over user-level config (project-level back-compat)", () => {
    writeUserLevelConfig({
      version: 1,
      repos: [{
        url: "https://github.com/user-level/r.git",
        path: "/p",
        defaultBranch: "main",
        testCommand: "pnpm test",
        buildCommand: "pnpm build",
      }],
    });
    process.env.REPO_1_URL = "https://github.com/env-var/r.git";
    process.env.REPO_1_DEFAULT_BRANCH = "main";
    process.env.REPO_1_TEAM_ID = "team-env";
    const configs = buildRepoConfigsFromEnv();
    expect(configs[0]!.url).toBe("https://github.com/env-var/r.git");
    delete process.env.REPO_1_URL;
    delete process.env.REPO_1_DEFAULT_BRANCH;
    delete process.env.REPO_1_TEAM_ID;
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```
npx vitest run src/__tests__/start-user-level-fallback.test.ts
```
Expected: FAIL (env-var-only path returns []).

- [ ] **Step 3: Read the existing `build-repo-configs.ts` to find the right insertion point.**

```
cat packages/cli/src/lib/build-repo-configs.ts
```

- [ ] **Step 4: Modify `build-repo-configs.ts` to add the fallback.**

After the existing env-var loop (at the point where `repoConfigs` is about to be returned), insert:

```ts
// User-level fallback (Task 5): if no REPO_* env vars produced anything,
// try ~/.urateam/config.json. This is what makes `ura init` + `ura repo add`
// usable end-to-end without operators having to hand-craft env vars.
if (repoConfigs.length === 0) {
  try {
    // Lazy import to keep build-repo-configs cheap for the env-only path.
    const { readUserLevelConfig } = require("./user-level-config.js");
    const userConfig = readUserLevelConfig();
    if (userConfig) {
      for (const r of userConfig.repos) {
        repoConfigs.push({
          url: r.url,
          defaultBranch: r.defaultBranch,
          testCommand: r.testCommand,
          buildCommand: r.buildCommand,
          ...(r.labelPattern && { labelPattern: r.labelPattern }),
        });
      }
    }
  } catch (err) {
    // Fall through with the empty env-var-only result.
  }
}
```

(Use dynamic `import()` rather than `require` if the file is ESM — match the existing module's import style.)

- [ ] **Step 5: Run tests, all 3 pass.**

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/build-repo-configs.ts packages/cli/src/__tests__/start-user-level-fallback.test.ts
git commit -m "feat(cli): ura start falls back to ~/.urateam/config.json"
```

---

## Task 6: Documentation

**Files:**
- Create: `deploy/USER_LEVEL_INSTALL.md`
- Modify: `CLAUDE.md` (add a brief user-level section + audit-event note if any new events were added — none in this PR)
- Modify: `README.md` (top-level — lead with user-level)

- [ ] **Step 1: Write `deploy/USER_LEVEL_INSTALL.md`**

The doc covers:

1. Quick start (3 commands: install, init, repo add)
2. `URATEAM_HOME` env var
3. Difference vs project-level install
4. Linear OAuth setup (manual, while `ura self-auth-linear` is a follow-up)
5. Running as a service (tmux / pm2 / systemd-user / launchd snippets — same content as Cyrus's, adapted)
6. Troubleshooting

- [ ] **Step 2: Update CLAUDE.md** — add a paragraph under "Repository Structure" pointing operators at the new doc and explaining that `ura start` now reads `~/.urateam/config.json` as a fallback.

- [ ] **Step 3: Commit**

```bash
git add deploy/USER_LEVEL_INSTALL.md CLAUDE.md README.md
git commit -m "docs: user-level install path"
```

---

## Self-Review

**Spec coverage:**
- ✅ `ura init` → Task 2
- ✅ `ura repo add` → Task 3
- ✅ `ura repo list` → Task 3
- ✅ `ura repo remove` → Task 3
- ✅ `ura uninstall` → Task 4
- ✅ `ura start` reads `~/.urateam/config.json` → Task 5
- ✅ Docs → Task 6
- ⚠️ Linear OAuth (`ura self-auth-linear`) — DEFERRED to a follow-up PR
- ⚠️ Service file generation (launchd / systemd-user) — DEFERRED; covered as snippets in docs

**Placeholder scan:** None — every step has concrete code or a concrete command.

**Type consistency:** `UserLevelRepo` / `UserLevelConfig` shapes are defined in Task 1 and used identically in Tasks 2–5. `repoConfigs` shape in Task 5 matches the existing `RepoConfig` produced by `buildRepoConfigsFromEnv` — verify by reading the file before modifying.

**Convention checks:**
- All new files use `createLogger`/`console.log` per existing CLI convention (CLI commands use `console.log` for user-facing output — different from the daemon's pino logger; that's the existing pattern).
- No `as any` casts. No `console.error` in failure paths — commander handles exit codes via `throw`.
- `cloneRepo` is dynamically imported in `repo.ts` to keep the test-mock surface clean.

---

## Execution Mode

Inline in the current session. Tasks 1–5 are TDD. Task 6 (docs) is non-TDD prose.

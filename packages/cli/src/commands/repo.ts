import { Command } from "commander";
import { rmSync } from "node:fs";
import { join, basename } from "node:path";
import { cloneRepo } from "@urateam/core";
import {
  readUserLevelConfig,
  writeUserLevelConfig,
  userLevelReposDir,
  type UserLevelRepo,
} from "../lib/user-level-config.js";

/**
 * Derive a filesystem-safe slug from a repo URL. Handles:
 *   https://github.com/org/name.git   → "name"
 *   git@github.com:org/name.git       → "name"
 *   ssh://git@host/path/to/name       → "name"
 *
 * Characters outside `[A-Za-z0-9._-]` are replaced with `-` so the slug
 * survives use as a directory name on every platform we target.
 */
function deriveSlug(url: string): string {
  const stripped = url.replace(/\.git$/, "");
  const last = stripped.split(/[/:]/).filter(Boolean).pop() ?? "repo";
  return last.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Load the user-level config, or throw a helpful "run `ura init` first"
 * error so the operator isn't left guessing why the command failed.
 */
function loadOrThrow() {
  const cfg = readUserLevelConfig();
  if (!cfg) {
    throw new Error(
      `ura: no user-level config found. Run 'ura init' first.`,
    );
  }
  return cfg;
}

/**
 * `ura repo` — the parent command. The subcommands below carry the
 * actual behavior.
 */
export const repoCommand = new Command("repo").description(
  "Manage repos in the user-level config (~/.urateam/config.json)",
);

/**
 * `ura repo add <url> [--branch] [--test-command] [--build-command]
 *                     [--team] [--label-pattern]`
 *
 * Clones the repo into `~/.urateam/repos/<slug>` and appends to
 * `config.json`. Rejects duplicate URLs so re-running by accident doesn't
 * produce two near-identical entries for the same upstream.
 */
repoCommand
  .command("add <url>")
  .description("Clone <url> into ~/.urateam/repos/<slug> and register it")
  .option("--branch <name>", "Default branch (defaults to 'main')", "main")
  .option("--test-command <cmd>", "Test command", "pnpm test")
  .option("--build-command <cmd>", "Build command", "pnpm build")
  .option("--team <id>", "Linear team ID (optional)")
  .option(
    "--label-pattern <pattern>",
    "Pipeline label pattern (BEC-177 routing)",
  )
  .action(async (url: string, opts: any) => {
    const cfg = loadOrThrow();
    if (cfg.repos.some((r) => r.url === url)) {
      throw new Error(`ura: ${url} is already configured.`);
    }
    const slug = deriveSlug(url);
    const path = join(userLevelReposDir(), slug);
    await cloneRepo(url, path);
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

/**
 * `ura repo list` — print the configured repos.
 *
 * Output is plain text; one repo per line. When no repos are configured,
 * prints a hint pointing at `ura repo add`.
 */
repoCommand
  .command("list")
  .description("List configured repos")
  .action(() => {
    const cfg = loadOrThrow();
    if (cfg.repos.length === 0) {
      console.log(
        "ura repo list: no repos configured. Run 'ura repo add <url>'.",
      );
      return;
    }
    for (const r of cfg.repos) {
      console.log(`  ${basename(r.path)}\t${r.url}\t(${r.defaultBranch})`);
    }
  });

/**
 * `ura repo remove <slug> [--purge]`
 *
 * Removes the repo from `config.json`. The clone on disk is preserved by
 * default so operators don't lose uncommitted work; `--purge` deletes the
 * directory after the config update.
 */
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
    console.log(
      `ura repo remove: removed '${slug}'${
        opts.purge ? " and deleted the clone" : ""
      }`,
    );
  });

/**
 * Shared helpers for building RepoConfig maps from standard env vars.
 * Used by both `ura dev` and `ura start` so both paths honour the same
 * env-var names and defaults — removing the duplication that existed in
 * dev.ts and start.ts before BEC-152 (deep-review pass 1).
 */
import type { RepoConfig } from "@urateam/core";
import { repoPluginsFromEnv } from "./repo-plugins-from-env.js";
import { readUserLevelConfig } from "./user-level-config.js";

function parseCsv(raw: string): string[] {
  return raw.split(",").filter(Boolean);
}

/**
 * Build a RepoConfig map from standard env vars.
 *
 * Recognised env vars (all optional except REPO_TEAM_ID + REPO_URL):
 *   REPO_TEAM_ID             — Linear team ID (key in the returned map)
 *   REPO_URL                 — Git remote URL
 *   REPO_DEFAULT_BRANCH      — default "main"
 *   REPO_TEST_CMD            — default "pnpm test"
 *   REPO_BUILD_CMD           — default "pnpm build"
 *   GITHUB_WEBHOOK_SECRET    — enables githubFeedback sub-config
 *   GITHUB_FEEDBACK_AUTO_TRIGGER          — default "true"
 *   GITHUB_FEEDBACK_TRIGGER_KEYWORD       — keyword required in comments
 *   GITHUB_FEEDBACK_ALLOWED_REVIEWERS     — csv of allowed GitHub usernames
 *   GITHUB_FEEDBACK_BOT_LOGINS           — csv of bot login names
 *   REPO_EXCLUDE_PLUGINS                  — via repoPluginsFromEnv()
 *   REPO_EXCLUDE_MCP_SERVERS              — via repoPluginsFromEnv()
 *   REPO_DISABLE_PLUGIN_AUTODETECT        — via repoPluginsFromEnv()
 *
 * Returns an empty object when REPO_TEAM_ID or REPO_URL is unset.
 */
export function buildRepoConfigsFromEnv(): Record<string, RepoConfig> {
  const repoConfigs: Record<string, RepoConfig> = {};
  if (process.env.REPO_TEAM_ID && process.env.REPO_URL) {
    const repoEntry: RepoConfig = {
      url: process.env.REPO_URL,
      defaultBranch: process.env.REPO_DEFAULT_BRANCH ?? "main",
      testCommand: process.env.REPO_TEST_CMD ?? "pnpm test",
      buildCommand: process.env.REPO_BUILD_CMD ?? "pnpm build",
    };

    if (process.env.GITHUB_WEBHOOK_SECRET) {
      repoEntry.githubFeedback = {
        autoTrigger: process.env.GITHUB_FEEDBACK_AUTO_TRIGGER !== "false",
        triggerKeyword: process.env.GITHUB_FEEDBACK_TRIGGER_KEYWORD,
        allowedReviewers: process.env.GITHUB_FEEDBACK_ALLOWED_REVIEWERS
          ? parseCsv(process.env.GITHUB_FEEDBACK_ALLOWED_REVIEWERS)
          : undefined,
        botLogins: process.env.GITHUB_FEEDBACK_BOT_LOGINS
          ? parseCsv(process.env.GITHUB_FEEDBACK_BOT_LOGINS)
          : undefined,
      };
    }

    const pluginCfg = repoPluginsFromEnv();
    if (pluginCfg) repoEntry.plugins = pluginCfg;

    repoConfigs[process.env.REPO_TEAM_ID] = repoEntry;
    return repoConfigs;
  }

  // User-level fallback: when no REPO_* env vars produced anything, try
  // ~/.urateam/config.json (or $URATEAM_HOME/config.json). This is what
  // makes the `ura init` + `ura repo add` path usable end-to-end without
  // operators having to hand-craft env vars.
  //
  // Read failures (malformed JSON, schema-validation error) bubble up —
  // the operator should see the error explicitly rather than silently get
  // an unconfigured daemon.
  const userConfig = readUserLevelConfig();
  if (!userConfig || userConfig.repos.length === 0) return repoConfigs;

  for (const repo of userConfig.repos) {
    const entry: RepoConfig = {
      url: repo.url,
      defaultBranch: repo.defaultBranch,
      testCommand: repo.testCommand,
      buildCommand: repo.buildCommand,
      ...(repo.labelPattern && { labelPattern: repo.labelPattern }),
    };
    // Key by teamId when present (matches the existing env-var schema);
    // fall back to a slug derived from the URL so config.json entries
    // without a teamId still get a stable key.
    const key = repo.teamId ?? deriveKeyFromUrl(repo.url);
    repoConfigs[key] = entry;
  }
  return repoConfigs;
}

/**
 * Derive a synthetic Record key from a repo URL when the user-level config
 * entry omits `teamId`. Mirrors the slug logic in `commands/repo.ts` but
 * lives here too so this file doesn't import from a sibling that pulls in
 * commander.
 */
function deriveKeyFromUrl(url: string): string {
  const stripped = url.replace(/\.git$/, "");
  const last = stripped.split(/[/:]/).filter(Boolean).pop() ?? "repo";
  return last.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Fail-fast guard: exits 1 with a clear operator-actionable error if
 * `repoConfigs` is empty.
 *
 * Without this guard the server starts looking healthy in logs but silently
 * fails every inbound Linear event with "no repo mapping". The first-time-
 * user setup path nearly always hits this because .urateam/.env ships with
 * `REPO_URL=` and `REPO_TEAM_ID=` blank. See urateam#33.
 */
export function requireRepoConfigs(
  repoConfigs: Record<string, unknown>,
  command: "ura dev" | "ura start",
): void {
  if (Object.keys(repoConfigs).length > 0) return;
  // Branch the error message based on whether `ura init` has been run.
  // Users on the user-level install path who forgot `ura repo add` need
  // very different advice than project-level operators who forgot the
  // env vars.
  const userConfig = readUserLevelConfig();
  if (userConfig) {
    // `ura init` has run; they just need to add a repo.
    console.error(
      `Error: no repos configured in ${process.env.URATEAM_HOME ?? "~/.urateam"}/config.json.\n` +
        "Run 'ura repo add <url> [--team <linear-team-id>]' to register a repo.\n" +
        "Example:\n" +
        "  ura repo add https://github.com/org/repo.git --team team-uuid\n" +
        `\n(command: ${command})\n`,
    );
  } else {
    console.error(
      "Error: no repoConfigs could be built.\n" +
        "Two install paths exist:\n\n" +
        "  Project-level (sidecar, env-var-driven):\n" +
        "    Set REPO_TEAM_ID and REPO_URL in .urateam/.env and restart.\n" +
        "    Example:\n" +
        "      REPO_TEAM_ID=<your Linear team UUID — usually the same as LINEAR_TEAM_ID>\n" +
        "      REPO_URL=https://github.com/org/repo\n\n" +
        "  User-level (~/.urateam config-file-driven):\n" +
        "    Run 'ura init' then 'ura repo add <url> --team <id>'.\n" +
        "    See deploy/USER_LEVEL_INSTALL.md.\n" +
        `\n(command: ${command})\n`,
    );
  }
  process.exit(1);
}

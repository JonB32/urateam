/**
 * Shared helpers for building RepoConfig maps from standard env vars.
 * Used by both `ura dev` and `ura start` so both paths honour the same
 * env-var names and defaults — removing the duplication that existed in
 * dev.ts and start.ts before BEC-152 (deep-review pass 1).
 */
import type { RepoConfig } from "@urateam/core";
import { repoPluginsFromEnv } from "./repo-plugins-from-env.js";

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
  if (!process.env.REPO_TEAM_ID || !process.env.REPO_URL) return repoConfigs;

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
  console.error(
    "Error: no repoConfigs could be built from environment variables.\n" +
      "Set REPO_TEAM_ID and REPO_URL in .urateam/.env and restart.\n" +
      "Example:\n" +
      "  REPO_TEAM_ID=<your Linear team UUID — usually the same as LINEAR_TEAM_ID>\n" +
      `  REPO_URL=https://github.com/org/repo\n` +
      `\n(command: ${command})\n`,
  );
  process.exit(1);
}

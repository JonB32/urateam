/**
 * Build GitHub App config from standard env vars.
 *
 * Used by both `packages/core/src/entrypoint.ts` (the standalone core
 * server) and `packages/cli/src/commands/start.ts` (the production CLI)
 * so both paths honour the same env-var names — removing the duplication
 * that existed before BEC-152 deep-review pass 1.
 *
 * Recognised env vars:
 *   GITHUB_APP_ID            — GitHub App ID (required to enable)
 *   GITHUB_PRIVATE_KEY_PATH  — path to the .pem private key file (required)
 *   GITHUB_INSTALLATION_ID   — installation ID (optional)
 */
import { readFileSync } from "node:fs";
import type { GitHubConfig } from "./github.js";
import { parseOptPosInt } from "../util/env.js";

/**
 * Build an optional `GitHubConfig` from standard env vars.
 * Returns `undefined` when `GITHUB_APP_ID` is not set.
 */
export function buildGitHubConfigFromEnv(): GitHubConfig | undefined {
  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_PRIVATE_KEY_PATH) {
    return undefined;
  }
  return {
    appId: process.env.GITHUB_APP_ID,
    privateKey: readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, "utf-8"),
    installationId: parseOptPosInt(process.env.GITHUB_INSTALLATION_ID),
  };
}

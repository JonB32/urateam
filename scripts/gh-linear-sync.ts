#!/usr/bin/env tsx
/**
 * GitHub Issues → Linear sync entry point.
 *
 * Invoked hourly by the `.github/workflows/gh-linear-sync.yml` GitHub Action.
 * All configuration is supplied via environment variables.
 *
 * Usage (local dev):
 *   pnpm build
 *   GH_LINEAR_SYNC_GITHUB_TOKEN=ghp_... \
 *   GH_LINEAR_SYNC_GITHUB_REPO=owner/repo \
 *   GH_LINEAR_SYNC_LINEAR_API_KEY=lin_api_... \
 *   GH_LINEAR_SYNC_LINEAR_TEAM_ID=team-uuid \
 *   pnpm exec tsx scripts/gh-linear-sync.ts
 *
 * For full configuration reference see deploy/GH_LINEAR_SYNC_SETUP.md.
 */

import {
  runGhLinearSync,
  createGitHubSyncClientFromToken,
  createLinearSyncClientFromApiKey,
  type GhLinearSyncConfig,
} from "@urateam/core";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        "See deploy/GH_LINEAR_SYNC_SETUP.md for setup instructions.",
    );
  }
  return val;
}

async function main(): Promise<void> {
  const config: GhLinearSyncConfig = {
    githubToken: requireEnv("GH_LINEAR_SYNC_GITHUB_TOKEN"),
    githubRepo: requireEnv("GH_LINEAR_SYNC_GITHUB_REPO"),
    linearApiKey: requireEnv("GH_LINEAR_SYNC_LINEAR_API_KEY"),
    linearTeamId: requireEnv("GH_LINEAR_SYNC_LINEAR_TEAM_ID"),
    labelFilters: process.env.GH_LINEAR_SYNC_LABEL_FILTERS
      ? process.env.GH_LINEAR_SYNC_LABEL_FILTERS.split(",").map((l) => l.trim()).filter(Boolean)
      : undefined,
    triageStateName: process.env.GH_LINEAR_SYNC_TRIAGE_STATE ?? "Triage",
    bidirectionalClose: process.env.GH_LINEAR_SYNC_BIDIRECTIONAL_CLOSE === "true",
    dryRun: process.env.GH_LINEAR_SYNC_DRY_RUN === "true",
  };

  if (config.dryRun) {
    console.log("[dry-run] No issues will be created or closed.");
  }

  const githubClient = await createGitHubSyncClientFromToken(config.githubToken);
  const linearClient = await createLinearSyncClientFromApiKey(config.linearApiKey);

  const result = await runGhLinearSync(config, {
    github: githubClient,
    linear: linearClient,
  });

  console.log("Sync complete:");
  console.log(`  Processed : ${result.processed}`);
  console.log(`  Created   : ${result.created}`);
  console.log(`  Skipped   : ${result.skipped}`);
  console.log(`  Closed    : ${result.closed}`);

  if (result.errors.length > 0) {
    console.error(`  Errors (${result.errors.length}):`);
    for (const err of result.errors) {
      console.error(`    - ${err}`);
    }
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(
    "Fatal error:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});

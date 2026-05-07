import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { serve } from "@hono/node-server";
import { createApp } from "./server.js";
import { defaultConfigs } from "./pipeline/config.js";
import type { GitHubConfig } from "./repo/github.js";
import { cleanupWorktrees } from "./repo/git.js";

// Build optional GitHub config from env vars
let github: GitHubConfig | undefined;
if (process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY_PATH) {
  github = {
    appId: process.env.GITHUB_APP_ID,
    privateKey: readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, "utf-8"),
    installationId: process.env.GITHUB_INSTALLATION_ID
      ? parseInt(process.env.GITHUB_INSTALLATION_ID, 10)
      : undefined,
  };
}

// Build optional dashboard auth.
// NOTE: core cannot import @urateam/dashboard (would be circular).
// dashboardAuth is read here so it can be passed to createApp for callers
// that mount the dashboard separately (e.g. the CLI). For a self-contained
// production deployment, run the dashboard as a separate process using
// packages/dashboard directly, or migrate this entrypoint to the CLI package.
const dashboardUser = process.env.DASHBOARD_USER;
const dashboardPass = process.env.DASHBOARD_PASSWORD;
const dashboardAuth =
  dashboardUser && dashboardPass
    ? { username: dashboardUser, password: dashboardPass }
    : undefined;

const _parsedTtl = parseInt(process.env.WORKTREE_TTL_HOURS ?? "24", 10);
const worktreeTtlHours = Number.isFinite(_parsedTtl) && _parsedTtl > 0 ? _parsedTtl : 24;

// Build repoConfigs from env vars (same pattern as CLI dev command)
const repoConfigs: Record<string, import("./types.js").RepoConfig> = {};
if (process.env.REPO_TEAM_ID && process.env.REPO_URL) {
  repoConfigs[process.env.REPO_TEAM_ID] = {
    url: process.env.REPO_URL,
    defaultBranch: process.env.REPO_DEFAULT_BRANCH ?? "main",
    testCommand: process.env.REPO_TEST_CMD ?? "pnpm test",
    buildCommand: process.env.REPO_BUILD_CMD ?? "pnpm build",
  };
}

const config = {
  webhookSecret: process.env.LINEAR_WEBHOOK_SECRET ?? "",
  linearApiKey: process.env.LINEAR_API_KEY ?? "",
  pipelineConfigs: defaultConfigs,
  repoConfigs,
  databaseUrl: process.env.DATABASE_URL,
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
  concurrency: parseInt(process.env.MAX_CONCURRENT_RUNS ?? "3", 10),
  agentRunDir: process.env.AGENT_RUN_DIR,
  github,
  dashboardAuth,
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
};

if (!config.webhookSecret) {
  console.error("LINEAR_WEBHOOK_SECRET is required");
  process.exit(1);
}

async function main() {
  const { app, db, runner } = await createApp(config);
  const port = parseInt(process.env.PORT ?? "3000", 10);

  console.log(`Linear Agent Framework starting on port ${port}`);
  console.log(`Pipelines: ${Object.keys(config.pipelineConfigs).join(", ")}`);
  console.log(`Database: ${config.databaseUrl?.startsWith("postgres") ? "Postgres" : "SQLite"}`);

  // --- Worktree cleanup cron ---
  // Failed pipeline runs preserve their worktrees for debugging.  Run an
  // initial sweep at startup, then repeat every hour so stale directories
  // don't accumulate between restarts.
  const agentRunDir = config.agentRunDir ?? join(homedir(), "data", "runs");
  async function runWorktreeCleanup() {
    const removed = await cleanupWorktrees(agentRunDir, worktreeTtlHours);
    if (removed.length > 0) {
      console.log(`Worktree cleanup: removed ${removed.length} stale director${removed.length === 1 ? "y" : "ies"} (TTL ${worktreeTtlHours}h)`);
    }
  }
  await runWorktreeCleanup();
  const cleanupInterval = setInterval(runWorktreeCleanup, 60 * 60 * 1000); // every hour
  cleanupInterval.unref(); // don't block process exit

  // One-time startup recovery: requeue any retriable runs left from a prior crash
  try {
    const { recoverRetriableRuns } = await import("./pm/actions/recover.js");
    const recoveryResult = await recoverRetriableRuns({
      db,
      runner,
      maxRetries: 3,
    });
    if (recoveryResult.recovered.length > 0) {
      console.log(`Startup recovery: requeued ${recoveryResult.recovered.length} retriable run(s)`);
    }
    if (recoveryResult.exhausted.length > 0) {
      console.log(`Startup recovery: ${recoveryResult.exhausted.length} run(s) exceeded max retries`);
    }
  } catch (err) {
    console.error("Startup recovery sweep failed:", err);
  }

  const server = serve({ fetch: app.fetch, port });

  function shutdown() {
    console.log("Shutting down...");
    clearInterval(cleanupInterval);
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 30_000);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

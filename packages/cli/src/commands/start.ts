import { Command } from "commander";
import { readFileSync } from "node:fs";
import { bootstrapSsoFromEnv } from "../sso-bootstrap.js";

export const startCommand = new Command("start")
  .description("Start production server (webhook + dashboard)")
  .option("--port <port>", "Webhook server port", "3000")
  .option("--dashboard-port <port>", "Dashboard port", "3001")
  .action(async (options) => {
    try {
    const { createApp, defaultConfigs, cleanupWorktrees, addLogStream, initSlackAlertManager, createSlackAlertStream } = await import("@urateam/core");

    // --- Slack error alerts (opt-in) ---
    if (
      process.env.SLACK_ERROR_ALERTS === "true" &&
      process.env.SLACK_BOT_TOKEN &&
      process.env.PM_AGENT_SLACK_CHANNEL_ID
    ) {
      const manager = initSlackAlertManager(
        process.env.SLACK_BOT_TOKEN,
        process.env.PM_AGENT_SLACK_CHANNEL_ID,
      );
      addLogStream(createSlackAlertStream(manager));
      console.log(`Slack error alerts: enabled (channel ${process.env.PM_AGENT_SLACK_CHANNEL_ID})`);
    }
    const { createDashboard } = await import("@urateam/dashboard");
    const { serve } = await import("@hono/node-server");

    // --- Validate required env vars ---
    if (!process.env.LINEAR_WEBHOOK_SECRET) {
      console.error("LINEAR_WEBHOOK_SECRET is required");
      process.exit(1);
    }

    // --- Build config from env vars ---
    const dashboardUser = process.env.DASHBOARD_USER;
    const dashboardPass = process.env.DASHBOARD_PASSWORD;
    if (!dashboardUser || !dashboardPass) {
      console.error(
        "DASHBOARD_USER and DASHBOARD_PASSWORD are required. " +
          "The dashboard exposes sensitive operational data and must not be publicly accessible. " +
          "Set both environment variables and restart.",
      );
      process.exit(1);
    }
    const dashboardAuth = { username: dashboardUser, password: dashboardPass };

    const repoConfigs: Record<string, import("@urateam/core").RepoConfig> = {};
    if (process.env.REPO_TEAM_ID && process.env.REPO_URL) {
      const repoEntry: import("@urateam/core").RepoConfig = {
        url: process.env.REPO_URL,
        defaultBranch: process.env.REPO_DEFAULT_BRANCH ?? "main",
        testCommand: process.env.REPO_TEST_CMD ?? "pnpm test",
        buildCommand: process.env.REPO_BUILD_CMD ?? "pnpm build",
      };

      // GitHub PR review feedback config (optional)
      if (process.env.GITHUB_WEBHOOK_SECRET) {
        repoEntry.githubFeedback = {
          autoTrigger: process.env.GITHUB_FEEDBACK_AUTO_TRIGGER !== "false",
          triggerKeyword: process.env.GITHUB_FEEDBACK_TRIGGER_KEYWORD,
          allowedReviewers: process.env.GITHUB_FEEDBACK_ALLOWED_REVIEWERS
            ? process.env.GITHUB_FEEDBACK_ALLOWED_REVIEWERS.split(",").filter(Boolean)
            : undefined,
          botLogins: process.env.GITHUB_FEEDBACK_BOT_LOGINS
            ? process.env.GITHUB_FEEDBACK_BOT_LOGINS.split(",").filter(Boolean)
            : undefined,
        };
      }

      repoConfigs[process.env.REPO_TEAM_ID] = repoEntry;
    }

    // GitHub App config (optional)
    let github: import("@urateam/core").GitHubConfig | undefined;
    if (process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY_PATH) {
      github = {
        appId: process.env.GITHUB_APP_ID,
        privateKey: readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, "utf-8"),
        installationId: process.env.GITHUB_INSTALLATION_ID
          ? parseInt(process.env.GITHUB_INSTALLATION_ID, 10)
          : undefined,
      };
    }

    // PM Agent Slack interface (optional — requires signing secret)
    const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
    const pmSlack = (slackSigningSecret && process.env.SLACK_BOT_TOKEN && process.env.PM_AGENT_SLACK_CHANNEL_ID)
      ? {
          signingSecret: slackSigningSecret,
          botToken: process.env.SLACK_BOT_TOKEN,
          channelId: process.env.PM_AGENT_SLACK_CHANNEL_ID,
          teamIds: (process.env.PM_AGENT_TEAM_IDS ?? "").split(",").filter(Boolean),
        }
      : undefined;

    // --- PM Agent config (built up-front so createApp can thread it into the webhook) ---
    // The webhook-side budget gate in webhook/handler.ts needs config.pmConfig to
    // activate the 100% hard-stop. If we only built this inside the PM_AGENT_ENABLED
    // branch below, the gate would be inert in production.
    const pmAgentEnabled = process.env.PM_AGENT_ENABLED === "true";
    let pmConfig: import("@urateam/core").PmAgentConfig | undefined;
    if (pmAgentEnabled) {
      const { PmAgentConfigSchema } = await import("@urateam/core");
      const slackBotToken = process.env.SLACK_BOT_TOKEN;
      if (!slackBotToken) {
        console.error("SLACK_BOT_TOKEN is required when PM_AGENT_ENABLED=true");
        process.exit(1);
      }
      const dailyBudgetStr = process.env.PM_AGENT_DAILY_TOKEN_BUDGET;
      if (!dailyBudgetStr) {
        console.error("PM_AGENT_DAILY_TOKEN_BUDGET is required when PM_AGENT_ENABLED=true");
        process.exit(1);
      }
      const slackChannelId = process.env.PM_AGENT_SLACK_CHANNEL_ID;
      if (!slackChannelId) {
        console.error("PM_AGENT_SLACK_CHANNEL_ID is required when PM_AGENT_ENABLED=true");
        process.exit(1);
      }
      const teamIds = (process.env.PM_AGENT_TEAM_IDS ?? "").split(",").filter(Boolean);
      if (teamIds.length === 0) {
        console.error("PM_AGENT_TEAM_IDS is required when PM_AGENT_ENABLED=true");
        process.exit(1);
      }
      pmConfig = PmAgentConfigSchema.parse({
        enabled: true,
        cronIntervalMs: parseInt(process.env.PM_AGENT_CRON_INTERVAL_MS ?? "1800000", 10),
        maxInFlight: parseInt(process.env.PM_AGENT_MAX_IN_FLIGHT ?? "3", 10),
        dailyTokenBudget: parseInt(dailyBudgetStr, 10),
        slackChannelId,
        teamIds,
      });
    }

    const config = {
      webhookSecret: process.env.LINEAR_WEBHOOK_SECRET,
      linearApiKey: process.env.LINEAR_API_KEY ?? "",
      pipelineConfigs: defaultConfigs,
      repoConfigs,
      databaseUrl: process.env.DATABASE_URL,
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
      discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
      concurrency: parseInt(process.env.MAX_CONCURRENT_RUNS ?? "3", 10),
      agentRunDir: process.env.AGENT_RUN_DIR,
      repoCloneDir: process.env.REPO_CLONE_DIR,
      github,
      dashboardAuth,
      pmSlack,
      pmConfig,
      githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    };

    // --- Start servers ---
    const { app, runner, db } = await createApp(config);

    // --- Recover runs interrupted by a previous restart ---
    await runner.recoverStuckRuns();
    const port = parseInt(process.env.PORT ?? options.port, 10);
    const dashboardPort = parseInt(process.env.DASHBOARD_PORT ?? options.dashboardPort, 10);

    // --- SSO (Enterprise, opt-in via URATEAM_SSO_ENABLED=true) ---
    const ssoBootstrap = await bootstrapSsoFromEnv();
    const dashboardApp = createDashboard({
      db,
      pipelineConfigs: config.pipelineConfigs,
      repoConfigs: config.repoConfigs,
      auth: dashboardAuth,
      sso: ssoBootstrap?.sso,
      workos: ssoBootstrap?.workos,
    });
    if (ssoBootstrap) {
      console.log(`SSO: enabled (WorkOS client ${ssoBootstrap.sso.workosClientId})`);
    }

    console.log(`Linear Agent Framework starting`);
    console.log(`Webhook:   http://localhost:${port}`);
    console.log(`Dashboard: http://localhost:${dashboardPort}`);
    console.log(`Database:  ${config.databaseUrl?.startsWith("postgres") ? "Postgres" : "SQLite"}`);
    console.log(`Pipelines: ${Object.keys(config.pipelineConfigs).join(", ")}`);
    console.log(`Repos:     ${Object.keys(config.repoConfigs).length}`);

    const webhookServer = serve({ fetch: app.fetch, port });
    const dashServer = serve({ fetch: dashboardApp.fetch, port: dashboardPort });

    // --- Worktree cleanup cron ---
    const agentRunDir = config.agentRunDir ?? "/var/agent-runs";
    const _parsedTtl = parseInt(process.env.WORKTREE_TTL_HOURS ?? "24", 10);
    const worktreeTtlHours = Number.isFinite(_parsedTtl) && _parsedTtl > 0 ? _parsedTtl : 24;

    async function runCleanup() {
      const removed = await cleanupWorktrees(agentRunDir, worktreeTtlHours);
      if (removed.length > 0) {
        console.log(`Cleanup: removed ${removed.length} stale worktree(s)`);
      }
    }
    await runCleanup();
    const cleanupInterval = setInterval(runCleanup, 60 * 60 * 1000);
    cleanupInterval.unref();

    // --- PM Agent (opt-in) ---
    let pmInterval: ReturnType<typeof setInterval> | undefined;
    if (pmAgentEnabled && pmConfig) {
      const { createPmScheduler } = await import("@urateam/core");
      const slackBotToken = process.env.SLACK_BOT_TOKEN!;

      const pmScheduler = createPmScheduler({
        config: pmConfig,
        db,
        linearApiKey: config.linearApiKey,
        slackBotToken,
        repoCloneDir: config.repoCloneDir,
        runner,
        pipelineConfigs: config.pipelineConfigs,
        repoConfigs: config.repoConfigs,
      });

      pmScheduler.tick().catch((err) => console.error("PM Agent initial tick failed:", err));
      pmInterval = setInterval(
        () => pmScheduler.tick().catch((err) => console.error("PM Agent tick failed:", err)),
        pmConfig.cronIntervalMs,
      );
      pmInterval.unref();

      console.log(`PM Agent: enabled (every ${pmConfig.cronIntervalMs / 60000}min, max ${pmConfig.maxInFlight} in-flight)`);
    }

    // --- Graceful shutdown ---
    function shutdown() {
      console.log("Shutting down...");
      clearInterval(cleanupInterval);
      if (pmInterval) clearInterval(pmInterval);
      let closed = 0;
      const onClose = () => { if (++closed === 2) process.exit(0); };
      dashServer.close(onClose);
      webhookServer.close(onClose);
      setTimeout(() => process.exit(1), 30_000);
    }

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    } catch (err) {
      console.error("Failed to start:", err);
      process.exit(1);
    }
  });

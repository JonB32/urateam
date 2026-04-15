import { Command } from "commander";
import { bootstrapSsoFromEnv } from "../sso-bootstrap.js";

export const devCommand = new Command("dev")
  .description("Start local development server (webhook + dashboard)")
  .option("--port <port>", "Webhook server port", "3000")
  .option("--dashboard-port <port>", "Dashboard port", "3001")
  .action(async (options) => {
    const { createApp, defaultConfigs } = await import("@urateam/core");
    const { createDashboard } = await import("@urateam/dashboard");

    const dashboardUser = process.env.DASHBOARD_USER;
    const dashboardPass = process.env.DASHBOARD_PASSWORD;
    const dashboardAuth =
      dashboardUser && dashboardPass
        ? { username: dashboardUser, password: dashboardPass }
        : undefined;

    // Build repoConfigs from env: REPO_TEAM_ID, REPO_URL, REPO_DEFAULT_BRANCH, etc.
    const repoConfigs: Record<string, import("@urateam/core").RepoConfig> = {};
    if (process.env.REPO_TEAM_ID && process.env.REPO_URL) {
      const repoEntry: import("@urateam/core").RepoConfig = {
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
            ? process.env.GITHUB_FEEDBACK_ALLOWED_REVIEWERS.split(",").filter(Boolean)
            : undefined,
          botLogins: process.env.GITHUB_FEEDBACK_BOT_LOGINS
            ? process.env.GITHUB_FEEDBACK_BOT_LOGINS.split(",").filter(Boolean)
            : undefined,
        };
      }

      repoConfigs[process.env.REPO_TEAM_ID] = repoEntry;
    }

    const config = {
      webhookSecret: process.env.LINEAR_WEBHOOK_SECRET ?? "dev-secret",
      linearApiKey: process.env.LINEAR_API_KEY ?? "",
      pipelineConfigs: defaultConfigs,
      repoConfigs,
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
      discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
      agentRunDir: process.env.AGENT_RUN_DIR ?? "/tmp/agent-runs",
      repoCloneDir: process.env.REPO_CLONE_DIR ?? "/tmp/agent-repos",
      githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    };

    // Validate SSO env vars before opening DB so misconfig fails fast.
    const ssoBootstrap = await bootstrapSsoFromEnv();

    const { app, db } = await createApp(config);
    const dashboardApp = createDashboard({
      db,
      pipelineConfigs: config.pipelineConfigs,
      repoConfigs: config.repoConfigs,
      auth: dashboardAuth,
      sso: ssoBootstrap?.sso,
      workos: ssoBootstrap?.workos,
    });

    const { serve } = await import("@hono/node-server");
    const port = parseInt(options.port, 10);
    const dashboardPort = parseInt(options.dashboardPort, 10);

    console.log(`Linear Agent Framework — Local Dev Mode`);
    console.log(`Webhook server:  http://localhost:${port}`);
    console.log(`Health check:    http://localhost:${port}/health`);
    console.log(`Dashboard:       http://localhost:${dashboardPort}`);
    if (dashboardAuth) {
      console.log(`Dashboard auth:  enabled (DASHBOARD_USER set)`);
    } else {
      console.warn(
        `Dashboard auth:  NOT configured — dashboard is blocked (set DASHBOARD_USER + DASHBOARD_PASSWORD)`,
      );
    }
    console.log(`\nPipelines loaded: ${Object.keys(config.pipelineConfigs).join(", ")}`);
    console.log(`\nUse ngrok or similar to expose webhook endpoint to Linear.`);

    serve({ fetch: app.fetch, port });
    serve({ fetch: dashboardApp.fetch, port: dashboardPort });
  });

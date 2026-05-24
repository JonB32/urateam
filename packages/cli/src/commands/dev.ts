import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { bootstrapSsoFromEnv } from "../sso-bootstrap.js";
import { preflightClaudeAuth } from "../lib/preflight-claude-auth.js";
import { preflightDirs } from "../lib/preflight-dirs.js";
import { buildRepoConfigsFromEnv, requireRepoConfigs } from "../lib/build-repo-configs.js";
import { loadEnvConfig } from "../lib/load-env-config.js";

export const devCommand = new Command("dev")
  .description("Start local development server (webhook + dashboard)")
  .option("--port <port>", "Webhook server port", "3000")
  .option("--dashboard-port <port>", "Dashboard port", "3001")
  .action(async (options) => {
    // Boot-time env validation — runs first, reports all errors at once.
    // In dev mode LINEAR_WEBHOOK_SECRET and dashboard auth are optional.
    const env = loadEnvConfig("dev");

    const { createApp, defaultConfigs, validateReviewModels } = await import("@urateam/core");
    const { createDashboard } = await import("@urateam/dashboard");

    const dashboardAuth =
      env.DASHBOARD_USER && env.DASHBOARD_PASSWORD
        ? { username: env.DASHBOARD_USER, password: env.DASHBOARD_PASSWORD }
        : undefined;

    // Build repoConfigs from env: REPO_TEAM_ID, REPO_URL, REPO_DEFAULT_BRANCH, etc.
    const repoConfigs = buildRepoConfigsFromEnv();

    // Fail fast if no repoConfigs could be built. Without this, `ura dev`
    // looks healthy in logs (webhook server up, dashboard up) but every
    // inbound Linear webhook fails with "no repo mapping" — usually after
    // the user has already moved a real issue to Todo. The first-time-user
    // setup path nearly always lands here because .urateam/.env ships with
    // `REPO_URL=` and `REPO_TEAM_ID=` blank. See urateam#33.
    requireRepoConfigs(repoConfigs, "ura dev");

    // --- Resolve and validate workspace directories ---
    const agentRunDir = env.AGENT_RUN_DIR ?? join(homedir(), "data", "runs");
    const repoCloneDir = env.REPO_CLONE_DIR ?? join(homedir(), "work", "repos");

    // Run three independent I/O checks in parallel so startup is faster:
    //   • preflightDirs  — verifies/creates agent-run and repo-clone directories
    //   • preflightClaudeAuth — verifies Claude API auth before opening DB (urateam#40)
    //   • validateReviewModels (BEC-171) — checks REVIEW_MODELS against OpenRouter catalog
    await Promise.all([
      preflightDirs({ agentRunDir, repoCloneDir, command: "ura dev" }),
      preflightClaudeAuth({ command: "ura dev" }),
      validateReviewModels(process.env),
    ]);

    const config = {
      webhookSecret: env.LINEAR_WEBHOOK_SECRET ?? "dev-secret",
      linearApiKey: env.LINEAR_API_KEY,
      pipelineConfigs: defaultConfigs,
      repoConfigs,
      slackWebhookUrl: env.SLACK_WEBHOOK_URL,
      discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
      agentRunDir,
      repoCloneDir,
      githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
    };

    // Validate SSO env vars before opening DB so misconfig fails fast.
    const ssoBootstrap = await bootstrapSsoFromEnv();

    const { app, db } = await createApp(config);

    try {
      const { checkLicense, logAuditEvent, configLoadedEvent } = await import("@urateam/core");
      const { createHash } = await import("node:crypto");
      const status = checkLicense(db);
      const sha = createHash("sha256").update(JSON.stringify(config.pipelineConfigs, null, 0)).digest("hex");
      void logAuditEvent(db, configLoadedEvent({ path: "(env-vars)", sha256: sha, tier: status.tier }));
    } catch {
      // audit must never crash startup
    }

    const dashboardApp = createDashboard({
      db,
      pipelineConfigs: config.pipelineConfigs,
      repoConfigs: config.repoConfigs,
      auth: dashboardAuth,
      sso: ssoBootstrap?.sso,
      workos: ssoBootstrap?.workos,
    });

    const { serve } = await import("@hono/node-server");
    const port = env.PORT;
    const dashboardPort = env.DASHBOARD_PORT;

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

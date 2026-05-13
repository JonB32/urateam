import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { bootstrapSsoFromEnv } from "../sso-bootstrap.js";
import { preflightClaudeAuth } from "../lib/preflight-claude-auth.js";
import { preflightDirs } from "../lib/preflight-dirs.js";
import { buildRepoConfigsFromEnv, requireRepoConfigs } from "../lib/build-repo-configs.js";
import { resolveUserLevelHome } from "../lib/user-level-config.js";

/**
 * User-level: also load `~/.urateam/.env` (or `$URATEAM_HOME/.env`) so secrets
 * load regardless of cwd. Node's `loadEnvFile()` in `index.ts` already loads
 * `<cwd>/.env` — that covers the project-level case where operators run
 * `ura start` from the project root. For user-level installs the operator
 * shouldn't need to `cd ~/.urateam` first; this is the fallback.
 *
 * Existing env vars win (loadEnvFile never overrides), so the cwd-side `.env`
 * is still authoritative when both are present.
 */
function loadUserLevelEnv(): void {
  const home = resolveUserLevelHome();
  const path = join(home, ".env");
  try {
    process.loadEnvFile(path);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn(
        `warning: failed to load ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export const startCommand = new Command("start")
  .description("Start production server (webhook + dashboard)")
  .option("--port <port>", "Webhook server port", "3000")
  .option("--dashboard-port <port>", "Dashboard port", "3001")
  .action(async (options) => {
    try {
    loadUserLevelEnv();
    const { createApp, defaultConfigs, applyDeepReviewPassesOverride, applyAutoMergeOverride, cleanupWorktrees, runAgentBranchSweep, addLogStream, initSlackAlertManager, createSlackAlertStream, validateReviewModels } = await import("@urateam/core");

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

    // Build repoConfigs from env: REPO_TEAM_ID, REPO_URL, REPO_DEFAULT_BRANCH, etc.
    const repoConfigs = buildRepoConfigsFromEnv();

    // Fail fast if no repoConfigs could be built. Same guard as `ura dev` —
    // without it the webhook server starts looking healthy and silently
    // fails every inbound Linear event with "no repo mapping". See urateam#33.
    requireRepoConfigs(repoConfigs, "ura start");

    // GitHub App config (optional)
    const { buildGitHubConfigFromEnv } = await import("@urateam/core");
    const github = buildGitHubConfigFromEnv();

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
        // BEC-150: opt-in label-match filter for the promote step. Default false
        // for back-compat; set true to prevent unactionable Backlog items from
        // being promoted to Todo.
        requirePipelineLabelForPromote:
          process.env.PM_AGENT_REQUIRE_PIPELINE_LABEL_FOR_PROMOTE === "true",
        // BEC-161: skip promote/start-todo for issues with N+ consecutive
        // failed runs. Default 3; set 0 to disable.
        maxConsecutiveFailures: parseInt(
          process.env.PM_AGENT_MAX_CONSECUTIVE_FAILURES ?? "3",
          10,
        ),
      });
    }

    // --- Release Manager config (BEC-135 — Pro tier) ---
    let rmConfig: import("@urateam/core").ReleaseManagerConfig | undefined;
    let rmRepoUrl: string | undefined;
    if (process.env.RELEASE_MANAGER_ENABLED === "true") {
      const { ReleaseManagerConfigSchema, isFeatureLicensed } = await import("@urateam/core");

      if (!isFeatureLicensed("release-manager")) {
        console.error(
          "RELEASE_MANAGER_ENABLED=true requires a Pro tier license that unlocks 'release-manager'. " +
          "Set URATEAM_LICENSE_KEY to a valid Pro license and restart.",
        );
        process.exit(1);
      }

      // Use the first configured repo as the target. v1 supports a single Release Manager.
      const firstRepoTeamId = Object.keys(repoConfigs)[0];
      rmRepoUrl = repoConfigs[firstRepoTeamId]?.url;
      if (!rmRepoUrl) {
        console.error("RELEASE_MANAGER_ENABLED=true requires a configured REPO_URL.");
        process.exit(1);
      }

      const triggers: Record<string, unknown> = {};
      if (process.env.RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE) {
        triggers.mergedPRsSince = parseInt(process.env.RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE, 10);
      }
      if (process.env.RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS) {
        triggers.timeSinceLastHours = parseInt(process.env.RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS, 10);
      }
      if (process.env.RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES) {
        triggers.ciGreenForMinutes = parseInt(process.env.RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES, 10);
      }
      if (process.env.RELEASE_MANAGER_TRIGGER_REQUIRE_SLACK_APPROVAL === "true") {
        triggers.requireSlackApproval = true;
      }

      if (process.env.RELEASE_MANAGER_TRIGGER_QA_WORKFLOW) {
        const qaWorkflow = process.env.RELEASE_MANAGER_TRIGGER_QA_WORKFLOW;
        const qaTeamId = process.env.RELEASE_MANAGER_TRIGGER_QA_LINEAR_TEAM_ID;
        const qaTimeoutMin = process.env.RELEASE_MANAGER_TRIGGER_QA_TIMEOUT_MINUTES;

        if (!qaTeamId) {
          console.error(
            "RELEASE_MANAGER_TRIGGER_QA_WORKFLOW set but RELEASE_MANAGER_TRIGGER_QA_LINEAR_TEAM_ID is missing. " +
            "Configure linearTeamId for filing gap issues.",
          );
          process.exit(1);
        }
        if (!process.env.LINEAR_API_KEY) {
          console.error(
            "qaCheck requires LINEAR_API_KEY (used to file gap issues). Set it and restart.",
          );
          process.exit(1);
        }

        triggers.qaCheck = {
          workflow: qaWorkflow,
          linearTeamId: qaTeamId,
          ...(qaTimeoutMin ? { timeoutMinutes: parseInt(qaTimeoutMin, 10) } : {}),
        };
      }

      try {
        rmConfig = ReleaseManagerConfigSchema.parse({
          enabled: true,
          schedule: process.env.RELEASE_MANAGER_SCHEDULE ?? "*/30 * * * *",
          triggers,
          versionBump: process.env.RELEASE_MANAGER_VERSION_BUMP ?? "patch",
          slackChannel: process.env.RELEASE_MANAGER_SLACK_CHANNEL,
          branch: process.env.RELEASE_MANAGER_BRANCH ?? "main",
        });
      } catch (err) {
        console.error("Release Manager config invalid:", (err as Error).message);
        process.exit(1);
      }
    }

    // BEC-163: enable BEC-134 OpenRouter fanout via env. Unset = defaults
    // unchanged (every pipeline keeps deepReviewPasses=0). Set to a
    // non-negative integer to override on every pipeline that has a
    // `review` stage (auto-implement, bug, needs-design — not quick-fix).
    //
    // BEC-178: opt every pipeline into auto-merge via env. Unset = defaults
    // unchanged (autoMerge undefined / off). Set to "true" or "false" to
    // override every pipeline. Auto-merge gates (diff size, blocking review
    // findings, mandatory reviewers, etc.) still apply when true.
    const pipelineConfigs = applyAutoMergeOverride(
      applyDeepReviewPassesOverride(
        defaultConfigs,
        process.env.URATEAM_DEEP_REVIEW_PASSES,
      ),
      process.env.URATEAM_AUTO_MERGE,
    );

    // --- Resolve and validate workspace directories ---
    const agentRunDir = process.env.AGENT_RUN_DIR ?? join(homedir(), "data", "runs");
    const repoCloneDir = process.env.REPO_CLONE_DIR ?? join(homedir(), "work", "repos");

    // Run three independent I/O checks in parallel so startup is faster:
    //   • validateReviewModels (BEC-171) — checks REVIEW_MODELS against OpenRouter catalog
    //   • preflightDirs  — verifies/creates agent-run and repo-clone directories
    //   • preflightClaudeAuth — verifies Claude API auth before opening DB (urateam#40)
    await Promise.all([
      validateReviewModels(process.env),
      preflightDirs({ agentRunDir, repoCloneDir, command: "ura start" }),
      preflightClaudeAuth({ command: "ura start", containerized: true }),
    ]);

    const config = {
      webhookSecret: process.env.LINEAR_WEBHOOK_SECRET,
      linearApiKey: process.env.LINEAR_API_KEY ?? "",
      pipelineConfigs,
      repoConfigs,
      databaseUrl: process.env.DATABASE_URL,
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
      discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
      concurrency: parseInt(process.env.MAX_CONCURRENT_RUNS ?? "3", 10),
      agentRunDir,
      repoCloneDir,
      github,
      dashboardAuth,
      pmSlack,
      pmConfig,
      githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    };

    // --- SSO (Enterprise, opt-in via URATEAM_SSO_ENABLED=true) ---
    // Validate SSO env vars BEFORE opening the DB / starting the runner so a
    // misconfigured deployment fails fast without leaking resources.
    const ssoBootstrap = await bootstrapSsoFromEnv();

    // --- Start servers ---
    const { app, runner, db } = await createApp(config);

    try {
      const { checkLicense, logAuditEvent, configLoadedEvent } = await import("@urateam/core");
      const { createHash } = await import("node:crypto");
      const status = checkLicense(db);
      const sha = createHash("sha256").update(JSON.stringify(config.pipelineConfigs, null, 0)).digest("hex");
      void logAuditEvent(db, configLoadedEvent({ path: "(env-vars)", sha256: sha, tier: status.tier }));
    } catch {
      // audit must never crash startup
    }

    // --- Recover runs interrupted by a previous restart ---
    await runner.recoverStuckRuns();
    const port = parseInt(process.env.PORT ?? options.port, 10);
    const dashboardPort = parseInt(process.env.DASHBOARD_PORT ?? options.dashboardPort, 10);

    const dashboardApp = createDashboard({
      db,
      pipelineConfigs: config.pipelineConfigs,
      repoConfigs: config.repoConfigs,
      auth: dashboardAuth,
      sso: ssoBootstrap?.sso,
      workos: ssoBootstrap?.workos,
      runner: {
        resume: runner.resume.bind(runner),
        start: runner.start.bind(runner) as (...args: any[]) => Promise<void>,
        requestStop: runner.requestStop.bind(runner),
        haltAll: runner.haltAll.bind(runner),
      },
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
    // agentRunDir is already resolved above (before preflightClaudeAuth).
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

    // --- Stale agent-branch sweep cron (BEC-174) ---
    // Sweeps `agent/*` branches on origin whose tip commit is older than
    // PM_AGENT_AGENT_BRANCH_TTL_DAYS (default 7) AND that have no open PR.
    // Skips branches with open PRs to preserve active human review.
    const _parsedAgentBranchTtl = parseInt(
      process.env.PM_AGENT_AGENT_BRANCH_TTL_DAYS ?? "7",
      10,
    );
    const agentBranchTtlDays =
      Number.isFinite(_parsedAgentBranchTtl) && _parsedAgentBranchTtl > 0
        ? _parsedAgentBranchTtl
        : 7;

    const repoUrls = Object.values(config.repoConfigs).map(
      (r) => (r as { url: string }).url,
    );

    async function runBranchSweepTick() {
      try {
        await runAgentBranchSweep({
          db,
          repoUrls,
          repoCloneDir: config.repoCloneDir,
          ttlDays: agentBranchTtlDays,
        });
      } catch (err) {
        console.error("Branch sweep tick failed:", (err as Error).message);
      }
    }
    void runBranchSweepTick();
    const branchSweepInterval = setInterval(
      () => void runBranchSweepTick(),
      60 * 60 * 1000,
    );
    branchSweepInterval.unref();

    // --- PM Agent (opt-in) ---
    let pmInterval: ReturnType<typeof setInterval> | undefined;
    let rmScheduler: import("@urateam/core").ReleaseManagerScheduler | undefined;
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
      if (process.env.PM_AGENT_PAUSED === "true") {
        console.log(`PM Agent: PM_AGENT_PAUSED=true — promote/start-todo/recover-stuck will be skipped on every tick until the env var is cleared and the container restarted`);
      }
    }

    // --- Release Manager (BEC-135 — Pro tier, opt-in) ---
    if (rmConfig && rmRepoUrl) {
      if (!github) {
        console.error(
          "RELEASE_MANAGER_ENABLED=true requires GITHUB_APP_ID + GITHUB_PRIVATE_KEY_PATH so the agent can create tags/releases.",
        );
        process.exit(1);
      }
      const { createGitHubClient, createReleaseManagerScheduler, isFeatureLicensed,
        handleReleaseSubcommand, parseReleaseSubcommand } = await import("@urateam/core");
      const rmOctokit = await createGitHubClient(github);

      let linearClient: import("@linear/sdk").LinearClient | undefined;
      if (rmConfig.triggers.qaCheck) {
        const { LinearClient } = await import("@linear/sdk");
        linearClient = new LinearClient({ apiKey: process.env.LINEAR_API_KEY! });
      }

      rmScheduler = createReleaseManagerScheduler({
        config: rmConfig,
        db,
        octokit: rmOctokit,
        repoUrl: rmRepoUrl,
        isLicensed: () => isFeatureLicensed("release-manager"),
        linear: linearClient,
        slack: process.env.SLACK_BOT_TOKEN
          ? {
              postMessage: async (channel, text) => {
                const { postSlackMessage } = await import("@urateam/core");
                const r = await postSlackMessage(process.env.SLACK_BOT_TOKEN!, { channel, text });
                return r !== null && (r as any).ok !== false;
              },
            }
          : undefined,
      });

      // Plumb a release-handler closure through pmSlack so /release routes here.
      if (pmSlack) {
        (pmSlack as any).releaseHandler = async ({ text, userId }: { text: string; userId: string }) => {
          const cmd = parseReleaseSubcommand(text);
          const pauseDurationHours = rmConfig!.triggers.timeSinceLastHours ?? 24;
          return handleReleaseSubcommand({
            cmd,
            db,
            repoUrl: rmRepoUrl!,
            branch: rmConfig!.branch,
            slackUserId: userId,
            pauseDurationHours,
            onSkip: (_reason) => {
              rmScheduler!.pauseUntil(new Date(Date.now() + pauseDurationHours * 3600 * 1000));
            },
          });
        };
      }

      rmScheduler.start();
      console.log(
        `Release Manager: enabled (schedule "${rmConfig.schedule}", repo ${rmRepoUrl}, branch ${rmConfig.branch})`,
      );
    }

    // --- Graceful shutdown ---
    function shutdown() {
      console.log("Shutting down...");
      clearInterval(cleanupInterval);
      clearInterval(branchSweepInterval);
      if (pmInterval) clearInterval(pmInterval);
      rmScheduler?.stop();
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

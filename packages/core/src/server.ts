import { Hono } from "hono";
import { createWebhookHandler } from "./webhook/handler.js";
import { createGitHubWebhookHandler } from "./webhook/github-handler.js";
import { createDb } from "./db/client.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { CompositeNotifier } from "./notifier/composite.js";
import { LinearNotifier } from "./notifier/linear.js";
import { SlackNotifier } from "./notifier/slack.js";
import { DiscordNotifier } from "./notifier/discord.js";
import type { PipelineConfig, RepoConfig, TriggerMap } from "./types.js";
import type { PmAgentConfig } from "./pm/types.js";
import type { GitHubConfig } from "./repo/github.js";
import type { GitLabConfig } from "./repo/gitlab.js";
import { isFeatureLicensed, checkLicense } from "./license.js";
import { createLogger } from "./logger.js";

const log = createLogger({ component: "server" });

export interface PmSlackInterfaceConfig {
  /** Slack signing secret for verifying inbound requests */
  signingSecret: string;
  /** Slack bot OAuth token (xoxb-…) */
  botToken: string;
  /** Channel ID for proactive PM notifications */
  channelId: string;
  /** Team IDs for issue creation commands */
  teamIds?: string[];
}

export interface ServerConfig {
  webhookSecret: string;
  linearApiKey: string;
  pipelineConfigs: Record<string, PipelineConfig>;
  repoConfigs: Record<string, RepoConfig>;
  triggerMap?: TriggerMap;
  databaseUrl?: string;
  slackWebhookUrl?: string;
  discordWebhookUrl?: string;
  concurrency?: number;
  agentRunDir?: string;
  repoCloneDir?: string;
  github?: GitHubConfig;
  gitlab?: GitLabConfig;
  dashboardAuth?: { username: string; password: string };
  /** When provided, mounts Slack slash command + Events API endpoints for the PM Agent */
  pmSlack?: PmSlackInterfaceConfig;
  /**
   * When provided, mounts the GitHub webhook handler at /webhooks/github.
   * Enables PR review comment → pipeline re-entry for review feedback.
   * The secret here is the GitHub webhook secret (separate from the Linear webhook secret).
   */
  githubWebhookSecret?: string;
  /**
   * PM Agent config. When provided, enables the 100% budget gate in the
   * webhook handler so new runs are refused when spend caps are exhausted.
   */
  pmConfig?: PmAgentConfig;
}

export async function createApp(config: ServerConfig) {
  const app = new Hono();

  const license = checkLicense();
  log.info({ tier: license.tier, licensed: license.licensed }, "license status");

  if (Object.keys(config.repoConfigs).length > 1 && !isFeatureLicensed("multi-repo")) {
    log.warn(
      { configuredRepos: Object.keys(config.repoConfigs).length },
      "multi-repo requires a license — only the first repo config will be used",
    );
    const firstKey = Object.keys(config.repoConfigs)[0];
    config.repoConfigs = { [firstKey]: config.repoConfigs[firstKey] };
  }

  // Database — auto-detects driver from URL
  const db = await createDb({
    connectionString: config.databaseUrl ?? ":memory:",
  });

  // Notifiers
  const notifiers = [
    new LinearNotifier({ apiKey: config.linearApiKey }),
    new SlackNotifier(config.slackWebhookUrl),
    new DiscordNotifier(config.discordWebhookUrl),
  ];
  const notifier = new CompositeNotifier(notifiers);

  // Pipeline runner
  const runner = new PipelineRunner({
    db,
    notifier,
    concurrency: config.concurrency ?? 3,
    agentRunDir: config.agentRunDir,
    repoCloneDir: config.repoCloneDir,
    github: config.github,
    gitlab: config.gitlab,
  });

  // Webhook handler
  const webhookApp = createWebhookHandler({
    webhookSecret: config.webhookSecret,
    runner,
    pipelineConfigs: config.pipelineConfigs,
    repoConfigs: config.repoConfigs,
    triggerMap: config.triggerMap,
    db: db as any,
    pmConfig: config.pmConfig,
  });

  // Mount routes
  app.route("/", webhookApp);

  // GitHub webhook handler (optional — for PR review comment → pipeline re-entry)
  // Only mount when a webhook secret is configured to prevent unauthenticated access.
  if (config.githubWebhookSecret) {
    const githubWebhookApp = createGitHubWebhookHandler({
      webhookSecret: config.githubWebhookSecret,
      runner,
      pipelineConfigs: config.pipelineConfigs,
      repoConfigs: config.repoConfigs,
      db: db as any,
      github: config.github,
    });
    app.route("/", githubWebhookApp);
  }

  // PM Agent Slack interface (optional, license-gated)
  if (config.pmSlack) {
    if (!isFeatureLicensed("slack-interface")) {
      log.warn(
        { feature: "slack-interface" },
        "pmSlack is configured but the slack-interface feature requires a Pro license — Slack routes will NOT be mounted",
      );
    } else {
      const { createSlackInterface } = await import("./pm/slack-interface.js");
      const { router: slackRouter } = createSlackInterface({
        signingSecret: config.pmSlack.signingSecret,
        botToken: config.pmSlack.botToken,
        channelId: config.pmSlack.channelId,
        linearApiKey: config.linearApiKey,
        teamIds: config.pmSlack.teamIds,
      });
      app.route("/", slackRouter);
    }
  }

  // Health check
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      pipelines: Object.keys(config.pipelineConfigs).length,
      repos: Object.keys(config.repoConfigs).length,
    });
  });

  return { app, runner, db };
}

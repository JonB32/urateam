/**
 * Interactive CLI wizard for the create-urateam installer. Orchestrates the
 * 9-stage prompt sequence that collects user configuration, detects existing
 * installations, and assembles ScaffoldOptions for the scaffolding step.
 */
import { existsSync } from "fs";
import { join, basename } from "path";
import {
  scaffold,
  normalizeBasePath,
  decodeLicense,
  type ScaffoldOptions,
  type PmAgentOptions,
  type GithubFeedbackOptions,
} from "./scaffold.js";

export interface WizardResult {
  projectDir: string;
  projectName: string;
  scaffoldOptions: ScaffoldOptions;
  /** The deploy mode selected by the user — "local" or "production". */
  deployMode: string;
  domain: string | undefined;
  dashboardBasePath: string | undefined;
  anthropicAuth: string;
}

/**
 * Run the interactive 9-stage wizard. Returns a WizardResult for the main
 * flow, or null when the early-exit path was handled internally (e.g. an
 * existing .env was detected and template files were refreshed).
 */
export async function runWizard(arg: string): Promise<WizardResult | null> {
  const prompts = (await import("prompts")).default;

  // Detect existing .env early so we can short-circuit before walking the
  // operator through 8 stages of prompts that won't be applied. The
  // scaffolder already preserves .env on re-run; without this, the prompts
  // are pure UX waste.
  const projectDirEarly = arg === "." ? process.cwd() : join(process.cwd(), arg);
  const existingEnv = join(projectDirEarly, ".urateam", ".env");
  if (existsSync(existingEnv)) {
    console.log(
      `\n  Existing .env detected at ${existingEnv}.\n` +
        "  Re-running create-urateam will refresh template files (Dockerfile, docker-compose.yml,\n" +
        "  Caddyfile, etc.) but will NOT touch your .env. To re-prompt for secrets, delete .env\n" +
        "  first and re-run. Continuing with template-refresh only…\n",
    );
    // Use minimal stub options — scaffold() needs them but won't write .env.
    scaffold({
      projectDir: projectDirEarly,
      projectName: arg === "." ? basename(projectDirEarly) || "my-project" : arg,
      linearApiKey: "",
      linearTeamId: "",
      repoUrl: "",
      defaultBranch: "main",
    });
    console.log(`  ✓ Template files refreshed in ${projectDirEarly}/.urateam\n`);
    return null;
  }

  // --- Stage 1: Linear / repo basics ---
  const stage1 = await prompts([
    { type: "text", name: "linearApiKey", message: "Linear API key:" },
    { type: "text", name: "linearTeamId", message: "Linear team ID:" },
    { type: "text", name: "repoUrl", message: "Repo URL (GitHub/GitLab):" },
    { type: "text", name: "defaultBranch", message: "Default branch:", initial: "main" },
  ]);
  if (!stage1.linearApiKey || !stage1.repoUrl) {
    console.error("Cancelled.");
    process.exit(1);
  }

  // --- Stage 2: deploy mode + Linear webhook secret (hidden input) ---
  const stage2 = await prompts([
    {
      type: "select",
      name: "deployMode",
      message: "Deploy target:",
      choices: [
        { title: "local (laptop / dev — pnpm dev)", value: "local" },
        { title: "production (VPS / docker compose)", value: "production" },
      ],
    },
    {
      // password type masks input so the secret doesn't land in scrollback / shell history
      type: "password",
      name: "linearWebhookSecret",
      message:
        "LINEAR_WEBHOOK_SECRET (paste from Linear webhook config; leave blank to fill in later):",
    },
  ]);

  // --- Stage 3: production-only details (domain / caddy email / dashboard base path) ---
  const stage3 =
    stage2.deployMode === "production"
      ? await prompts([
          { type: "text", name: "domain", message: "Public domain (e.g. urateam.example.com):" },
          { type: "text", name: "caddyEmail", message: "Email for Let's Encrypt:" },
          {
            type: "text",
            name: "dashboardBasePath",
            message:
              "DASHBOARD_BASE_PATH (leading slash, no trailing — leave blank if dashboard is at root):",
          },
        ])
      : { domain: undefined, caddyEmail: undefined, dashboardBasePath: undefined };

  // --- Stage 4: Anthropic auth choice ---
  const stage4 = await prompts([
    {
      type: "select",
      name: "anthropicAuth",
      message: "Anthropic auth method:",
      choices: [
        { title: "Claude Code CLI (`claude login` after deploy)", value: "cli" },
        { title: "API key (set ANTHROPIC_API_KEY now)", value: "apiKey" },
      ],
    },
    {
      type: (prev) => (prev === "apiKey" ? "password" : null),
      name: "anthropicApiKey",
      message: "ANTHROPIC_API_KEY:",
    },
  ]);

  // --- Stage 5: license + tier-gated PM agent setup ---
  const stage5 = await prompts([
    {
      // password type masks the JWT so it doesn't echo to scrollback / shell history.
      // Decoded license summary printed below intentionally only shows tier + features,
      // not the full JWT, so paste-into-terminal stays opaque.
      type: "password",
      name: "licenseKey",
      message: "URATEAM_LICENSE_KEY (leave blank for OSS):",
    },
  ]);
  const license = decodeLicense(stage5.licenseKey);

  if (license) {
    console.log(
      `\n  License decoded: tier=${license.tier}, features=[${license.features.join(", ")}]`,
    );
    if (license.expiresAt && license.expiresAt.getTime() < Date.now()) {
      console.warn(
        `  ⚠ License expired at ${license.expiresAt.toISOString()} — runtime will reject ` +
          "it and fall back to OSS tier. Renew before deploying.",
      );
    }
    console.log("");
  }

  let pmAgent: PmAgentOptions | undefined;
  if (
    license &&
    license.tier !== "oss" &&
    license.features.includes("slack-interface")
  ) {
    console.log(
      "\n  Your license includes the `slack-interface` feature (PM agent + Slack /pm slash commands).\n" +
        "  You can configure it now if you have your Slack app credentials handy, or skip and add\n" +
        "  the PM_AGENT_* + SLACK_* lines to .env later. Setup walkthrough:\n" +
        "  https://github.com/JonB32/urateam/blob/main/docs/slack-setup.md\n",
    );
    const setupNow = await prompts({
      type: "confirm",
      name: "setup",
      message: "Set up PM agent + Slack interface now?",
      initial: false,
    });
    if (setupNow.setup) {
      const pmPrompts = await prompts([
        { type: "password", name: "slackBotToken", message: "SLACK_BOT_TOKEN (xoxb-...):" },
        { type: "password", name: "slackSigningSecret", message: "SLACK_SIGNING_SECRET:" },
        { type: "text", name: "slackChannelId", message: "PM_AGENT_SLACK_CHANNEL_ID (Cxxxxx):" },
        {
          type: "text",
          name: "teamIds",
          message: "PM_AGENT_TEAM_IDS (comma-separated):",
          initial: stage1.linearTeamId,
        },
        {
          type: "number",
          name: "dailyTokenBudget",
          message: "PM_AGENT_DAILY_TOKEN_BUDGET:",
          initial: 5_000_000,
        },
      ]);
      if (pmPrompts.slackBotToken && pmPrompts.slackSigningSecret && pmPrompts.slackChannelId) {
        pmAgent = {
          slackBotToken: pmPrompts.slackBotToken,
          slackSigningSecret: pmPrompts.slackSigningSecret,
          slackChannelId: pmPrompts.slackChannelId,
          teamIds: pmPrompts.teamIds || stage1.linearTeamId,
          dailyTokenBudget: pmPrompts.dailyTokenBudget ?? 5_000_000,
        };
      } else if (pmPrompts.slackBotToken || pmPrompts.slackSigningSecret || pmPrompts.slackChannelId) {
        // Partial input — warn loudly so the operator doesn't think they configured PM.
        console.warn(
          "\n  ⚠ PM agent setup incomplete — at least one of SLACK_BOT_TOKEN, " +
            "SLACK_SIGNING_SECRET, PM_AGENT_SLACK_CHANNEL_ID was blank. The PM_AGENT_* " +
            "block in .env has been left commented out; fill it in by hand to enable.\n",
        );
      }
    }
  }

  // --- Stage 6: optional GitHub webhook secret + notification webhooks ---
  const stage6 = await prompts([
    {
      // Hidden input — secret is shared with GitHub's webhook config. If the
      // operator already has a secret in GitHub, paste it here. Otherwise leave
      // blank and the auto-gen step at Stage 8 will mint one for both sides.
      type: "password",
      name: "githubWebhookSecret",
      message:
        "GITHUB_WEBHOOK_SECRET (paste from GitHub if you already set one, or leave blank to auto-generate):",
    },
    {
      type: "text",
      name: "slackWebhookUrl",
      message:
        "SLACK_WEBHOOK_URL (incoming-webhook for pipeline events; leave blank to skip):",
    },
    {
      type: "text",
      name: "discordWebhookUrl",
      message: "DISCORD_WEBHOOK_URL (leave blank to skip):",
    },
  ]);

  // --- Stage 7: per-stage agent profile overrides (wizard) ---
  const stage7Customize = await prompts({
    type: "confirm",
    name: "customize",
    message:
      "Customize per-stage agent budgets (URATEAM_AGENT_PROFILES)? Most operators skip this.",
    initial: false,
  });
  let agentProfiles: ScaffoldOptions["agentProfiles"] | undefined;
  if (stage7Customize.customize) {
    agentProfiles = {};
    const stages = ["implement", "test", "review"];
    for (const stage of stages) {
      const wantStage = await prompts({
        type: "confirm",
        name: "yes",
        message: `Override budget for the \`${stage}\` stage?`,
        initial: false,
      });
      if (!wantStage.yes) continue;
      // Min/max mirror the runtime ceilings in packages/core/src/executor/profiles.ts:96
      // (MAX_TURNS_CEILING=500, MAX_INPUT_TOKENS_CEILING=500_000) so the wizard
      // rejects out-of-range values at input time instead of letting the runtime
      // silently drop them with a warn.
      const profile = await prompts([
        {
          type: "number",
          name: "maxTurns",
          message: `  ${stage}.maxTurns (1–500, blank to keep default):`,
          min: 1,
          max: 500,
        },
        {
          type: "number",
          name: "maxInputTokens",
          message: `  ${stage}.maxInputTokens (1–500000, blank to keep default):`,
          min: 1,
          max: 500_000,
        },
        { type: "text", name: "model", message: `  ${stage}.model (blank to keep default):` },
      ]);
      const entry: { maxTurns?: number; maxInputTokens?: number; model?: string } = {};
      if (typeof profile.maxTurns === "number") entry.maxTurns = profile.maxTurns;
      if (typeof profile.maxInputTokens === "number") entry.maxInputTokens = profile.maxInputTokens;
      if (profile.model) entry.model = profile.model;
      if (Object.keys(entry).length > 0) agentProfiles[stage] = entry;
    }
    if (Object.keys(agentProfiles).length === 0) {
      agentProfiles = undefined; // all stages skipped — don't write a `{}` JSON
    } else {
      // Validate that the profiles object is JSON-serializable so a typo doesn't
      // get persisted as broken syntax that the agent would crash on at runtime.
      try {
        JSON.stringify(agentProfiles);
      } catch (e) {
        console.error("Internal: agent profiles failed JSON serialization — skipping.", e);
        agentProfiles = undefined;
      }
    }
  }

  // --- Stage 8: secret generation strategy ---
  // GITHUB_WEBHOOK_SECRET is in this set with one twist: if the operator
  // explicitly pasted a value in Stage 6, it wins; otherwise it's auto-genned
  // here. Either way the operator gets a value they can paste into GitHub's
  // webhook config so HMAC signatures match.
  const stage8 = await prompts({
    type: "confirm",
    name: "autoGen",
    message:
      "Auto-generate POSTGRES_PASSWORD, DASHBOARD_PASSWORD, GITHUB_WEBHOOK_SECRET? (No → leave blank in .env for any not provided above)",
    initial: true,
  });

  // --- Stage 9: GitHub PR-comment re-trigger config (gated) ---
  // Only prompt when both signals are present:
  //   - URATEAM_LICENSE_KEY pasted (operator is engaged with the product enough
  //     to want advanced workflows)
  //   - A GITHUB_WEBHOOK_SECRET will exist in .env (either pasted in Stage 6
  //     or auto-genned in Stage 8) — without it the runtime won't even mount
  //     the feedback handler.
  let githubFeedback: GithubFeedbackOptions | undefined;
  const willHaveGhSecret = !!stage6.githubWebhookSecret || stage8.autoGen;
  if (stage5.licenseKey && willHaveGhSecret) {
    const setupFeedback = await prompts({
      type: "confirm",
      name: "setup",
      message:
        "Configure GitHub PR-comment re-triggers (GITHUB_FEEDBACK_*) now? You can skip and add later.",
      initial: false,
    });
    if (setupFeedback.setup) {
      const fb = await prompts([
        {
          type: "text",
          name: "triggerKeyword",
          message:
            "  GITHUB_FEEDBACK_TRIGGER_KEYWORD (require this string in PR comment to fire; blank = any review/comment):",
        },
        {
          type: "text",
          name: "allowedReviewers",
          message:
            "  GITHUB_FEEDBACK_ALLOWED_REVIEWERS (csv of GitHub usernames whose comments fire it; blank = all):",
        },
        {
          type: "text",
          name: "botLogins",
          message:
            "  GITHUB_FEEDBACK_BOT_LOGINS (csv of bot logins like github-actions[bot]; blank = none):",
        },
        {
          type: "confirm",
          name: "autoTrigger",
          message: "  GITHUB_FEEDBACK_AUTO_TRIGGER — fire automatically on qualifying comments?",
          initial: true,
        },
      ]);
      githubFeedback = {
        triggerKeyword: fb.triggerKeyword || undefined,
        allowedReviewers: fb.allowedReviewers || undefined,
        botLogins: fb.botLogins || undefined,
        autoTrigger: fb.autoTrigger,
      };
    }
  }

  const projectDir = arg === "." ? process.cwd() : join(process.cwd(), arg);
  const projectName = arg === "." ? basename(projectDir) || "my-project" : arg;

  const scaffoldOptions: ScaffoldOptions = {
    projectDir,
    projectName,
    linearApiKey: stage1.linearApiKey,
    linearTeamId: stage1.linearTeamId,
    repoUrl: stage1.repoUrl,
    defaultBranch: stage1.defaultBranch || "main",
    deployMode: stage2.deployMode,
    linearWebhookSecret: stage2.linearWebhookSecret,
    domain: stage3.domain,
    caddyEmail: stage3.caddyEmail,
    dashboardBasePath: normalizeBasePath(stage3.dashboardBasePath),
    anthropicApiKey: stage4.anthropicApiKey,
    licenseKey: stage5.licenseKey,
    pmAgent,
    githubWebhookSecret: stage6.githubWebhookSecret || undefined,
    githubFeedback,
    slackWebhookUrl: stage6.slackWebhookUrl || undefined,
    discordWebhookUrl: stage6.discordWebhookUrl || undefined,
    agentProfiles,
    autoGenSecrets: stage8.autoGen,
  };

  return {
    projectDir,
    projectName,
    scaffoldOptions,
    deployMode: stage2.deployMode,
    domain: stage3.domain,
    dashboardBasePath: normalizeBasePath(stage3.dashboardBasePath),
    anthropicAuth: stage4.anthropicAuth,
  };
}

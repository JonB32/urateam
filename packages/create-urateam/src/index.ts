#!/usr/bin/env node
import {
  mkdirSync,
  writeFileSync,
  cpSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  appendFileSync,
} from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface PmAgentOptions {
  slackBotToken: string;
  slackSigningSecret: string;
  slackChannelId: string;
  teamIds: string;
  /** Daily token cap for the PM agent loop. Default 5_000_000 (5M). */
  dailyTokenBudget?: number;
}

export interface GithubFeedbackOptions {
  /** Mention a reviewer @bot or paste the keyword in a PR comment to retrigger the pipeline. */
  triggerKeyword?: string;
  /** Comma-separated GitHub usernames whose comments are honored. Default: all. */
  allowedReviewers?: string;
  /** Comma-separated GitHub bot logins whose comments are honored (e.g. github-actions[bot]). */
  botLogins?: string;
  /** When false, only triggers on the explicit triggerKeyword. Default true. */
  autoTrigger?: boolean;
}

export interface ScaffoldOptions {
  /** The project root directory. `.urateam/` will be created inside it. */
  projectDir: string;
  /** Project name — used in CLAUDE.md header and .urateam/package.json. */
  projectName: string;
  linearApiKey: string;
  linearTeamId: string;
  repoUrl: string;
  defaultBranch: string;

  // --- Production deploy fields (all optional — omitted = local-dev mode) ---
  deployMode?: "local" | "production";
  /** Public hostname Caddy will request a Let's Encrypt cert for. */
  domain?: string;
  /** Email for ACME / Let's Encrypt expiry warnings. */
  caddyEmail?: string;
  /** Linear webhook signing secret — must match the value set in Linear. */
  linearWebhookSecret?: string;
  /** Anthropic auth — set this for headless / API-key path; omit for `claude login`. */
  anthropicApiKey?: string;
  /** Pro license JWT. If omitted, the scaffolded sidecar runs in OSS mode. */
  licenseKey?: string;
  /** Dashboard basic-auth username (default "admin"). */
  dashboardUser?: string;
  /** Dashboard basic-auth password. If omitted and autoGenSecrets is true, a fresh one is generated. */
  dashboardPassword?: string;
  /** Path prefix the dashboard is mounted under (no trailing slash). Empty = root. */
  dashboardBasePath?: string;
  /** Postgres password. If omitted and autoGenSecrets is true, a fresh one is generated. */
  postgresPassword?: string;
  /** GitHub webhook signing secret. If omitted and autoGenSecrets is true, a fresh one is generated. */
  githubWebhookSecret?: string;
  /** Concurrency cap for in-flight pipeline runs. Default 3. */
  maxConcurrentRuns?: number;
  /** Pro PM-agent setup. Only honored when license tier includes `slack-interface`. */
  pmAgent?: PmAgentOptions;
  /** GitHub PR-comment-driven re-trigger config (only kicks in when GITHUB_WEBHOOK_SECRET is set). */
  githubFeedback?: GithubFeedbackOptions;
  /** Slack incoming-webhook URL for pipeline notifications (no Pro license needed). */
  slackWebhookUrl?: string;
  /** Discord webhook URL for pipeline notifications (no Pro license needed). */
  discordWebhookUrl?: string;
  /**
   * Per-stage agent budget overrides. JSON-stringified at write time. Example:
   * `{ test: { maxTurns: 50, maxInputTokens: 80000 } }`. See urateam#38.
   */
  agentProfiles?: Record<string, { maxTurns?: number; maxInputTokens?: number; model?: string }>;
  /**
   * When true (default), missing secret fields (DASHBOARD_PASSWORD, POSTGRES_PASSWORD,
   * GITHUB_WEBHOOK_SECRET) are auto-generated. When false, missing fields are written
   * blank in .env so the operator can fill them in by hand.
   */
  autoGenSecrets?: boolean;
}

export interface LicenseInfo {
  tier: "pro" | "enterprise" | "oss";
  features: string[];
  customerId?: string;
  expiresAt?: Date;
}

export interface ScaffoldResult {
  /** Absolute path to the created `.urateam/` directory. */
  urateamDir: string;
  /** Decoded license info, or null if no licenseKey was provided / it was unparseable. */
  license: LicenseInfo | null;
  /** Auto-generated secrets that the operator should record on first run. */
  generatedSecrets: {
    dashboardPassword?: string;
    postgresPassword?: string;
    githubWebhookSecret?: string;
  };
  /** TODOs surfaced for the next-steps printout. */
  todos: string[];
}

/**
 * Decode a urateam license JWT payload WITHOUT verifying the signature.
 *
 * The scaffolder doesn't ship the public key (would bloat the package and
 * couple it to a specific signing-key generation), and a malformed JWT here
 * just produces a wrong prompt flow which is recoverable by editing .env
 * after the fact. Production verification happens at runtime in the agent
 * via packages/core/src/license.ts against the embedded public key.
 *
 * Returns null on any parse failure.
 */
export function decodeLicense(jwt: string | undefined | null): LicenseInfo | null {
  if (!jwt) return null;
  const segments = jwt.split(".");
  if (segments.length !== 3) return null;
  try {
    const payloadJson = Buffer.from(
      segments[1].replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (segments[1].length % 4)) % 4),
      "base64",
    ).toString("utf-8");
    const payload = JSON.parse(payloadJson) as {
      tier?: string;
      features?: string[];
      sub?: string;
      exp?: number;
    };
    const tier =
      payload.tier === "pro" || payload.tier === "enterprise" ? payload.tier : "oss";
    return {
      tier,
      features: payload.features ?? [],
      customerId: payload.sub,
      expiresAt: payload.exp ? new Date(payload.exp * 1000) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Build the `.env` content for a scaffolded urateam sidecar.
 *
 * Pure function: takes already-resolved values, returns the file string.
 * Auto-generation of missing secrets is the caller's responsibility (see
 * resolveSecrets below) so this stays trivially testable.
 */
function buildEnv(
  options: Required<
    Pick<
      ScaffoldOptions,
      "linearApiKey" | "linearTeamId" | "repoUrl" | "defaultBranch"
    >
  > & {
    deployMode: "local" | "production";
    linearWebhookSecret: string;
    domain: string;
    caddyEmail: string;
    anthropicApiKey: string;
    licenseKey: string;
    dashboardUser: string;
    dashboardPassword: string;
    postgresPassword: string;
    githubWebhookSecret: string;
    maxConcurrentRuns: number;
    pmAgent: PmAgentOptions | undefined;
    dashboardBasePath: string;
    githubFeedback: GithubFeedbackOptions | undefined;
    slackWebhookUrl: string;
    discordWebhookUrl: string;
    agentProfiles: ScaffoldOptions["agentProfiles"];
  },
): string {
  const lines: string[] = [];
  const push = (line: string) => lines.push(line);
  const blank = () => lines.push("");

  push("# === Linear (REQUIRED) ===");
  push(`LINEAR_API_KEY=${options.linearApiKey}`);
  // Comment out when blank so the runtime's "is required" check fails fast
  // with the right message instead of silently treating "" as a valid secret.
  if (options.linearWebhookSecret) {
    push(`LINEAR_WEBHOOK_SECRET=${options.linearWebhookSecret}`);
  } else {
    push("# LINEAR_WEBHOOK_SECRET=  # paste from Linear's webhook config UI");
  }
  push(`LINEAR_TEAM_ID=${options.linearTeamId}`);
  blank();

  push("# === Repository (REQUIRED) ===");
  push(`REPO_URL=${options.repoUrl}`);
  push(`REPO_DEFAULT_BRANCH=${options.defaultBranch}`);
  // REPO_TEAM_ID is the map key for repoConfigs[teamId] — defaulted to
  // LINEAR_TEAM_ID for single-team / single-repo setups (the env-var path).
  // Multi-repo Pro deployments use repos.config.ts instead and can ignore
  // this var. See packages/cli/src/commands/start.ts:50.
  push(`REPO_TEAM_ID=${options.linearTeamId}`);
  blank();

  push("# === Anthropic auth ===");
  if (options.anthropicApiKey) {
    push(`ANTHROPIC_API_KEY=${options.anthropicApiKey}`);
  } else {
    push("# ANTHROPIC_API_KEY=  # blank → run `docker compose exec agent claude login` after deploy");
  }
  blank();

  push("# === Pro license (blank = OSS tier) ===");
  push(`URATEAM_LICENSE_KEY=${options.licenseKey}`);
  blank();

  push("# === GitHub auth (REQUIRED for PR creation) ===");
  push("# Either run `docker compose exec agent gh auth login` after deploy,");
  push("# or set the GitHub App trio below:");
  push("# GITHUB_APP_ID=");
  push("# GITHUB_PRIVATE_KEY_PATH=/run/gh-app.pem");
  push("# GITHUB_INSTALLATION_ID=");
  push(`GITHUB_WEBHOOK_SECRET=${options.githubWebhookSecret}`);
  blank();

  push("# === Database ===");
  push(`POSTGRES_PASSWORD=${options.postgresPassword}`);
  blank();

  if (options.deployMode === "production") {
    push("# === Domain (production deploy) ===");
    push(`DOMAIN=${options.domain}`);
    push(`CADDY_EMAIL=${options.caddyEmail}`);
    blank();
  }

  push("# === Dashboard auth ===");
  push(`DASHBOARD_USER=${options.dashboardUser}`);
  push(`DASHBOARD_PASSWORD=${options.dashboardPassword}`);
  if (options.dashboardBasePath) {
    push(`DASHBOARD_BASE_PATH=${options.dashboardBasePath}`);
  } else {
    push("# DASHBOARD_BASE_PATH=  # set with leading slash, no trailing, when behind a path prefix");
  }
  blank();

  push("# === Concurrency ===");
  push(`MAX_CONCURRENT_RUNS=${options.maxConcurrentRuns}`);
  blank();

  if (options.pmAgent) {
    push("# === PM Agent (Pro: slack-interface) ===");
    push("PM_AGENT_ENABLED=true");
    push(`PM_AGENT_TEAM_IDS=${options.pmAgent.teamIds}`);
    push(`PM_AGENT_SLACK_CHANNEL_ID=${options.pmAgent.slackChannelId}`);
    push(`PM_AGENT_DAILY_TOKEN_BUDGET=${options.pmAgent.dailyTokenBudget ?? 5_000_000}`);
    push(`PM_AGENT_MAX_IN_FLIGHT=3`);
    push(`SLACK_BOT_TOKEN=${options.pmAgent.slackBotToken}`);
    push(`SLACK_SIGNING_SECRET=${options.pmAgent.slackSigningSecret}`);
    blank();
  } else {
    push("# === PM Agent (Pro: slack-interface) — fill in to enable ===");
    push("# PM_AGENT_ENABLED=true");
    push("# PM_AGENT_TEAM_IDS=");
    push("# PM_AGENT_SLACK_CHANNEL_ID=");
    push("# PM_AGENT_DAILY_TOKEN_BUDGET=5000000");
    push("# PM_AGENT_MAX_IN_FLIGHT=3");
    push("# SLACK_BOT_TOKEN=");
    push("# SLACK_SIGNING_SECRET=");
    blank();
  }

  push("# === GitHub PR-comment re-trigger (optional, gated by GITHUB_WEBHOOK_SECRET above) ===");
  if (options.githubFeedback) {
    if (options.githubFeedback.autoTrigger === false) {
      push("GITHUB_FEEDBACK_AUTO_TRIGGER=false");
    } else {
      push("# GITHUB_FEEDBACK_AUTO_TRIGGER=true  # default — fire on any qualifying review/comment");
    }
    if (options.githubFeedback.triggerKeyword) {
      push(`GITHUB_FEEDBACK_TRIGGER_KEYWORD=${options.githubFeedback.triggerKeyword}`);
    } else {
      push("# GITHUB_FEEDBACK_TRIGGER_KEYWORD=  # require this keyword in the comment to fire");
    }
    if (options.githubFeedback.allowedReviewers) {
      push(`GITHUB_FEEDBACK_ALLOWED_REVIEWERS=${options.githubFeedback.allowedReviewers}`);
    } else {
      push("# GITHUB_FEEDBACK_ALLOWED_REVIEWERS=  # comma-separated GitHub usernames");
    }
    if (options.githubFeedback.botLogins) {
      push(`GITHUB_FEEDBACK_BOT_LOGINS=${options.githubFeedback.botLogins}`);
    } else {
      push("# GITHUB_FEEDBACK_BOT_LOGINS=  # comma-separated bot logins, e.g. github-actions[bot]");
    }
  } else {
    push("# GITHUB_FEEDBACK_AUTO_TRIGGER=true  # default — fire on any qualifying review/comment");
    push("# GITHUB_FEEDBACK_TRIGGER_KEYWORD=  # require this keyword in the comment to fire");
    push("# GITHUB_FEEDBACK_ALLOWED_REVIEWERS=  # comma-separated GitHub usernames");
    push("# GITHUB_FEEDBACK_BOT_LOGINS=  # comma-separated bot logins, e.g. github-actions[bot]");
  }
  blank();

  push("# === Pipeline notifications (no Pro license needed) ===");
  if (options.slackWebhookUrl) {
    push(`SLACK_WEBHOOK_URL=${options.slackWebhookUrl}`);
  } else {
    push("# SLACK_WEBHOOK_URL=  # Slack incoming-webhook for pipeline event posts");
  }
  if (options.discordWebhookUrl) {
    push(`DISCORD_WEBHOOK_URL=${options.discordWebhookUrl}`);
  } else {
    push("# DISCORD_WEBHOOK_URL=  # Discord webhook for pipeline event posts");
  }
  blank();

  push("# === Per-stage agent budget overrides (urateam#38) ===");
  if (options.agentProfiles && Object.keys(options.agentProfiles).length > 0) {
    push(`URATEAM_AGENT_PROFILES='${JSON.stringify(options.agentProfiles)}'`);
  } else {
    push("# URATEAM_AGENT_PROFILES='{\"test\":{\"maxTurns\":50,\"maxInputTokens\":80000}}'");
  }
  blank();

  push("# === Optional ===");
  push("# LOG_LEVEL=info");
  push("");
  push("# Additional tunables (worktree TTL, repo clone dir, agent run dir, etc.)");
  push("# documented in .env.example next to this file. Keep that file as the");
  push("# canonical reference; this .env is generated from prompts.");
  return lines.join("\n") + "\n";
}

function resolveSecrets(options: ScaffoldOptions): {
  dashboardPassword: string;
  postgresPassword: string;
  githubWebhookSecret: string;
  generated: ScaffoldResult["generatedSecrets"];
} {
  const autoGen = options.autoGenSecrets ?? true;
  const generated: ScaffoldResult["generatedSecrets"] = {};

  let dashboardPassword = options.dashboardPassword ?? "";
  let postgresPassword = options.postgresPassword ?? "";
  let githubWebhookSecret = options.githubWebhookSecret ?? "";

  if (autoGen) {
    // base64url avoids `+`, `/`, `=` which can trip strict env-file parsers
    // and a few HMAC validators in the wild.
    if (!dashboardPassword) {
      dashboardPassword = randomBytes(18).toString("base64url");
      generated.dashboardPassword = dashboardPassword;
    }
    if (!postgresPassword) {
      postgresPassword = randomBytes(24).toString("base64url");
      generated.postgresPassword = postgresPassword;
    }
    if (!githubWebhookSecret) {
      githubWebhookSecret = randomBytes(32).toString("hex");
      generated.githubWebhookSecret = githubWebhookSecret;
    }
  }

  return { dashboardPassword, postgresPassword, githubWebhookSecret, generated };
}

/**
 * Scaffold a urateam sidecar into a project directory.
 *
 * Creates:
 *   - <projectDir>/.urateam/            — isolated urateam config + deps
 *     - package.json                    — depends on @urateam/cli
 *     - .env                            — Linear keys, webhook secret, etc.
 *     - .env.example
 *     - Dockerfile
 *     - docker-compose.yml
 *     - Caddyfile                       — reverse proxy + auto-HTTPS
 *     - README.md                       — how to run the sidecar
 *   - <projectDir>/CLAUDE.md            — project conventions (only if absent)
 *   - <projectDir>/README.md            — project readme (only if absent)
 *   - <projectDir>/.gitignore           — ensures .urateam/.env is ignored
 *
 * The project root `package.json` is NOT touched. Existing `.env` and
 * `package.json` inside `.urateam/` are preserved on re-run.
 */
export function scaffold(options: ScaffoldOptions): ScaffoldResult {
  const { projectDir, projectName, linearApiKey, linearTeamId, repoUrl, defaultBranch } = options;

  mkdirSync(projectDir, { recursive: true });

  let templateDir = join(__dirname, "..", "template");
  if (!statSync(templateDir, { throwIfNoEntry: false })?.isDirectory()) {
    templateDir = join(__dirname, "..", "..", "template");
  }

  const urateamDir = join(projectDir, ".urateam");
  mkdirSync(urateamDir, { recursive: true });

  const urateamTemplateDir = join(templateDir, ".urateam");
  for (const entry of readdirSync(urateamTemplateDir)) {
    if (entry === ".env") continue;
    const src = join(urateamTemplateDir, entry);
    const dest = join(urateamDir, entry);
    cpSync(src, dest, { recursive: true, force: true });
  }

  const pkgPath = join(urateamDir, "package.json");
  if (!existsSync(pkgPath)) {
    const pkg = {
      name: `${projectName}-urateam`,
      private: true,
      type: "module",
      scripts: {
        dev: "ura dev",
        start: "ura start",
      },
      dependencies: {
        "@urateam/cli": "^0.1.4",
      },
    };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }

  const license = decodeLicense(options.licenseKey);
  const todos: string[] = [];

  const { dashboardPassword, postgresPassword, githubWebhookSecret, generated } =
    resolveSecrets(options);

  // --- Compose .env from inputs + resolved secrets ---
  const envPath = join(urateamDir, ".env");
  if (!existsSync(envPath)) {
    const linearWebhookSecret = options.linearWebhookSecret ?? "";
    if (!linearWebhookSecret) {
      todos.push(
        "LINEAR_WEBHOOK_SECRET — paste from Linear's webhook config UI " +
          "(Workspace settings → API → Webhooks).",
      );
    }
    if (!options.licenseKey) {
      todos.push(
        "URATEAM_LICENSE_KEY — Pro features (PM agent, Slack interface, multi-repo, " +
          "deep-review, etc.) stay disabled until you set this.",
      );
    }
    if (
      license?.tier &&
      license.tier !== "oss" &&
      license.features.includes("slack-interface") &&
      !options.pmAgent
    ) {
      todos.push(
        "PM_AGENT_* — your license includes `slack-interface`. Fill in the " +
          "PM_AGENT_* + SLACK_* lines in .env to enable it.",
      );
    }
    if (!options.anthropicApiKey) {
      todos.push(
        "Anthropic auth — run `docker compose exec agent claude login` after the stack is up " +
          "(or set ANTHROPIC_API_KEY in .env for headless API auth).",
      );
    }
    todos.push(
      "GitHub auth — run `docker compose exec agent gh auth login` after the stack is up " +
        "(or set the GITHUB_APP_* trio in .env for app-based auth).",
    );
    if (options.deployMode === "production" && !options.domain) {
      todos.push("DOMAIN — set in .env before running `docker compose up`.");
    }
    if (options.deployMode === "production" && !options.caddyEmail) {
      todos.push("CADDY_EMAIL — recommended for Let's Encrypt expiry warnings.");
    }
    if (!options.autoGenSecrets) {
      if (!options.dashboardPassword) todos.push("DASHBOARD_PASSWORD — fill in .env.");
      if (!options.postgresPassword) todos.push("POSTGRES_PASSWORD — fill in .env.");
      if (!options.githubWebhookSecret) todos.push("GITHUB_WEBHOOK_SECRET — fill in .env.");
    }

    const envContent = buildEnv({
      linearApiKey,
      linearTeamId,
      repoUrl,
      defaultBranch,
      deployMode: options.deployMode ?? "local",
      linearWebhookSecret,
      domain: options.domain ?? "",
      caddyEmail: options.caddyEmail ?? "",
      anthropicApiKey: options.anthropicApiKey ?? "",
      licenseKey: options.licenseKey ?? "",
      dashboardUser: options.dashboardUser ?? "admin",
      dashboardPassword,
      dashboardBasePath: options.dashboardBasePath ?? "",
      postgresPassword,
      githubWebhookSecret,
      maxConcurrentRuns: options.maxConcurrentRuns ?? 3,
      pmAgent: options.pmAgent,
      githubFeedback: options.githubFeedback,
      slackWebhookUrl: options.slackWebhookUrl ?? "",
      discordWebhookUrl: options.discordWebhookUrl ?? "",
      agentProfiles: options.agentProfiles,
    });
    writeFileSync(envPath, envContent);
  }

  // --- Project root files: copy only if absent ---
  const rootFilesWithPlaceholder = ["CLAUDE.md", "README.md"];
  for (const file of rootFilesWithPlaceholder) {
    const dest = join(projectDir, file);
    if (existsSync(dest)) continue;
    const src = join(templateDir, file);
    if (!existsSync(src)) continue;
    const content = readFileSync(src, "utf-8");
    writeFileSync(dest, content.replace(/\{\{PROJECT_NAME\}\}/g, projectName));
  }

  const gitignorePath = join(projectDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, URATEAM_GITIGNORE);
  } else {
    const existing = readFileSync(gitignorePath, "utf-8");
    const hasBareEntry = existing
      .split(/\r?\n/)
      .some((line) => line.trim() === ".urateam/.env");
    if (!hasBareEntry) {
      const separator = existing.endsWith("\n") ? "\n" : "\n\n";
      appendFileSync(gitignorePath, separator + URATEAM_GITIGNORE);
    }
  }

  return { urateamDir, license, generatedSecrets: generated, todos };
}

const URATEAM_GITIGNORE = `# urateam sidecar
.urateam/.env
.urateam/.env.*
!.urateam/.env.example
.urateam/node_modules/
.urateam/dist/
.urateam/pnpm-lock.yaml
`;


// CLI entrypoint — only runs when executed directly (not when imported for testing)
async function main() {
  const arg = process.argv[2] ?? ".";
  if (arg === "--help" || arg === "-h") {
    console.log("Usage: create-urateam [project-name]");
    console.log("  create-urateam              # adds .urateam/ to current directory (default)");
    console.log("  create-urateam .            # same as above");
    console.log("  create-urateam my-project   # creates new directory and adds .urateam/ inside");
    process.exit(0);
  }

  const prompts = (await import("prompts")).default;

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
      type: "text",
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

  // --- Stage 6: notification webhooks (Slack / Discord — both optional) ---
  const stage6 = await prompts([
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
      const profile = await prompts([
        {
          type: "number",
          name: "maxTurns",
          message: `  ${stage}.maxTurns (blank to keep default):`,
        },
        {
          type: "number",
          name: "maxInputTokens",
          message: `  ${stage}.maxInputTokens (blank to keep default):`,
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
      // Round-trip-validate the JSON we'd write so a typo doesn't get persisted as broken
      // syntax that the agent would crash on at runtime.
      try {
        JSON.parse(JSON.stringify(agentProfiles));
      } catch (e) {
        console.error("Internal: agent profiles JSON failed to round-trip — skipping.", e);
        agentProfiles = undefined;
      }
    }
  }

  // --- Stage 8: secret generation strategy ---
  const stage8 = await prompts({
    type: "confirm",
    name: "autoGen",
    message:
      "Auto-generate POSTGRES_PASSWORD, DASHBOARD_PASSWORD, GITHUB_WEBHOOK_SECRET? (No → leave blank in .env)",
    initial: true,
  });

  const projectDir = arg === "." ? process.cwd() : join(process.cwd(), arg);
  const projectName = arg === "." ? basename(projectDir) || "my-project" : arg;

  const result = scaffold({
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
    dashboardBasePath: stage3.dashboardBasePath || undefined,
    anthropicApiKey: stage4.anthropicApiKey,
    licenseKey: stage5.licenseKey,
    pmAgent,
    slackWebhookUrl: stage6.slackWebhookUrl || undefined,
    discordWebhookUrl: stage6.discordWebhookUrl || undefined,
    agentProfiles,
    autoGenSecrets: stage8.autoGen,
  });

  // --- Next steps printout ---
  console.log(`\n  ✓ urateam sidecar installed in ${result.urateamDir}\n`);

  if (Object.keys(result.generatedSecrets).length > 0) {
    console.log("  Auto-generated secrets (saved to .env — record these now):");
    if (result.generatedSecrets.dashboardPassword) {
      console.log(
        `    Dashboard login: admin / ${result.generatedSecrets.dashboardPassword}`,
      );
    }
    if (result.generatedSecrets.postgresPassword) {
      console.log(`    POSTGRES_PASSWORD: ${result.generatedSecrets.postgresPassword}`);
    }
    if (result.generatedSecrets.githubWebhookSecret) {
      console.log(
        `    GITHUB_WEBHOOK_SECRET: ${result.generatedSecrets.githubWebhookSecret.slice(0, 12)}…`,
      );
    }
    console.log("");
  }

  if (result.license) {
    console.log(`  License: ${result.license.tier}`);
    if (result.license.features.length > 0) {
      console.log(`  Features: ${result.license.features.join(", ")}`);
    }
    console.log("");
  }

  if (result.todos.length > 0) {
    console.log("  Still to do (edit .urateam/.env or run the noted commands):");
    for (const todo of result.todos) {
      console.log(`    • ${todo}`);
    }
    console.log("");
  }

  // Detail any .env updates the operator must do before bringing the stack up.
  if (result.todos.length > 0) {
    console.log("  Before starting the stack, edit .urateam/.env to fill in:");
    for (const todo of result.todos) {
      console.log(`    • ${todo}`);
    }
    console.log("");
  }

  console.log("  Next:");
  if (arg !== ".") console.log(`    cd ${arg}`);
  console.log("    cd .urateam");
  if (result.todos.length > 0) {
    console.log("    # ↑ open .env in your editor and fill in the TODOs above first");
  }
  if (stage2.deployMode === "production") {
    console.log("    docker compose up -d --build");
    if (stage4.anthropicAuth === "cli") {
      console.log("    docker compose exec agent claude login    # device-flow auth");
    }
    console.log("    docker compose exec agent gh auth login   # device-flow auth");
    console.log("");
    console.log("  After the stack is up:");
    console.log(`    1. Add a webhook in Linear → Settings → API → Webhooks`);
    console.log(`         URL: https://${stage3.domain || "<your-domain>"}/webhooks/linear`);
    console.log(`         Subscribe to: Issue state changes`);
    console.log(`         Copy the secret → paste into .env as LINEAR_WEBHOOK_SECRET → restart the stack`);
    console.log(`    2. Open the dashboard at https://${stage3.domain || "<your-domain>"} (admin / your-generated-password)`);
    console.log(`    3. Move a Linear issue to Todo with a pipeline label to trigger your first run`);
  } else {
    console.log("    pnpm install");
    console.log("    ura dev");
  }
  console.log("\n  Slack / PM agent setup walkthrough:");
  console.log("    https://github.com/JonB32/urateam/blob/main/docs/slack-setup.md");
  console.log("\n  See CLAUDE.md in the project root for agent context.\n");
}

const isEntrypoint = process.argv[1]?.endsWith("create-urateam") ||
                     process.argv[1]?.endsWith("index.js");
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

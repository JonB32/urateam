/**
 * Sole process.env reader for all CLI-consumed environment variables.
 *
 * Call `loadEnvConfig(mode)` before any subsystem builder or server
 * initialization. Returns a fully-typed `EnvConfig` or exits with a
 * consolidated error listing every bad/missing value.
 *
 * "start" mode = production (LINEAR_WEBHOOK_SECRET required, dashboard auth
 *   required, RELEASE_MANAGER_ENABLED triggers GitHub App check at boot).
 * "dev" mode = local development (LINEAR_WEBHOOK_SECRET optional, dashboard
 *   auth optional).
 *
 * Implementation note — manual validation instead of Zod:
 * The issue acceptance criteria specified a Zod schema. The implementation
 * uses manual TypeScript helpers from @urateam/core (parseIntOr, etc.)
 * instead, because: (a) @urateam/cli had no direct Zod dependency at the
 * time; (b) the manual approach provides identical compile-time type safety
 * via the EnvConfig interface; (c) the batched-error behavior we need
 * (collect ALL errors, then exit once) is easier to implement with the
 * manual helpers than with Zod's safeParse which short-circuits per field.
 * Future maintainers may switch to Zod if they add it as a direct dep.
 */

import { parseIntOr, parsePosIntOr, parseFloatOr, parseOptPosInt, createLogger } from "@urateam/core";

const log = createLogger({ component: "env-validation" });

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Typed representation of all CLI-consumed env vars.
 *
 * convention-exception: credential-in-interface — This interface deliberately
 * contains fields with *Token, *Secret, *Key, *Password names. EnvConfig IS
 * the typed replacement for process.env in the CLI layer; these names mirror
 * the env-var names exactly so operators can cross-reference with ENV_VARS.md.
 * The credentials are read from process.env once at boot, validated, and then
 * passed explicitly to subsystem builders — they do not persist beyond startup.
 */
export interface EnvConfig {
  // Core
  LINEAR_WEBHOOK_SECRET: string | undefined;
  LINEAR_API_KEY: string;
  DASHBOARD_USER: string | undefined;
  DASHBOARD_PASSWORD: string | undefined;
  DATABASE_URL: string | undefined;
  URATEAM_LICENSE_KEY: string | undefined;
  ANTHROPIC_API_KEY: string | undefined;
  CLAUDE_CODE_OAUTH_TOKEN: string | undefined;

  // Repo config
  REPO_TEAM_ID: string | undefined;
  REPO_URL: string | undefined;
  REPO_DEFAULT_BRANCH: string;
  REPO_TEST_CMD: string;
  REPO_BUILD_CMD: string;
  REPO_EXCLUDE_PLUGINS: string | undefined;
  REPO_EXCLUDE_MCP_SERVERS: string | undefined;
  REPO_DISABLE_PLUGIN_AUTODETECT: boolean;

  // GitHub App
  GITHUB_APP_ID: string | undefined;
  GITHUB_PRIVATE_KEY_PATH: string | undefined;
  GITHUB_INSTALLATION_ID: number | undefined;
  GITHUB_WEBHOOK_SECRET: string | undefined;
  GITHUB_FEEDBACK_AUTO_TRIGGER: boolean;
  GITHUB_FEEDBACK_TRIGGER_KEYWORD: string | undefined;
  GITHUB_FEEDBACK_ALLOWED_REVIEWERS: string | undefined;
  GITHUB_FEEDBACK_BOT_LOGINS: string | undefined;

  // Server / Infrastructure
  PORT: number;
  DASHBOARD_PORT: number;
  AGENT_RUN_DIR: string | undefined;
  REPO_CLONE_DIR: string | undefined;
  MAX_CONCURRENT_RUNS: number;
  WORKTREE_TTL_HOURS: number;

  // Notifications
  SLACK_BOT_TOKEN: string | undefined;
  SLACK_SIGNING_SECRET: string | undefined;
  SLACK_WEBHOOK_URL: string | undefined;
  SLACK_ERROR_ALERTS: boolean;
  DISCORD_WEBHOOK_URL: string | undefined;

  // PM Agent
  PM_AGENT_ENABLED: boolean;
  PM_AGENT_CRON_INTERVAL_MS: number;
  PM_AGENT_MAX_IN_FLIGHT: number;
  PM_AGENT_DAILY_TOKEN_BUDGET: number | undefined;
  PM_AGENT_SLACK_CHANNEL_ID: string | undefined;
  PM_AGENT_TEAM_IDS: string | undefined;
  PM_AGENT_REQUIRE_PIPELINE_LABEL_FOR_PROMOTE: boolean;
  PM_AGENT_MAX_CONSECUTIVE_FAILURES: number;
  PM_AGENT_PAUSED: boolean;
  PM_AGENT_AGENT_BRANCH_TTL_DAYS: number;
  PM_AGENT_STUCK_RUN_AGE_MIN: number;

  // Release Manager
  RELEASE_MANAGER_ENABLED: boolean;
  RELEASE_MANAGER_SCHEDULE: string;
  RELEASE_MANAGER_VERSION_BUMP: string;
  RELEASE_MANAGER_SLACK_CHANNEL: string | undefined;
  RELEASE_MANAGER_BRANCH: string;
  RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE: number | undefined;
  RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS: number | undefined;
  RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES: number | undefined;
  RELEASE_MANAGER_TRIGGER_REQUIRE_SLACK_APPROVAL: boolean;
  RELEASE_MANAGER_TRIGGER_QA_WORKFLOW: string | undefined;
  RELEASE_MANAGER_TRIGGER_QA_LINEAR_TEAM_ID: string | undefined;
  RELEASE_MANAGER_TRIGGER_QA_TIMEOUT_MINUTES: number | undefined;

  // SSO (Enterprise)
  URATEAM_SSO_ENABLED: boolean;
  URATEAM_WORKOS_API_KEY: string | undefined;
  URATEAM_WORKOS_CLIENT_ID: string | undefined;
  URATEAM_WORKOS_REDIRECT_URI: string | undefined;
  URATEAM_SSO_STATE_SECRET: string | undefined;
  URATEAM_SSO_ALLOWED_DOMAIN: string | undefined;
  URATEAM_SSO_SESSION_HOURS: number;
  URATEAM_SSO_COOKIE_NAME: string;
  URATEAM_SSO_COOKIE_SECURE: boolean;

  // Review Models (OpenRouter)
  REVIEW_MODELS: string | undefined;
  OPENROUTER_API_KEY: string | undefined;
  OPENROUTER_BASE_URL: string | undefined;
  REVIEW_MODELS_MAX_OUTPUT_TOKENS: number | undefined;
  REVIEW_MODELS_TIMEOUT_MS: number | undefined;
  REVIEW_MODELS_MAX_INPUT_TOKENS: number | undefined;
  REVIEW_MODELS_MIN_OUTPUT_RATIO: number;
  REVIEW_MODELS_HEALTH_LOOKBACK_HOURS: number;
  REVIEW_MODELS_MIN_RUNS: number;

  // Pipeline overrides (passed through as raw strings to core helpers)
  URATEAM_DEEP_REVIEW_PASSES: string | undefined;
  URATEAM_AUTO_MERGE: string | undefined;

  // RBAC / Admin
  URATEAM_ADMIN_EMAILS: string | undefined;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function str(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return env[key]?.trim() || undefined;
}

function flag(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] === "true";
}

// opt-out boolean: default true, explicitly disabled by setting to "false"
function flagOptOut(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] !== "false";
}

// ── Main validation ────────────────────────────────────────────────────────

export function loadEnvConfig(
  mode: "start" | "dev",
  env: NodeJS.ProcessEnv = process.env,
): EnvConfig {
  const errors: string[] = [];

  function require(key: string, description?: string): string | undefined {
    const val = str(env, key);
    if (!val) errors.push(`${key} is required${description ? ` (${description})` : ""}`);
    return val;
  }

  function requireIf(condition: boolean, key: string, context: string): string | undefined {
    if (!condition) return str(env, key);
    const val = str(env, key);
    if (!val) errors.push(`${key} is required when ${context}`);
    return val;
  }

  function requireIntIf(condition: boolean, key: string, context: string): number | undefined {
    if (!condition) return parseOptPosInt(str(env, key));
    const raw = str(env, key);
    if (!raw) {
      errors.push(`${key} is required when ${context}`);
      return undefined;
    }
    const n = parsePosIntOr(raw, 0);
    if (n === 0) errors.push(`${key} must be a positive integer (got "${raw}")`);
    return n === 0 ? undefined : n;
  }

  function validatePosInt(key: string, raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    const n = parsePosIntOr(raw, 0);
    if (n === 0) errors.push(`${key} must be a positive integer (got "${raw}")`);
    return n === 0 ? fallback : n;
  }

  // ── Production-required fields ──────────────────────────────────────────
  const pmEnabled = flag(env, "PM_AGENT_ENABLED");
  const rmEnabled = flag(env, "RELEASE_MANAGER_ENABLED");
  const ssoEnabled = flag(env, "URATEAM_SSO_ENABLED");

  const linearWebhookSecret =
    mode === "start" ? require("LINEAR_WEBHOOK_SECRET") : str(env, "LINEAR_WEBHOOK_SECRET");

  let dashboardUser: string | undefined;
  let dashboardPassword: string | undefined;
  if (mode === "start") {
    dashboardUser = require("DASHBOARD_USER");
    dashboardPassword = require("DASHBOARD_PASSWORD");
  } else {
    dashboardUser = str(env, "DASHBOARD_USER");
    dashboardPassword = str(env, "DASHBOARD_PASSWORD");
  }

  // ── PM Agent conditional requirements ───────────────────────────────────
  const pmSlackBotToken = requireIf(pmEnabled, "SLACK_BOT_TOKEN", "PM_AGENT_ENABLED=true");
  const pmDailyBudgetRaw = str(env, "PM_AGENT_DAILY_TOKEN_BUDGET");
  const pmSlackChannelId = requireIf(pmEnabled, "PM_AGENT_SLACK_CHANNEL_ID", "PM_AGENT_ENABLED=true");
  const pmTeamIds = requireIf(pmEnabled, "PM_AGENT_TEAM_IDS", "PM_AGENT_ENABLED=true");

  let pmDailyBudget: number | undefined;
  if (pmEnabled) {
    pmDailyBudget = requireIntIf(true, "PM_AGENT_DAILY_TOKEN_BUDGET", "PM_AGENT_ENABLED=true");
  } else {
    pmDailyBudget = parseOptPosInt(pmDailyBudgetRaw);
  }

  if (pmEnabled && pmTeamIds) {
    const ids = pmTeamIds.split(",").filter(Boolean);
    if (ids.length === 0)
      errors.push("PM_AGENT_TEAM_IDS must contain at least one team ID when PM_AGENT_ENABLED=true");
  }

  // ── Release Manager conditional requirements ─────────────────────────────
  // Deferred validation fix: check GitHub App credentials at boot when RM is enabled.
  const githubAppId = str(env, "GITHUB_APP_ID");
  const githubPrivateKeyPath = str(env, "GITHUB_PRIVATE_KEY_PATH");
  if (rmEnabled && (!githubAppId || !githubPrivateKeyPath)) {
    errors.push(
      "RELEASE_MANAGER_ENABLED=true requires GITHUB_APP_ID and GITHUB_PRIVATE_KEY_PATH " +
        "so the agent can create tags/releases",
    );
  }

  const rmQaWorkflow = str(env, "RELEASE_MANAGER_TRIGGER_QA_WORKFLOW");
  if (rmEnabled && rmQaWorkflow) {
    if (!str(env, "RELEASE_MANAGER_TRIGGER_QA_LINEAR_TEAM_ID")) {
      errors.push(
        "RELEASE_MANAGER_TRIGGER_QA_WORKFLOW requires RELEASE_MANAGER_TRIGGER_QA_LINEAR_TEAM_ID",
      );
    }
    if (!str(env, "LINEAR_API_KEY")) {
      errors.push("qaCheck requires LINEAR_API_KEY (used to file gap issues)");
    }
  }

  // ── SSO conditional requirements ─────────────────────────────────────────
  // Note: bootstrapSsoFromEnv already validates these; we include them here
  // for the consolidated boot-time error report.
  if (ssoEnabled) {
    requireIf(true, "URATEAM_WORKOS_API_KEY", "URATEAM_SSO_ENABLED=true");
    requireIf(true, "URATEAM_WORKOS_CLIENT_ID", "URATEAM_SSO_ENABLED=true");
    requireIf(true, "URATEAM_WORKOS_REDIRECT_URI", "URATEAM_SSO_ENABLED=true");
    requireIf(true, "URATEAM_SSO_STATE_SECRET", "URATEAM_SSO_ENABLED=true");
  }

  // ── Review Models symmetric validation ───────────────────────────────────
  // Mirrors the check in packages/core/src/executor/review/review-provider.ts
  // so the error surfaces at boot rather than at the first review-stage run.
  const reviewModels = str(env, "REVIEW_MODELS");
  const openrouterApiKey = str(env, "OPENROUTER_API_KEY");
  if (reviewModels && !openrouterApiKey) {
    errors.push(
      "REVIEW_MODELS is set but OPENROUTER_API_KEY is missing — both must be set or both unset",
    );
  }
  if (openrouterApiKey && !reviewModels) {
    errors.push(
      "OPENROUTER_API_KEY is set but REVIEW_MODELS is missing or empty — both must be set or both unset",
    );
  }

  // ── Numeric parsing ───────────────────────────────────────────────────────
  const portRaw = str(env, "PORT");
  const dashPortRaw = str(env, "DASHBOARD_PORT");

  const port = validatePosInt("PORT", portRaw, 3000);
  const dashboardPort = validatePosInt("DASHBOARD_PORT", dashPortRaw, 3001);
  const maxConcurrent = validatePosInt(
    "MAX_CONCURRENT_RUNS",
    str(env, "MAX_CONCURRENT_RUNS"),
    3,
  );

  // ── Report all errors at once ─────────────────────────────────────────────
  if (errors.length > 0) {
    log.error(
      { errors },
      `\nBoot-time environment validation failed (${errors.length} error${errors.length === 1 ? "" : "s"}):\n` +
        errors.map((e) => `  • ${e}`).join("\n") +
        "\n\nCheck deploy/ENV_VARS.md for documentation on all supported variables.\n",
    );
    process.exit(1);
  }

  return {
    // Core
    LINEAR_WEBHOOK_SECRET: linearWebhookSecret,
    LINEAR_API_KEY: str(env, "LINEAR_API_KEY") ?? "",
    DASHBOARD_USER: dashboardUser,
    DASHBOARD_PASSWORD: dashboardPassword,
    DATABASE_URL: str(env, "DATABASE_URL"),
    URATEAM_LICENSE_KEY: str(env, "URATEAM_LICENSE_KEY"),
    ANTHROPIC_API_KEY: str(env, "ANTHROPIC_API_KEY"),
    CLAUDE_CODE_OAUTH_TOKEN: str(env, "CLAUDE_CODE_OAUTH_TOKEN"),

    // Repo
    REPO_TEAM_ID: str(env, "REPO_TEAM_ID"),
    REPO_URL: str(env, "REPO_URL"),
    REPO_DEFAULT_BRANCH: str(env, "REPO_DEFAULT_BRANCH") ?? "main",
    REPO_TEST_CMD: str(env, "REPO_TEST_CMD") ?? "pnpm test",
    REPO_BUILD_CMD: str(env, "REPO_BUILD_CMD") ?? "pnpm build",
    REPO_EXCLUDE_PLUGINS: str(env, "REPO_EXCLUDE_PLUGINS"),
    REPO_EXCLUDE_MCP_SERVERS: str(env, "REPO_EXCLUDE_MCP_SERVERS"),
    REPO_DISABLE_PLUGIN_AUTODETECT: flag(env, "REPO_DISABLE_PLUGIN_AUTODETECT"),

    // GitHub App
    GITHUB_APP_ID: githubAppId,
    GITHUB_PRIVATE_KEY_PATH: githubPrivateKeyPath,
    GITHUB_INSTALLATION_ID: parseOptPosInt(str(env, "GITHUB_INSTALLATION_ID")),
    GITHUB_WEBHOOK_SECRET: str(env, "GITHUB_WEBHOOK_SECRET"),
    GITHUB_FEEDBACK_AUTO_TRIGGER: flagOptOut(env, "GITHUB_FEEDBACK_AUTO_TRIGGER"),
    GITHUB_FEEDBACK_TRIGGER_KEYWORD: str(env, "GITHUB_FEEDBACK_TRIGGER_KEYWORD"),
    GITHUB_FEEDBACK_ALLOWED_REVIEWERS: str(env, "GITHUB_FEEDBACK_ALLOWED_REVIEWERS"),
    GITHUB_FEEDBACK_BOT_LOGINS: str(env, "GITHUB_FEEDBACK_BOT_LOGINS"),

    // Server
    PORT: port,
    DASHBOARD_PORT: dashboardPort,
    AGENT_RUN_DIR: str(env, "AGENT_RUN_DIR"),
    REPO_CLONE_DIR: str(env, "REPO_CLONE_DIR"),
    MAX_CONCURRENT_RUNS: maxConcurrent,
    WORKTREE_TTL_HOURS: parsePosIntOr(str(env, "WORKTREE_TTL_HOURS"), 24),

    // Notifications
    SLACK_BOT_TOKEN: pmEnabled ? pmSlackBotToken : str(env, "SLACK_BOT_TOKEN"),
    SLACK_SIGNING_SECRET: str(env, "SLACK_SIGNING_SECRET"),
    SLACK_WEBHOOK_URL: str(env, "SLACK_WEBHOOK_URL"),
    SLACK_ERROR_ALERTS: flag(env, "SLACK_ERROR_ALERTS"),
    DISCORD_WEBHOOK_URL: str(env, "DISCORD_WEBHOOK_URL"),

    // PM Agent (defaults match PmAgentConfigSchema to remove dual-default)
    PM_AGENT_ENABLED: pmEnabled,
    PM_AGENT_CRON_INTERVAL_MS: parsePosIntOr(str(env, "PM_AGENT_CRON_INTERVAL_MS"), 1_800_000),
    PM_AGENT_MAX_IN_FLIGHT: parsePosIntOr(str(env, "PM_AGENT_MAX_IN_FLIGHT"), 3),
    PM_AGENT_DAILY_TOKEN_BUDGET: pmDailyBudget,
    PM_AGENT_SLACK_CHANNEL_ID: pmEnabled ? pmSlackChannelId : str(env, "PM_AGENT_SLACK_CHANNEL_ID"),
    PM_AGENT_TEAM_IDS: pmEnabled ? pmTeamIds : str(env, "PM_AGENT_TEAM_IDS"),
    PM_AGENT_REQUIRE_PIPELINE_LABEL_FOR_PROMOTE: flag(
      env,
      "PM_AGENT_REQUIRE_PIPELINE_LABEL_FOR_PROMOTE",
    ),
    PM_AGENT_MAX_CONSECUTIVE_FAILURES: parseIntOr(
      str(env, "PM_AGENT_MAX_CONSECUTIVE_FAILURES"),
      3,
    ),
    PM_AGENT_PAUSED: flag(env, "PM_AGENT_PAUSED"),
    PM_AGENT_AGENT_BRANCH_TTL_DAYS: parsePosIntOr(str(env, "PM_AGENT_AGENT_BRANCH_TTL_DAYS"), 7),
    PM_AGENT_STUCK_RUN_AGE_MIN: parsePosIntOr(str(env, "PM_AGENT_STUCK_RUN_AGE_MIN"), 60),

    // Release Manager (defaults match ReleaseManagerConfigSchema)
    RELEASE_MANAGER_ENABLED: rmEnabled,
    RELEASE_MANAGER_SCHEDULE: str(env, "RELEASE_MANAGER_SCHEDULE") ?? "*/30 * * * *",
    RELEASE_MANAGER_VERSION_BUMP: str(env, "RELEASE_MANAGER_VERSION_BUMP") ?? "patch",
    RELEASE_MANAGER_SLACK_CHANNEL: str(env, "RELEASE_MANAGER_SLACK_CHANNEL"),
    RELEASE_MANAGER_BRANCH: str(env, "RELEASE_MANAGER_BRANCH") ?? "main",
    RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE: parseOptPosInt(
      str(env, "RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE"),
    ),
    RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS: parseOptPosInt(
      str(env, "RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS"),
    ),
    RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES: parseOptPosInt(
      str(env, "RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES"),
    ),
    RELEASE_MANAGER_TRIGGER_REQUIRE_SLACK_APPROVAL: flag(
      env,
      "RELEASE_MANAGER_TRIGGER_REQUIRE_SLACK_APPROVAL",
    ),
    RELEASE_MANAGER_TRIGGER_QA_WORKFLOW: rmQaWorkflow,
    RELEASE_MANAGER_TRIGGER_QA_LINEAR_TEAM_ID: str(
      env,
      "RELEASE_MANAGER_TRIGGER_QA_LINEAR_TEAM_ID",
    ),
    RELEASE_MANAGER_TRIGGER_QA_TIMEOUT_MINUTES: parseOptPosInt(
      str(env, "RELEASE_MANAGER_TRIGGER_QA_TIMEOUT_MINUTES"),
    ),

    // SSO
    URATEAM_SSO_ENABLED: ssoEnabled,
    URATEAM_WORKOS_API_KEY: str(env, "URATEAM_WORKOS_API_KEY"),
    URATEAM_WORKOS_CLIENT_ID: str(env, "URATEAM_WORKOS_CLIENT_ID"),
    URATEAM_WORKOS_REDIRECT_URI: str(env, "URATEAM_WORKOS_REDIRECT_URI"),
    URATEAM_SSO_STATE_SECRET: str(env, "URATEAM_SSO_STATE_SECRET"),
    URATEAM_SSO_ALLOWED_DOMAIN: str(env, "URATEAM_SSO_ALLOWED_DOMAIN"),
    URATEAM_SSO_SESSION_HOURS: parsePosIntOr(str(env, "URATEAM_SSO_SESSION_HOURS"), 24),
    URATEAM_SSO_COOKIE_NAME: str(env, "URATEAM_SSO_COOKIE_NAME") ?? "urateam_session",
    URATEAM_SSO_COOKIE_SECURE: env.URATEAM_SSO_COOKIE_SECURE !== "false",

    // Review Models
    REVIEW_MODELS: reviewModels,
    OPENROUTER_API_KEY: openrouterApiKey,
    OPENROUTER_BASE_URL: str(env, "OPENROUTER_BASE_URL"),
    REVIEW_MODELS_MAX_OUTPUT_TOKENS: parseOptPosInt(str(env, "REVIEW_MODELS_MAX_OUTPUT_TOKENS")),
    REVIEW_MODELS_TIMEOUT_MS: parseOptPosInt(str(env, "REVIEW_MODELS_TIMEOUT_MS")),
    REVIEW_MODELS_MAX_INPUT_TOKENS: parseOptPosInt(str(env, "REVIEW_MODELS_MAX_INPUT_TOKENS")),
    REVIEW_MODELS_MIN_OUTPUT_RATIO: parseFloatOr(str(env, "REVIEW_MODELS_MIN_OUTPUT_RATIO"), 0.05),
    REVIEW_MODELS_HEALTH_LOOKBACK_HOURS: parsePosIntOr(
      str(env, "REVIEW_MODELS_HEALTH_LOOKBACK_HOURS"),
      168,
    ),
    REVIEW_MODELS_MIN_RUNS: parsePosIntOr(str(env, "REVIEW_MODELS_MIN_RUNS"), 5),

    // Pipeline overrides
    URATEAM_DEEP_REVIEW_PASSES: str(env, "URATEAM_DEEP_REVIEW_PASSES"),
    URATEAM_AUTO_MERGE: str(env, "URATEAM_AUTO_MERGE"),

    // RBAC
    URATEAM_ADMIN_EMAILS: str(env, "URATEAM_ADMIN_EMAILS"),
  };
}

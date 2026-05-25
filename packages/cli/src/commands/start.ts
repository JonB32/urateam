import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PM_AGENT_CRON_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
import { bootstrapSsoFromEnv } from "../sso-bootstrap.js";
import { preflightClaudeAuth } from "../lib/preflight-claude-auth.js";
import { preflightDirs } from "../lib/preflight-dirs.js";
import { buildRepoConfigsFromEnv, requireRepoConfigs } from "../lib/build-repo-configs.js";
import {
  resolveUserLevelHome,
  userLevelConfigPath,
  readUserLevelConfig,
} from "../lib/user-level-config.js";
import { loadEnvConfig } from "../lib/load-env-config.js";

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

/**
 * Call fn once at startup (awaited or fire-and-forget), then schedule it on a
 * repeating interval. The interval is unref'd so it doesn't prevent process exit.
 * Returns the handle so callers can clearInterval on shutdown.
 */
async function scheduleRepeatedly(
  fn: () => Promise<void>,
  intervalMs: number,
  immediate: "await" | "void" = "void",
): Promise<ReturnType<typeof setInterval>> {
  if (immediate === "await") {
    await fn();
  } else {
    void fn();
  }
  const handle = setInterval(() => void fn(), intervalMs);
  handle.unref();
  return handle;
}

export const startCommand = new Command("start")
  .description("Start production server (webhook + dashboard)")
  .option("--port <port>", "Webhook server port", "3000")
  .option("--dashboard-port <port>", "Dashboard port", "3001")
  .option(
    "--tunnel <mode>",
    "Auto-launch a Cloudflare tunnel: 'none' (default), 'cloudflare-quick' (free, ephemeral URL), or 'cloudflare-token' (requires CLOUDFLARE_TUNNEL_TOKEN + URATEAM_PUBLIC_URL)",
    "none",
  )
  .action(async (options) => {
    try {
    loadUserLevelEnv();
    // Boot-time env validation — runs first, reports all errors at once.
    const env = loadEnvConfig("start");


    const { createApp, defaultConfigs, applyDeepReviewPassesOverride, applyAutoMergeOverride, cleanupWorktrees, runAgentBranchSweep, addLogStream, initSlackAlertManager, createSlackAlertStream, validateReviewModels } = await import("@urateam/core");

    // --- Slack error alerts (opt-in) ---
    if (
      env.SLACK_ERROR_ALERTS &&
      env.SLACK_BOT_TOKEN &&
      env.PM_AGENT_SLACK_CHANNEL_ID
    ) {
      const manager = initSlackAlertManager(
        env.SLACK_BOT_TOKEN,
        env.PM_AGENT_SLACK_CHANNEL_ID,
      );
      addLogStream(createSlackAlertStream(manager));
      console.log(`Slack error alerts: enabled (channel ${env.PM_AGENT_SLACK_CHANNEL_ID})`);
    }
    const { createDashboard } = await import("@urateam/dashboard");
    const { serve } = await import("@hono/node-server");

    // Dashboard auth is validated by loadEnvConfig("start") — safe to assert non-null.
    const dashboardAuth = {
      username: env.DASHBOARD_USER!,
      password: env.DASHBOARD_PASSWORD!,
    };

    // Build repoConfigs from env: REPO_TEAM_ID, REPO_URL, REPO_DEFAULT_BRANCH, etc.
    // Pass process.env explicitly — loadEnvConfig() has already validated all vars.
    const repoConfigs = buildRepoConfigsFromEnv(process.env);

    // Fail fast if no repoConfigs could be built. Same guard as `ura dev` —
    // without it the webhook server starts looking healthy and silently
    // fails every inbound Linear event with "no repo mapping". See urateam#33.
    requireRepoConfigs(repoConfigs, "ura start");

    // GitHub App config (optional)
    const { buildGitHubConfigFromEnv } = await import("@urateam/core");
    const github = buildGitHubConfigFromEnv(process.env);

    // PM Agent Slack interface (optional — requires signing secret)
    const slackSigningSecret = env.SLACK_SIGNING_SECRET;
    let pmSlack: import("@urateam/core").PmSlackInterfaceConfig | undefined =
      (slackSigningSecret && env.SLACK_BOT_TOKEN && env.PM_AGENT_SLACK_CHANNEL_ID)
        ? {
            signingSecret: slackSigningSecret,
            botToken: env.SLACK_BOT_TOKEN,
            channelId: env.PM_AGENT_SLACK_CHANNEL_ID,
            teamIds: (env.PM_AGENT_TEAM_IDS ?? "").split(",").filter(Boolean),
          }
        : undefined;

    // --- PM Agent config (built up-front so createApp can thread it into the webhook) ---
    // The webhook-side budget gate in webhook/handler.ts needs config.pmConfig to
    // activate the 100% hard-stop. If we only built this inside the PM_AGENT_ENABLED
    // branch below, the gate would be inert in production.
    let pmConfig: import("@urateam/core").PmAgentConfig | undefined;
    if (env.PM_AGENT_ENABLED) {
      const { PmAgentConfigSchema } = await import("@urateam/core");
      // All conditional requirements already validated by loadEnvConfig — safe to assert.
      pmConfig = PmAgentConfigSchema.parse({
        enabled: true,
        // Use EnvConfig values (defaults already applied); no ?? fallbacks needed.
        cronIntervalMs: env.PM_AGENT_CRON_INTERVAL_MS,
        maxInFlight: env.PM_AGENT_MAX_IN_FLIGHT,
        dailyTokenBudget: env.PM_AGENT_DAILY_TOKEN_BUDGET,
        slackChannelId: env.PM_AGENT_SLACK_CHANNEL_ID,
        teamIds: (env.PM_AGENT_TEAM_IDS ?? "").split(",").filter(Boolean),
        requirePipelineLabelForPromote: env.PM_AGENT_REQUIRE_PIPELINE_LABEL_FOR_PROMOTE,
        maxConsecutiveFailures: env.PM_AGENT_MAX_CONSECUTIVE_FAILURES,
      });
    }

    // --- Release Manager config (BEC-135 — Pro tier) ---
    // GitHub App credential check moved to loadEnvConfig — no longer deferred.
    let rmConfig: import("@urateam/core").ReleaseManagerConfig | undefined;
    let rmRepoUrl: string | undefined;
    if (env.RELEASE_MANAGER_ENABLED) {
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
      if (env.RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE !== undefined) {
        triggers.mergedPRsSince = env.RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE;
      }
      if (env.RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS !== undefined) {
        triggers.timeSinceLastHours = env.RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS;
      }
      if (env.RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES !== undefined) {
        triggers.ciGreenForMinutes = env.RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES;
      }
      if (env.RELEASE_MANAGER_TRIGGER_REQUIRE_SLACK_APPROVAL) {
        triggers.requireSlackApproval = true;
      }

      if (env.RELEASE_MANAGER_TRIGGER_QA_WORKFLOW) {
        // Conditional requirements already validated by loadEnvConfig.
        triggers.qaCheck = {
          workflow: env.RELEASE_MANAGER_TRIGGER_QA_WORKFLOW,
          linearTeamId: env.RELEASE_MANAGER_TRIGGER_QA_LINEAR_TEAM_ID!,
          ...(env.RELEASE_MANAGER_TRIGGER_QA_TIMEOUT_MINUTES
            ? { timeoutMinutes: env.RELEASE_MANAGER_TRIGGER_QA_TIMEOUT_MINUTES }
            : {}),
        };
      }

      try {
        rmConfig = ReleaseManagerConfigSchema.parse({
          enabled: true,
          schedule: env.RELEASE_MANAGER_SCHEDULE,
          triggers,
          versionBump: env.RELEASE_MANAGER_VERSION_BUMP,
          slackChannel: env.RELEASE_MANAGER_SLACK_CHANNEL,
          branch: env.RELEASE_MANAGER_BRANCH,
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
        env.URATEAM_DEEP_REVIEW_PASSES,
      ),
      env.URATEAM_AUTO_MERGE,
    );

    // --- Resolve and validate workspace directories ---
    const agentRunDir = env.AGENT_RUN_DIR ?? join(homedir(), "data", "runs");
    const repoCloneDir = env.REPO_CLONE_DIR ?? join(homedir(), "work", "repos");

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
      webhookSecret: env.LINEAR_WEBHOOK_SECRET!,
      linearApiKey: env.LINEAR_API_KEY,
      pipelineConfigs,
      repoConfigs,
      databaseUrl: env.DATABASE_URL,
      slackWebhookUrl: env.SLACK_WEBHOOK_URL,
      discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
      concurrency: env.MAX_CONCURRENT_RUNS,
      agentRunDir,
      repoCloneDir,
      github,
      dashboardAuth,
      pmSlack,
      pmConfig,
      githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
    };

    // --- SSO (Enterprise, opt-in via URATEAM_SSO_ENABLED=true) ---
    // Validate SSO env vars BEFORE opening the DB / starting the runner so a
    // misconfigured deployment fails fast without leaking resources.
    const ssoBootstrap = await bootstrapSsoFromEnv(process.env);

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
    const port = env.PORT;
    const dashboardPort = env.DASHBOARD_PORT;

    // --- PM Agent scheduler (create before dashboard so triggerPmTick can be wired in) ---
    // The scheduler object is created here; the initial tick + interval are started after
    // the servers come up. The dashboard callback captures the scheduler by reference.
    let pmScheduler: { tick(): Promise<void> } | undefined;
    if (env.PM_AGENT_ENABLED && pmConfig) {
      const { createPmScheduler } = await import("@urateam/core");
      pmScheduler = createPmScheduler({
        config: pmConfig,
        db,
        linearApiKey: config.linearApiKey,
        slackBotToken: env.SLACK_BOT_TOKEN!,
        repoCloneDir: config.repoCloneDir,
        runner,
        pipelineConfigs: config.pipelineConfigs,
        repoConfigs: config.repoConfigs,
      });
    }

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
      triggerPmTick: pmScheduler ? () => pmScheduler!.tick() : undefined,
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

    // --- Optional tunnel (cloudflared) ---
    // Brings a public URL up via cloudflared when `--tunnel <mode>` is set.
    // "none" (default) is a no-op. The TunnelManager supervises the child
    // with exponential-backoff restart; failures are logged but don't crash
    // the daemon — the daemon stays up on the local ports so operators can
    // still SSH in and debug.
    let tunnelManager: import("../lib/tunnel.js").TunnelManager | undefined;
    if (options.tunnel && options.tunnel !== "none") {
      const mode = options.tunnel as "cloudflare-quick" | "cloudflare-token";
      if (mode !== "cloudflare-quick" && mode !== "cloudflare-token") {
        console.error(
          `--tunnel: unknown mode '${options.tunnel}'. Allowed: none, cloudflare-quick, cloudflare-token`,
        );
        process.exit(1);
      }
      const { TunnelManager, CloudflaredMissingError } = await import(
        "../lib/tunnel.js"
      );
      const token = process.env.CLOUDFLARE_TUNNEL_TOKEN;
      const publicUrl = process.env.URATEAM_PUBLIC_URL;
      tunnelManager = new TunnelManager({
        mode,
        localPort: port,
        token,
        publicUrl,
      });
      try {
        const result = await tunnelManager.start();
        process.env.URATEAM_PUBLIC_URL = result.publicUrl;
        console.log(`Tunnel:    ${result.publicUrl} (${mode})`);
        // Attach a runtime error handler BEFORE any subsequent restart can
        // exhaust the cap. EventEmitter throws if "error" emits without a
        // listener; without this, a flapping cloudflared would crash the
        // daemon when the restart cap is hit.
        tunnelManager.on("error", (err: Error) => {
          console.error(
            `Tunnel: supervisor gave up (${err.message}); daemon continues on local ports`,
          );
        });
        try {
          const { logAuditEvent, tunnelStartedEvent } = await import(
            "@urateam/core"
          );
          void logAuditEvent(
            db,
            tunnelStartedEvent({
              provider: mode,
              publicUrl: result.publicUrl,
              restartCount: result.restartCount,
            }),
          );
        } catch {
          // audit must never crash startup
        }
      } catch (err) {
        if (err instanceof CloudflaredMissingError) {
          console.error(err.message);
        } else {
          console.error(
            `Tunnel: failed to start (${(err as Error).message}); daemon will run on local ports only`,
          );
        }
        tunnelManager = undefined;
      }
    }

    // --- Optional user-level config hot-reload ---
    // Watches ~/.urateam/config.json (or $URATEAM_HOME/config.json) and
    // applies safe changes without a daemon restart. Activates only when
    // we're in user-level mode (no REPO_* env vars AND config.json exists);
    // project-level (sidecar) installs are env-var driven and don't need
    // hot-reload. Unsafe field changes (url, path, defaultBranch) log a
    // "restart required" warning. Removals with in-flight pipeline runs
    // are deferred to the next reload to avoid mid-flight interruption.
    let configWatcher: import("../lib/config-watcher.js").ConfigWatcher | undefined;
    const userLevelMode =
      !process.env.REPO_TEAM_ID &&
      !process.env.REPO_URL &&
      readUserLevelConfig() !== null;
    if (userLevelMode) {
      const { ConfigWatcher, hashConfig } = await import(
        "../lib/config-watcher.js"
      );
      const initial = readUserLevelConfig()!;
      configWatcher = new ConfigWatcher(initial, {
        path: userLevelConfigPath(),
      });

      const deriveKeyFromUrl = (url: string): string => {
        const stripped = url.replace(/\.git$/, "");
        const last =
          stripped.split(/[/:]/).filter(Boolean).pop() ?? "repo";
        return last.replace(/[^A-Za-z0-9._-]/g, "-");
      };

      configWatcher.on("applied", async (diff: import("../lib/config-watcher.js").ConfigDiff) => {
        for (const r of diff.added) {
          const key = r.teamId ?? deriveKeyFromUrl(r.url);
          config.repoConfigs[key] = {
            url: r.url,
            defaultBranch: r.defaultBranch,
            testCommand: r.testCommand,
            buildCommand: r.buildCommand,
            ...(r.labelPattern && { labelPattern: r.labelPattern }),
          };
          console.log(`config: + ${r.url} (live)`);
        }
        for (const m of diff.modifiedSafe) {
          // Look up the OLD entry using the previous teamId / URL slug —
          // not the new ones — so we find the entry even when teamId
          // itself changed.
          const oldKey = m.prev.teamId ?? deriveKeyFromUrl(m.prev.url);
          const existing = config.repoConfigs[oldKey];
          if (existing) {
            if (m.fields.includes("testCommand")) {
              existing.testCommand = m.repo.testCommand;
            }
            if (m.fields.includes("buildCommand")) {
              existing.buildCommand = m.repo.buildCommand;
            }
            if (m.fields.includes("labelPattern")) {
              existing.labelPattern = m.repo.labelPattern;
            }
            if (m.fields.includes("teamId")) {
              // The map-key changes when teamId changes — re-key the entry
              // under the new key so webhook routing keeps working.
              const newKey =
                m.repo.teamId ?? deriveKeyFromUrl(m.repo.url);
              if (newKey !== oldKey) {
                delete config.repoConfigs[oldKey];
                config.repoConfigs[newKey] = existing;
              }
            }
            console.log(
              `config: ~ ${m.repo.url} (${m.fields.join(",")}) — applied live`,
            );
          }
        }
        for (const m of diff.modifiedUnsafe) {
          console.warn(
            `config: ! ${m.repo.url} unsafe field change (${m.fields.join(",")}) — restart required to apply`,
          );
        }
        // Removal: delete the entry from the live repoConfigs immediately.
        // In-flight pipeline runs hold their own snapshot of the runner state
        // and continue uninterrupted — removing the entry only stops the
        // webhook/PM router from sending NEW work to the repo. Operators
        // who need to forcibly stop in-flight runs should use `ura stop`
        // or `ura halt`.
        for (const r of diff.removed) {
          const key = r.teamId ?? deriveKeyFromUrl(r.url);
          delete config.repoConfigs[key];
          console.log(`config: - ${r.url} (live; in-flight runs continue)`);
        }
        try {
          const { logAuditEvent, configReloadedEvent } = await import(
            "@urateam/core"
          );
          void logAuditEvent(
            db,
            configReloadedEvent({
              added: diff.added.map((r) => r.url),
              removed: diff.removed.map((r) => r.url),
              modifiedSafe: diff.modifiedSafe.map((m) => m.repo.url),
              modifiedUnsafe: diff.modifiedUnsafe.map((m) => m.repo.url),
              sha256: hashConfig(configWatcher!.getCurrent()),
            }),
          );
        } catch {
          // audit must never crash the watcher loop
        }
      });

      configWatcher.on("error", (err) => {
        console.warn(
          `config-watcher: ${err.message}; keeping previous in-memory config`,
        );
      });

      configWatcher.start();
      console.log(`Config:    watching ${userLevelConfigPath()} (live reload)`);
    }

    // --- Worktree cleanup cron ---
    const worktreeTtlHours = env.WORKTREE_TTL_HOURS;

    const cleanupInterval = await scheduleRepeatedly(async () => {
      const removed = await cleanupWorktrees(agentRunDir, worktreeTtlHours);
      if (removed.length > 0) {
        console.log(`Cleanup: removed ${removed.length} stale worktree(s)`);
      }
    }, 60 * 60 * 1000, "await");

    // --- Stale agent-branch sweep cron (BEC-174) ---
    // Sweeps `agent/*` branches on origin whose tip commit is older than
    // PM_AGENT_AGENT_BRANCH_TTL_DAYS (default 7) AND that have no open PR.
    // Skips branches with open PRs to preserve active human review.
    const agentBranchTtlDays = env.PM_AGENT_AGENT_BRANCH_TTL_DAYS;

    // Compute repoUrls per-tick so hot-reloaded additions/removals are
    // picked up by the branch sweep without requiring a daemon restart.
    const branchSweepInterval = await scheduleRepeatedly(async () => {
      const repoUrls = Object.values(config.repoConfigs).map(
        (r) => (r as { url: string }).url,
      );
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
    }, 60 * 60 * 1000, "void");

    // --- PM Agent tick schedule (scheduler already created above, before createDashboard) ---
    let pmInterval: ReturnType<typeof setInterval> | undefined;
    let rmScheduler: import("@urateam/core").ReleaseManagerScheduler | undefined;
    if (env.PM_AGENT_ENABLED && pmScheduler && pmConfig) {
      const capturedScheduler = pmScheduler;
      capturedScheduler.tick().catch((err: unknown) => console.error("PM Agent initial tick failed:", err));
      pmInterval = setInterval(
        () => capturedScheduler.tick().catch((err: unknown) => console.error("PM Agent tick failed:", err)),
        pmConfig.cronIntervalMs,
      );
      pmInterval.unref();

      console.log(`PM Agent: enabled (every ${pmConfig.cronIntervalMs / 60000}min, max ${pmConfig.maxInFlight} in-flight)`);
      if (env.PM_AGENT_PAUSED) {
        console.log(`PM Agent: PM_AGENT_PAUSED=true — promote/start-todo/recover-stuck will be skipped on every tick until the env var is cleared and the container restarted`);
      }
    }

    // --- Release Manager (BEC-135 — Pro tier, opt-in) ---
    if (rmConfig && rmRepoUrl) {
      // GitHub App credentials already verified at boot by loadEnvConfig.
      const { createGitHubClient, createReleaseManagerScheduler, isFeatureLicensed,
        handleReleaseSubcommand, parseReleaseSubcommand } = await import("@urateam/core");
      const [rmOctokit, linearSdk] = await Promise.all([
        createGitHubClient(github!),
        rmConfig.triggers.qaCheck ? import("@linear/sdk") : Promise.resolve(null),
      ]);

      let linearClient: import("@linear/sdk").LinearClient | undefined;
      if (rmConfig.triggers.qaCheck && linearSdk) {
        linearClient = new linearSdk.LinearClient({ apiKey: env.LINEAR_API_KEY });
      }

      rmScheduler = createReleaseManagerScheduler({
        config: rmConfig,
        db,
        octokit: rmOctokit,
        repoUrl: rmRepoUrl,
        isLicensed: () => isFeatureLicensed("release-manager"),
        linear: linearClient,
        slack: env.SLACK_BOT_TOKEN
          ? {
              postMessage: async (channel, text) => {
                const { postSlackMessage } = await import("@urateam/core");
                // postSlackMessage returns Promise<any> — no cast needed
                const r = await postSlackMessage(env.SLACK_BOT_TOKEN!, { channel, text });
                return r !== null && r.ok !== false;
              },
              // BEC-142: Block Kit messages for awaiting-approval prompts (Approve/Skip buttons).
              postBlockKit: async (channel, blocks, fallbackText) => {
                const { postSlackMessage } = await import("@urateam/core");
                const r = await postSlackMessage(process.env.SLACK_BOT_TOKEN!, {
                  channel,
                  blocks,
                  text: fallbackText,
                });
                return r !== null && (r as any).ok !== false;
              },
            }
          : undefined,
      });

      // Plumb a release-handler closure through pmSlack so /release routes here.
      // releaseHandler is now a typed optional field on PmSlackInterfaceConfig.
      if (pmSlack) {
        pmSlack.releaseHandler = async ({ text, userId }) => {
          const cmd = parseReleaseSubcommand(text);
          const pauseDurationHours = rmConfig!.triggers.timeSinceLastHours ?? 24;
          return handleReleaseSubcommand({
            cmd,
            db,
            repoUrl: rmRepoUrl!,
            branch: rmConfig!.branch,
            slackUserId: userId,
            pauseDurationHours,
            octokit: rmOctokit,
            config: rmConfig!,
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
    async function shutdown() {
      console.log("Shutting down...");
      clearInterval(cleanupInterval);
      clearInterval(branchSweepInterval);
      if (pmInterval) clearInterval(pmInterval);
      rmScheduler?.stop();
      configWatcher?.stop();
      // Stop tunnel before closing HTTP servers so cloudflared sees clean
      // disconnects instead of a half-open socket dance. Emit `tunnel.stopped`
      // for observability of intentional shutdowns.
      if (tunnelManager) {
        // Capture restartCount BEFORE stop() — the count reflects how many
        // times cloudflared crashed during the daemon's life, which is the
        // metric operators want to see for "did this tunnel flap?".
        const restartCount = tunnelManager.getRestartCount();
        try {
          await tunnelManager.stop();
          try {
            const { logAuditEvent, tunnelStoppedEvent } = await import(
              "@urateam/core"
            );
            void logAuditEvent(
              db,
              tunnelStoppedEvent({
                provider: options.tunnel as
                  | "cloudflare-quick"
                  | "cloudflare-token",
                restartCount,
                exitCode: null,
                signal: "SIGTERM",
              }),
            );
          } catch {
            // audit must never crash shutdown
          }
        } catch (err) {
          console.error(`Tunnel shutdown error: ${(err as Error).message}`);
        }
      }
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

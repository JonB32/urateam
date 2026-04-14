import { Command } from "commander";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  PipelineConfig,
  RepoConfig,
  Notifier,
  PipelineRun,
  StageResult,
  PipelineResult,
  PipelineError,
} from "@urateam/core";
import type { LinearIssue } from "@urateam/core";

// ---------------------------------------------------------------------------
// Exported helpers (for unit testing)
// ---------------------------------------------------------------------------

/**
 * Loads a pipeline config module and returns the record of pipeline configs.
 * Supports both `export const pipelines = ...` and `export default ...`.
 */
export async function loadPipelineConfigModule(
  filePath: string,
): Promise<Record<string, unknown>> {
  const url = pathToFileURL(filePath).href;
  const mod = await import(url);
  return mod.pipelines ?? mod.default ?? mod;
}

/**
 * Loads a repos config module and returns the record of repo configs.
 * Supports both `export const repos = ...` and `export default ...`.
 */
export async function loadRepoConfigModule(
  filePath: string,
): Promise<Record<string, unknown>> {
  const url = pathToFileURL(filePath).href;
  const mod = await import(url);
  return mod.repos ?? mod.default ?? mod;
}

/**
 * Returns a copy of `config` with `stages` filtered to only include `stage`.
 * Throws if `stage` is not present in the pipeline's stages.
 */
export function filterPipelineToStage(
  config: PipelineConfig,
  stage: string,
): PipelineConfig {
  if (!(config.stages as string[]).includes(stage)) {
    throw new Error(
      `Stage "${stage}" is not in pipeline "${config.name}" (stages: ${config.stages.join(", ")})`,
    );
  }
  return { ...config, stages: [stage as PipelineConfig["stages"][number]] };
}

/**
 * Resolves which repo config to use.
 * Prefers a match by teamId, falls back to the first entry.
 */
export function resolveRepoConfig(
  repoConfigs: Record<string, RepoConfig>,
  teamId: string,
): RepoConfig | null {
  if (repoConfigs[teamId]) return repoConfigs[teamId];
  const keys = Object.keys(repoConfigs);
  if (keys.length === 0) return null;
  return repoConfigs[keys[0]];
}

/**
 * Creates a simple console-based notifier for local runs.
 */
export function createConsoleNotifier(): Notifier {
  return {
    onPipelineStart(run: PipelineRun): Promise<void> {
      console.log(
        `[lag run] Pipeline started — run ${run.id.slice(0, 8)} | branch: ${run.branch}`,
      );
      return Promise.resolve();
    },
    onStageComplete(
      run: PipelineRun,
      stage: string,
      result: StageResult,
    ): Promise<void> {
      const icon = result.status === "completed" ? "✅" : "❌";
      console.log(
        `[lag run] Stage ${stage} ${icon} | tokens: ${result.inputTokens}in / ${result.outputTokens}out`,
      );
      return Promise.resolve();
    },
    onPipelineComplete(run: PipelineRun, result: PipelineResult): Promise<void> {
      console.log(`[lag run] Pipeline complete ✅`);
      if (result.prUrl) console.log(`  PR: ${result.prUrl}`);
      console.log(
        `  Tokens: ${result.totalInputTokens.toLocaleString()}in / ${result.totalOutputTokens.toLocaleString()}out`,
      );
      return Promise.resolve();
    },
    onPipelineFailed(run: PipelineRun, error: PipelineError): Promise<void> {
      console.error(`[lag run] Pipeline failed ❌`);
      console.error(`  Stage: ${error.stage}`);
      console.error(`  Error: ${error.message}`);
      return Promise.resolve();
    },
    onHumanReviewNeeded(
      run: PipelineRun,
      prUrl: string,
      reason: string,
    ): Promise<void> {
      console.log(`[lag run] Human review needed 👀`);
      console.log(`  PR: ${prUrl}`);
      console.log(`  Reason: ${reason}`);
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const runCommand = new Command("run")
  .description("Run a pipeline against a Linear issue")
  .requiredOption("--issue <id>", "Linear issue identifier (e.g., LIN-123)")
  .option("--stage <stage>", "Run only this stage")
  .option("--only", "Run only the specified stage (requires --stage)")
  .option("--dry-run", "Show plan without executing")
  .option(
    "--config <path>",
    "Pipeline config file path",
    "./pipeline.config.ts",
  )
  .option("--repos <path>", "Repo config file path", "./repos.config.ts")
  .action(async (options) => {
    // --- Validate --only requires --stage -----------------------------------
    if (options.only && !options.stage) {
      console.error("Error: --only requires --stage to be specified.");
      console.error("Usage: lag run --issue LIN-123 --stage implement --only");
      process.exit(1);
    }

    // --- Quick dry-run: show parsed options without needing API key ----------
    if (options.dryRun && !process.env.LINEAR_API_KEY) {
      console.log("=== lag run — Dry Run (no API key) ===");
      console.log(`issue: ${options.issue}`);
      console.log(`config: ${options.config}`);
      console.log(`repos: ${options.repos}`);
      if (options.stage) {
        console.log(`stage: ${options.stage}`);
        console.log(`only: ${!!options.only}`);
      }
      console.log("Set LINEAR_API_KEY for full dry-run with issue resolution.");
      return;
    }

    // --- Auth check ---------------------------------------------------------
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      console.error("Error: LINEAR_API_KEY is not set.");
      console.error(
        "Obtain your API key from https://linear.app/settings/api and run:",
      );
      console.error("  export LINEAR_API_KEY=lin_api_...");
      process.exit(1);
    }

    // --- Load configs -------------------------------------------------------
    const configPath = resolve(options.config as string);
    const reposPath = resolve(options.repos as string);

    const { validatePipelineConfigs, validateRepoConfigs, resolvePipeline } =
      await import("@urateam/core");

    let pipelineConfigs: Record<string, PipelineConfig>;
    try {
      const raw = await loadPipelineConfigModule(configPath);
      pipelineConfigs = validatePipelineConfigs(raw);
    } catch (err: any) {
      console.error(`Error loading pipeline config from ${configPath}:`);
      console.error(`  ${err?.message ?? String(err)}`);
      process.exit(1);
    }

    let repoConfigs: Record<string, RepoConfig>;
    try {
      const raw = await loadRepoConfigModule(reposPath);
      repoConfigs = validateRepoConfigs(raw);
    } catch (err: any) {
      console.error(`Error loading repo config from ${reposPath}:`);
      console.error(`  ${err?.message ?? String(err)}`);
      process.exit(1);
    }

    // --- Fetch issue from Linear --------------------------------------------
    let issue: LinearIssue;
    try {
      const { LinearClient } = await import("@linear/sdk");
      const client = new LinearClient({ apiKey });
      const sdkIssue = await client.issue(options.issue as string);

      // Resolve lazy relations
      const team = await sdkIssue.team;
      const project = await sdkIssue.project;

      // Labels are a connection in the Linear SDK
      let labelNames: string[] = [];
      try {
        const labelsConn = await (sdkIssue as any).labels();
        labelNames = ((labelsConn?.nodes ?? []) as any[]).map(
          (l: any) => l.name ?? "",
        );
      } catch {
        // labels() not available or empty — proceed without labels
      }

      issue = {
        id: sdkIssue.id,
        identifier: sdkIssue.identifier,
        title: sdkIssue.title,
        description: sdkIssue.description ?? "",
        labels: labelNames.map((name) => ({ name })),
        priority: sdkIssue.priority,
        teamId: team?.id ?? "",
        projectId: project?.id,
      };
    } catch (err: any) {
      const msg: string = err?.message ?? String(err);
      if (
        msg.toLowerCase().includes("unauthorized") ||
        msg.toLowerCase().includes("invalid api key") ||
        msg.toLowerCase().includes("authentication")
      ) {
        console.error("Error: Linear authentication failed.");
        console.error("Verify LINEAR_API_KEY is valid and has read access.");
      } else {
        console.error(
          `Error: Failed to fetch issue "${options.issue}" from Linear:`,
        );
        console.error(`  ${msg}`);
      }
      process.exit(1);
    }

    // --- Resolve pipeline ---------------------------------------------------
    const labelNames = issue.labels.map((l) => l.name);
    const resolved = resolvePipeline(labelNames, pipelineConfigs);
    if (!resolved) {
      console.error(
        `No pipeline config matches labels: ${labelNames.join(", ") || "(none)"}`,
      );
      console.error(
        `Available pipelines: ${Object.keys(pipelineConfigs).join(", ")}`,
      );
      process.exit(1);
    }

    let pipelineConfig = resolved.config;

    // --- Stage filtering ----------------------------------------------------
    if (options.stage) {
      try {
        pipelineConfig = filterPipelineToStage(
          pipelineConfig,
          options.stage as string,
        );
      } catch (err: any) {
        console.error(`Error: ${err?.message ?? String(err)}`);
        process.exit(1);
      }
    }

    // --- Resolve repo config ------------------------------------------------
    const repoConfig = resolveRepoConfig(repoConfigs, issue.teamId);
    if (!repoConfig) {
      console.error("Error: No repo configs found in repos.config.ts.");
      process.exit(1);
    }

    // --- Sanitize issue -----------------------------------------------------
    const { mapIssueToSchema } = await import("@urateam/core");
    const sanitizedIssue = mapIssueToSchema(issue);

    // --- Dry run ------------------------------------------------------------
    if (options.dryRun) {
      console.log("=== lag run — Dry Run ===");
      console.log(`Issue:     ${issue.identifier}: ${issue.title}`);
      console.log(
        `Pipeline:  ${resolved.key} (${pipelineConfig.name})`,
      );
      console.log(`Stages:    ${pipelineConfig.stages.join(" → ")}`);
      console.log(`Repo:      ${repoConfig.url}`);
      console.log(`Branch:    ${sanitizedIssue.id}/${sanitizedIssue.slug}`);
      console.log(`Labels:    ${labelNames.join(", ") || "(none)"}`);
      console.log(`Priority:  ${issue.priority}`);
      console.log(`Config:    ${configPath}`);
      console.log(`Repos:     ${reposPath}`);
      return;
    }

    // --- Live run -----------------------------------------------------------
    const { createDb, PipelineRunner, CompositeNotifier } = await import(
      "@urateam/core"
    );

    const db = await createDb({
      connectionString:
        process.env.DATABASE_URL ?? ":memory:",
    });

    // --- Startup audit events (license + config fingerprint) ---------------
    try {
      const {
        checkLicense,
        computeConfigFingerprint,
        logAuditEvent,
        configLoadedEvent,
      } = await import("@urateam/core");
      const status = checkLicense(db);
      const sha = await computeConfigFingerprint(configPath);
      if (sha) {
        void logAuditEvent(
          db,
          configLoadedEvent({ path: configPath, sha256: sha, tier: status.tier }),
        );
      }
    } catch (err) {
      // audit must never crash startup
      console.warn(`[lag run] startup audit emit failed: ${(err as Error).message}`);
    }

    const consoleNotifier = createConsoleNotifier();

    // Completion promise — resolves when pipeline finishes or rejects on failure
    let resolveCompletion: () => void;
    let rejectCompletion: (err: Error) => void;
    const completionPromise = new Promise<void>((res, rej) => {
      resolveCompletion = res;
      rejectCompletion = rej;
    });

    const completionNotifier: Notifier = {
      onPipelineStart(): Promise<void> { return Promise.resolve(); },
      onStageComplete(): Promise<void> { return Promise.resolve(); },
      onPipelineComplete(): Promise<void> {
        resolveCompletion();
        return Promise.resolve();
      },
      onPipelineFailed(_run: PipelineRun, error: PipelineError): Promise<void> {
        rejectCompletion(
          new Error(`Pipeline failed at stage "${error.stage}": ${error.message}`),
        );
        return Promise.resolve();
      },
    };

    const notifier = new CompositeNotifier([consoleNotifier, completionNotifier]);

    const runner = new PipelineRunner({
      db,
      notifier,
      concurrency: 1,
      agentRunDir: process.env.AGENT_RUN_DIR ?? "/tmp/agent-runs",
      repoCloneDir: process.env.REPO_CLONE_DIR ?? "/tmp/agent-repos",
    });

    // Graceful shutdown
    const shutdown = () => {
      console.log("\n[lag run] Aborting pipeline...");
      runner.abort(issue.identifier);
      setTimeout(() => process.exit(0), 5_000).unref();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    console.log(
      `[lag run] Starting pipeline "${resolved.key}" for ${issue.identifier}: ${issue.title}`,
    );

    await runner.start(
      issue,
      resolved.key,
      pipelineConfig,
      repoConfig,
      sanitizedIssue,
    );

    // Wait for the queued pipeline to finish
    try {
      await completionPromise;
      process.exit(0);
    } catch (err: any) {
      console.error(`\n[lag run] ${err?.message ?? String(err)}`);
      process.exit(1);
    }
  });

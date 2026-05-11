import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  StageType,
  SanitizedIssue,
  RepoConfig,
  HandoffArtifact,
  StageResult,
  ReviewFeedbackContext,
  MergeConflictContext,
  AgentProfile,
} from "../types.js";
import type { Db, AnyDb } from "../db/client.js";
import { stageRuns, agentLogs } from "../db/schema.js";
import { getAgentProfiles } from "./profiles.js";
import { assemblePrompt } from "./prompt/assembler.js";
import { extractHandoff } from "./extract-handoff.js";
import { resolveTooling } from "./mcp-resolver.js";
import type { TechStackProfile } from "../repo/tech-stack.js";
import type { DevcontainerSession } from "../repo/devcontainer.js";
import { createLogger } from "../logger.js";
import { type StreamMessage } from "./agent-stream.js";
import { createAgentProvider } from "./provider/factory.js";

/**
 * BEC-183: wall-clock stage timeouts. Independent of the in-stream watchdog
 * (StageStalledError / StagePreStreamStalledError inside consumeAgentStream),
 * this is a second defensive layer that covers the case where the SDK's
 * query() or iterator setup hangs before any message arrives and the
 * firstMessageTimeoutMs timer inside consumeAgentStream somehow fails to fire.
 * Default: 60 min for implement (longest legitimate stage), 30 min for others.
 */
const WALL_CLOCK_STAGE_TIMEOUT_MS: Partial<Record<string, number>> = {
  implement: 60 * 60_000, // 60 min — longest legitimate stage
};
const DEFAULT_WALL_CLOCK_STAGE_TIMEOUT_MS = 30 * 60_000; // 30 min for all others

/** First-message timeout passed to consumeAgentStream (BEC-183). */
const FIRST_MESSAGE_TIMEOUT_MS = 5 * 60_000; // 5 min

/**
 * BEC-182: review-feedback runs are bounded — N comments, push, done.
 * Override the implement profile's maxTurns / maxInputTokens to prevent
 * spelunking. Keep tools and model from the base profile.
 *
 * Exported as a pure function so it can be tested without mocking the Agent SDK.
 */
export function applyReviewFeedbackProfileOverride(
  profile: AgentProfile,
  stage: StageType,
  hasReviewFeedback: boolean,
): AgentProfile {
  if (hasReviewFeedback && stage === "implement") {
    return { ...profile, maxTurns: 30, maxInputTokens: 60_000 };
  }
  return profile;
}

export interface ExecuteStageContext {
  runId: string;
  issueId: string;
  stage: StageType;
  sanitizedIssue: SanitizedIssue;
  repoConfig: RepoConfig;
  handoff?: HandoffArtifact;
  workdir: string;
  db: Db;
  techStack?: TechStackProfile;
  devcontainerSession?: DevcontainerSession;
  /** RALPH iteration context — appended to prompt when re-running implement. */
  ralphContext?: string;
  /** Per-stage model overrides from PipelineConfig. When set for the current stage,
   *  this takes precedence over the profile's default model. */
  stageModels?: Record<string, string>;
  /**
   * Per-stage provider overrides (BEC-201). Keys are stage names; values are provider IDs
   * (e.g., "anthropic-sdk", "openrouter"). The IMPLEMENT_PROVIDER env var takes precedence.
   * Only the implement stage currently supports non-Anthropic providers.
   * Example: { implement: "openrouter" }
   */
  stageProviders?: Record<string, string>;
  /** PR review feedback context. When present on an implement stage, the prompt is
   *  rewritten to address the specific review comments rather than re-implementing
   *  from scratch. The agent is instructed to push to the existing PR branch. */
  reviewFeedback?: ReviewFeedbackContext;
  /** Merge-conflict resolution context. When present on an implement stage, the
   *  prompt is rewritten to focus narrowly on resolving rebase conflicts and
   *  continuing the rebase — no issue re-implementation, no build/test runs.
   *  Takes precedence over `reviewFeedback` if both are set. */
  mergeConflictContext?: MergeConflictContext;
}

export async function executeStage(
  context: ExecuteStageContext,
): Promise<StageResult> {
  const {
    runId,
    issueId,
    stage,
    sanitizedIssue,
    repoConfig,
    handoff,
    workdir,
    db: rawDb,
  } = context;

  if (stage === "await-approval") {
    throw new Error("await-approval is not an agent stage");
  }

  const profile = getAgentProfiles()[stage];
  if (!profile) {
    throw new Error(`No agent profile for stage: ${stage}`);
  }

  const effectiveProfile = applyReviewFeedbackProfileOverride(
    profile,
    stage,
    !!context.reviewFeedback,
  );

  // Bind runId, issueId and stage to every log line in this execution
  const log = createLogger({ component: "Executor", runId, issueId, stage });

  const db = rawDb as AnyDb;
  const stageRunId = nanoid();
  let prompt = assemblePrompt(
    stage,
    sanitizedIssue,
    repoConfig,
    handoff,
    context.reviewFeedback,
    context.mergeConflictContext,
  );

  // When a devcontainer is active, instruct the agent to run shell commands inside it
  if (context.devcontainerSession) {
    const ws = context.devcontainerSession.workspaceFolder;
    prompt += `\n\n<devcontainer-context>
A devcontainer is active for this worktree. Run all shell commands inside the container using:
  devcontainer exec --workspace-folder ${context.devcontainerSession.worktreePath} <command>
The workspace folder inside the container is: ${ws}
Do NOT run build, test, or lint commands directly on the host — always use \`devcontainer exec\`.
</devcontainer-context>`;
  }

  // Append RALPH context if this is a re-run with gap analysis
  if (context.ralphContext) {
    prompt += `\n\n${context.ralphContext}`;
  }

  await db.insert(stageRuns).values({
    id: stageRunId,
    pipelineRunId: runId,
    stage,
    status: "running",
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let lastTextContent = "";
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let usedProviderName = "anthropic-sdk";
  let usedModelId = context.stageModels?.[stage] ?? effectiveProfile.model ?? "claude-sonnet-4-6";

  try {
    // Resolve MCP servers and plugins based on tech stack
    const tooling = context.techStack
      ? resolveTooling(context.techStack, stage, repoConfig.plugins)
      : { mcpServers: {}, plugins: [] };

    const mcpServerNames = Object.keys(tooling.mcpServers);
    if (mcpServerNames.length > 0) {
      log.info({ mcpServers: mcpServerNames }, "MCP servers resolved");
    }
    if (tooling.plugins.length > 0) {
      log.info({ plugins: tooling.plugins.map((p) => (p as { path: string }).path) }, "plugins resolved");
    }

    // BEC-201: select agent provider via factory.
    // The factory reads IMPLEMENT_PROVIDER env var and context.stageProviders for the stage.
    // Non-Anthropic providers are only supported for the implement stage.
    const provider = createAgentProvider(stage, context.stageProviders, process.env);
    // Set usedProviderName immediately so the DB row records the correct provider
    // even when provider.execute() throws (error path also persists this value).
    usedProviderName = provider.providerId;
    log.info({ provider: provider.providerId }, "agent provider selected");

    // BEC-183: wall-clock stage timeout values (kept here for BEC-183 source-text tests).
    // These are passed to the provider as hints; AnthropicAgentSDK uses them directly.
    const stageTimeoutMs = WALL_CLOCK_STAGE_TIMEOUT_MS[stage] ?? DEFAULT_WALL_CLOCK_STAGE_TIMEOUT_MS;

    // Batch agent_logs inserts for throughput
    const BATCH_SIZE = 20;
    let logBatch: Array<{ id: string; stageRunId: string; type: string; content: string }> = [];

    async function flushLogBatch() {
      if (logBatch.length === 0) return;
      await db.insert(agentLogs).values(logBatch);
      logBatch = [];
    }

    // Execute the stage via the selected provider.
    // firstMessageTimeoutMs is passed to the AnthropicAgentSDK provider which forwards it
    // to consumeAgentStream — this string must appear in executor.ts for BEC-183 tests.
    const providerResult = await provider.execute({
      prompt,
      workdir,
      stage,
      profile: effectiveProfile,
      modelConfig: {
        model: context.stageModels?.[stage] ?? effectiveProfile.model,
      },
      runId,
      issueId,
      mcpServers: tooling.mcpServers as Record<string, unknown>,
      plugins: tooling.plugins as unknown[],
      stageTimeoutMs,
      firstMessageTimeoutMs: FIRST_MESSAGE_TIMEOUT_MS,
      onProgress: (stats) => {
        log.info(stats, "stage still in progress");
      },
      onToolMessage: (msg) => {
        const streamMsg = msg as StreamMessage;
        logBatch.push({
          id: nanoid(),
          stageRunId: stageRunId,
          type: streamMsg.type ?? "unknown",
          content: JSON.stringify(msg).slice(0, 2048),
        });
        if (logBatch.length >= BATCH_SIZE) {
          flushLogBatch().catch((err) => log.warn({ err }, "mid-stream log batch flush failed"));
        }
      },
    });

    // Flush remaining log entries
    await flushLogBatch();

    inputTokens = providerResult.inputTokens;
    outputTokens = providerResult.outputTokens;
    cacheCreationInputTokens = providerResult.cacheCreationInputTokens;
    cacheReadInputTokens = providerResult.cacheReadInputTokens;
    turns = providerResult.turns;
    lastTextContent = providerResult.lastText;
    usedProviderName = providerResult.providerName;
    usedModelId = providerResult.modelId;

    // Pass `origin/<defaultBranch>` as baseRef so extractHandoff's
    // empty-filesChanged override picks up commits the agent made on the
    // branch in earlier stages (urateam#35 widened-fix gap from PR #95).
    // Note: extractHandoff takes the FULL ref form including `origin/` —
    // `getChangedFiles` in repo/git.ts takes a bare branch and prefixes
    // internally; don't conflate the two contracts.
    const handoffResult = await extractHandoff(
      lastTextContent,
      runId,
      issueId,
      stage,
      workdir,
      `origin/${repoConfig.defaultBranch}`,
    );

    await db
      .update(stageRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        turns,
        handoffArtifact: JSON.stringify(handoffResult.artifact),
        providerName: usedProviderName,
        modelId: usedModelId,
      })
      .where(eq(stageRuns.id, stageRunId));

    log.info({ inputTokens, outputTokens, turns, provider: usedProviderName, model: usedModelId }, "stage completed");
    return {
      status: "completed",
      handoffArtifact: handoffResult.artifact,
      handoffIsStructured: handoffResult.structured,
      inputTokens,
      outputTokens,
      turns,
      stageRunId,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    log.error({ err: error, provider: usedProviderName }, "stage failed");

    await db.insert(agentLogs).values({
      id: nanoid(),
      stageRunId: stageRunId,
      type: "error",
      content: errorMessage.slice(0, 2048),
    });

    await db
      .update(stageRuns)
      .set({
        status: "failed",
        completedAt: new Date(),
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        turns,
        errorMessage,
        providerName: usedProviderName,
        modelId: usedModelId,
      })
      .where(eq(stageRuns.id, stageRunId));

    return {
      status: "failed",
      inputTokens,
      outputTokens,
      turns,
      errorMessage,
      stageRunId,
    };
  }
}

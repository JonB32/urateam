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
import { buildStagePermissionOptions } from "./permissions.js";
import { resolveTooling } from "./mcp-resolver.js";
import type { TechStackProfile } from "../repo/tech-stack.js";
import type { DevcontainerSession } from "../repo/devcontainer.js";
import { createLogger } from "../logger.js";
import { consumeAgentStream, StagePreStreamStalledError, type StreamMessage } from "./agent-stream.js";
import { isClaudeAuthValid } from "./auth-check.js";
import { detectStageHang, HANG_DETECTION_INTERVAL_MS } from "./hang-detection.js";

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

  try {
    // Pre-flight auth check — fail fast with a clear message rather than
    // burning tokens on a doomed run.
    if (!(await isClaudeAuthValid())) {
      throw new Error(
        "Claude auth credentials are invalid or expired. Run: docker compose exec <service> claude login",
      );
    }

    // Import Agent SDK dynamically to allow mocking in tests
    log.info({ workdir }, "importing Agent SDK");
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    log.info({ workdir }, "starting agent query");

    // Resolve MCP servers and plugins based on tech stack
    const tooling = context.techStack
      ? resolveTooling(context.techStack, stage, repoConfig.plugins)
      : { mcpServers: {}, plugins: [] };

    const mcpServerNames = Object.keys(tooling.mcpServers);
    if (mcpServerNames.length > 0) {
      log.info({ mcpServers: mcpServerNames }, "MCP servers resolved");
    }
    if (tooling.plugins.length > 0) {
      log.info({ plugins: tooling.plugins.map((p) => p.path) }, "plugins resolved");
    }

    const messages = query({
      prompt,
      options: {
        allowedTools: effectiveProfile.tools,
        maxTurns: effectiveProfile.maxTurns,
        cwd: workdir,
        ...buildStagePermissionOptions(stage),
        ...(context.stageModels?.[stage] ?? effectiveProfile.model
          ? { model: context.stageModels?.[stage] ?? effectiveProfile.model! }
          : {}),
        ...(mcpServerNames.length > 0 ? { mcpServers: tooling.mcpServers } : {}),
        ...(tooling.plugins.length > 0 ? { plugins: tooling.plugins } : {}),
      },
    });
    log.info("iterating agent messages");

    // Track last progress timestamp for hang detection (BEC-209).
    // Updated on every tool message and every onProgress tick so the
    // HANG_DETECTION_INTERVAL_MS setInterval below has a fresh reference.
    let lastProgressAt = new Date();

    // BEC-209: start a 5-minute hang-detection interval for the implement stage.
    // detectStageHang() logs an ERROR when no progress has been observed for
    // 30+ minutes. This is a LOGGING mechanism only — termination is handled by
    // the existing StageStalledError / WALL_CLOCK_STAGE_TIMEOUT_MS guards.
    let hangCheckInterval: ReturnType<typeof setInterval> | undefined;
    if (stage === "implement") {
      hangCheckInterval = setInterval(() => {
        detectStageHang(runId, stage, lastProgressAt);
      }, HANG_DETECTION_INTERVAL_MS);
    }

    // Batch agent_logs inserts for throughput
    const BATCH_SIZE = 20;
    let logBatch: Array<{ id: string; stageRunId: string; type: string; content: string }> = [];

    async function flushLogBatch() {
      if (logBatch.length === 0) return;
      await db.insert(agentLogs).values(logBatch);
      logBatch = [];
    }

    // BEC-183: capture the iterator that consumeAgentStream will create so we
    // can call .return() for cleanup if the wall-clock timeout fires before the
    // inner firstMessageTimeoutMs guard does. consumeAgentStream calls
    // messages[Symbol.asyncIterator]() exactly once — the wrapper intercepts
    // that call and stores the reference.
    let capturedMessagesIterator: AsyncIterator<unknown> | undefined;
    const messagesWithCapture: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        const iter = messages[Symbol.asyncIterator]();
        capturedMessagesIterator = iter;
        return iter;
      },
    };

    // BEC-183: wall-clock stage timeout — second defensive layer independent
    // of the in-stream watchdog. Fires as StagePreStreamStalledError so the
    // catch block below sets status=failed with a clear message.
    const stageTimeoutMs = WALL_CLOCK_STAGE_TIMEOUT_MS[stage] ?? DEFAULT_WALL_CLOCK_STAGE_TIMEOUT_MS;
    let stageTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const stageTimeoutPromise = new Promise<never>((_, reject) => {
      stageTimeoutTimer = setTimeout(() => {
        reject(new StagePreStreamStalledError(stageTimeoutMs));
      }, stageTimeoutMs);
    });

    const result = await Promise.race([
      consumeAgentStream(messagesWithCapture, {
        onProgress: (stats) => {
          // BEC-209: update progress timestamp for hang detection, then
          // write to DB (fire-and-forget, rate-limited by progressIntervalMs).
          lastProgressAt = new Date();
          db.update(stageRuns)
            .set({ lastProgressAt })
            .where(eq(stageRuns.id, stageRunId))
            .catch((err: unknown) => log.warn({ err }, "lastProgressAt DB update failed"));
          log.info(stats, "stage still in progress");
        },
        onToolMessage: (msg: StreamMessage) => {
          // BEC-209: any tool message counts as progress.
          lastProgressAt = new Date();
          logBatch.push({
            id: nanoid(),
            stageRunId: stageRunId,
            type: msg.type!,
            content: JSON.stringify(msg).slice(0, 2048),
          });
          if (logBatch.length >= BATCH_SIZE) {
            flushLogBatch().catch((err) => log.warn({ err }, "mid-stream log batch flush failed"));
          }
        },
        firstMessageTimeoutMs: FIRST_MESSAGE_TIMEOUT_MS,
      }),
      stageTimeoutPromise,
    ]).catch((err: unknown) => {
      // When the wall-clock timeout fires before consumeAgentStream's own
      // firstMessageTimeoutMs guard, the internal iterator is still pending.
      // Signal it to release any SDK network connections or event listeners.
      // Best-effort: if the generator is truly blocked on a never-resolving
      // Promise, .return() won't unblock it, but the GC will eventually
      // collect it once this run's references are dropped.
      capturedMessagesIterator?.return?.()?.catch(() => {});
      throw err;
    }).finally(() => {
      // Always clear the wall-clock timer whether the stream succeeds, stalls,
      // or throws any other error — prevents the timer from dangling after the
      // stage exits the happy path.
      if (stageTimeoutTimer) clearTimeout(stageTimeoutTimer);
      // BEC-209: clear hang-detection interval for implement stage.
      if (hangCheckInterval) clearInterval(hangCheckInterval);
    });

    // Flush remaining log entries
    await flushLogBatch();

    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
    cacheCreationInputTokens = result.cacheCreationInputTokens;
    cacheReadInputTokens = result.cacheReadInputTokens;
    turns = result.turns;
    lastTextContent = result.lastText;

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
      })
      .where(eq(stageRuns.id, stageRunId));

    log.info({ inputTokens, outputTokens, turns }, "stage completed");
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
    log.error({ err: error }, "stage failed");

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

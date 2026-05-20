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
import { isClaudeAuthValid, resolveClaudeAuth } from "./auth-check.js";
import { isResumable } from "./session-policy.js";
import { transcriptExists, defaultProjectsRoot } from "./session-store.js";
// BEC-231 — `agentSessionMissingFallbackEvent` was previously fired from this
// module when the resume branch found the JSONL absent. The new logic always
// picks the right shape (`sessionId:` to create, `resume:` to continue) based
// on actual disk state, so the missing-fallback path is unreachable from here.
// The event type itself is kept in `audit/events.ts` for callers (e.g. the
// session-volume boot check) that may need it.
import { agentSessionResumedEvent } from "../audit/index.js";
import { logAuditEvent } from "../audit/writer.js";

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
  /**
   * BEC-227 — agent session continuity.
   *
   * UUID of the per-run SDK session, or `null` when the
   * `URATEAM_ENABLE_AGENT_SESSION_RESUME` flag is off. Runner mints this once
   * at start() and threads it through every executeStage() call so resumable
   * stages share one SDK transcript across the pipeline.
   *
   * When `null` (flag off) no session options are added to the SDK call.
   * When non-null AND `isResumable(stage, model)` is true:
   *   - first resumable stage → `options.sessionId = agentSessionId` (creates)
   *   - subsequent resumable stages → `options.resume = agentSessionId` (reuses)
   *
   * Optional for backwards compatibility with existing callers and tests; the
   * runner always sets it. Defaults to `null` (no session opts).
   */
  agentSessionId?: string | null;
  /**
   * BEC-227 — true only on the first resumable stage of the run. Runner
   * tracks this via a `hasInitiatedSession` flag and flips it once on the
   * first resumable-stage call. Required to disambiguate the SDK call shape:
   * sessionId on create vs. resume on reuse. Defaults to `false`.
   */
  isFirstResumableStage?: boolean;
  /**
   * BEC-227 — when `true`, the rendered prompt omits the
   * `<previous-stage-context>` block. Runner sets this on resumed RALPH
   * re-implement iterations: the agent already received the same handoff in
   * the initial turn (now visible in the resumed SDK session's transcript),
   * so re-injecting it as prompt text would waste input tokens and risk
   * confusing the model with duplicated context. Defaults to `false`.
   */
  suppressHandoff?: boolean;
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
    { suppressHandoff: context.suppressHandoff ?? false },
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
    // Resolve auth method before any SDK call (BEC-207). Logs which path is
    // active (oauth-token / api-key / session) alongside the run context.
    const claudeAuth = resolveClaudeAuth();
    log.info({ authMethod: claudeAuth.method }, "Claude auth method resolved");

    // Pre-flight auth check — fail fast with a clear message rather than
    // burning tokens on a doomed run. Short-circuits to true for env-var
    // auth paths (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY).
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

    // BEC-227 — resolve per-stage session opts. The runner mints
    // `agentSessionId` once per run and flips `isFirstResumableStage` on the
    // first resumable stage. Combined with `isResumable(stage, model)` this
    // chooses between three call shapes: create (`sessionId`), reuse
    // (`resume`), or no session opts (always-fresh stages, non-Claude models,
    // or flag off).
    //
    // Task 7 (this block): on the resume branch (non-first resumable stage),
    // verify the SDK's JSONL transcript file actually exists on disk before
    // setting `resume`. If the JSONL is missing (e.g. container tmpfs lost,
    // operator wiped `~/.claude/projects`), the SDK would throw on resume.
    // Drop to a fresh-session shape, emit a `missing_fallback` audit event,
    // and warn so operators can spot loss patterns.
    // BEC-231 — derive session-shape from on-disk state, not from an in-memory
    // flag. The previous implementation passed `isFirstResumableStage` (set by
    // the runner via `hasInitiatedSession`) and used it to pick `sessionId:` vs.
    // `resume:`. That flag flipped after the first resumable stage's CALL —
    // before the SDK had actually written a single message to the JSONL. If the
    // first stage failed (auth 401, MCP init error, pre-stream stall) before
    // the SDK got that far, every subsequent stage saw "session initiated; use
    // resume:" and fell back when the JSONL didn't exist. The session was lost
    // for the run's lifetime.
    //
    // Fix: ignore `isFirstResumableStage`. Check `transcriptExists()` on every
    // stage. JSONL present → `resume:`. JSONL absent → `sessionId:` (which
    // re-attempts creation; the SDK pre-assigns the UUID and writes a fresh
    // transcript if there's nothing on disk).
    //
    // The `isFirstResumableStage` field is retained on `ExecuteStageContext`
    // for backwards compatibility with callers that still pass it; the value
    // is now ignored. Runner cleanup is in the companion runner.ts edit.
    const resolvedModel = context.stageModels?.[stage] ?? effectiveProfile.model;
    const agentSessionId = context.agentSessionId ?? null;
    const wantsResume =
      agentSessionId !== null &&
      !!resolvedModel &&
      isResumable(stage, resolvedModel);
    let sessionOpts: { sessionId?: string; resume?: string } = {};
    if (wantsResume) {
      const exists = transcriptExists({
        projectsRoot: defaultProjectsRoot(),
        cwd: workdir,
        sessionId: agentSessionId!,
      });
      if (exists) {
        // Transcript present — resume the conversation.
        sessionOpts = { resume: agentSessionId! };
        try {
          const { readFileSync } = await import("node:fs");
          const tp = (await import("./session-store.js")).transcriptPath({
            projectsRoot: defaultProjectsRoot(),
            cwd: workdir,
            sessionId: agentSessionId!,
          });
          const priorMessageCount = readFileSync(tp, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0).length;
          void logAuditEvent(
            db,
            agentSessionResumedEvent({
              runId,
              issueId,
              sessionId: agentSessionId!,
              stage,
              priorMessageCount,
            }),
          );
        } catch (err) {
          log.warn(
            { err: (err as Error).message },
            "failed to count prior session messages — emitting resumed event with count=0",
          );
          void logAuditEvent(
            db,
            agentSessionResumedEvent({
              runId,
              issueId,
              sessionId: agentSessionId!,
              stage,
              priorMessageCount: 0,
            }),
          );
        }
      } else {
        // Transcript absent — (re-)create the session. The SDK pre-assigns
        // our UUID; if a prior call started but failed before writing, this
        // call gets a fresh shot at writing the first message.
        sessionOpts = { sessionId: agentSessionId! };
      }
    }

    const messages = query({
      prompt,
      options: {
        allowedTools: effectiveProfile.tools,
        maxTurns: effectiveProfile.maxTurns,
        cwd: workdir,
        ...buildStagePermissionOptions(stage),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(mcpServerNames.length > 0 ? { mcpServers: tooling.mcpServers } : {}),
        ...(tooling.plugins.length > 0 ? { plugins: tooling.plugins } : {}),
        ...sessionOpts,
        // BEC-227 Track C-1: strip per-session dynamic sections (cwd, git
        // status) from the claude_code preset so the system prompt is
        // stable across stages. Improves cache hit rate even when no SDK
        // session is involved, so we ship it on unconditionally in Phase 1.
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
          excludeDynamicSections: true,
        },
      },
    });
    log.info("iterating agent messages");

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
          log.info(stats, "stage still in progress");
        },
        onToolMessage: (msg: StreamMessage) => {
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

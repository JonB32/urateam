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
import { detectStageHang, HANG_DETECTION_INTERVAL_MS } from "./hang-detection.js";
import { resolveSessionOpts } from "./session-resolver.js";
import { persistDecisionArtifact } from "../db/decisions-store.js";

/**
 * BEC-183: wall-clock stage timeouts. Independent of the in-stream watchdog
 * (StageStalledError / StagePreStreamStalledError inside consumeAgentStream),
 * this is a second defensive layer that covers the case where the SDK's
 * query() or iterator setup hangs before any message arrives and the
 * firstMessageTimeoutMs timer inside consumeAgentStream somehow fails to fire.
 * Default: 60 min for implement (longest legitimate stage), 30 min for others.
 */
const WALL_CLOCK_STAGE_TIMEOUT_MS: Partial<Record<StageType, number>> = {
  implement: 60 * 60_000, // 60 min — longest legitimate stage
};
const DEFAULT_WALL_CLOCK_STAGE_TIMEOUT_MS = 30 * 60_000; // 30 min for all others

/** First-message timeout passed to consumeAgentStream (BEC-183). */
const FIRST_MESSAGE_TIMEOUT_MS = 5 * 60_000; // 5 min

/** Max bytes stored per log entry in agent_logs (tool messages + error messages). */
const LOG_CONTENT_MAX_BYTES = 2048;

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
  /**
   * BEC-227 Phase 4 / Track D. RALPH iteration index (0 = initial implement,
   * 1..N = re-implement after RALPH gap check) used as the persistence
   * iteration column for `pipeline_run_decisions`. Other implement-stage
   * re-entries (e.g. review-fix loop) may pass their own iteration index
   * when relevant. Purely informational; Track B's surgical-review-fix
   * path reads only the highest-iteration row, but stages logging different
   * iterations creates a useful audit trail. Defaults to 0.
   */
  iteration?: number;
  /**
   * BEC-227 Phase 4 / Track B. When set, replaces the prompt that
   * `assemblePrompt()` + RALPH-context + devcontainer-context would
   * produce. Used by the surgical-review-fix path: the resumed agent
   * already has full context in its SDK transcript, so we send only the
   * focused findings-plus-prior-decisions prompt. Always combine with
   * `suppressHandoff: true` for clarity — the override skips the existing
   * prompt entirely; suppressing the handoff doc-string is logically
   * redundant but makes the call-site intent explicit.
   */
  promptOverride?: string;
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

  // BEC-227 Phase 4 / Track B — `promptOverride` replaces the assembled prompt
  // entirely. Used by the surgical-review-fix path; the resumed SDK session
  // already carries all upstream context.
  if (context.promptOverride) {
    prompt = context.promptOverride;
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

  // BEC-249: wall-clock timer started BEFORE any pre-flight await so it
  // covers resolveSessionOpts (which calls countLines via createReadStream
  // and can hang on an unresponsive Docker volume). Declared outside try so
  // the finally block can always cancel it regardless of which exit path runs.
  const stageTimeoutMs = WALL_CLOCK_STAGE_TIMEOUT_MS[stage] ?? DEFAULT_WALL_CLOCK_STAGE_TIMEOUT_MS;
  let stageTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const stageTimeoutPromise = new Promise<never>((_, reject) => {
    stageTimeoutTimer = setTimeout(() => {
      reject(new StagePreStreamStalledError(stageTimeoutMs));
    }, stageTimeoutMs);
  });
  // Suppress Node.js PromiseRejectionHandledWarning: rejection is always consumed
  // by the Promise.race calls below; no-op handler marks it "handled" for the
  // unhandledRejection machinery without affecting race or error semantics.
  stageTimeoutPromise.catch(() => {});

  // BEC-251: diagnostic state captured for error enrichment in the catch block.
  // Declared outside try so the catch block can read whatever was set before the throw.
  const stageStartMs = Date.now();
  let capturedStderr = "";
  let claudeAuthMethod = "unknown";
  let sessionType: "fresh" | "resumed" | "none" = "none";

  try {
    // Resolve auth method before any SDK call (BEC-207). Logs which path is
    // active (oauth-token / api-key / mounted-session) alongside the run context.
    const claudeAuth = resolveClaudeAuth();
    claudeAuthMethod = claudeAuth.method;
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

    // BEC-228 — resolve per-stage session opts via shared helper (extracted
    // from the ~70-line inline block that was duplicated in deep-review.ts).
    // BEC-231 — session-resolver derives the shape from on-disk state, not
    // from `isFirstResumableStage` (which flipped before the SDK wrote
    // anything; first-stage failures left the session lost forever).
    // BEC-249 — raced against stageTimeoutPromise so a hung countLines call
    // (unresponsive Docker volume) is cut by the wall-clock guard.
    const resolvedModel = context.stageModels?.[stage] ?? effectiveProfile.model;
    const agentSessionId = context.agentSessionId ?? null;
    const sessionOpts = await Promise.race([
      resolveSessionOpts({
        stage,
        model: resolvedModel,
        agentSessionId,
        workdir,
        runId,
        issueId,
        db,
      }),
      stageTimeoutPromise,
    ]);

    // BEC-251: determine session type for error enrichment.
    if ("resume" in sessionOpts) {
      sessionType = "resumed";
    } else if ("sessionId" in sessionOpts) {
      sessionType = "fresh";
    } else {
      sessionType = "none";
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
        // BEC-251: capture stderr from the Claude Code child process so it is
        // available for error enrichment if the process exits non-zero. The SDK
        // only pipes stderr when this callback is provided (otherwise it is
        // "ignore"). We keep at most 2 KB — the tail is most relevant.
        stderr: (chunk: string) => {
          capturedStderr += chunk;
          if (capturedStderr.length > 2000) {
            capturedStderr = capturedStderr.slice(-2000);
          }
        },
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
      // Swap the array before inserting so new items pushed during the async
      // insert are not lost when the original flush completes.
      const itemsToInsert = logBatch;
      logBatch = [];
      await db.insert(agentLogs).values(itemsToInsert);
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
    // BEC-249: stageTimeoutPromise is created before the try block; same
    // instance reused here so the wall-clock covers pre-flight + stream.
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
            content: JSON.stringify(msg).slice(0, LOG_CONTENT_MAX_BYTES),
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

    // BEC-227 Phase 4 / Track D — persist the agent's decision artifact when
    // the implement stage emitted one. Fire-and-forget; persistDecisionArtifact
    // already swallows errors internally (best-effort by design), but we still
    // wrap in try/catch to defend against an unexpected throw outside the
    // helper's contract. Only implement-stage emits decisions — other stages'
    // outputs aren't shaped for this artifact.
    if (stage === "implement" && handoffResult.decisions) {
      try {
        await persistDecisionArtifact(db, {
          pipelineRunId: runId,
          iteration: context.iteration ?? 0,
          stage: "implement",
          payload: handoffResult.decisions,
        });
      } catch (err) {
        log.warn({ err }, "persistDecisionArtifact threw despite internal swallow — ignoring");
      }
    }

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

    const exitCodeMatch = errorMessage.match(/exited with code (\d+)/);
    const exitCode: number | null = exitCodeMatch ? Number(exitCodeMatch[1]) : null;
    const stderrBounded = capturedStderr.slice(-500);

    const durationMs = Date.now() - stageStartMs;

    const enrichedContext: Record<string, unknown> = {
      message: errorMessage,
      exitCode,
      authMethod: claudeAuthMethod,
      sessionType,
      durationMs,
    };
    if (stderrBounded) {
      enrichedContext.stderr = stderrBounded;
    }

    // agent_logs.content: structured JSON, bounded at 2 KB (no stack trace).
    const enrichedJson = JSON.stringify(enrichedContext).slice(0, 2048);

    // pipeline_runs.error_message (via stage_runs.errorMessage and StageResult):
    // a compact one-liner with key fields inline so it reads at a glance.
    const summaryParts = [
      `exitCode=${exitCode ?? "?"}`,
      `auth=${claudeAuthMethod}`,
      `session=${sessionType}`,
      `duration=${durationMs}ms`,
    ];
    const enrichedMessage = `${errorMessage} [${summaryParts.join(", ")}]`;

    await db.insert(agentLogs).values({
      id: nanoid(),
      stageRunId: stageRunId,
      type: "error",
      content: enrichedJson,
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
        errorMessage: enrichedMessage,
      })
      .where(eq(stageRuns.id, stageRunId));

    return {
      status: "failed",
      inputTokens,
      outputTokens,
      turns,
      errorMessage: enrichedMessage,
      stageRunId,
    };
  } finally {
    // Always cancel the wall-clock timer regardless of exit path (BEC-249).
    // Clearing an already-fired timer is a no-op, so this is always safe.
    if (stageTimeoutTimer) clearTimeout(stageTimeoutTimer);
  }
}

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
import { consumeAgentStream, type StreamMessage } from "./agent-stream.js";
import { isClaudeAuthValid } from "./auth-check.js";

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
        allowedTools: profile.tools,
        maxTurns: profile.maxTurns,
        cwd: workdir,
        ...buildStagePermissionOptions(stage),
        ...(context.stageModels?.[stage] ?? profile.model
          ? { model: context.stageModels?.[stage] ?? profile.model! }
          : {}),
        ...(mcpServerNames.length > 0 ? { mcpServers: tooling.mcpServers } : {}),
        ...(tooling.plugins.length > 0 ? { plugins: tooling.plugins } : {}),
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

    const result = await consumeAgentStream(messages, {
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
    });

    // Flush remaining log entries
    await flushLogBatch();

    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
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

/**
 * AnthropicAgentSDK — default AgentProvider implementation using @anthropic-ai/claude-agent-sdk.
 *
 * This is the original agentic execution path: the Claude agent receives the full
 * prompt, can call tools (Read, Write, Edit, Bash, Glob, Grep, …), iterates over
 * multiple turns, and produces a HandoffArtifact JSON block in its final text output.
 *
 * Timeout behaviour mirrors executor.ts BEC-183 defences:
 *  - `firstMessageTimeoutMs` → consumeAgentStream pre-stream stall guard
 *  - `stageTimeoutMs`        → outer Promise.race wall-clock cap
 */

import type { AgentProvider, AgentExecuteParams, AgentExecuteResult } from "./index.js";
import { buildStagePermissionOptions } from "../permissions.js";
import { consumeAgentStream, StagePreStreamStalledError, type StreamMessage } from "../agent-stream.js";
import { isClaudeAuthValid } from "../auth-check.js";
import { createLogger } from "../../logger.js";

export class AnthropicAgentSDK implements AgentProvider {
  readonly providerId = "anthropic-sdk" as const;

  async execute(params: AgentExecuteParams): Promise<AgentExecuteResult> {
    const {
      prompt,
      workdir,
      stage,
      profile,
      modelConfig,
      runId,
      issueId,
      mcpServers,
      plugins,
      stageTimeoutMs,
      firstMessageTimeoutMs,
      onProgress,
      onToolMessage,
    } = params;

    const log = createLogger({ component: "provider.anthropic-sdk", runId, issueId, stage });

    // Pre-flight auth check — fail fast with a clear message.
    if (!(await isClaudeAuthValid())) {
      throw new Error(
        "Claude auth credentials are invalid or expired. Run: docker compose exec <service> claude login",
      );
    }

    // Dynamic import so tests can vi.mock("@anthropic-ai/claude-agent-sdk").
    log.info({ workdir }, "importing Agent SDK");
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    log.info({ workdir }, "starting agent query");

    const effectiveModel = modelConfig.model ?? profile.model;

    const messages = query({
      prompt,
      options: {
        allowedTools: profile.tools,
        maxTurns: profile.maxTurns,
        cwd: workdir,
        ...buildStagePermissionOptions(stage),
        ...(effectiveModel ? { model: effectiveModel } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers: mcpServers as any } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(plugins && plugins.length > 0 ? { plugins: plugins as any } : {}),
      },
    });

    log.info("iterating agent messages");

    // Capture the iterator so we can call .return() for cleanup on timeout.
    let capturedMessagesIterator: AsyncIterator<unknown> | undefined;
    const messagesWithCapture: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        const iter = messages[Symbol.asyncIterator]();
        capturedMessagesIterator = iter;
        return iter;
      },
    };

    // Build wall-clock timeout promise when a limit is provided.
    // Capture stageTimeoutMs in a local const so TypeScript narrows it as number
    // inside the setTimeout callback (closure might lose narrowing otherwise).
    const capturedStageTimeoutMs = stageTimeoutMs;
    let stageTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const stageTimeoutPromise: Promise<never> = capturedStageTimeoutMs !== undefined
      ? new Promise<never>((_, reject) => {
          stageTimeoutTimer = setTimeout(() => {
            reject(new StagePreStreamStalledError(capturedStageTimeoutMs));
          }, capturedStageTimeoutMs);
        })
      : new Promise<never>(() => { /* never resolves when no timeout given */ });

    const streamResult = await Promise.race([
      consumeAgentStream(messagesWithCapture, {
        onProgress: (stats) => {
          log.info(stats, "stage still in progress");
          onProgress?.(stats as Record<string, unknown>);
        },
        onToolMessage: (msg: StreamMessage) => {
          onToolMessage?.(msg);
        },
        firstMessageTimeoutMs,
      }),
      stageTimeoutPromise,
    ]).catch((err: unknown) => {
      // Release the SDK iterator on timeout to avoid dangling network connections.
      capturedMessagesIterator?.return?.()?.catch(() => {});
      throw err;
    }).finally(() => {
      if (stageTimeoutTimer) clearTimeout(stageTimeoutTimer);
    });

    return {
      lastText: streamResult.lastText,
      inputTokens: streamResult.inputTokens,
      outputTokens: streamResult.outputTokens,
      cacheCreationInputTokens: streamResult.cacheCreationInputTokens,
      cacheReadInputTokens: streamResult.cacheReadInputTokens,
      turns: streamResult.turns,
      providerName: "anthropic-sdk",
      modelId: effectiveModel ?? "claude-sonnet-4-6",
    };
  }
}

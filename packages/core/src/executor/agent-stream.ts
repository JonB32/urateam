/**
 * Shared helpers for consuming Agent SDK message streams and parsing
 * JSON blocks from agent output.
 */

export interface StreamMessage {
  type?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  content?: Array<{ type: string; text?: string }> | string;
  /** Agent SDK wraps assistant text in `message` for some message shapes */
  message?: { content?: Array<{ type: string; text?: string }> | string } | string;
}

export interface ConsumeResult {
  lastText: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

/**
 * Thrown when a stage's agent stream makes no observable progress
 * (no new output tokens or assistant turns) for `progressTimeoutMs`.
 * See urateam#122 — without this watchdog, an SDK stuck on internal
 * rate-limit-or-auth retry loops could keep a stage "running" for hours.
 */
export class StageStalledError extends Error {
  constructor(
    public readonly stalledForMs: number,
    public readonly lastStats: { messageCount: number; turns: number; inputTokens: number; outputTokens: number },
  ) {
    super(
      `stage stalled — no token/turn progress in ${Math.round(stalledForMs / 1000)}s ` +
        `(messageCount=${lastStats.messageCount}, turns=${lastStats.turns}, outputTokens=${lastStats.outputTokens})`,
    );
    this.name = "StageStalledError";
  }
}

/**
 * Consume an Agent SDK message stream, accumulating token usage and
 * extracting the last assistant text content.
 *
 * The optional `onToolMessage` callback is invoked for tool_use / tool_result
 * messages so callers (e.g. executor.ts) can log them without duplicating
 * the iteration boilerplate.
 */
export async function consumeAgentStream(
  messages: AsyncIterable<unknown>,
  options?: {
    onToolMessage?: (msg: StreamMessage) => void;
    /** Called periodically (every progressIntervalMs) with current stats */
    onProgress?: (stats: { messageCount: number; turns: number; inputTokens: number; outputTokens: number }) => void;
    progressIntervalMs?: number;
    /**
     * Throw StageStalledError if no new outputTokens or turns arrive in this window.
     * Default 30 minutes. See urateam#122.
     */
    progressTimeoutMs?: number;
  },
): Promise<ConsumeResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let lastText = "";
  let messageCount = 0;
  let lastProgressTime = Date.now();
  let lastTokenAdvanceAt = Date.now();
  const progressInterval = options?.progressIntervalMs ?? 30_000;
  const stallTimeoutMs = options?.progressTimeoutMs ?? 30 * 60_000;

  const iterator = (messages as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  while (true) {
    const remainingUntilStall = stallTimeoutMs - (Date.now() - lastTokenAdvanceAt);
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const stallSentinel: unique symbol = Symbol("stall") as unknown as never;
    const next = iterator.next();
    const stallPromise = new Promise<typeof stallSentinel>((resolve) => {
      stallTimer = setTimeout(() => resolve(stallSentinel), Math.max(remainingUntilStall, 0));
    });

    const raced = await Promise.race([next, stallPromise]);
    if (stallTimer) clearTimeout(stallTimer);

    if (raced === stallSentinel) {
      // Fire-and-forget cleanup — when the agent generator is paused on a
      // never-resolving await (the exact zombie pattern from urateam#122),
      // awaiting iterator.return() would hang forever waiting for that
      // await to settle. Best-effort signal; let the GC handle the rest.
      iterator.return?.().catch(() => {});
      throw new StageStalledError(Date.now() - lastTokenAdvanceAt, {
        messageCount,
        turns,
        inputTokens,
        outputTokens,
      });
    }

    const result = raced as IteratorResult<unknown>;
    if (result.done) break;

    const message = result.value as StreamMessage;
    messageCount++;

    if (options?.onProgress && Date.now() - lastProgressTime >= progressInterval) {
      options.onProgress({ messageCount, turns, inputTokens, outputTokens });
      lastProgressTime = Date.now();
    }

    const prevOutputTokens = outputTokens;
    if (message.usage) {
      inputTokens += message.usage.input_tokens ?? 0;
      outputTokens += message.usage.output_tokens ?? 0;
    }

    if (
      (message.type === "tool_use" || message.type === "tool_result") &&
      options?.onToolMessage
    ) {
      options.onToolMessage(message);
    }

    if (message.type === "assistant") {
      // Agent SDK may put text in `content` (tool-using sessions) or
      // `message.content` (no-tool sessions). Check both.
      if (message.content) {
        const text = extractText(message.content);
        if (text) lastText = text;
      } else if (message.message) {
        const inner = typeof message.message === "string"
          ? message.message
          : message.message.content
            ? extractText(message.message.content)
            : "";
        if (inner) lastText = inner;
      }
    }

    if (message.type === "assistant") {
      turns++;
    }

    // Reset stall watchdog on real progress (output tokens advance OR a turn was added).
    // messageCount alone is NOT enough — see urateam#122 reproduction where
    // messageCount kept advancing but turns/outputTokens stayed flat for 8h.
    if (outputTokens > prevOutputTokens || message.type === "assistant") {
      lastTokenAdvanceAt = Date.now();
    }
  }

  return { lastText, inputTokens, outputTokens, turns };
}

/**
 * Extract text from an Agent SDK message content field.
 */
export function extractText(
  content: Array<{ type: string; text?: string }> | string,
): string {
  return Array.isArray(content)
    ? content
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
    : String(content);
}

/**
 * Extract and parse a bare JSON object from text (finds first `{...}` match).
 * Returns null if no object is found or if parsing fails.
 */
export function parseJsonObject(text: string): any | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Extract and parse a ```json fenced code block from agent output text.
 * Returns null if no block is found or if parsing fails.
 */
export function parseJsonBlock(text: string): unknown | null {
  const match = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

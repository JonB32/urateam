/**
 * Shared helpers for consuming Agent SDK message streams and parsing
 * JSON blocks from agent output.
 */
import { createLogger } from "../logger.js";

const log = createLogger({ component: "AgentStream" });

export interface StreamMessage {
  type?: string;
  /** Top-level usage — populated on the final `result` message. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  content?: Array<{ type: string; text?: string }> | string;
  /** Agent SDK wraps assistant text in `message` for some message shapes. For
   *  `type: "assistant"` messages, per-turn `usage` is nested HERE (not at
   *  top-level) — without reading it, max-turns failures record 0 tokens
   *  because the SDK throws before the final `result` message emits. */
  message?:
    | {
        content?: Array<{ type: string; text?: string }> | string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      }
    | string;
}

export interface ConsumeResult {
  lastText: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
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
 * Thrown when no message is received from the agent stream before the
 * `firstMessageTimeoutMs` deadline. This covers the pre-stream hang class
 * (BEC-183) where query() returns an iterator that never yields its first
 * message — e.g., blocked on an SDK-internal auth-retry loop, MCP init
 * failure, or a never-resolving Promise before the iterator advances.
 *
 * Distinct from StageStalledError (mid-stream silence after ≥1 message).
 */
export class StagePreStreamStalledError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(
      `stage pre-stream stall — no message received within ${Math.round(timeoutMs / 1000)}s of starting`,
    );
    this.name = "StagePreStreamStalledError";
  }
}

/**
 * Thrown when a stage's agent stream is interrupted via the abort signal
 * (operator-initiated cancel). Distinct from the timeout errors because the
 * runner uses the error class to decide how to mark the run (`aborted`, not
 * `failed`).
 */
export class StageCancelledError extends Error {
  constructor() {
    super("stage cancelled by operator");
    this.name = "StageCancelledError";
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
     * Throw StageStalledError if no new outputTokens or assistant turns arrive
     * in this window. Default 30 minutes. See urateam#122.
     *
     * NOTE: tool_use / tool_result messages do NOT reset this timer. The
     * ROT-15 zombie pattern emitted system messages while stuck, but a
     * legitimate long-running tool call (e.g. a 30+ min build) also produces
     * no assistant turns until the tool returns. If your stage runs slow
     * tool calls, raise this value (or chunk the work).
     */
    progressTimeoutMs?: number;
    /**
     * Throw StagePreStreamStalledError if no message at all arrives within
     * this window. Default 5 minutes. Protects against SDK hangs that occur
     * before the first message is emitted (e.g., auth-retry loop inside
     * query(), MCP server boot failure, never-resolving iterator setup).
     * BEC-183: distinct from progressTimeoutMs (mid-stream silence after ≥1
     * message). Set shorter than progressTimeoutMs to catch hangs early.
     */
    firstMessageTimeoutMs?: number;
    /**
     * AbortSignal for operator-initiated cancel. When the signal fires, the
     * iterator's `.return()` is invoked and the function throws
     * `StageCancelledError`. Pre-aborted signals fire on entry so the function
     * exits before consuming any messages.
     */
    abortSignal?: AbortSignal;
  },
): Promise<ConsumeResult> {
  // Honour a pre-aborted signal immediately so callers can short-circuit
  // without paying for an iterator setup.
  if (options?.abortSignal?.aborted) {
    throw new StageCancelledError();
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let turns = 0;
  let lastText = "";
  let messageCount = 0;
  let lastProgressTime = Date.now();
  let lastTokenAdvanceAt = Date.now();
  const progressInterval = options?.progressIntervalMs ?? 30_000;
  const stallTimeoutMs = options?.progressTimeoutMs ?? 30 * 60_000;
  // BEC-183: first-message timeout — fires if the iterator never yields its
  // first message (pre-stream hang). Default 5 min; covers auth refresh,
  // MCP boot, and model warmup latencies while still detecting SDK deadlocks.
  const firstMsgTimeoutMs = options?.firstMessageTimeoutMs ?? 5 * 60_000;
  const streamStartAt = Date.now();
  let firstMessageReceived = false;

  const iterator = (messages as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const STALLED = { __stalled: true } as const;
  const ABORTED = { __aborted: true } as const;
  type StallSentinel = typeof STALLED;
  type AbortSentinel = typeof ABORTED;
  while (true) {
    const stallRemaining = stallTimeoutMs - (Date.now() - lastTokenAdvanceAt);
    // First-message timeout: only active until the first real message arrives.
    const firstMsgRemaining = firstMessageReceived
      ? Infinity
      : firstMsgTimeoutMs - (Date.now() - streamStartAt);
    // Use whichever deadline is sooner; clamp to 0 to fire immediately if
    // either has already elapsed.
    const remainingUntilTimeout = Math.max(Math.min(stallRemaining, firstMsgRemaining), 0);

    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let nextSettled = false;
    let nextValue: IteratorResult<unknown> | undefined;
    const next = iterator.next().then((v) => {
      nextSettled = true;
      nextValue = v;
      return v;
    });
    const stallPromise = new Promise<StallSentinel>((resolve) => {
      stallTimer = setTimeout(() => resolve(STALLED), remainingUntilTimeout);
    });

    // Race the abort signal in alongside next + stallPromise. We re-create the
    // listener each iteration so it cleans up automatically (removeEventListener
    // below) and an external abort fires within one iteration tick.
    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<AbortSentinel>((resolve) => {
      if (!options?.abortSignal) return; // Promise never resolves — Promise.race ignores it
      if (options.abortSignal.aborted) {
        resolve(ABORTED);
        return;
      }
      abortListener = () => resolve(ABORTED);
      options.abortSignal.addEventListener("abort", abortListener, { once: true });
    });

    const raced = await Promise.race([next, stallPromise, abortPromise]);
    if (stallTimer) clearTimeout(stallTimer);
    if (abortListener && options?.abortSignal) {
      options.abortSignal.removeEventListener("abort", abortListener);
    }

    if (raced === ABORTED) {
      // Operator-initiated cancel. Same .return() best-effort cleanup as the
      // stall path; the agent generator may be parked on a never-resolving
      // await, in which case GC handles eventual release.
      iterator.return?.()?.catch((err) => log.debug({ err }, "iterator cleanup failed on abort"));
      throw new StageCancelledError();
    }

    if (raced === STALLED) {
      // Defensive race-loss check: if the iterator settled in the same tick
      // as the timer fired, prefer the message we already have. The
      // microtask vs macrotask ordering in V8 makes this near-impossible
      // in practice, but the cost is one boolean check.
      if (!(nextSettled && nextValue && !nextValue.done)) {
        // Fire-and-forget cleanup — when the agent generator is paused on a
        // never-resolving await (the exact zombie pattern from urateam#122),
        // awaiting iterator.return() would hang forever waiting for that
        // await to settle. Best-effort signal; let the GC handle the rest.
        iterator.return?.()?.catch((err) => log.debug({ err }, "iterator cleanup failed"));
        if (!firstMessageReceived) {
          // Pre-stream hang: the iterator never yielded its first message
          // within firstMsgTimeoutMs. Throw StagePreStreamStalledError so
          // callers can distinguish this from a mid-stream stall. BEC-183.
          throw new StagePreStreamStalledError(firstMsgTimeoutMs);
        }
        throw new StageStalledError(Date.now() - lastTokenAdvanceAt, {
          messageCount,
          turns,
          inputTokens,
          outputTokens,
        });
      }
    }

    const result = (raced === STALLED ? nextValue! : raced) as IteratorResult<unknown>;
    if (result.done) break;

    // Mark that at least one message has arrived; deactivates first-message timer.
    firstMessageReceived = true;

    const message = result.value as StreamMessage;
    messageCount++;

    if (options?.onProgress && Date.now() - lastProgressTime >= progressInterval) {
      options.onProgress({ messageCount, turns, inputTokens, outputTokens });
      lastProgressTime = Date.now();
    }

    const prevOutputTokens = outputTokens;
    // Token usage can land in either of two places depending on message type:
    //  - `message.usage`           — top-level on the final `result` message.
    //  - `message.message.usage`   — nested on every per-turn `assistant`
    //    message (the SDK wraps the underlying Anthropic API response there).
    // Read both. Without the nested path, max-turns failures record 0 tokens
    // because the SDK throws before the `result` message is ever emitted.
    const nestedUsage =
      typeof message.message === "object" ? message.message?.usage : undefined;
    const usage = message.usage ?? nestedUsage;
    if (usage) {
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
      cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
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

  return { lastText, inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens, turns };
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
 * Internal helper: apply `regex` to `text`, then JSON-parse the capture group
 * at `groupIndex`. Returns null if the regex doesn't match or parsing fails.
 * Eliminates the try-catch boilerplate duplicated in parseJsonObject and
 * parseJsonBlock.
 */
function parseJsonWithRegex(text: string, regex: RegExp, groupIndex: number = 0): unknown | null {
  const match = text.match(regex);
  if (!match) return null;
  try {
    return JSON.parse(match[groupIndex]);
  } catch {
    return null;
  }
}

/**
 * Extract and parse a bare JSON object from text. Returns null if no object
 * is found or if parsing fails.
 *
 * Strategy:
 * 1. Try `JSON.parse(text.trim())` first — covers clean JSON-only responses
 *    (the prefill-anchored v2 triage prompt elicits this shape).
 * 2. Fall back to bracket-counted extraction: find the first `{`, then walk
 *    forward tracking nesting depth (string-aware, escape-aware) until the
 *    matching closing `}`. Handles nested objects/arrays correctly — the
 *    previous non-greedy regex (`\{[\s\S]*?\}`) truncated at the first inner
 *    `}` and silently failed to parse v2 Haiku responses with `riskAssessment`
 *    / `examples` / `testStrategy` objects.
 */
export function parseJsonObject(text: string): any | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to extraction
    }
  }
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Extract and parse a ```json fenced code block from agent output text.
 * Returns null if no block is found or if parsing fails.
 */
export function parseJsonBlock(text: string): unknown | null {
  return parseJsonWithRegex(text, /```json\s*\n([\s\S]*?)\n```/, 1);
}

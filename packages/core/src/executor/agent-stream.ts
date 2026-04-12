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
  },
): Promise<ConsumeResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let lastText = "";
  let messageCount = 0;
  let lastProgressTime = Date.now();
  const progressInterval = options?.progressIntervalMs ?? 30_000;

  for await (const rawMessage of messages) {
    const message = rawMessage as StreamMessage;
    messageCount++;

    if (options?.onProgress && Date.now() - lastProgressTime >= progressInterval) {
      options.onProgress({ messageCount, turns, inputTokens, outputTokens });
      lastProgressTime = Date.now();
    }

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

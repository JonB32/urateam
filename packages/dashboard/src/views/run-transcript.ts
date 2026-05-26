import { escapeHtml } from "./layout.js";

/**
 * Subset of the SDK's `SessionMessage` shape that this view needs. We pull
 * the canonical type from `@urateam/core` (which re-exports it from the
 * Claude Agent SDK) so callers don't need to know about the SDK boundary.
 */
export interface TranscriptMessage {
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  /** Raw SDK message — typically `{ content: string }` or a structured array. */
  message: unknown;
  parent_tool_use_id: null;
}

/**
 * Best-effort extraction of human-readable text from an SDK message envelope.
 * The SDK's `message` field is `unknown` and varies by message type:
 *  - simple text:           `{ content: "..." }`
 *  - assistant tool-use:    `{ content: [{ type: "text", text: "..." }, ...] }`
 *  - system / boundary:     other shapes
 * We try the common cases and fall back to a pretty-printed JSON blob so
 * nothing is silently dropped. Result is always raw text — the caller is
 * responsible for escaping before emitting HTML.
 */
function extractContent(message: unknown): string {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    const msg = message as { content?: unknown };
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts = content.map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as { type?: string; text?: string; content?: unknown };
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
        }
        return JSON.stringify(part);
      });
      return parts.join("\n");
    }
  }
  // Fallback: full message as pretty JSON so we don't silently swallow content.
  return JSON.stringify(message, null, 2);
}

/**
 * Render the transcript view for a run. Returns the inner HTML for the
 * <main> element — the caller wraps in `layout()`.
 *
 * Each message is wrapped in a `<details>` collapsible. Assistant messages
 * default to open (they're typically the interesting output); user/system
 * messages stay collapsed to reduce visual noise. Order is preserved from
 * the SDK (chronological from the JSONL transcript file).
 */
export function runTranscriptView(
  runId: string,
  messages: TranscriptMessage[],
  basePath: string,
): string {
  const backLink = `<p style="margin-bottom:1rem;"><a href="${basePath}/runs/${encodeURIComponent(runId)}">← Back to run</a></p>`;

  if (messages.length === 0) {
    return `${backLink}<div class="card"><h2>Transcript</h2><p style="color:var(--color-text-muted);">No transcript available for this run.</p></div>`;
  }

  const items = messages
    .map((m, i) => {
      const text = extractContent(m.message);
      const isOpen = m.type === "assistant" ? " open" : "";
      return `<details${isOpen} class="transcript-message transcript-message-${m.type}">
        <summary>#${i + 1} — <strong>${escapeHtml(m.type)}</strong> <span style="color:var(--color-text-muted);font-size:0.8125rem;">${escapeHtml(m.uuid)}</span></summary>
        <pre style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(text)}</pre>
      </details>`;
    })
    .join("\n");

  return `${backLink}<div class="card">
    <h2>Transcript <span style="font-weight:400;font-size:0.875rem;color:var(--color-text-muted);">(${messages.length} message${messages.length === 1 ? "" : "s"})</span></h2>
    <div class="transcript-messages">${items}</div>
  </div>`;
}

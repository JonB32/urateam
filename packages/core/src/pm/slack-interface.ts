/**
 * PM Agent Slack Interface — bidirectional human-agent communication.
 *
 * Inbound:
 *   POST /slack/commands  — slash commands (/pm prioritize, /pm create, …)
 *   POST /slack/events    — Events API (natural language messages + URL verification)
 *
 * Outbound helpers (call from PM scheduler):
 *   notifyAssigned, notifySkipped, askForClarification, postDailySummary
 *
 * This file retains: types, request parsing, Slack signature verification, the
 * notifier class, and the Hono router factory.  Command execution logic was
 * extracted to `slack-commands.ts` (BEC-195) and bulk-create analysis to
 * `slack-bulk.ts` (BEC-195).  Both are re-exported here for backward
 * compatibility so existing import sites do not need to change.
 */

import { Hono } from "hono";
import { createLogger } from "../logger.js";
import { sanitize } from "../executor/prompt/sanitizer.js";
import { parseJsonObject } from "../executor/agent-stream.js";
import { makeCallClaude, makeCallClaudeSonnet } from "./call-claude.js";
import { postSlackMessage } from "./slack-helpers.js";
import { executePmCommand } from "./slack-commands.js";
import type { CommandExecutorDeps, PmCommand } from "./slack-commands.js";

const log = createLogger({ component: "PmAgent:slack-interface" });

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility
// ---------------------------------------------------------------------------
// Consumers that previously imported directly from slack-interface.ts continue
// to work without changing their import statements.

export { isPmPaused, setPmPaused } from "./pause-state.js";
export { type BulkIssueSpec, analyzeBulkCreateRequest } from "./slack-bulk.js";
export { type PmCommand, type CommandExecutorDeps, executePmCommand } from "./slack-commands.js";

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

/** Valid PM command type names — kept in sync with the PmCommand union type. */
const VALID_PM_COMMAND_TYPES = [
  "prioritize",
  "create",
  "bulk_create",
  "status",
  "pause",
  "resume",
  "assign",
  "unknown",
] as const;

/** Lazy singleton for the `crypto` built-in — avoids repeated dynamic import on every Slack request. */
let _cryptoModule: typeof import("crypto") | null = null;

async function getCrypto(): Promise<typeof import("crypto") | null> {
  if (!_cryptoModule) {
    try {
      _cryptoModule = await import("crypto");
    } catch {
      log.error("crypto module unavailable — cannot verify Slack signatures");
      return null;
    }
  }
  return _cryptoModule;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackInterfaceConfig {
  /** Slack signing secret for request verification */
  signingSecret: string;
  /** Slack bot OAuth token (xoxb-…) */
  botToken: string;
  /** Channel to send proactive PM notifications to */
  channelId: string;
  /** Linear API key (needed for create / prioritize / assign commands) */
  linearApiKey?: string;
  /** Team IDs for issue creation commands */
  teamIds?: string[];
  /** Optional injectable for testing */
  callClaude?: (prompt: string) => Promise<string>;
  /** Optional Sonnet-model callable for bulk create analysis (defaults to Sonnet if not provided) */
  callClaudeSonnet?: (prompt: string) => Promise<string>;
  /** BEC-135: optional handler for /release subcommands. */
  releaseHandler?: (params: { text: string; userId: string }) => Promise<{ text: string; responseType: "ephemeral" | "in_channel" }>;
}

export interface AssignedNotification {
  issueId: string;
  issueTitle: string;
  reasoning: string;
  issueUrl?: string;
}

export interface SkippedNotification {
  issueId: string;
  issueTitle: string;
  reasoning: string;
}

export interface DailySummaryEntry {
  issueId: string;
  issueTitle: string;
  status: "assigned" | "completed" | "blocked";
}

// ---------------------------------------------------------------------------
// Slack request verification
// ---------------------------------------------------------------------------

/**
 * Verifies the Slack signing secret against the X-Slack-Signature header.
 * Returns `true` if valid, `false` otherwise.
 *
 * See https://api.slack.com/authentication/verifying-requests-from-slack
 */
export async function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
): Promise<boolean> {
  // Reject requests older than 5 minutes
  const requestAge = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (requestAge > 300) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;

  const crypto = await getCrypto();
  if (!crypto) return false;

  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(baseString, "utf8")
    .digest("hex");

  const expected = `v0=${hmac}`;

  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// Command parser
// ---------------------------------------------------------------------------

/**
 * Parses the text following "/pm" into a structured `PmCommand`.
 *
 * Examples:
 *   "prioritize BEC-25"         → { type: "prioritize", issueId: "BEC-25" }
 *   'create "title" "desc"'     → { type: "create", title: "title", description: "desc" }
 *   "status"                    → { type: "status" }
 *   "pause"                     → { type: "pause" }
 *   "resume"                    → { type: "resume" }
 *   "assign BEC-13"             → { type: "assign", issueId: "BEC-13" }
 */
const ISSUE_ID_RE = /^[A-Z]+-\d+$/;

/**
 * Extracts and validates an issue ID from a command like "prioritize BEC-25".
 * Returns the uppercase issue ID string, or `null` if the format is invalid.
 */
function parseIssueIdCommand(trimmed: string, keyword: string): string | null {
  const re = new RegExp(`^${keyword}\\s+`, "i");
  const raw = trimmed.replace(re, "").trim().toUpperCase();
  return ISSUE_ID_RE.test(raw) ? raw : null;
}

export function parsePmCommand(text: string): PmCommand {
  const trimmed = text.trim();

  if (/^prioritize\s+/i.test(trimmed)) {
    const issueId = parseIssueIdCommand(trimmed, "prioritize");
    if (!issueId) return { type: "unknown", original: text };
    return { type: "prioritize", issueId };
  }

  if (/^assign\s+/i.test(trimmed)) {
    const issueId = parseIssueIdCommand(trimmed, "assign");
    if (!issueId) return { type: "unknown", original: text };
    return { type: "assign", issueId };
  }

  if (/^create\s+/i.test(trimmed)) {
    const rest = trimmed.replace(/^create\s+/i, "").trim();
    const matches = rest.match(/^"([^"]+)"\s+"([^"]+)"$/);
    if (matches) {
      return { type: "create", title: matches[1], description: matches[2] };
    }
    // Single-quoted titles, no description
    const singleMatch = rest.match(/^"([^"]+)"$/);
    if (singleMatch) {
      return { type: "create", title: singleMatch[1], description: "" };
    }
    return { type: "unknown", original: text };
  }

  if (/^status$/i.test(trimmed)) return { type: "status" };
  if (/^pause$/i.test(trimmed)) return { type: "pause" };
  if (/^resume$/i.test(trimmed)) return { type: "resume" };

  return { type: "unknown", original: text };
}

// ---------------------------------------------------------------------------
// Natural language intent parsing via Claude
// ---------------------------------------------------------------------------

/**
 * Interprets a free-text Slack message as a `PmCommand` using Claude.
 * Returns `{ type: "unknown", original }` if no actionable intent is found.
 */
export async function interpretNaturalLanguage(
  message: string,
  callClaude: (prompt: string) => Promise<string>,
): Promise<PmCommand> {
  const safe = sanitize(message);
  const prompt = `You are a PM Agent assistant. The following Slack message was sent to you:\n\n"${safe}"\n\nClassify it as exactly ONE of these JSON responses (no other text):\n{"type":"prioritize","issueId":"<id>"}\n{"type":"create","title":"<t>","description":"<d>"}\n{"type":"bulk_create","request":"<original request>"}\n{"type":"status"}\n{"type":"pause"}\n{"type":"resume"}\n{"type":"assign","issueId":"<id>"}\n{"type":"unknown","original":"${safe}"}\n\nRules:\n- Issue IDs look like BEC-25, ENG-42, etc.\n- "more urgent" / "higher priority" → prioritize\n- "add", "open a ticket", "create" → create (single issue with clear title)\n- "create issues for", "find gaps and create", "generate issues", "analyze and create multiple", "create tickets for all" → bulk_create (multiple issues from analysis)\n- "what's running", "show queue" → status\n- "stop", "pause" → pause\n- "start again", "unpause", "resume" → resume\n- "move to todo", "assign" → assign\n- Use bulk_create when the request implies analysis or generating multiple issues, not a single specific issue\n\nRespond ONLY with the JSON object.`;

  try {
    const raw = await callClaude(prompt);
    const parsed = parseJsonObject(raw) as PmCommand | null;
    if (!parsed) return { type: "unknown", original: message };
    // Validate type field against the canonical list of command types
    if (!(VALID_PM_COMMAND_TYPES as readonly string[]).includes(parsed.type)) {
      return { type: "unknown", original: message };
    }
    return parsed;
  } catch (err) {
    log.warn({ err, message }, "failed to parse NL intent");
    return { type: "unknown", original: message };
  }
}

// ---------------------------------------------------------------------------
// Outbound notifications (PM Agent → Slack)
// ---------------------------------------------------------------------------

export class SlackInterfaceNotifier {
  private botToken: string;
  private channelId: string;

  constructor(config: Pick<SlackInterfaceConfig, "botToken" | "channelId">) {
    this.botToken = config.botToken;
    this.channelId = config.channelId;
  }

  /** Called when PM Agent promotes an issue to Todo. */
  async notifyAssigned(n: AssignedNotification): Promise<void> {
    const urlPart = n.issueUrl ? `<${n.issueUrl}|${n.issueId}>` : `*${n.issueId}*`;
    const text =
      `🤖 *PM Agent assigned* ${urlPart}: ${n.issueTitle}\n` +
      `*Reasoning:* ${n.reasoning}`;
    await this.postMessage({ channel: this.channelId, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
  }

  /** Called when PM Agent skips/deprioritizes an issue. */
  async notifySkipped(n: SkippedNotification): Promise<void> {
    const text =
      `⏭ *PM Agent skipped* *${n.issueId}*: ${n.issueTitle}\n` +
      `*Reason:* ${n.reasoning}`;
    await this.postMessage({ channel: this.channelId, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
  }

  /** Ask a human for input when priority is ambiguous. */
  async askForClarification(question: string): Promise<void> {
    const text = `❓ *PM Agent needs your input:*\n${question}`;
    await this.postMessage({ channel: this.channelId, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
  }

  /** Post a daily summary of assigned, completed, and blocked issues. */
  async postDailySummary(entries: DailySummaryEntry[], date?: string): Promise<void> {
    const label = date ?? new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const lines: string[] = [`📊 *PM Agent Daily Summary — ${label}*`, ""];

    const assigned = entries.filter((e) => e.status === "assigned");
    const completed = entries.filter((e) => e.status === "completed");
    const blocked = entries.filter((e) => e.status === "blocked");

    if (assigned.length > 0) {
      lines.push(`*Assigned (${assigned.length}):*`);
      for (const e of assigned) lines.push(`  • *${e.issueId}* — ${e.issueTitle}`);
    }
    if (completed.length > 0) {
      lines.push(`*Completed (${completed.length}):*`);
      for (const e of completed) lines.push(`  • *${e.issueId}* — ${e.issueTitle}`);
    }
    if (blocked.length > 0) {
      lines.push(`*Blocked (${blocked.length}):*`);
      for (const e of blocked) lines.push(`  • *${e.issueId}* — ${e.issueTitle}`);
    }
    if (entries.length === 0) {
      lines.push("No activity today.");
    }

    await this.postMessage({
      channel: this.channelId,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }],
    });
  }

  private async postMessage(payload: object): Promise<void> {
    await postSlackMessage(this.botToken, payload);
  }
}

// ---------------------------------------------------------------------------
// Hono router factory
// ---------------------------------------------------------------------------

/**
 * Creates a Hono router that handles Slack slash commands and Events API
 * messages for the PM Agent.
 *
 * Mount it in your app:
 *   const { router } = createSlackInterface(config);
 *   app.route("/", router);
 *
 * The router registers:
 *   POST /slack/commands — Slack slash command handler
 *   POST /slack/events   — Slack Events API handler
 */
export function createSlackInterface(config: SlackInterfaceConfig): {
  router: Hono;
  notifier: SlackInterfaceNotifier;
} {
  const router = new Hono();
  const notifier = new SlackInterfaceNotifier(config);

  const callClaude = config.callClaude ?? makeCallClaude();
  const callClaudeSonnet = config.callClaudeSonnet ?? makeCallClaudeSonnet();
  const executorDeps: CommandExecutorDeps = {
    linearApiKey: config.linearApiKey,
    teamIds: config.teamIds,
    callClaudeSonnet,
  };

  // Helper: verify Slack signature and return 401 on failure
  async function checkSignature(c: any): Promise<string | null> {
    const rawBody = await c.req.text();
    const timestamp = c.req.header("X-Slack-Request-Timestamp") ?? "";
    const signature = c.req.header("X-Slack-Signature") ?? "";
    const valid = await verifySlackSignature(rawBody, timestamp, signature, config.signingSecret);
    if (!valid) return null;
    return rawBody;
  }

  // ------------------------------------------------------------------
  // POST /slack/commands
  // ------------------------------------------------------------------
  router.post("/slack/commands", async (c) => {
    const rawBody = await checkSignature(c);
    if (rawBody === null) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    // Parse URL-encoded form body
    const params = new URLSearchParams(rawBody);
    const slashCommand = params.get("command") ?? "";
    const commandText = (params.get("text") ?? "").trim();
    const responseUrl = params.get("response_url") ?? "";
    const userId = params.get("user_id") ?? "";

    log.info({ slashCommand, commandText }, "received Slack slash command");

    // Branch: /release vs /pm (the legacy default).
    if (slashCommand === "/release") {
      if (!config.releaseHandler) {
        return c.json({
          response_type: "ephemeral",
          text: ":x: Release Manager is not configured on this server.",
        });
      }
      const r = await config.releaseHandler({ text: commandText, userId });
      if (responseUrl) {
        postToResponseUrl(responseUrl, r.text, r.responseType).catch((err) =>
          log.error({ err }, "failed to post to Slack response_url"),
        );
      }
      return c.json({ response_type: r.responseType, text: r.text });
    }

    // Default: /pm path (preserves existing behavior).
    let cmd = parsePmCommand(commandText);

    // Fall back to NL interpretation if command is unknown
    if (cmd.type === "unknown" && commandText.length > 0) {
      cmd = await interpretNaturalLanguage(commandText, callClaude);
    }

    const replyText = await executePmCommand(cmd, executorDeps);

    // If a response_url is provided, post back asynchronously
    if (responseUrl) {
      postToResponseUrl(responseUrl, replyText).catch((err) =>
        log.error({ err }, "failed to post to Slack response_url"),
      );
    }

    // Immediate acknowledgement (required within 3s)
    return c.json({ response_type: "ephemeral", text: replyText });
  });

  // ------------------------------------------------------------------
  // POST /slack/events
  // ------------------------------------------------------------------
  router.post("/slack/events", async (c) => {
    // Slack sends url_verification during setup — must respond with challenge.
    // We peek at the body first; if it's a challenge, respond immediately.
    // For all other events, verify the signature.
    const rawBody = await c.req.text();

    let body: Record<string, any>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // URL verification challenge — respond before signature check
    // (Slack sends this once during Event Subscriptions setup)
    if (body.type === "url_verification") {
      return c.json({ challenge: body.challenge });
    }

    // Verify signature for all real events
    const timestamp = c.req.header("X-Slack-Request-Timestamp") ?? "";
    const signature = c.req.header("X-Slack-Signature") ?? "";
    const valid = await verifySlackSignature(rawBody, timestamp, signature, config.signingSecret);
    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    // Handle event callbacks
    if (body.type === "event_callback") {
      const event = body.event ?? {};

      // Only handle direct messages or mentions in the PM channel
      if (event.type === "app_mention" || event.type === "message") {
        // Skip bot messages to avoid loops
        if (event.bot_id || event.subtype === "bot_message") {
          return c.json({ ok: true });
        }

        const messageText: string = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
        if (!messageText) return c.json({ ok: true });

        log.info({ messageText }, "received Slack message event");

        // Process asynchronously — acknowledge immediately
        processMessageAsync(messageText, event.channel ?? config.channelId, config.botToken, callClaude, executorDeps)
          .catch((err) => log.error({ err }, "async message processing failed"));
      }
    }

    return c.json({ ok: true });
  });

  return { router, notifier };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function postToResponseUrl(
  responseUrl: string,
  text: string,
  responseType: "ephemeral" | "in_channel" = "ephemeral",
): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: responseType, text }),
  });
}

async function processMessageAsync(
  text: string,
  channel: string,
  botToken: string,
  callClaude: (prompt: string) => Promise<string>,
  deps: CommandExecutorDeps,
): Promise<void> {
  const cmd = await interpretNaturalLanguage(text, callClaude);
  const replyText = await executePmCommand(cmd, deps);
  await postSlackMessage(botToken, { channel, text: replyText });
}

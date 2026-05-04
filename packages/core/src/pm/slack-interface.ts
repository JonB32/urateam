/**
 * PM Agent Slack Interface — bidirectional human-agent communication.
 *
 * Inbound:
 *   POST /slack/commands  — slash commands (/pm prioritize, /pm create, …)
 *   POST /slack/events    — Events API (natural language messages + URL verification)
 *
 * Outbound helpers (call from PM scheduler):
 *   notifyAssigned, notifySkipped, askForClarification, postDailySummary
 */

import { Hono } from "hono";
import { createLogger } from "../logger.js";
import { sanitize } from "../executor/prompt/sanitizer.js";
import { parseJsonObject } from "../executor/agent-stream.js";
import { makeCallClaude, makeCallClaudeSonnet } from "./call-claude.js";
import { postSlackMessage } from "./slack-helpers.js";

const log = createLogger({ component: "PmAgent:slack-interface" });

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

/** Linear workflow state name for the Triage column. */
const LINEAR_STATE_TRIAGE = "Triage";
/** Linear workflow state name for the Todo column. */
const LINEAR_STATE_TODO = "Todo";
/** Linear label name that triggers the auto-implement pipeline. */
const LINEAR_LABEL_AUTO_IMPLEMENT = "auto-implement";

/** Valid numeric priority values accepted by Linear (1=Urgent … 4=Low). */
const VALID_PRIORITIES = [1, 2, 3, 4] as const;
/** Default priority used when a generated issue omits or has an invalid value. */
const DEFAULT_PRIORITY = 3;

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

export type PmCommand =
  | { type: "prioritize"; issueId: string }
  | { type: "create"; title: string; description: string }
  | { type: "bulk_create"; request: string }
  | { type: "status" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "assign"; issueId: string }
  | { type: "unknown"; original: string };

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
// Shared pause state — single-process only; use Redis for multi-process
// ---------------------------------------------------------------------------

let paused = false;

export function isPmPaused(): boolean {
  return paused;
}

export function setPmPaused(value: boolean): void {
  paused = value;
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
// Command executor
// ---------------------------------------------------------------------------

export interface BulkIssueSpec {
  title: string;
  description: string;
  priority: number;
  acceptanceCriteria: string[];
}

/**
 * Subset of Linear's IssueCreateInput used by this module.
 * Typed explicitly to avoid `any` and catch field-name typos at compile time.
 */
interface LinearIssueCreateInput {
  teamId: string;
  title: string;
  description?: string;
  priority?: number;
  stateId?: string;
  labelIds?: string[];
}

export interface CommandExecutorDeps {
  linearApiKey?: string;
  teamIds?: string[];
  callClaudeSonnet?: (prompt: string) => Promise<string>;
}

/**
 * Executes a parsed `PmCommand` against Linear and returns a human-readable
 * response string suitable for posting back to Slack.
 */
export async function executePmCommand(
  cmd: PmCommand,
  deps: CommandExecutorDeps,
): Promise<string> {
  let _linear: any = null;
  async function getLinear() {
    if (!_linear && deps.linearApiKey) {
      const { LinearClient } = await import("@linear/sdk");
      _linear = new LinearClient({ apiKey: deps.linearApiKey });
    }
    return _linear;
  }

  /**
   * Searches Linear for an issue by its identifier (e.g. "BEC-25") and returns
   * the first match, or `null` when not found. Shared by prioritize + assign.
   */
  async function findIssueByIdentifier(linear: any, issueId: string): Promise<any | null> {
    const results = await linear.searchIssues(issueId);
    return results.nodes?.[0] ?? null;
  }

  switch (cmd.type) {
    case "status": {
      const state = paused ? "⏸ *Paused*" : "▶️ *Running*";
      return `PM Agent is ${state}.\nUse \`/pm pause\` or \`/pm resume\` to control autonomous assignment.`;
    }

    case "pause": {
      setPmPaused(true);
      log.info("PM Agent paused via Slack");
      return "⏸ PM Agent autonomous assignment has been *paused*. Use `/pm resume` to restart.";
    }

    case "resume": {
      setPmPaused(false);
      log.info("PM Agent resumed via Slack");
      return "▶️ PM Agent autonomous assignment has been *resumed*.";
    }

    case "prioritize": {
      if (!deps.linearApiKey) {
        return `⚠️ No Linear API key configured — cannot prioritize *${cmd.issueId}*.`;
      }
      try {
        const linear = await getLinear();
        if (!linear) return `⚠️ No Linear API key configured — cannot prioritize *${cmd.issueId}*.`;
        const issue = await findIssueByIdentifier(linear, cmd.issueId);
        if (!issue) return `⚠️ Issue *${cmd.issueId}* not found in Linear.`;
        // updateIssue and createComment are independent — run in parallel
        await Promise.all([
          linear.updateIssue(issue.id, { priority: 1 }),
          linear.createComment({
            issueId: issue.id,
            body: "🤖 **PM Agent** — Bumped to top of queue via Slack command.",
          }),
        ]);
        log.info({ issueId: cmd.issueId }, "prioritized via Slack");
        return `✅ *${cmd.issueId}* has been bumped to top priority (Urgent).`;
      } catch (err) {
        log.error({ err, issueId: cmd.issueId }, "prioritize failed");
        return `❌ Failed to prioritize *${cmd.issueId}*: ${(err as Error).message}`;
      }
    }

    case "assign": {
      if (!deps.linearApiKey) {
        return `⚠️ No Linear API key configured — cannot assign *${cmd.issueId}*.`;
      }
      try {
        const linear = await getLinear();
        if (!linear) return `⚠️ No Linear API key configured — cannot assign *${cmd.issueId}*.`;
        const issue = await findIssueByIdentifier(linear, cmd.issueId);
        if (!issue) return `⚠️ Issue *${cmd.issueId}* not found in Linear.`;

        const team = await issue.team;
        const allStates = await linear.workflowStates({
          filter: { team: { id: { eq: team?.id } } },
          first: 50,
        });
        const todoState = allStates.nodes?.find((s: any) => s.name === LINEAR_STATE_TODO);
        if (!todoState) return `⚠️ No "${LINEAR_STATE_TODO}" state found for *${cmd.issueId}*'s team.`;

        await linear.updateIssue(issue.id, { stateId: todoState.id });
        await linear.createComment({
          issueId: issue.id,
          body: "🤖 **PM Agent** — Manually assigned to Todo via Slack command.",
        });
        log.info({ issueId: cmd.issueId }, "manually assigned to Todo via Slack");
        return `✅ *${cmd.issueId}* has been moved to Todo.`;
      } catch (err) {
        log.error({ err, issueId: cmd.issueId }, "assign failed");
        return `❌ Failed to assign *${cmd.issueId}*: ${(err as Error).message}`;
      }
    }

    case "create": {
      if (!deps.linearApiKey) {
        return `⚠️ No Linear API key configured — cannot create issue.`;
      }
      if (!deps.teamIds || deps.teamIds.length === 0) {
        return `⚠️ No team IDs configured — cannot create issue.`;
      }
      try {
        const linear = await getLinear();
        if (!linear) return `⚠️ No Linear API key configured — cannot create issue.`;
        const created = await linear.createIssue({
          teamId: deps.teamIds[0],
          title: cmd.title,
          description: cmd.description || undefined,
        });
        const issue = await created.issue;
        const url = issue?.url ?? "";
        log.info({ title: cmd.title, issueId: issue?.identifier }, "issue created via Slack");
        return `✅ Created <${url}|${issue?.identifier ?? "new issue"}>: *${cmd.title}*`;
      } catch (err) {
        log.error({ err, title: cmd.title }, "create issue failed");
        return `❌ Failed to create issue: ${(err as Error).message}`;
      }
    }

    case "bulk_create": {
      if (!deps.linearApiKey) {
        return `⚠️ No Linear API key configured — cannot create issues.`;
      }
      if (!deps.teamIds || deps.teamIds.length === 0) {
        return `⚠️ No team IDs configured — cannot create issues.`;
      }
      if (!deps.callClaudeSonnet) {
        return `⚠️ Bulk create requires a Sonnet model caller — not configured.`;
      }
      try {
        const specs = await analyzeBulkCreateRequest(cmd.request, deps.callClaudeSonnet);
        if (specs.length === 0) {
          return `🤔 Could not generate any issues from your request. Try being more specific.`;
        }

        const linear = await getLinear();
        if (!linear) return `⚠️ No Linear API key configured — cannot create issues.`;

        // Resolve the Triage state and auto-implement label IDs
        const teamId = deps.teamIds[0];
        const [allStatesRes, allLabelsRes] = await Promise.all([
          linear.workflowStates({ filter: { team: { id: { eq: teamId } } }, first: 50 }),
          linear.issueLabels({ first: 100 }),
        ]);
        const triageState = allStatesRes.nodes?.find((s: any) => s.name === LINEAR_STATE_TRIAGE);
        const labelMap = new Map<string, string>();
        for (const label of allLabelsRes.nodes ?? []) {
          labelMap.set(label.name.toLowerCase(), label.id);
        }
        const autoImplementLabelId = labelMap.get(LINEAR_LABEL_AUTO_IMPLEMENT);

        // Build all payloads first, then create all issues in parallel
        const payloads: LinearIssueCreateInput[] = specs.map((spec) => {
          const descWithCriteria =
            spec.acceptanceCriteria.length > 0
              ? `${spec.description}\n\n**Acceptance Criteria:**\n${spec.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}`
              : spec.description;

          const payload: LinearIssueCreateInput = {
            teamId,
            title: spec.title,
            description: descWithCriteria || undefined,
            priority: spec.priority,
          };
          if (triageState) payload.stateId = triageState.id;
          if (autoImplementLabelId) payload.labelIds = [autoImplementLabelId];
          return payload;
        });

        const results = await Promise.all(payloads.map((p) => linear.createIssue(p)));
        const issueObjects = await Promise.all(results.map((r: any) => r.issue));

        const created: Array<{ identifier: string; url: string; title: string }> = [];
        for (let i = 0; i < issueObjects.length; i++) {
          const issue = issueObjects[i];
          if (issue) {
            const title = specs[i].title;
            created.push({ identifier: issue.identifier ?? "", url: issue.url ?? "", title });
            log.info({ issueId: issue.identifier, title }, "bulk issue created via Slack");
          }
        }

        if (created.length === 0) {
          return `❌ Failed to create any issues.`;
        }

        const lines = [`✅ Created ${created.length} issue${created.length === 1 ? "" : "s"}:`];
        for (const issue of created) {
          const link = issue.url ? `<${issue.url}|${issue.identifier}>` : `*${issue.identifier}*`;
          lines.push(`• ${link}: *${issue.title}*`);
        }
        return lines.join("\n");
      } catch (err) {
        log.error({ err, request: cmd.request }, "bulk create failed");
        return `❌ Failed to create issues: ${(err as Error).message}`;
      }
    }

    case "unknown":
      return `🤔 I didn't understand that. Try:\n• \`/pm status\`\n• \`/pm prioritize BEC-25\`\n• \`/pm create "title" "description"\`\n• \`/pm assign BEC-13\`\n• \`/pm pause\` / \`/pm resume\``;

    default:
      return `Unknown command.`;
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

/**
 * Uses a capable Claude model (Sonnet) to analyze a bulk create request and
 * produce a structured list of issue specifications.
 */
export async function analyzeBulkCreateRequest(
  request: string,
  callClaudeSonnet: (prompt: string) => Promise<string>,
): Promise<BulkIssueSpec[]> {
  const safe = sanitize(request);
  const prompt =
    `You are a software PM Agent. A user asked: "${safe}"\n\n` +
    `Analyze this request and generate a list of concrete, actionable software issues to create.\n` +
    `Each issue must have a clear title, description, priority (1=urgent, 2=high, 3=medium, 4=low), and acceptance criteria.\n\n` +
    `Respond ONLY with a JSON array (no other text), e.g.:\n` +
    `[\n` +
    `  {\n` +
    `    "title": "Issue title",\n` +
    `    "description": "Clear description of what needs to be done",\n` +
    `    "priority": 2,\n` +
    `    "acceptanceCriteria": ["Criterion 1", "Criterion 2"]\n` +
    `  }\n` +
    `]\n\n` +
    `Rules:\n` +
    `- Generate between 1 and 10 issues\n` +
    `- Each issue must be specific and actionable\n` +
    `- Priority must be 1, 2, 3, or 4\n` +
    `- acceptanceCriteria must be a non-empty array of strings\n` +
    `- Respond ONLY with the JSON array, no markdown fences or explanation`;

  try {
    const raw = await callClaudeSonnet(prompt);
    // Parse the array — look for a JSON array in the response
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      log.warn({ responsePreview: raw.slice(0, 200) }, "bulk create: no JSON array in Claude response");
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(arrayMatch[0]);
    } catch {
      log.warn({ responsePreview: raw.slice(0, 200) }, "bulk create: failed to parse JSON array");
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const specs: BulkIssueSpec[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const description = typeof item.description === "string" ? item.description.trim() : "";
      const priority =
        typeof item.priority === "number" && (VALID_PRIORITIES as readonly number[]).includes(item.priority)
          ? item.priority
          : DEFAULT_PRIORITY;
      const acceptanceCriteria = Array.isArray(item.acceptanceCriteria)
        ? item.acceptanceCriteria.filter((c: unknown) => typeof c === "string" && c.trim().length > 0)
        : [];
      if (!title) continue;
      // Cap title/description length to prevent excessively large issues
      specs.push({
        title: title.slice(0, 200),
        description: description.slice(0, 5000),
        priority,
        acceptanceCriteria: acceptanceCriteria.slice(0, 10),
      });
    }

    return specs.slice(0, 10);
  } catch (err) {
    log.warn({ err }, "bulk create: failed to analyze request");
    return [];
  }
}

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


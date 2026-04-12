import { Writable } from "node:stream";

/** Escape characters that are active in Slack mrkdwn to prevent injection. */
function escapeSlackMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes

export interface AlertEntry {
  level?: number;
  component?: string;
  issueId?: string;
  runId?: string;
  stage?: string;
  msg?: string;
  err?: { message?: string; stack?: string } | string;
  [key: string]: unknown;
}

/**
 * Manages rate-limited Slack error alerts.
 *
 * Watches pino log entries (level >= 50) and routes pipeline, PM Agent,
 * auth, and git errors to a configured Slack channel via chat.postMessage.
 *
 * Duplicate errors (same component + message) are suppressed for 5 minutes
 * to prevent alert fatigue.
 */
export class SlackAlertManager {
  private readonly rateLimitMap = new Map<string, number>();

  constructor(
    private readonly botToken: string,
    private readonly channelId: string,
  ) {}

  /**
   * Process a single pino log entry. If the entry is at error level (>= 50)
   * and passes the rate limiter, sends a Slack Block Kit alert.
   * Fire-and-forget — never throws.
   */
  handleEntry(entry: AlertEntry): void {
    if (typeof entry.level !== "number" || entry.level < 50) return;

    const component = entry.component;
    const errObj = entry.err;
    const errMessage =
      errObj && typeof errObj === "object" && "message" in errObj
        ? (errObj as { message?: string }).message
        : typeof errObj === "string"
          ? errObj
          : undefined;
    const message = errMessage ?? entry.msg ?? "unknown error";

    // Build dedup key: component + first 100 chars of error message
    const dedupKey = `${component ?? "unknown"}:${message.slice(0, 100)}`;
    if (this.isRateLimited(dedupKey)) return;
    this.markRateLimit(dedupKey);

    const blocks = this.buildBlocks(entry, message);

    // Fire-and-forget. Errors are written to stderr directly (not pino)
    // to avoid a feedback loop through the alert stream.
    this.send(blocks).catch((e) => {
      process.stderr.write(`[SlackAlerts] Failed to send alert: ${e}\n`);
    });
  }

  // --- Private helpers ---

  private isRateLimited(key: string): boolean {
    const last = this.rateLimitMap.get(key);
    if (last === undefined) return false;
    if (Date.now() - last >= RATE_LIMIT_MS) {
      this.rateLimitMap.delete(key);
      return false;
    }
    return true;
  }

  private markRateLimit(key: string): void {
    this.rateLimitMap.set(key, Date.now());
  }

  private buildBlocks(entry: AlertEntry, errorMessage: string): object[] {
    const { component, issueId, runId, stage } = entry;
    const lowerMsg = errorMessage.toLowerCase();

    const isAuthError =
      lowerMsg.includes("401") ||
      lowerMsg.includes("unauthorized") ||
      lowerMsg.includes("authentication") ||
      lowerMsg.includes("api key");

    const isPmAgent =
      typeof component === "string" && component.startsWith("PmAgent");

    const isGitError =
      component === "git" ||
      lowerMsg.includes("git") ||
      lowerMsg.includes("clone failed") ||
      lowerMsg.includes("push failed");

    const title = isAuthError
      ? "🔑 Auth Error — Action Required"
      : isPmAgent
        ? "🤖 PM Agent Error"
        : isGitError
          ? "🔧 Git Operation Failed"
          : "🚨 Pipeline Error";

    const blocks: object[] = [
      {
        type: "header",
        text: { type: "plain_text", text: title },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Error:* ${escapeSlackMrkdwn(errorMessage)}`,
        },
      },
    ];

    if (isAuthError) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Remediation:* Check that `ANTHROPIC_API_KEY` and `LINEAR_API_KEY` are valid and not expired.",
        },
      });
    }

    const contextParts: string[] = [];
    if (issueId) contextParts.push(`Issue: \`${escapeSlackMrkdwn(issueId)}\``);
    if (runId && typeof runId === "string")
      contextParts.push(`Run: \`${escapeSlackMrkdwn(runId.slice(0, 8))}\``);
    if (stage) contextParts.push(`Stage: \`${escapeSlackMrkdwn(stage)}\``);
    if (component) contextParts.push(`Component: \`${escapeSlackMrkdwn(component)}\``);
    contextParts.push(`Time: ${new Date().toISOString()}`);

    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: contextParts.join(" | ") }],
    });

    return blocks;
  }

  private async send(blocks: object[]): Promise<void> {
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.botToken}`,
      },
      body: JSON.stringify({ channel: this.channelId, blocks }),
    });
    const data = (await resp.json()) as { ok?: boolean; error?: string };
    if (!data?.ok) {
      process.stderr.write(`[SlackAlerts] postMessage returned ok:false: ${data?.error}\n`);
    }
  }
}

/**
 * A Node.js Writable stream that parses pino JSON log lines and forwards
 * error-level entries to a SlackAlertManager. Intended to be used with
 * addLogStream() from logger.ts.
 */
export class SlackAlertStream extends Writable {
  constructor(private readonly manager: SlackAlertManager) {
    super();
  }

  _write(chunk: Buffer, _enc: BufferEncoding, callback: () => void): void {
    try {
      const line = chunk.toString().trim();
      if (line) {
        const entry = JSON.parse(line) as AlertEntry;
        this.manager.handleEntry(entry);
      }
    } catch {
      // Ignore malformed log lines
    }
    callback();
  }
}

// --- Module-level singleton ---

let _manager: SlackAlertManager | null = null;

/**
 * Initialise the global SlackAlertManager singleton.
 * Call this once at startup when SLACK_ERROR_ALERTS=true.
 */
export function initSlackAlertManager(
  botToken: string,
  channelId: string,
): SlackAlertManager {
  _manager = new SlackAlertManager(botToken, channelId);
  return _manager;
}

/** Returns the active singleton, or null if not initialised. */
export function getSlackAlertManager(): SlackAlertManager | null {
  return _manager;
}

/**
 * Create a pino-compatible Writable stream for the given manager.
 * Wire this up with addLogStream() from logger.ts.
 */
export function createSlackAlertStream(
  manager: SlackAlertManager,
): SlackAlertStream {
  return new SlackAlertStream(manager);
}

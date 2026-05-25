/**
 * AuthMonitor — periodic Claude session health-check (BEC-207 / BEC-237).
 *
 * Covers three auth paths:
 *
 *  - ANTHROPIC_API_KEY only (no CLAUDE_CODE_OAUTH_TOKEN) → skip. Static key
 *    never expires on its own; probing would add noise with no benefit.
 *  - CLAUDE_CODE_OAUTH_TOKEN set → probe with `claude -p "ok"` (real API call).
 *    OAuth tokens CAN expire or be revoked. On failure: Slack alert + audit event
 *    with authMethod "oauth-token" so operators know to run `claude setup-token`.
 *  - Neither env var (mounted session) → probe with `claude -p "ok"` (real API call).
 *    Interactive sessions expire weekly. On failure: Slack alert + audit event
 *    with authMethod "mounted-session" so operators know to run `claude login`.
 *
 * The monitor is registered as a step inside the PM scheduler tick so it runs
 * on the same cadence as the PM agent's own health checks.
 */
import { createLogger } from "../logger.js";
import { postSlackMessage } from "../pm/slack-helpers.js";
import { claudeAuthExpiredEvent } from "../audit/events.js";
import { getAuthExpiredMessages } from "../audit/auth-error-messages.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { resetAuthCheckCache, probeClaudeAuth } from "./auth-check.js";
import type { AnyDb } from "../db/client.js";

const log = createLogger({ component: "AuthMonitor" });

/** Default check interval: 6 hours */
export const AUTH_MONITOR_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Timeout for the AuthMonitor probe. Longer than the preflight timeout — the monitor runs off the critical path. */
const PROBE_TIMEOUT_MONITOR_MS = 15_000;

export interface AuthMonitorOptions {
  /** Slack bot token for posting alerts. Optional — skips Slack if absent. */
  slackBotToken?: string;
  /**
   * Slack channel ID for auth expiry alerts.
   * Typically PM_AGENT_SLACK_CHANNEL_ID when SLACK_ERROR_ALERTS=true.
   */
  slackErrorChannel?: string;
  /** Database for writing claude.auth_expired audit events. Optional. */
  db?: AnyDb;
}

/**
 * Run the periodic Claude auth health-check.
 *
 * Call this from the PM scheduler tick with a 6-hour throttle. The function
 * is idempotent and safe to call more frequently — it will no-op until the
 * interval has elapsed.
 *
 * @param lastCheckTime - Unix-ms timestamp of the last successful check run.
 *   Pass 0 on first call. The caller stores and passes back the returned value.
 * @returns Updated lastCheckTime (pass back on next call).
 */
export async function runAuthMonitorCheck(
  lastCheckTime: number,
  opts: AuthMonitorOptions,
  intervalMs = AUTH_MONITOR_INTERVAL_MS,
): Promise<number> {
  const now = Date.now();
  if (now - lastCheckTime < intervalMs) {
    return lastCheckTime; // Not time to check yet
  }

  // Skip ONLY when ANTHROPIC_API_KEY is the sole auth mechanism. That key
  // never expires on its own — probing it adds noise with no benefit.
  // CLAUDE_CODE_OAUTH_TOKEN is different: it is an OAuth token that CAN expire
  // or be revoked, so we always probe when it is set (BEC-237).
  if (process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    log.debug("AuthMonitor: ANTHROPIC_API_KEY static key detected, skipping session check");
    return now;
  }

  const authMethod: "oauth-token" | "mounted-session" = process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? "oauth-token"
    : "mounted-session";

  log.info({ authMethod }, "AuthMonitor: checking Claude auth validity");

  // Force a fresh probe (bypass the 5-min cache in isClaudeAuthValid)
  resetAuthCheckCache();

  // Real API call — `claude auth status` only checks local credential presence,
  // not whether the credential is accepted by the Anthropic API (BEC-244).
  // Network errors / timeouts resolve { valid: true } (fail-open).
  const result = await probeClaudeAuth(PROBE_TIMEOUT_MONITOR_MS);

  if (result.valid) {
    log.debug({ authMethod }, "AuthMonitor: auth is valid");
    return now;
  }

  // Auth invalid — alert and record.
  const { hint, slackText } = getAuthExpiredMessages(authMethod);
  const logPrefix =
    authMethod === "oauth-token"
      ? "AuthMonitor: CLAUDE_CODE_OAUTH_TOKEN has expired or been revoked. "
      : "AuthMonitor: mounted Claude session expired. ";
  log.error(logPrefix + hint);

  // Slack alert — text branches on auth method so operators get actionable instructions.
  if (opts.slackBotToken && opts.slackErrorChannel) {
    const text = slackText;
    try {
      await postSlackMessage(opts.slackBotToken, {
        channel: opts.slackErrorChannel,
        text,
      });
    } catch (err) {
      log.warn({ err }, "AuthMonitor: failed to post Slack alert");
    }
  }

  // Audit event.
  //
  // We use `logAuditEventUnchecked` (which bypasses the `audit-log` Enterprise
  // feature gate) deliberately: a Claude auth expiry is an operational signal
  // that any operator needs to see regardless of license tier. The alternative
  // — `logAuditEvent` — would silently drop the event in OSS and Pro deployments
  // where `audit-log` isn't licensed, leaving the operator wondering why their
  // pipeline runs started failing en masse with no visible event in the audit
  // dashboard. CLAUDE.md's list of bypass call sites should include this one
  // alongside `license.ts` and the Pro-tier PM/RM modules.
  if (opts.db) {
    void logAuditEventUnchecked(
      opts.db,
      claudeAuthExpiredEvent({ detectedAt: new Date(), authMethod }),
    );
  }

  return now;
}

/**
 * Stateful AuthMonitor factory.
 * Creates a closure that tracks `lastCheckTime` across repeated calls,
 * so callers don't need to manage the timestamp themselves.
 */
export function createAuthMonitor(opts: AuthMonitorOptions, intervalMs = AUTH_MONITOR_INTERVAL_MS) {
  let lastCheckTime = 0;

  return {
    /**
     * Run the auth check if the interval has elapsed.
     * Fire-and-forget safe — errors are logged but never thrown.
     */
    async tick(): Promise<void> {
      try {
        lastCheckTime = await runAuthMonitorCheck(lastCheckTime, opts, intervalMs);
      } catch (err) {
        log.warn({ err }, "AuthMonitor tick failed");
      }
    },
  };
}

export type AuthMonitor = ReturnType<typeof createAuthMonitor>;

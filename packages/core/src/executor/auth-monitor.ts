/**
 * AuthMonitor — periodic Claude session health-check (BEC-207).
 *
 * Defence-in-depth for operators still using the mounted-session auth path
 * (`claude login` / ~/.config/claude/). The monitor runs every 6 hours:
 *
 *  - When CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is set → returns
 *    immediately (long-lived token paths have no session-lifetime semantics).
 *  - Otherwise → runs `claude auth status`. On failure: fires a Slack alert
 *    to the configured error channel and writes a `claude.auth_expired` audit
 *    event so operators can correlate expiry with pipeline failures.
 *
 * The monitor is registered as a step inside the PM scheduler tick so it runs
 * on the same cadence as the PM agent's own health checks.
 */
import { execFile } from "node:child_process";
import { createLogger } from "../logger.js";
import { postSlackMessage } from "../pm/slack-helpers.js";
import { claudeAuthExpiredEvent } from "../audit/events.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { resetAuthCheckCache } from "./auth-check.js";
import type { AnyDb } from "../db/client.js";

const log = createLogger({ component: "AuthMonitor" });

/** Default check interval: 6 hours */
export const AUTH_MONITOR_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

  // BEC-207: env-var paths have no session-lifetime semantics — skip.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
    log.debug("AuthMonitor: env-var auth path detected, skipping session check");
    return now;
  }

  log.info("AuthMonitor: checking mounted Claude session validity");

  // Force a fresh subprocess call (bypass the 5-min cache in isClaudeAuthValid)
  resetAuthCheckCache();

  const valid = await new Promise<boolean>((resolve) => {
    execFile("claude", ["auth", "status"], { timeout: 15_000 }, (err) => {
      resolve(!err);
    });
  });

  if (valid) {
    log.debug("AuthMonitor: mounted session is valid");
    return now;
  }

  // Session invalid — alert and record.
  log.error(
    "AuthMonitor: mounted Claude session expired. " +
    "Run `claude login` in the container, or switch to CLAUDE_CODE_OAUTH_TOKEN (see deploy/CLAUDE_AUTH.md).",
  );

  // Slack alert
  if (opts.slackBotToken && opts.slackErrorChannel) {
    try {
      await postSlackMessage(opts.slackBotToken, {
        channel: opts.slackErrorChannel,
        text:
          "⚠ *Claude session auth expired* — new pipeline runs will fail immediately.\n" +
          "Fix: `docker compose exec <service> claude login`\n" +
          "Or switch to `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token` once). " +
          "See `deploy/CLAUDE_AUTH.md` for details.",
      });
    } catch (err) {
      log.warn({ err }, "AuthMonitor: failed to post Slack alert");
    }
  }

  // Audit event.
  //
  // We use `logAuditEventUnchecked` (which bypasses the `audit-log` Enterprise
  // feature gate) deliberately: a Claude-session expiry is an operational
  // signal that any operator needs to see regardless of license tier. The
  // alternative — `logAuditEvent` — would silently drop the event in OSS and
  // Pro deployments where `audit-log` isn't licensed, leaving the operator
  // wondering why their pipeline runs started failing en masse with no
  // visible event in the audit dashboard. CLAUDE.md's list of bypass call
  // sites should include this one alongside `license.ts` and the Pro-tier
  // PM/RM modules.
  if (opts.db) {
    void logAuditEventUnchecked(opts.db, claudeAuthExpiredEvent({ detectedAt: new Date() }));
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

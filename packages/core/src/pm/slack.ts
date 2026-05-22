import type { TickResult, ApprovalAction } from "./types.js";
import type { StuckIssueResult } from "./actions/recover-stuck.js";
import { postSlackMessage } from "./slack-helpers.js";
import { createLogger } from "../logger.js";
import { truncateWithEllipsis } from "../util/strings.js";

const log = createLogger({ component: "PmAgent:slack" });

const CIRCUIT_BROKEN_ISSUES_CAP = 10;

// Slack `section` blocks cap `text.text` at 3000 chars; we leave headroom.
// Exported for testing.
export const SLACK_SECTION_TEXT_MAX = 2900;

/**
 * Pack `lines` into one or more Slack `section` blocks whose `text.text`
 * stays under `maxChars`. Greedy: fills each block until adding the next
 * line would overflow, then opens a new block.
 *
 * Single lines longer than `maxChars` are passed through as-is — callers
 * are expected to have already truncated values to reasonable widths (the
 * PM digest uses `truncateWithEllipsis` on titles + error messages, so an
 * individual line stays well under the cap).
 */
export function chunkLinesToSlackSectionBlocks(
  lines: string[],
  maxChars: number = SLACK_SECTION_TEXT_MAX,
): Array<{ type: "section"; text: { type: "mrkdwn"; text: string } }> {
  const blocks: Array<{ type: "section"; text: { type: "mrkdwn"; text: string } }> = [];
  let buf: string[] = [];
  let bufLen = 0;
  for (const line of lines) {
    const needed = (buf.length === 0 ? 0 : 1) + line.length; // +1 for joining "\n"
    if (bufLen + needed > maxChars && buf.length > 0) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: buf.join("\n") } });
      buf = [];
      bufLen = 0;
    }
    buf.push(line);
    bufLen += (bufLen === 0 ? 0 : 1) + line.length;
  }
  if (buf.length > 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: buf.join("\n") } });
  }
  return blocks;
}

export interface PmSlackConfig {
  botToken: string;
  channelId: string;
}

export class PmSlackNotifier {
  private botToken: string;
  private channelId: string;
  // Dedup flag: after the first missing_scope warn fires, subsequent per-tick
  // calls stay silent. The startup probe (probeReactionsScope) handles the
  // one-time error-level log; this flag prevents the 7×/tick warn flood.
  private _missingScopeLogged = false;

  constructor(config: PmSlackConfig) {
    this.botToken = config.botToken;
    this.channelId = config.channelId;
  }

  /**
   * One-time startup probe: call reactions.get with a bogus timestamp.
   * Slack validates OAuth scopes before parameter values, so a missing_scope
   * error means reactions:read is absent regardless of whether the message
   * exists. Any other error (message_not_found, channel_not_found) means the
   * scope is present. Logs a single error-level line if the scope is missing
   * so operators see it at boot rather than buried in per-tick warn bursts.
   */
  async probeReactionsScope(): Promise<void> {
    try {
      const data = await this._callSlackApi("reactions.get", {
        channel: this.channelId,
        timestamp: "0.000000",
      });
      if (!data?.ok && data?.error === "missing_scope") {
        log.error(
          { error: "missing_scope" },
          "Slack bot token is missing the reactions:read scope — approval-via-reaction will not work. " +
          "Fix: add reactions:read to your Slack app's Bot Token Scopes and reinstall the app to the workspace.",
        );
      }
    } catch (err) {
      log.warn({ err }, "Slack startup scope probe failed (could not verify reactions:read)");
    }
  }

  async postDigest(tick: TickResult, maxInFlight: number, minConsecutiveFailures: number = 3): Promise<void> {
    const hasActions =
      tick.paused ||
      tick.triaged.length > 0 ||
      tick.promoted.length > 0 ||
      tick.approvalsResolved > 0 ||
      tick.deprioritizeRequested.length > 0 ||
      tick.cancelRequested.length > 0 ||
      (tick.recoveredStuckIssues?.length ?? 0) > 0 ||
      (tick.circuitBrokenIssues?.length ?? 0) > 0 ||
      tick.errors.length > 0;

    if (!hasActions) return;

    const bg = tick.budgetGuard;
    const lines: string[] = [];
    lines.push(`*PM Agent Run* — ${new Date().toUTCString()}`);
    lines.push(`In-flight: ${bg.activeCount}/${maxInFlight} | Token budget: ${bg.tokenSpendPercent}% used`);
    const warnScopes = (tick.budgetScopes ?? []).filter((s) => s.tier !== "ok" && s.scope.kind !== "global");
    if (warnScopes.length > 0) {
      const maxDisplay = 10;
      const display = warnScopes.slice(0, maxDisplay);
      const scopeLines = display.map((s) => {
        const icon = s.tier === "blocked-100" ? "🔴" : s.tier === "warn-80" ? "🟠" : "🟡";
        return `${icon} ${s.scopeLabel}: ${s.percent}% (${s.used.toLocaleString()}/${s.limit.toLocaleString()})`;
      });
      const suffix = warnScopes.length > maxDisplay ? ` +${warnScopes.length - maxDisplay} more` : "";
      lines.push(`*Budget by scope:* ${scopeLines.join(" | ")}${suffix}`);
    }
    if (tick.paused) {
      lines.push("⏸ *Paused* — skipping promote/deprioritize/cancel");
    }
    lines.push("");

    if (tick.triaged.length > 0) {
      const ids = tick.triaged.map((t) => t.issueId).join(", ");
      lines.push(`*Triaged:* ${tick.triaged.length} issues (${ids})`);
    }
    if (tick.promoted.length > 0) {
      const promoted = tick.promoted.filter((p) => p.promoted);
      const skipped = tick.promoted.filter((p) => !p.promoted);
      if (promoted.length > 0) {
        lines.push(`*Promoted:* ${promoted.map((p) => p.issueId).join(", ")}`);
      }
      if (skipped.length > 0) {
        const details = skipped.map((s) => `${s.issueId} (${s.reason})`).join(", ");
        lines.push(`*Skipped:* ${details}`);
      }
    }
    if (tick.approvalsResolved > 0) {
      lines.push(`*Approvals resolved:* ${tick.approvalsResolved}`);
    }
    if (tick.approvalsPending > 0) {
      lines.push(`*Pending approval:* ${tick.approvalsPending}`);
    }
    if (tick.deprioritizeRequested.length > 0) {
      lines.push(`*Deprioritize requested:* ${tick.deprioritizeRequested.join(", ")}`);
    }
    if (tick.cancelRequested.length > 0) {
      lines.push(`*Cancel requested:* ${tick.cancelRequested.join(", ")}`);
    }
    if (tick.recoveredStuckIssues && tick.recoveredStuckIssues.length > 0) {
      lines.push(`*Auto-recovered stuck issues:* ${tick.recoveredStuckIssues.join(", ")}`);
    }
    if (tick.circuitBrokenIssues && tick.circuitBrokenIssues.length > 0) {
      const cap = CIRCUIT_BROKEN_ISSUES_CAP;
      const display = tick.circuitBrokenIssues.slice(0, cap);
      const overflow = tick.circuitBrokenIssues.length - display.length;
      lines.push("");
      lines.push(`*Circuit-Broken Issues* (≥${minConsecutiveFailures} consecutive failures in last 7 days):`);
      for (const issue of display) {
        const idLabel = issue.url ? `<${issue.url}|${issue.issueId}>` : issue.issueId;
        const title = truncateWithEllipsis(issue.issueTitle, 80);
        const errPart = issue.errorMessage
          ? `: \`${truncateWithEllipsis(issue.errorMessage, 200)}\``
          : "";
        const ts = issue.failedAt.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
        lines.push(`• *${idLabel}* _${title}_${errPart} (${ts})`);
      }
      if (overflow > 0) {
        lines.push(`_+${overflow} more_`);
      }
    }
    if (tick.errors.length > 0) {
      lines.push("");
      lines.push(`*Errors:* ${tick.errors.join("; ")}`);
    }

    await this.postMessage({
      channel: this.channelId,
      blocks: chunkLinesToSlackSectionBlocks(lines),
    });
  }

  async postApprovalRequest(
    issueId: string,
    action: ApprovalAction,
    reason: string,
    issueUrl: string,
  ): Promise<string> {
    const actionLabel = action === "deprioritize" ? "deprioritize to Icebox" : "cancel";
    const text =
      `*PM Agent* wants to *${actionLabel}* <${issueUrl}|${issueId}>.\n` +
      `*Reason:* ${reason}\n\n` +
      `React :white_check_mark: to approve or :x: to reject.`;

    const data = await this.postMessage({
      channel: this.channelId,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
      ],
    });

    return data?.ts ?? "";
  }

  async checkApprovalReactions(messageTs: string): Promise<"approved" | "rejected" | "pending"> {
    try {
      const data = await this._callSlackApi("reactions.get", {
        channel: this.channelId,
        timestamp: messageTs,
      });

      if (!data?.ok) {
        if (data?.error === "missing_scope") {
          if (!this._missingScopeLogged) {
            log.warn(
              { error: data.error, messageTs },
              "Slack reactions.get returned ok:false (reactions:read scope missing — suppressing further per-tick warnings; see startup log for fix)",
            );
            this._missingScopeLogged = true;
          }
          // else: silently skip — flood deduped to one warn per notifier instance
        } else {
          log.warn({ error: data?.error, messageTs }, "Slack reactions.get returned ok:false");
        }
        return "pending";
      }

      const reactions: Array<{ name: string; count: number }> = data?.message?.reactions ?? [];

      if (reactions.some((r) => r.name === "white_check_mark")) return "approved";
      if (reactions.some((r) => r.name === "x")) return "rejected";
      return "pending";
    } catch (err) {
      log.error({ err, messageTs }, "failed to check Slack reactions");
      return "pending";
    }
  }

  async postStuckIssueRecovered(issues: StuckIssueResult[]): Promise<void> {
    if (issues.length === 0) return;

    const lines: string[] = [
      `*PM Agent — Auto-recovered ${issues.length} stuck issue(s)*`,
    ];
    for (const issue of issues) {
      const runNote = issue.lastRunStatus
        ? ` (last run: \`${issue.lastRunStatus}\`${issue.recoveredLongRunning ? " — zombie run marked failed" : ""})`
        : "";
      lines.push(
        `• *${issue.identifier}* — ${issue.title}: \`${issue.previousState}\` → \`${issue.targetState}\`${runNote}`,
      );
    }

    await this.postMessage({
      channel: this.channelId,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      ],
    });
  }

  async postApprovalExpired(issueId: string): Promise<void> {
    await this.postMessage({
      channel: this.channelId,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*PM Agent* — Approval expired for *${issueId}*. Will re-evaluate next cycle.`,
          },
        },
      ],
    });
  }

  private async _callSlackApi(endpoint: string, params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const url = `https://slack.com/api/${endpoint}?${qs}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return resp.json();
  }

  private async postMessage(payload: object): Promise<any> {
    return postSlackMessage(this.botToken, payload);
  }
}

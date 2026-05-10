import type { TickResult, ApprovalAction } from "./types.js";
import type { StuckIssueResult } from "./actions/recover-stuck.js";
import { postSlackMessage } from "./slack-helpers.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "PmAgent:slack" });

export interface PmSlackConfig {
  botToken: string;
  channelId: string;
}

export class PmSlackNotifier {
  private botToken: string;
  private channelId: string;

  constructor(config: PmSlackConfig) {
    this.botToken = config.botToken;
    this.channelId = config.channelId;
  }

  async postDigest(tick: TickResult, maxInFlight: number): Promise<void> {
    const hasActions =
      tick.paused ||
      tick.triaged.length > 0 ||
      tick.promoted.length > 0 ||
      tick.approvalsResolved > 0 ||
      tick.deprioritizeRequested.length > 0 ||
      tick.cancelRequested.length > 0 ||
      (tick.recoveredStuckIssues?.length ?? 0) > 0 ||
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
    if (tick.errors.length > 0) {
      lines.push("");
      lines.push(`*Errors:* ${tick.errors.join("; ")}`);
    }

    await this.postMessage({
      channel: this.channelId,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      ],
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
      const url = `https://slack.com/api/reactions.get?channel=${encodeURIComponent(this.channelId)}&timestamp=${encodeURIComponent(messageTs)}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      const data = await resp.json() as any;

      if (!data?.ok) {
        log.warn({ error: data?.error, messageTs }, "Slack reactions.get returned ok:false");
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

  private async postMessage(payload: object): Promise<any> {
    return postSlackMessage(this.botToken, payload);
  }
}

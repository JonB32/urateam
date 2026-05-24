import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import type { Octokit } from "@octokit/rest";
import type { AnyDb } from "../db/client.js";
import { releaseApprovals, releaseDecisions } from "../db/schema.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { releaseApprovedEvent, releaseSkippedEvent } from "../audit/events.js";
import { createLogger } from "../logger.js";
import type { ReleaseManagerConfig } from "./types.js";
import { collectState } from "./state.js";
import { bumpFromConfigAndCommits } from "./versioning.js";
import {
  evalMergedPRsSince,
  evalTimeSinceLastHours,
  evalCiGreenForMinutes,
  evalRequireSlackApproval,
  evalQaCheck,
} from "./triggers.js";

const log = createLogger({ component: "ReleaseManager:slack-handler" });

function relativeTime(d: Date | null): string {
  if (!d) return "unknown";
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.round(diffHr / 24);
  return `${diffDays}d ago`;
}

function triggerGlyph(pass: boolean, waiting = false): string {
  if (pass) return "✓";
  return waiting ? "⏳" : "✗";
}

export type ReleaseSubcommand =
  | { kind: "approve" }
  | { kind: "skip"; reason: string }
  | { kind: "status" }
  | { kind: "unknown"; original: string };

/**
 * Parse the text after "/release" into a structured subcommand.
 *   /release approve            → { kind: "approve" }
 *   /release skip foo bar       → { kind: "skip", reason: "foo bar" }
 *   /release status             → { kind: "status" }
 *   anything else / empty       → { kind: "unknown", original }
 *
 * "skip" with no reason returns "unknown" so the caller renders the help message.
 */
export function parseReleaseSubcommand(text: string): ReleaseSubcommand {
  const trimmed = (text ?? "").trim();
  const lower = trimmed.toLowerCase();

  if (lower === "approve") return { kind: "approve" };
  if (lower === "status") return { kind: "status" };

  if (/^skip\s+\S/.test(lower)) {
    const reason = trimmed.replace(/^skip\s+/i, "").trim();
    return { kind: "skip", reason };
  }

  return { kind: "unknown", original: trimmed };
}

export interface HandleReleaseSubcommandInput {
  cmd: ReleaseSubcommand;
  db: AnyDb;
  repoUrl: string;
  branch: string;
  slackUserId: string;
  /** Optional hook so the scheduler can be told to pause after /release skip. */
  onSkip?: (reason: string) => void;
  /** Optional: hours until the next eligible tick after a /release skip. Used in the response text. */
  pauseDurationHours?: number;
  /** When provided alongside config, status renders live trigger state (v2 rich mode). */
  octokit?: Octokit;
  /** When provided alongside octokit, status renders live trigger state (v2 rich mode). */
  config?: ReleaseManagerConfig;
}

export interface SlackResponse {
  text: string;
  responseType: "ephemeral" | "in_channel";
}

const HELP_TEXT =
  "Try `/release approve`, `/release skip <reason>`, or `/release status`.";

export async function handleReleaseSubcommand(
  input: HandleReleaseSubcommandInput,
): Promise<SlackResponse> {
  const { cmd, db, repoUrl, branch, slackUserId, onSkip, pauseDurationHours } = input;

  switch (cmd.kind) {
    case "approve": {
      const id = `ra_${randomUUID()}`;
      try {
        await (db as any).insert(releaseApprovals).values({
          id,
          repoUrl,
          branch,
          approvedAt: new Date(),
          approvedBy: slackUserId,
        });
        void logAuditEventUnchecked(db, releaseApprovedEvent({ repoUrl, branch, approvedBy: slackUserId }));
        return {
          text: `:white_check_mark: Approved by <@${slackUserId}>. Next eligible tick will fire if other rules pass.`,
          responseType: "in_channel",
        };
      } catch (err: any) {
        // UNIQUE partial index → "already approved" friendly message.
        const msg = String(err?.message ?? err);
        if (/UNIQUE|unique|duplicate/.test(msg)) {
          return {
            text: `:information_source: <@${slackUserId}> has already approved this release. Awaiting other triggers.`,
            responseType: "in_channel",
          };
        }
        log.error({ err, repoUrl, branch }, "release approve write failed");
        return {
          text: `:x: Failed to record approval: ${msg}`,
          responseType: "ephemeral",
        };
      }
    }

    case "skip": {
      const id = `rd_${randomUUID()}`;
      await (db as any).insert(releaseDecisions).values({
        id,
        repoUrl,
        branch,
        decidedAt: new Date(),
        decision: "skip",
        reason: `manual:${cmd.reason}`,
        triggerStateJson: JSON.stringify({ source: "slack", slackUserId }),
        attemptCount: 0,
      });
      void logAuditEventUnchecked(db, releaseSkippedEvent({
        repoUrl,
        branch,
        reason: `manual:${cmd.reason}`,
      }));
      onSkip?.(cmd.reason);
      const durationText = pauseDurationHours
        ? `Will re-evaluate after ${pauseDurationHours}h.`
        : "Will re-evaluate on next tick.";
      return {
        text: `:double_vertical_bar: Release skipped: ${cmd.reason}. ${durationText}`,
        responseType: "in_channel",
      };
    }

    case "status": {
      const lines: string[] = [`*Release Manager status — ${repoUrl} (${branch})*`];

      if (input.octokit && input.config) {
        const { config } = input;
        const ttlHours = config.triggers.timeSinceLastHours;
        const approvalTtlMs = ttlHours && ttlHours > 0 ? ttlHours * 3600_000 : 24 * 3600_000;
        try {
          const state = await collectState({
            octokit: input.octokit,
            db,
            repoUrl,
            branch,
            approvalTtlMs,
          });
          const proposedNext = bumpFromConfigAndCommits(
            state.lastTag,
            state.commitsSinceLastTag,
            config.versionBump,
          );
          lines.push(`Last tag: ${state.lastTag ?? "(none)"} (${relativeTime(state.lastTagAt)})`);
          lines.push(`Proposed next: ${proposedNext}`);
          lines.push("Trigger state:");
          const t = config.triggers;
          if (t.mergedPRsSince !== undefined) {
            const r = evalMergedPRsSince(state.mergedCommitsSinceLastTag, t.mergedPRsSince);
            lines.push(`  ${triggerGlyph(r.pass)} ${r.reason}`);
          }
          if (t.timeSinceLastHours !== undefined) {
            const r = evalTimeSinceLastHours(state.lastTagAt, t.timeSinceLastHours);
            lines.push(`  ${triggerGlyph(r.pass)} ${r.reason}`);
          }
          if (t.ciGreenForMinutes !== undefined) {
            const r = evalCiGreenForMinutes(state.ciStatus, state.ciGreenSince, t.ciGreenForMinutes);
            lines.push(`  ${triggerGlyph(r.pass)} ${r.reason}`);
          }
          if (t.qaCheck !== undefined) {
            const r = evalQaCheck({
              qaConfig: t.qaCheck,
              headSha: state.headSha,
              workflowFileExists: true,
              qaRun: state.qaRun,
              runConclusion: null,
            });
            const waiting = r.reason === "qa_running" || r.reason === "qa_needs_trigger";
            lines.push(`  ${triggerGlyph(r.pass, waiting)} qaCheck: ${r.reason}`);
          }
          if (t.requireSlackApproval === true) {
            const r = evalRequireSlackApproval(true, state.hasFreshApproval);
            const label = r.pass
              ? "requireSlackApproval=true (approved)"
              : "requireSlackApproval=true (no fresh approval)";
            lines.push(`  ${triggerGlyph(r.pass, !r.pass)} ${label}`);
          }
        } catch (err: any) {
          log.error({ err, repoUrl, branch }, "collectState failed in /release status");
          lines.push(`_(live state unavailable: ${String(err?.message ?? err)})_`);
        }
      }

      const recent = await (db as any)
        .select({
          decidedAt: releaseDecisions.decidedAt,
          decision: releaseDecisions.decision,
          reason: releaseDecisions.reason,
          firedTag: releaseDecisions.firedTag,
        })
        .from(releaseDecisions)
        .where(and(eq(releaseDecisions.repoUrl, repoUrl), eq(releaseDecisions.branch, branch)))
        .orderBy(desc(releaseDecisions.decidedAt))
        .limit(5);

      lines.push("Recent decisions:");
      if (recent.length === 0) {
        lines.push("  _no decisions yet_");
      } else {
        for (const r of recent) {
          const ts = r.decidedAt instanceof Date ? r.decidedAt.toISOString() : String(r.decidedAt);
          const tail = r.firedTag ? ` (tag=${r.firedTag})` : "";
          lines.push(`  • [${r.decision}] ${r.reason}${tail} — ${ts}`);
        }
      }
      return {
        text: lines.join("\n"),
        responseType: "ephemeral",
      };
    }

    case "unknown":
      return { text: HELP_TEXT, responseType: "ephemeral" };
  }
}

import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { releaseApprovals, releaseDecisions } from "../db/schema.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { releaseApprovedEvent, releaseSkippedEvent } from "../audit/events.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "ReleaseManager:slack-handler" });

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

      const lines: string[] = [`*Release Manager status — ${repoUrl} (${branch})*`, "Recent decisions:"];
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

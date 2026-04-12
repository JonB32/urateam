import type { PmSlackNotifier } from "../slack.js";
import type { AnyDb } from "../../db/client.js";
import { pmApprovals } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { resolveWorkflowStates } from "../linear-helpers.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ component: "PmAgent:approvals" });

const APPROVAL_TIMEOUT_MS = 48 * 60 * 60 * 1000; // 48 hours

export interface ResolveApprovalsInput {
  linearClient: any;
  slackNotifier: PmSlackNotifier;
  db: AnyDb;
  teamIds: string[];
  /** Pre-fetched workflow state map. Falls back to fetching if not provided. */
  stateMap?: Map<string, string>;
}

export interface ResolveApprovalsResult {
  resolved: number;
  expired: number;
  stillPending: number;
}

export async function resolveApprovals(input: ResolveApprovalsInput): Promise<ResolveApprovalsResult> {
  const { linearClient, slackNotifier, db, teamIds } = input;
  let resolvedCount = 0;
  let expiredCount = 0;

  const pending = await db
    .select()
    .from(pmApprovals)
    .where(eq(pmApprovals.status, "pending"));

  if (pending.length === 0) return { resolved: 0, expired: 0, stillPending: 0 };

  const stateMap = input.stateMap ?? await resolveWorkflowStates(linearClient, teamIds);

  for (const approval of pending) {
    try {
      const createdAt = approval.createdAt instanceof Date
        ? approval.createdAt
        : new Date(approval.createdAt);
      const elapsed = Date.now() - createdAt.getTime();

      if (elapsed > APPROVAL_TIMEOUT_MS) {
        await db
          .update(pmApprovals)
          .set({ status: "expired", resolvedAt: new Date() })
          .where(eq(pmApprovals.id, approval.id));
        await slackNotifier.postApprovalExpired(approval.issueId);
        expiredCount++;
        log.info({ issueId: approval.issueId, action: approval.action }, "approval expired");
        continue;
      }

      const reaction = await slackNotifier.checkApprovalReactions(approval.slackMessageTs);

      if (reaction === "pending") continue;

      if (reaction === "rejected") {
        await db
          .update(pmApprovals)
          .set({ status: "rejected", resolvedAt: new Date() })
          .where(eq(pmApprovals.id, approval.id));
        resolvedCount++;
        log.info({ issueId: approval.issueId, action: approval.action }, "approval rejected");
        continue;
      }

      // Approved — mark in DB first to prevent duplicate execution on retry
      await db
        .update(pmApprovals)
        .set({ status: "approved", resolvedAt: new Date() })
        .where(eq(pmApprovals.id, approval.id));
      resolvedCount++;

      // Execute the Linear action (best-effort after DB commit)
      let actionExecuted = false;
      const targetState = approval.action === "deprioritize" ? "Icebox" : "Canceled";
      const actionLabel = approval.action === "deprioritize"
        ? "Deprioritized to Icebox"
        : "Canceled";

      for (const teamId of teamIds) {
        const stateId = stateMap.get(`${teamId}:${targetState}`);
        if (stateId) {
          try {
            const searchResults = await linearClient.searchIssues(approval.issueId);
            const issue = searchResults.nodes[0];
            if (issue) {
              await linearClient.updateIssue(issue.id, { stateId });
              await linearClient.createComment({
                issueId: issue.id,
                body: `🤖 **PM Agent** — ${actionLabel} (approved via Slack).\nReason: ${approval.reason}`,
              });
              actionExecuted = true;
            }
            break;
          } catch {
            // Try next team
          }
        }
      }

      if (!actionExecuted) {
        log.error({ issueId: approval.issueId, action: approval.action }, "approved in DB but Linear action failed — manual intervention needed");
      } else {
        log.info({ issueId: approval.issueId, action: approval.action }, "approval executed");
      }
    } catch (err) {
      log.error({ approvalId: approval.id, err }, "failed to resolve approval");
    }
  }

  return { resolved: resolvedCount, expired: expiredCount, stillPending: pending.length - resolvedCount - expiredCount };
}

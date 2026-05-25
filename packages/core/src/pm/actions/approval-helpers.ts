import type { PmSlackNotifier } from "../slack.js";
import type { AnyDb } from "../../db/client.js";
import type { ApprovalAction } from "../types.js";
import { pmApprovals } from "../../db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createLogger } from "../../logger.js";

const log = createLogger({ component: "PmAgent:approval-helpers" });

/**
 * Batch-fetch all pending approvals for a set of issue IDs and an action.
 * Returns a Set of issueIds that already have a pending approval.
 * Use this before a loop to eliminate N+1 SELECT queries.
 */
export async function batchFetchPendingApprovals(
  db: AnyDb,
  issueIds: string[],
  action: ApprovalAction,
): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();

  const rows = await db.select().from(pmApprovals)
    .where(and(inArray(pmApprovals.issueId, issueIds), eq(pmApprovals.action, action), eq(pmApprovals.status, "pending")));

  return new Set(rows.map((r: any) => r.issueId));
}

/**
 * Post an approval request to Slack and insert a pending row into `pm_approvals`.
 * Does NOT check for an existing pending approval — callers that batch-fetch
 * pending approvals upfront should use this after the Set lookup.
 * Returns the Slack message timestamp on success, or null if the Slack post failed.
 */
export async function insertApprovalRequest(
  db: AnyDb,
  slackNotifier: PmSlackNotifier,
  issueId: string,
  action: ApprovalAction,
  reason: string,
  issueUrl: string,
): Promise<string | null> {
  const ts = await slackNotifier.postApprovalRequest(issueId, action, reason, issueUrl);
  if (!ts) {
    log.debug({ issueId }, "Slack post failed, skipping approval insert");
    return null;
  }
  await db.insert(pmApprovals).values({
    id: nanoid(),
    issueId,
    action,
    reason,
    slackMessageTs: ts,
    status: "pending",
  });
  return ts;
}

export async function requestApprovalIfNotPending(
  db: AnyDb,
  slackNotifier: PmSlackNotifier,
  issueId: string,
  action: ApprovalAction,
  reason: string,
  issueUrl: string,
): Promise<boolean> {
  const existing = await db.select().from(pmApprovals)
    .where(and(eq(pmApprovals.issueId, issueId), eq(pmApprovals.action, action), eq(pmApprovals.status, "pending")));
  if (existing.length > 0) return false;

  const ts = await slackNotifier.postApprovalRequest(issueId, action, reason, issueUrl);
  if (!ts) return false;

  await db.insert(pmApprovals).values({
    id: nanoid(),
    issueId,
    action,
    reason,
    slackMessageTs: ts,
    status: "pending",
  });
  return true;
}

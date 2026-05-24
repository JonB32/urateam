import type { PmSlackNotifier } from "../slack.js";
import type { AnyDb } from "../../db/client.js";
import { batchFetchPendingApprovals, insertApprovalRequest } from "./approval-helpers.js";
import { createLogger } from "../../logger.js";
import type { LinearClient } from "@linear/sdk";

const log = createLogger({ component: "PmAgent:cancel" });

export interface CancelInput {
  linearClient: Pick<LinearClient, "issues">;
  teamIds: string[];
  slackNotifier: PmSlackNotifier;
  db: AnyDb;
  abandonedDays: number;
}

export async function cancelAbandonedIssues(input: CancelInput): Promise<string[]> {
  const { linearClient, teamIds, slackNotifier, db, abandonedDays } = input;
  const requested: string[] = [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - abandonedDays);

  const commentCutoff = new Date();
  commentCutoff.setDate(commentCutoff.getDate() - 14);

  // Pre-fetch all issues from both states so we can batch-fetch approvals
  const stateIssues: Array<{ stateName: string; issues: any[] }> = [];
  for (const stateName of ["Backlog", "Icebox"]) {
    const issuesResponse = await linearClient.issues({
      filter: {
        team: { id: { in: teamIds } },
        state: { name: { eq: stateName } },
        priority: { eq: 4 },
        updatedAt: { lt: cutoff.toISOString() },
      },
      first: 10,
    });
    stateIssues.push({ stateName, issues: issuesResponse.nodes ?? [] });
  }

  // Batch-fetch all pending cancel approvals in a single SELECT
  const allIssueIds = stateIssues.flatMap(({ issues }) => issues.map((i: any) => i.identifier));
  const pendingApprovals = await batchFetchPendingApprovals(db, allIssueIds, "cancel");

  // Process issues using in-memory Set lookup
  for (const { stateName, issues } of stateIssues) {
    for (const issue of issues) {
      try {
        const comments = issue.comments?.nodes ?? [];
        const hasRecentComment = comments.some(
          (c: any) => new Date(c.createdAt) > commentCutoff,
        );
        if (hasRecentComment) continue;

        if (pendingApprovals.has(issue.identifier)) {
          log.debug({ issueId: issue.identifier }, "pending cancel approval already exists, skipping");
          continue;
        }

        const ageDays = Math.floor((Date.now() - new Date(issue.updatedAt).getTime()) / 86_400_000);
        const reason = `In ${stateName} for ${ageDays} days, priority 4, no comments in 14 days`;
        const issueUrl = issue.url ?? `https://linear.app/issue/${issue.identifier}`;

        const ts = await insertApprovalRequest(db, slackNotifier, issue.identifier, "cancel", reason, issueUrl);
        if (!ts) continue;

        requested.push(issue.identifier);
        log.info({ issueId: issue.identifier, ageDays, stateName }, "cancel approval requested");
      } catch (err) {
        log.error({ issueId: issue.identifier, err }, "failed to request cancel approval");
      }
    }
  }

  return requested;
}

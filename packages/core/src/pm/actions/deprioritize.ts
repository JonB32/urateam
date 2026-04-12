import type { PmSlackNotifier } from "../slack.js";
import type { AnyDb } from "../../db/client.js";
import { batchFetchPendingApprovals } from "./approval-helpers.js";
import { pmApprovals } from "../../db/schema.js";
import { createLogger } from "../../logger.js";
import { nanoid } from "nanoid";

const log = createLogger({ component: "PmAgent:deprioritize" });

export interface DeprioritizeInput {
  linearClient: any;
  teamIds: string[];
  slackNotifier: PmSlackNotifier;
  db: AnyDb;
  staleDays: number;
  minPriority: number;
}

export async function deprioritizeStaleIssues(input: DeprioritizeInput): Promise<string[]> {
  const { linearClient, teamIds, slackNotifier, db, staleDays, minPriority } = input;
  const requested: string[] = [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - staleDays);

  const issuesResponse = await linearClient.issues({
    filter: {
      team: { id: { in: teamIds } },
      state: { name: { eq: "Backlog" } },
      priority: { gte: minPriority },
      updatedAt: { lt: cutoff.toISOString() },
    },
    first: 10,
  });

  const issues = issuesResponse.nodes ?? [];

  // Batch-fetch all pending deprioritize approvals in a single SELECT
  const allIssueIds = issues.map((i: any) => i.identifier);
  const pendingApprovals = await batchFetchPendingApprovals(db, allIssueIds, "deprioritize");

  for (const issue of issues) {
    try {
      if (pendingApprovals.has(issue.identifier)) {
        log.debug({ issueId: issue.identifier }, "pending deprioritize approval already exists, skipping");
        continue;
      }

      const ageDays = Math.floor((Date.now() - new Date(issue.updatedAt).getTime()) / 86_400_000);
      const reason = `In Backlog for ${ageDays} days, priority ${issue.priority}, no activity`;
      const issueUrl = issue.url ?? `https://linear.app/issue/${issue.identifier}`;

      const ts = await slackNotifier.postApprovalRequest(issue.identifier, "deprioritize", reason, issueUrl);
      if (!ts) {
        log.debug({ issueId: issue.identifier }, "Slack post failed, skipping");
        continue;
      }

      await db.insert(pmApprovals).values({
        id: nanoid(),
        issueId: issue.identifier,
        action: "deprioritize",
        reason,
        slackMessageTs: ts,
        status: "pending",
      });

      requested.push(issue.identifier);
      log.info({ issueId: issue.identifier, ageDays }, "deprioritize approval requested");
    } catch (err) {
      log.error({ issueId: issue.identifier, err }, "failed to request deprioritize approval");
    }
  }

  return requested;
}

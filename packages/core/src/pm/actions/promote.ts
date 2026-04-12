import type { PromoteResult, ConflictCheckResult } from "../types.js";
import { resolveWorkflowStates } from "../linear-helpers.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ component: "PmAgent:promote" });

export interface PromoteInput {
  linearClient: any;
  teamIds: string[];
  slotsAvailable: number;
  checkConflict: (description: string) => Promise<ConflictCheckResult>;
  /** Pre-fetched workflow state map. Falls back to fetching if not provided. */
  stateMap?: Map<string, string>;
}

export async function promoteReadyIssues(input: PromoteInput): Promise<PromoteResult[]> {
  const { linearClient, teamIds, slotsAvailable, checkConflict } = input;
  const results: PromoteResult[] = [];

  if (slotsAvailable <= 0) return results;

  const issuesResponse = await linearClient.issues({
    filter: {
      team: { id: { in: teamIds } },
      state: { name: { eq: "Backlog" } },
    },
    first: 20,
    orderBy: "createdAt",
  });

  // Sort by priority client-side (1=urgent first, then by creation date)
  const candidates = (issuesResponse.nodes ?? []).sort(
    (a: any, b: any) => (a.priority ?? 4) - (b.priority ?? 4),
  );
  if (candidates.length === 0) return results;

  const stateMap = input.stateMap ?? await resolveWorkflowStates(linearClient, teamIds);
  const todoStates = new Map<string, string>();
  for (const [key, id] of stateMap) {
    if (key.endsWith(":Todo")) {
      todoStates.set(key.split(":")[0], id);
    }
  }

  let promotedCount = 0;

  for (const candidate of candidates) {
    if (promotedCount >= slotsAvailable) break;

    const team = await candidate.team;
    const teamId = team?.id;
    const todoStateId = teamId ? todoStates.get(teamId) : undefined;

    const conflict = await checkConflict(candidate.description ?? "");

    if (conflict.overlapRisk === "high") {
      results.push({
        issueId: candidate.identifier,
        issueTitle: candidate.title,
        promoted: false,
        reason: `conflict: ${conflict.reasoning}`,
        overlapRisk: "high",
      });
      log.info({ issueId: candidate.identifier }, "skipped — high conflict risk");
      continue;
    }

    if (!todoStateId) {
      log.warn({ issueId: candidate.identifier, teamId }, "no Todo state found for team, skipping promote");
      results.push({
        issueId: candidate.identifier,
        issueTitle: candidate.title,
        promoted: false,
        reason: "no Todo state found for team",
      });
      continue;
    }

    await linearClient.updateIssue(candidate.id, { stateId: todoStateId });

    const overlapNote = conflict.overlapRisk === "low"
      ? `\n⚠️ *Low overlap risk:* ${conflict.reasoning}`
      : "";

    await linearClient.createComment({
      issueId: candidate.id,
      body:
        `🤖 **PM Agent — Promoted to Todo**\n\n` +
        `Highest priority non-conflicting issue in backlog.${overlapNote}`,
    });

    results.push({
      issueId: candidate.identifier,
      issueTitle: candidate.title,
      promoted: true,
      reason: "highest priority, no conflict",
      overlapRisk: conflict.overlapRisk,
    });

    promotedCount++;
    log.info({ issueId: candidate.identifier, overlapRisk: conflict.overlapRisk }, "promoted to Todo");
  }

  return results;
}

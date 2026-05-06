import type { PromoteResult, ConflictCheckResult } from "../types.js";
import type { PipelineConfig } from "../../types.js";
import { resolveWorkflowStates } from "../linear-helpers.js";
import { resolvePipeline } from "../../pipeline/router.js";
import { createLogger } from "../../logger.js";
import type { AnyDb } from "../../db/client.js";
import { logAuditEventUnchecked, pmPromotedEvent } from "../../audit/index.js";

const log = createLogger({ component: "PmAgent:promote" });

export interface PromoteInput {
  linearClient: any;
  teamIds: string[];
  slotsAvailable: number;
  checkConflict: (description: string) => Promise<ConflictCheckResult>;
  /** Pre-fetched workflow state map. Falls back to fetching if not provided. */
  stateMap?: Map<string, string>;
  /** Optional DB handle. When present, successful promotions write audit events. */
  db?: AnyDb;
  /**
   * BEC-150: when true, only promote issues that have a label resolving to a
   * configured pipeline. Prevents Todo from filling with items the agent would
   * later refuse to start. Requires `pipelineConfigs`; throws otherwise.
   */
  requirePipelineLabel?: boolean;
  /**
   * Pipeline configs keyed by label (same shape used by start-todo via
   * resolvePipeline). Required when `requirePipelineLabel=true`.
   */
  pipelineConfigs?: Record<string, PipelineConfig>;
}

export async function promoteReadyIssues(input: PromoteInput): Promise<PromoteResult[]> {
  const { linearClient, teamIds, slotsAvailable, checkConflict } = input;
  const results: PromoteResult[] = [];

  if (slotsAvailable <= 0) return results;

  if (input.requirePipelineLabel && !input.pipelineConfigs) {
    throw new Error(
      "promoteReadyIssues: requirePipelineLabel=true requires pipelineConfigs to be set",
    );
  }

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

    // BEC-150: short-circuit BEFORE any per-candidate Linear API call (team,
    // conflict-check). Only promote issues whose labels resolve to a configured
    // pipeline; this keeps Todo from filling with items the agent would later
    // refuse to start, and avoids wasted `await candidate.team` round-trips
    // for filtered candidates on large Backlogs.
    if (input.requirePipelineLabel) {
      const labelsConnection = await candidate.labels?.();
      const labelNodes = labelsConnection?.nodes ?? [];
      const labelNames: string[] = labelNodes.map((l: any) => l.name);
      const resolved = resolvePipeline(labelNames, input.pipelineConfigs!);
      if (!resolved) {
        log.info(
          { issueId: candidate.identifier, labels: labelNames },
          "skipped promote: no pipeline-matching label",
        );
        results.push({
          issueId: candidate.identifier,
          issueTitle: candidate.title,
          promoted: false,
          reason: "no pipeline-matching label",
        });
        continue;
      }
    }

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

    if (input.db) {
      void logAuditEventUnchecked(input.db, pmPromotedEvent({
        issueId: candidate.identifier,
        fromState: "Backlog",
        toState: "Todo",
        priority: candidate.priority,
        reason: conflict.overlapRisk === "low"
          ? `highest priority, low overlap: ${conflict.reasoning}`
          : "highest priority, no conflict",
      }));
    }

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

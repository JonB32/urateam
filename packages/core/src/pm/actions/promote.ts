import type { PromoteResult, ConflictCheckResult } from "../types.js";
import type { PipelineConfig } from "../../types.js";
import { resolveWorkflowStates } from "../linear-helpers.js";
import { resolveIssueRelations } from "../../util/linear.js";
import { resolvePipeline } from "../../pipeline/router.js";
import { createLogger } from "../../logger.js";
import { truncateWithEllipsis } from "../../util/strings.js";
import type { AnyDb } from "../../db/client.js";
import {
  logAuditEventUnchecked,
  pmPromotedEvent,
  pmSkippedCircuitBreakerEvent,
  pmEscalatedToNeedsDesignEvent,
} from "../../audit/index.js";
import {
  batchCountConsecutiveFailures,
  getLastFailureError,
} from "./db-queries.js";

/**
 * Tier 5 — the pipeline label assigned to issues that have tripped the
 * consecutive-failures circuit breaker. Mirrors the observer-marker gate
 * vocabulary so operators see one consistent set of "human review needed"
 * routings across surfaces.
 */
const ESCALATION_PIPELINE_LABEL = "needs-design";

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
  /**
   * BEC-161: when set, candidates whose pipeline has ≥ this many consecutive
   * failed runs (since the last success) are skipped instead of promoted.
   * Prevents the recover-stuck → promote → start-todo → fail doom loop.
   * Leave undefined to disable the breaker (default behavior).
   */
  maxConsecutiveFailures?: number;
  /**
   * BEC-236 — issue IDs the half-open probe selected this tick. Issues in
   * this Set bypass the consecutive-failures circuit-breaker skip, allowing
   * exactly one probe run per cooldown window. When undefined, breaker
   * behavior is unchanged from BEC-161/181.
   */
  probeOverrideIds?: Set<string>;
  /**
   * BEC-161/BEC-181: returns the number of consecutive failed runs for an
   * issue. Tests inject a stub here (avoids real DB rows). Production omits
   * this so `batchCountConsecutiveFailures` is used instead (single DB
   * round-trip for all candidates). Either `getFailureCount` or `db` must be
   * set when `maxConsecutiveFailures` is configured.
   */
  getFailureCount?: (issueId: string) => Promise<number>;
  /**
   * Tier 5 — fetches the most recent failed run's errorMessage for an
   * issue. Used by the escalation path to summarize the failure mode in
   * the Linear comment + Slack alert. Tests inject a stub. Production
   * omits this so `getLastFailureError` is used against `db` instead.
   * If neither is set, the escalation still fires but with `errorMessage:
   * null`.
   */
  getLastError?: (issueId: string) => Promise<string | null>;
  /**
   * Tier 5 — Slack alert callback invoked when an issue is escalated to
   * needs-design. Operators wire this to their PM notifier. Optional: if
   * unset, escalation proceeds without a Slack post (Linear + audit
   * event still fire).
   */
  slackPostAlert?: (args: {
    issueId: string;
    issueTitle: string;
    failureCount: number;
    errorMessage: string | null;
  }) => Promise<void>;
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

  if (input.maxConsecutiveFailures !== undefined && !input.getFailureCount && !input.db) {
    throw new Error(
      "promoteReadyIssues: maxConsecutiveFailures requires either getFailureCount or db to be set",
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

  // BEC-181: pre-fetch failure counts for all candidates in a single DB
  // round-trip to avoid an N+1 query pattern in the per-candidate loop.
  // Uses getFailureCount (test-injectable stub) when provided; otherwise
  // falls back to batchCountConsecutiveFailures for a single DB round-trip.
  let prefetchedFailureCounts: Map<string, number> | null = null;
  if (input.maxConsecutiveFailures !== undefined && !input.getFailureCount && input.db) {
    const candidateIds = candidates.map((c: any) => c.identifier as string);
    prefetchedFailureCounts = await batchCountConsecutiveFailures(input.db, candidateIds);
  }

  let promotedCount = 0;

  // Pre-fetch all candidate relations in parallel before entering the loop.
  // Each candidate's team/labels are independent, so a single Promise.all
  // reduces wall-clock time from O(N × RTT) to O(RTT) for the batch.
  const allCandidateRelations = await Promise.all(
    candidates.map((c: any) => resolveIssueRelations(c)),
  );

  for (let i = 0; i < candidates.length; i++) {
    if (promotedCount >= slotsAvailable) break;
    const candidate = candidates[i]!;

    // Both team and labels were fetched concurrently above via Promise.all.
    const { team, labels: labelsConnection } = allCandidateRelations[i]!;
    const teamId = team?.id;
    const labelNodes = labelsConnection?.nodes ?? [];
    const labelNames: string[] = labelNodes.map((l: any) => l.name);

    // BEC-150: filter candidates whose labels don't resolve to a configured
    // pipeline, keeping Todo from filling with items the agent would later
    // refuse to start.
    if (input.requirePipelineLabel) {
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

    if (input.maxConsecutiveFailures !== undefined) {
      const failureCount = input.getFailureCount
        ? await input.getFailureCount(candidate.identifier)
        : (prefetchedFailureCounts!.get(candidate.identifier) ?? 0);
      if (
        failureCount >= input.maxConsecutiveFailures &&
        !input.probeOverrideIds?.has(candidate.identifier)
      ) {
        log.warn(
          { issueId: candidate.identifier, failureCount, threshold: input.maxConsecutiveFailures },
          "skipped promote: circuit-breaker engaged (too many consecutive failures)",
        );
        if (input.db) {
          void logAuditEventUnchecked(
            input.db,
            pmSkippedCircuitBreakerEvent({
              issueId: candidate.identifier,
              failureCount,
              threshold: input.maxConsecutiveFailures,
              source: "promote",
            }),
          );
        }

        // Tier 5 — escalation. If the issue is NOT already routed to
        // needs-design, move it there now, post a Linear comment with the
        // last failure's error message, and send a Slack alert. Idempotent:
        // subsequent ticks find the label already in place and skip
        // re-escalation (the circuit-breaker event still fires every tick
        // for observability).
        const alreadyEscalated = labelNames
          .map((n) => n.toLowerCase())
          .includes(ESCALATION_PIPELINE_LABEL);
        if (!alreadyEscalated) {
          let errorMessage: string | null = null;
          try {
            errorMessage = input.getLastError
              ? await input.getLastError(candidate.identifier)
              : input.db
              ? await getLastFailureError(input.db, candidate.identifier)
              : null;
          } catch (err) {
            log.warn(
              { issueId: candidate.identifier, err },
              "Tier 5 escalation: failed to fetch last error message — proceeding with null",
            );
          }

          // Best-effort label resolution. If `needs-design` doesn't exist in
          // the workspace, log and continue — same defensive pattern as
          // observer-origin / Tier 4.
          const needsDesignLabelId = await (async () => {
            try {
              const allLabels = await linearClient.issueLabels({ first: 100 });
              for (const label of allLabels.nodes ?? []) {
                if (label.name.toLowerCase() === ESCALATION_PIPELINE_LABEL) {
                  return label.id as string;
                }
              }
            } catch (err) {
              log.warn(
                { issueId: candidate.identifier, err },
                "Tier 5 escalation: failed to look up needs-design label",
              );
            }
            return undefined;
          })();

          if (!needsDesignLabelId) {
            log.warn(
              { issueId: candidate.identifier, label: ESCALATION_PIPELINE_LABEL },
              "Tier 5 escalation: '" +
                ESCALATION_PIPELINE_LABEL +
                "' label not found in Linear — escalation logged but issue not relabeled",
            );
          }

          try {
            // Replace the existing label set with [oldLabels..., needs-design]
            // — add, don't overwrite, so existing pipeline labels remain
            // visible (operator can see this used to be auto-implement, etc).
            if (needsDesignLabelId) {
              const existingIds = labelNodes
                .map((l: any) => l.id)
                .filter(Boolean);
              const merged = [...new Set([...existingIds, needsDesignLabelId])];
              await linearClient.updateIssue(candidate.id, { labelIds: merged });
            }
            const truncated = errorMessage
              ? truncateWithEllipsis(errorMessage, 500)
              : "(no error message captured on the most recent failed run)";
            await linearClient.createComment({
              issueId: candidate.id,
              body:
                `🚨 **PM Agent — Escalated to \`needs-design\`**\n\n` +
                `This issue has hit the consecutive-failures circuit breaker: ` +
                `**${failureCount}** consecutive failed pipeline runs ` +
                `(threshold ${input.maxConsecutiveFailures}). The agent has stopped ` +
                `retrying. A human should diagnose the failure mode before the ticket ` +
                `is moved back into the pipeline.\n\n` +
                `**Last failure:**\n\`\`\`\n${truncated}\n\`\`\``,
            });
          } catch (err) {
            log.warn(
              { issueId: candidate.identifier, err },
              "Tier 5 escalation: failed to update issue / post comment",
            );
          }

          // Slack alert (best-effort; isolated from Linear failures so a
          // notifier outage doesn't suppress the audit signal).
          if (input.slackPostAlert) {
            try {
              await input.slackPostAlert({
                issueId: candidate.identifier,
                issueTitle: candidate.title,
                failureCount,
                errorMessage,
              });
            } catch (err) {
              log.warn(
                { issueId: candidate.identifier, err },
                "Tier 5 escalation: Slack alert failed",
              );
            }
          }

          if (input.db) {
            void logAuditEventUnchecked(
              input.db,
              pmEscalatedToNeedsDesignEvent({
                issueId: candidate.identifier,
                failureCount,
                errorMessage,
              }),
            );
          }

          log.warn(
            {
              issueId: candidate.identifier,
              failureCount,
              hasError: errorMessage !== null,
            },
            "Tier 5 escalation: moved issue to needs-design and notified",
          );
        }

        results.push({
          issueId: candidate.identifier,
          issueTitle: candidate.title,
          promoted: false,
          reason: alreadyEscalated
            ? `circuit-breaker: ${failureCount} consecutive failed runs (already escalated to needs-design)`
            : `circuit-breaker: ${failureCount} consecutive failed runs (escalated to needs-design)`,
        });
        continue;
      }
    }
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

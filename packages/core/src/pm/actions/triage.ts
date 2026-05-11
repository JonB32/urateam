import type { TriageResult } from "../types.js";
import { parseJsonObject } from "../../executor/agent-stream.js";
import { resolveWorkflowStates } from "../linear-helpers.js";
import { resolveIssueRelations } from "../../util/linear.js";
import { createLogger } from "../../logger.js";
import type { AnyDb } from "../../db/client.js";
import { logAuditEventUnchecked, pmTriageClassifiedEvent } from "../../audit/index.js";

const log = createLogger({ component: "PmAgent:triage" });

const MAX_ISSUES_PER_TICK = 10;
const DEFAULT_BATCH_SIZE = 3;

/**
 * Marker embedded in the body of every GitHub issue filed by the urateam
 * quality-observer. `gh-linear-sync` copies the GitHub body verbatim into the
 * Linear ticket description, so the marker survives the sync and is the
 * authoritative way to detect observer-origin tickets on the Linear side
 * (labels are not propagated by gh-linear-sync).
 *
 * Source of truth: urateam-quality-observer/src/github-issue-writer.ts.
 */
const OBSERVER_BODY_MARKER = "<!-- urateam-qo-observer:";

/**
 * Pipeline label assigned to observer-origin tickets. `needs-design` includes
 * an `await-approval` stage that blocks until a human approves, so these
 * findings surface without burning implement-stage tokens on a non-actionable
 * diagnostic. See CLAUDE.md "Quality Observer" for the rationale.
 */
const OBSERVER_PIPELINE_LABEL = "needs-design";

function isObserverOriginIssue(description: string | null | undefined): boolean {
  return typeof description === "string" && description.includes(OBSERVER_BODY_MARKER);
}

export interface TriageInput {
  linearClient: any; // LinearClient from @linear/sdk
  teamIds: string[];
  callClaude: (prompt: string) => Promise<string>;
  sanitize: (text: string) => string;
  /** Number of issues to process concurrently. Defaults to 3. */
  batchSize?: number;
  /** Pre-fetched workflow state map (teamId:stateName → stateId). Fetched once per scheduler tick. */
  stateMap?: Map<string, string>;
  /** Optional DB handle. When present, successful classifications write audit events. */
  db?: AnyDb;
}

/**
 * Process an array of items in batches of `size`, awaiting each batch before
 * starting the next. Returns a flat array of results (preserving order).
 */
async function runInBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

export async function triageNewIssues(input: TriageInput): Promise<TriageResult[]> {
  const { linearClient, teamIds, callClaude, sanitize, batchSize = DEFAULT_BATCH_SIZE } = input;
  const stateMap = input.stateMap ?? await resolveWorkflowStates(linearClient, teamIds);

  const issuesResponse = await linearClient.issues({
    filter: {
      team: { id: { in: teamIds } },
      state: { name: { eq: "Triage" } },
    },
    first: MAX_ISSUES_PER_TICK,
  });

  const issues = issuesResponse.nodes ?? [];
  if (issues.length === 0) return [];

  const allLabels = await linearClient.issueLabels({ first: 100 });
  const labelMap = new Map<string, string>();
  for (const label of allLabels.nodes ?? []) {
    labelMap.set(label.name.toLowerCase(), label.id);
  }

  const results = (await runInBatches(
    issues.slice(0, MAX_ISSUES_PER_TICK),
    batchSize,
    async (issue: any) => {
      try {
        if (isObserverOriginIssue(issue.description)) {
          const team = await issue.team;
          const teamId = team?.id;
          const backlogStateId = teamId ? stateMap.get(`${teamId}:Backlog`) : undefined;

          const issueLabels = [OBSERVER_PIPELINE_LABEL];
          const labelIds = issueLabels
            .map((l) => labelMap.get(l.toLowerCase()))
            .filter(Boolean);
          if (labelIds.length === 0) {
            log.warn(
              { issueId: issue.identifier, label: OBSERVER_PIPELINE_LABEL },
              "observer-origin gate: '" + OBSERVER_PIPELINE_LABEL +
                "' label not found in Linear — issue will move to Backlog without pipeline label and won't be routed by promote",
            );
          }

          const rationale =
            "Observer-origin finding (body marker detected) — routed to needs-design so the await-approval stage gates a human before any implement-stage work runs.";

          const updatePayload: any = { priority: 3 };
          if (labelIds.length > 0) updatePayload.labelIds = labelIds;
          if (backlogStateId) updatePayload.stateId = backlogStateId;

          await linearClient.updateIssue(issue.id, updatePayload);
          await linearClient.createComment({
            issueId: issue.id,
            body:
              `🤖 **PM Agent — Triaged (Quality Observer finding)**\n\n` +
              `**Pipeline:** ${OBSERVER_PIPELINE_LABEL}\n` +
              `**Rationale:** ${rationale}`,
          });

          const result: TriageResult = {
            issueId: issue.identifier,
            priority: 3,
            labels: issueLabels,
            complexity: "medium",
            rationale,
            acceptanceCriteria: [],
          };
          if (input.db) {
            void logAuditEventUnchecked(input.db, pmTriageClassifiedEvent({
              issueId: issue.identifier,
              label: OBSERVER_PIPELINE_LABEL,
              rationale,
            }));
          }
          log.info(
            { issueId: issue.identifier, pipelineLabel: OBSERVER_PIPELINE_LABEL },
            "triaged observer-origin issue (skipped Claude classification)",
          );
          return result;
        }

        const sanitizedDesc = sanitize(issue.description ?? "");
        const prompt =
          `Classify this software issue and generate acceptance criteria. Respond with ONLY a JSON object, no other text.\n\n` +
          `Issue: ${issue.identifier}\n` +
          `Title: ${sanitize(issue.title)}\n` +
          `Description: ${sanitizedDesc}\n\n` +
          `IMPORTANT rules for generating acceptance criteria:\n` +
          `1. INTEGRATION: Every new function, module, or utility MUST have a criterion that specifies where it is called from in existing code (e.g. "runner.ts calls checkFoo() after the test stage completes"). Code that is exported but never imported outside its own test file is incomplete.\n` +
          `2. DOCUMENTATION: If the change adds new configuration, public API, CLI flags, or changes behavior, include a criterion requiring updates to relevant documentation (CLAUDE.md, README.md, deploy/README.md, or inline JSDoc).\n` +
          `3. TESTING: Include a criterion for tests that exercise the integration path, not just the utility in isolation.\n` +
          `4. Each criterion must be concrete and verifiable by reading the code — avoid vague criteria like "works correctly" or "is implemented".\n\n` +
          `Respond with exactly this JSON format (no markdown, no explanation, just the JSON):\n` +
          `{"priority": <1-4 where 1=urgent>, "labels": [<"bug"|"feature"|"backend"|"frontend"|"infra"|"docs">], "complexity": <"trivial"|"small"|"medium"|"large">, "rationale": "<one sentence>", "acceptanceCriteria": ["<integration criterion — specifies call site in existing code>", "<behavior criterion — testable outcome>", "<documentation criterion — if applicable>", ...]}`;

        const response = await callClaude(prompt);
        const parsed = parseJsonObject(response);
        if (!parsed) {
          log.warn({ issueId: issue.identifier, responsePreview: response.slice(0, 200) }, "invalid Claude JSON, skipping triage");
          return null;
        }

        const { priority, labels, complexity, rationale } = parsed;
        if (typeof priority !== "number" || !Array.isArray(labels) || !rationale) {
          log.warn({ issueId: issue.identifier, parsed }, "incomplete Claude response, skipping");
          return null;
        }

        const hasBug = labels.some((l: string) => l.toLowerCase() === "bug");
        const pipelineLabel = hasBug ? "bug" : (complexity === "trivial" ? "quick-fix" : "auto-implement");
        const issueLabels = [...new Set([...labels, pipelineLabel])];

        const labelIds = issueLabels
          .map((l: string) => labelMap.get(l.toLowerCase()))
          .filter(Boolean);

        // Resolve the issue's team relation (parallelised with state/labels via
        // resolveIssueRelations for consistency; only team is needed here).
        const { team } = await resolveIssueRelations(issue);
        const teamId = team?.id;
        const backlogStateId = teamId ? stateMap.get(`${teamId}:Backlog`) : undefined;

        const acceptanceCriteria: string[] = Array.isArray(parsed.acceptanceCriteria)
          ? parsed.acceptanceCriteria.filter((c: any) => typeof c === "string" && c.length > 0)
          : [];

        // Append acceptance criteria to issue description if not already present
        const updatePayload: any = { priority };
        if (labelIds.length > 0) updatePayload.labelIds = labelIds;
        if (backlogStateId) updatePayload.stateId = backlogStateId;

        const existingDesc = issue.description ?? "";
        if (acceptanceCriteria.length > 0 && !existingDesc.includes("**Acceptance Criteria:**")) {
          const criteriaSection = `\n\n**Acceptance Criteria:**\n${acceptanceCriteria.map((c: string) => `- [ ] ${c}`).join("\n")}`;
          updatePayload.description = existingDesc + criteriaSection;
        }

        await linearClient.updateIssue(issue.id, updatePayload);

        await linearClient.createComment({
          issueId: issue.id,
          body:
            `🤖 **PM Agent — Triaged**\n\n` +
            `**Priority:** ${priority} | **Complexity:** ${complexity}\n` +
            `**Labels:** ${issueLabels.join(", ")}\n` +
            `**Pipeline:** ${pipelineLabel}\n` +
            `**Rationale:** ${rationale}` +
            (acceptanceCriteria.length > 0
              ? `\n\n**Generated Acceptance Criteria:**\n${acceptanceCriteria.map((c: string) => `- ${c}`).join("\n")}`
              : ""),
        });

        const result: TriageResult = { issueId: issue.identifier, priority, labels: issueLabels, complexity, rationale, acceptanceCriteria };
        if (input.db) {
          void logAuditEventUnchecked(input.db, pmTriageClassifiedEvent({
            issueId: issue.identifier,
            label: pipelineLabel,
            rationale: String(rationale),
          }));
        }
        log.info({ issueId: issue.identifier, priority, labels: issueLabels, pipelineLabel, complexity }, "triaged issue");
        return result;
      } catch (err) {
        log.error({ issueId: issue.identifier, err }, "failed to triage issue");
        return null;
      }
    }
  )).filter((r): r is TriageResult => r !== null);

  return results;
}

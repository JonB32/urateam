import type { HandoffArtifact } from "../types.js";

/**
 * Options for generating a PR description.
 */
export interface PRDescriptionOptions {
  /** Handoff artifact from the final pipeline stage (may be undefined if pipeline failed early). */
  handoff: HandoffArtifact | undefined;
  /** Linear issue identifier (e.g. "BEC-109") appended as "Resolves <id>". */
  issueId: string;
  /** When true, adds a "Draft PR" callout with reasons. */
  shouldDraft?: boolean;
  /** RALPH satisfaction result — false means at least one acceptance criterion is unmet. */
  ralphSatisfied?: boolean;
  /** List of unmet RALPH gap items (used for count in draft reason). */
  ralphGaps?: unknown[];
  /**
   * Set when the RALPH check agent itself failed (threw, hit its turn cap,
   * or produced no parseable JSON). Distinct from `ralphSatisfied: false`
   * with a non-empty gap list — that means RALPH ran successfully and found
   * real gaps. When this is true, the draft reason wording switches from
   * "RALPH found N unmet acceptance criteria" to "RALPH evaluation failed:
   * <reason>" so reviewers don't waste time hunting for a non-existent
   * failed requirement (urateam#108).
   */
  ralphEvaluationFailed?: boolean;
  /** Human-readable reason from `RalphCheckResult.evaluationError`. */
  ralphEvaluationError?: string;
  /** Blocking review findings that remain unresolved (used for count in draft reason). */
  unresolvedBlockingFindings?: unknown[];
  /** Agent-authored commit messages (not auto-committed fallbacks) to include in a Commits section. */
  agentCommits?: string[];
}

/**
 * Build the markdown body for an auto-generated pull request.
 *
 * Template order:
 *   ## Summary    — from handoff.summary (fallback: "No summary available.")
 *   ## Changes    — bulleted list of handoff.filesChanged (fallback: "No file changes recorded.")
 *   ## Test plan  — filtered list of test/spec files from filesChanged (fallback: "No test changes")
 *   ## Commits    — agent-authored commit messages (section omitted when empty)
 *   > Draft PR    — draft-status callout (section omitted when not a draft)
 *   Resolves <id> — Linear issue link
 *
 * Sections are separated by double newlines (markdown paragraph breaks).
 */
export function generatePRDescription(options: PRDescriptionOptions): string {
  const {
    handoff,
    issueId,
    shouldDraft = false,
    ralphSatisfied = true,
    ralphGaps = [],
    ralphEvaluationFailed = false,
    ralphEvaluationError,
    unresolvedBlockingFindings = [],
    agentCommits = [],
  } = options;

  const parts: string[] = [];

  // Summary section
  parts.push(`## Summary\n${handoff?.summary ?? "No summary available."}`);

  // Changes section
  if (handoff?.filesChanged?.length) {
    parts.push(`## Changes\n${handoff.filesChanged.map((f) => `- \`${f}\``).join("\n")}`);
  } else {
    parts.push(`## Changes\nNo file changes recorded.`);
  }

  // Test plan section — filter filesChanged for test/spec files
  const testFiles =
    handoff?.filesChanged?.filter((f) =>
      /[/._]tests?[/._]|[/._]specs?[/._]|__tests__|\.test\.[jt]sx?$|\.spec\.[jt]sx?$/i.test(f),
    ) ?? [];
  if (testFiles.length > 0) {
    parts.push(`## Test plan\n${testFiles.map((f) => `- \`${f}\``).join("\n")}`);
  } else {
    parts.push(`## Test plan\nNo test changes`);
  }

  // Commits section — include agent-authored commit messages (not auto-committed fallbacks)
  const agentOnlyCommits = agentCommits.filter((msg) => !msg.includes("(auto-committed)"));
  if (agentOnlyCommits.length > 0) {
    parts.push(`## Commits\n${agentOnlyCommits.map((c) => `- ${c}`).join("\n")}`);
  }

  // Flag draft status with reason
  if (shouldDraft) {
    const reasons: string[] = [];
    if (!ralphSatisfied) {
      // urateam#108: distinguish "agent ran, found gaps" from "evaluator
      // crashed". The previous "RALPH found N unmet acceptance criteria"
      // copy lied when N actually counted "RALPH check agent failed: ..."
      // strings, sending reviewers hunting for a non-existent requirement
      // failure.
      if (ralphEvaluationFailed) {
        reasons.push(
          `RALPH evaluation failed (${ralphEvaluationError ?? "no detail"}) — human review required`,
        );
      } else {
        reasons.push(`RALPH found ${ralphGaps.length} unmet acceptance criteria`);
      }
    }
    if (unresolvedBlockingFindings.length > 0)
      reasons.push(`${unresolvedBlockingFindings.length} blocking review findings remain`);
    parts.push(`> **Draft PR** — ${reasons.join("; ")}. See PR comments for details.`);
  }

  // Issue link at the end of the description
  parts.push(`Resolves ${issueId}`);

  return parts.join("\n\n");
}

/**
 * Triage v2 rendering — Linear comment + issue description appender.
 *
 * Pure functions. No I/O. Two exports:
 * - `renderTriageComment(result, opts)` → markdown body for
 *   `linearClient.createComment`. Renders v1 sections always; v2 sections
 *   only when at least one v2 field is present on `result`.
 * - `appendTriageSectionsToDescription(existingDesc, result)` → mutated
 *   description with new sections appended. Idempotent (skips sections
 *   whose `**Label:**` marker already appears).
 *
 * Contract reference: specs/001-triage-v2/contracts/triage-result.schema.md
 */
import type { TriageResult } from "../types.js";

interface RenderOpts {
  forceNeedsDesign: boolean;
  pipelineLabel: string;
}

/** True iff `result` carries at least one Tier-6b field. */
function hasV2Fields(result: TriageResult): boolean {
  return Boolean(
    result.assumptions ??
      result.examples ??
      result.affectedFiles ??
      result.testStrategy ??
      result.riskAssessment,
  );
}

/** Render `(none)` placeholder for an absent v2 field; render the formatter otherwise. */
function renderOr(value: unknown, formatter: () => string): string {
  return value ? formatter() : "(none)";
}

function renderAssumptions(result: TriageResult): string {
  return renderOr(
    result.assumptions?.length ? result.assumptions : undefined,
    () => result.assumptions!.map((a) => `- ${a}`).join("\n"),
  );
}

function renderExamples(result: TriageResult): string {
  return renderOr(
    result.examples?.length ? result.examples : undefined,
    () =>
      result.examples!
        .map(
          (e, i) =>
            `${i + 1}. **Scenario:** ${e.scenario}\n   **Expected:** ${e.expected}`,
        )
        .join("\n"),
  );
}

function renderAffectedFiles(result: TriageResult): string {
  return renderOr(
    result.affectedFiles?.length ? result.affectedFiles : undefined,
    () => result.affectedFiles!.map((f) => `- ${f}`).join("\n"),
  );
}

function renderTestStrategy(result: TriageResult): string {
  return renderOr(result.testStrategy, () => {
    const lines: string[] = [];
    if (result.testStrategy!.unit) {
      lines.push(`- **Unit:** ${result.testStrategy!.unit}`);
    }
    if (result.testStrategy!.integration) {
      lines.push(`- **Integration:** ${result.testStrategy!.integration}`);
    }
    return lines.length > 0 ? lines.join("\n") : "(none)";
  });
}

function renderRiskAssessment(result: TriageResult): string {
  return renderOr(
    result.riskAssessment,
    () =>
      `**Severity:** ${result.riskAssessment!.severity} | **Areas:** ${result.riskAssessment!.areas.join(", ") || "(none)"}`,
  );
}

/** Render the v1 (Tier-4-aware) portion of the comment. */
function renderV1Sections(result: TriageResult): string {
  const parts: string[] = [];
  if (result.acceptanceCriteria.length > 0) {
    parts.push(
      `\n\n**Generated Acceptance Criteria:**\n${result.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
    );
  }
  if (result.approachSummary) {
    parts.push(`\n\n**Approach (Tier 4):**\n${result.approachSummary}`);
  }
  if (result.openQuestions?.length) {
    parts.push(
      `\n\n**Open questions (must be answered before implement):**\n${result.openQuestions.map((q) => `- ${q}`).join("\n")}`,
    );
  }
  if (result.antiAcceptanceCriteria?.length) {
    parts.push(
      `\n\n**Anti-acceptance criteria (this should NOT do):**\n${result.antiAcceptanceCriteria.map((q) => `- ${q}`).join("\n")}`,
    );
  }
  return parts.join("");
}

/** Render the v2 Tier-6b block. Only called when at least one v2 field is set. */
function renderV2Block(result: TriageResult): string {
  return (
    `\n\n### Assumptions\n${renderAssumptions(result)}` +
    `\n\n### Examples\n${renderExamples(result)}` +
    `\n\n### Affected Files\n${renderAffectedFiles(result)}` +
    `\n\n### Test Strategy\n${renderTestStrategy(result)}` +
    `\n\n### Risk Assessment\n${renderRiskAssessment(result)}`
  );
}

/**
 * Render the markdown body posted to the Linear issue by triage.
 *
 * Order of sections:
 *   1. Header with priority / complexity / labels / pipeline / rationale
 *   2. v1: Acceptance Criteria, Approach (Tier 4), Open Questions, Anti-AC
 *   3. v2 (only if any v2 field present): Assumptions, Examples,
 *      Affected Files, Test Strategy, Risk Assessment
 */
export function renderTriageComment(
  result: TriageResult,
  opts: RenderOpts,
): string {
  const labelsDedup = Array.from(new Set(result.labels));
  const header =
    `🤖 **PM Agent — Triaged**${opts.forceNeedsDesign ? " (routed to needs-design)" : ""}\n\n` +
    `**Priority:** ${result.priority} | **Complexity:** ${result.complexity}\n` +
    `**Labels:** ${labelsDedup.join(", ")}\n` +
    `**Pipeline:** ${opts.pipelineLabel}\n` +
    `**Rationale:** ${result.rationale}`;

  return header + renderV1Sections(result) + (hasV2Fields(result) ? renderV2Block(result) : "");
}

// ---------------------------------------------------------------------------
// Issue-description appender.
// ---------------------------------------------------------------------------

/**
 * Append triage sections to the issue description. Idempotent — skips any
 * section whose `**Label:**` marker already appears in `existingDesc`.
 *
 * Section order (matches the comment): Acceptance Criteria, Examples,
 * Affected Files, Test Strategy, Risk Assessment. The order is important
 * for the future schema-mapper extension that will parse these out.
 */
export function appendTriageSectionsToDescription(
  existingDesc: string,
  result: TriageResult,
): string {
  const sections: Array<{ marker: string; render: () => string | null }> = [
    {
      marker: "**Acceptance Criteria:**",
      render: () =>
        result.acceptanceCriteria.length > 0
          ? `**Acceptance Criteria:**\n${result.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}`
          : null,
    },
    {
      marker: "**Examples:**",
      render: () =>
        result.examples?.length
          ? `**Examples:**\n${result.examples
              .map(
                (e, i) =>
                  `${i + 1}. **Scenario:** ${e.scenario}\n   **Expected:** ${e.expected}`,
              )
              .join("\n")}`
          : null,
    },
    {
      marker: "**Affected Files:**",
      render: () =>
        result.affectedFiles?.length
          ? `**Affected Files:**\n${result.affectedFiles.map((f) => `- ${f}`).join("\n")}`
          : null,
    },
    {
      marker: "**Test Strategy:**",
      render: () => {
        if (!result.testStrategy) return null;
        const lines: string[] = [];
        if (result.testStrategy.unit) {
          lines.push(`- **Unit:** ${result.testStrategy.unit}`);
        }
        if (result.testStrategy.integration) {
          lines.push(`- **Integration:** ${result.testStrategy.integration}`);
        }
        return lines.length > 0
          ? `**Test Strategy:**\n${lines.join("\n")}`
          : null;
      },
    },
    {
      marker: "**Risk Assessment:**",
      render: () =>
        result.riskAssessment
          ? `**Risk Assessment:**\n- **Severity:** ${result.riskAssessment.severity}\n- **Areas:** ${result.riskAssessment.areas.join(", ") || "(none)"}`
          : null,
    },
  ];

  let out = existingDesc;
  for (const section of sections) {
    if (out.includes(section.marker)) continue;
    const rendered = section.render();
    if (rendered === null) continue;
    out = `${out}\n\n${rendered}`;
  }
  return out;
}

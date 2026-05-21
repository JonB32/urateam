import { HandoffArtifactSchema } from "../types.js";
import type { DecisionArtifact, HandoffArtifact } from "../types.js";
import { parseJsonBlock } from "./agent-stream.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "Handoff" });

export interface HandoffParseResult {
  artifact: HandoffArtifact;
  /** True when the agent emitted a valid, structured JSON handoff block. */
  structured: boolean;
  /**
   * BEC-227 Phase 4 / Track D. Parsed `<decisions>` block from the agent's
   * final message, or null if absent / malformed / schema-mismatch. The
   * `parseHandoffArtifact()` helper in this file does not see the agent's
   * raw output, only the handoff JSON block, so it always returns null
   * here; `extractHandoff()` populates this field by calling
   * `parseDecisionsBlock(agentOutput)` against the full agent text.
   */
  decisions: DecisionArtifact | null;
}

export function buildFallback(
  metadata: { runId: string; issueId: string; stage: string; timestamp: string },
  summary: string,
): HandoffArtifact {
  // Note (urateam#97): callers should NOT use this raw `summary` string
  // for end-user surfaces. The slow path in extract-handoff.ts applies
  // a JSON-soup heuristic before assigning to artifact.summary so the
  // PR body's "## Summary" section doesn't render review-finding JSON
  // fragments verbatim (rotulus#7 reproduction). buildFallback itself is
  // schema-required to populate `summary` to satisfy HandoffArtifact;
  // the sanitization logically belongs at the call site, not here.
  //
  // The deeper root cause — per-stage prompts in templates.ts never
  // instruct the agent to emit a HandoffArtifact JSON block — is tracked
  // in urateam#97 as the long-term fix. When that lands, the fast path
  // becomes load-bearing and this fallback is rarely hit.
  return {
    ...metadata,
    summary: summary || `Stage ${metadata.stage} completed without structured output`,
    filesChanged: [],
    approach: "",
    context: {
      issueIntent: "",
      constraints: [],
      assumptions: [],
    },
    tokenBudget: {
      contextTokensUsed: 0,
      recommendedMaxTurns: 10,
    },
  };
}

/**
 * Parse and validate a HandoffArtifact from agent output text.
 *
 * Expects the agent to emit a ```json fenced block containing the artifact
 * fields (summary, filesChanged, approach, context, tokenBudget).
 * Metadata fields (runId, issueId, stage, timestamp) are injected automatically.
 *
 * Returns a structured result so callers can distinguish real handoffs from
 * fallbacks and decide whether to continue or surface a warning.
 */
export function parseHandoffArtifact(
  agentOutput: string,
  runId: string,
  issueId: string,
  stage: string,
): HandoffParseResult {
  const metadata = {
    runId,
    issueId,
    stage,
    timestamp: new Date().toISOString(),
  };

  const parsed = parseJsonBlock(agentOutput);
  if (!parsed) {
    // Demoted from error → debug: this fires on EVERY implement/test stage
    // because per-stage prompts in `packages/core/src/executor/prompt/templates.ts`
    // never instruct the agent to emit a HandoffArtifact-shaped JSON block.
    // The slow path in extractHandoff reconstructs filesChanged from git diff
    // and provides a sanitized summary, so this isn't an actionable error —
    // it's expected operation. Logging at error level falsely flagged it as
    // a problem in every operator dashboard (and triggered Slack alerts via
    // notifier/slack-alerts.ts which fires on level >= 50). See urateam#97.
    //
    // CONTRACT FOR FLIP-BACK: when (a) the per-stage prompts in templates.ts
    // are updated to request a HandoffArtifact JSON block, AND (b) the fast
    // path actually reaches `structured: true` on a meaningful fraction of
    // runs, this log should flip back to warn. Track via urateam#97.
    log.debug({ stage }, "no valid JSON block in agent output, using slow-path reconstruction");
    return {
      artifact: buildFallback(metadata, agentOutput.slice(0, 500)),
      structured: false,
      // BEC-227 Phase 4 / Track D — this helper doesn't parse decisions;
      // extractHandoff() overlays the real value from parseDecisionsBlock().
      decisions: null,
    };
  }

  // Agent-supplied fields first, then metadata overwrites — pipeline-injected
  // fields (runId, issueId, stage, timestamp) must always be authoritative
  const fullArtifact = {
    ...(parsed as Record<string, unknown>),
    ...metadata,
  };

  const result = HandoffArtifactSchema.safeParse(fullArtifact);
  if (!result.success) {
    // Same demotion as the no-block case above (urateam#97); same
    // flip-back contract. The review stage routinely emits review-findings
    // JSON (severity/file/line shape, see security/review-checklist.ts
    // REVIEW_OUTPUT_FORMAT) which fails this validation. That's expected
    // operation, not an error.
    log.debug(
      { stage, validationErrors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") },
      "JSON block did not match HandoffArtifact schema, using slow-path reconstruction",
    );
    return {
      artifact: buildFallback(metadata, agentOutput.slice(0, 500)),
      structured: false,
      // BEC-227 Phase 4 / Track D — this helper doesn't parse decisions;
      // extractHandoff() overlays the real value from parseDecisionsBlock().
      decisions: null,
    };
  }

  return { artifact: result.data, structured: true, decisions: null };
}

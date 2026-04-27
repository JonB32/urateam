import { HandoffArtifactSchema } from "../types.js";
import type { HandoffArtifact } from "../types.js";
import { parseJsonBlock } from "./agent-stream.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "Handoff" });

export interface HandoffParseResult {
  artifact: HandoffArtifact;
  /** True when the agent emitted a valid, structured JSON handoff block. */
  structured: boolean;
}

export function buildFallback(
  metadata: { runId: string; issueId: string; stage: string; timestamp: string },
  summary: string,
): HandoffArtifact {
  // Note (urateam#35 Bug 1): if `summary` here is the agent's raw output
  // truncated to 500 chars, it may contain JSON fragments from a self-
  // critique block the agent leaked instead of structured prose. The fix
  // for that is upstream prompt engineering (constraining the agent's
  // structured-output instructions) — not summary sanitization here, which
  // would be fragile regex hacks.
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
    // because per-stage prompts (templates.ts) never instruct the agent to
    // emit a HandoffArtifact-shaped JSON block. The slow path in
    // extractHandoff reconstructs filesChanged from git diff and provides a
    // sanitized summary, so this isn't an actionable error — it's expected
    // operation. Logging at error level falsely flagged it as a problem in
    // every operator dashboard. See urateam#97. (When prompt engineering
    // catches up and the fast path actually runs, this log becomes useful
    // again — flip back to warn at that point.)
    log.debug({ stage }, "no valid JSON block in agent output, using slow-path reconstruction");
    return {
      artifact: buildFallback(metadata, agentOutput.slice(0, 500)),
      structured: false,
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
    // Same demotion as the no-block case above (urateam#97). The review
    // stage routinely emits review-findings JSON (severity/file/line shape)
    // which fails this validation. That's expected, not an error.
    log.debug(
      { stage, validationErrors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") },
      "JSON block did not match HandoffArtifact schema, using slow-path reconstruction",
    );
    return {
      artifact: buildFallback(metadata, agentOutput.slice(0, 500)),
      structured: false,
    };
  }

  return { artifact: result.data, structured: true };
}

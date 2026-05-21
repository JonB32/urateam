import { logAuditEvent } from "../audit/writer.js";
import { surgicalReviewFixEvent } from "../audit/events.js";
import { surgicalReviewFixPrompt } from "../executor/prompt/templates.js";
import { transcriptExists, defaultProjectsRoot } from "../executor/session-store.js";
import { getLatestDecisionArtifact } from "../db/decisions-store.js";
import type { AnyDb } from "../db/client.js";
import type { ReviewFinding } from "../types.js";

/**
 * BEC-227 Phase 4 / Track B. Decides whether the review-fix loop can take
 * the surgical (resume-based) path and, if so, builds the prompt.
 *
 *   - `surgical`: agent_session_id non-null AND JSONL transcript on disk.
 *     The caller passes `prompt` to `executeStage` via `promptOverride`
 *     + `suppressHandoff: true`. The decisions snippet (if any) is
 *     embedded in `prompt`.
 *   - `legacy`: any of those conditions is false. The caller falls back
 *     to the existing full implement-template re-run.
 *
 * Either way, exactly one `pipeline.surgical_review_fix` audit event
 * fires so operators can monitor the fallback rate.
 */
export async function runSurgicalReviewFix(args: {
  db: AnyDb;
  runId: string;
  issueId: string;
  agentSessionId: string | null;
  worktreePath: string;
  blockingFindings: ReviewFinding[];
}): Promise<{
  path: "surgical" | "legacy";
  prompt: string;
  decisionPayloadBytes: number;
}> {
  const { db, runId, issueId, agentSessionId, worktreePath, blockingFindings } = args;

  let path: "surgical" | "legacy" = "legacy";
  let promptStr = "";
  let decisionPayloadBytes = 0;

  if (agentSessionId !== null) {
    const exists = transcriptExists({
      projectsRoot: defaultProjectsRoot(),
      cwd: worktreePath,
      sessionId: agentSessionId,
    });
    if (exists) {
      const decisionRow = await getLatestDecisionArtifact(db, runId);
      const decisions = decisionRow?.payload ?? null;
      promptStr = surgicalReviewFixPrompt(blockingFindings, decisions);
      decisionPayloadBytes = decisions ? JSON.stringify(decisions).length : 0;
      path = "surgical";
    }
  }

  void logAuditEvent(
    db,
    surgicalReviewFixEvent({
      runId,
      issueId,
      path,
      findingsCount: blockingFindings.length,
      decisionPayloadBytes,
    }),
  );

  return { path, prompt: promptStr, decisionPayloadBytes };
}

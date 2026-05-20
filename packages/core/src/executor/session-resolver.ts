/**
 * BEC-228 — shared helper for resolving per-stage SDK session options.
 *
 * Encapsulates the full BEC-227 flow:
 *   policy check → JSONL existence check → audit-event emission
 *
 * Called from both `executor.ts` (main pipeline stages) and `deep-review.ts`
 * (parallel sub-agents). The only caller-visible difference is the `stage`
 * label: pipeline stages pass the StageType string directly; deep-review
 * sub-agents pass a qualified label like `"review:reuse"`.
 */

import { readFileSync } from "node:fs";
import { isResumable } from "./session-policy.js";
import { transcriptExists, defaultProjectsRoot, transcriptPath } from "./session-store.js";
import {
  agentSessionMissingFallbackEvent,
  agentSessionResumedEvent,
} from "../audit/index.js";
import { logAuditEvent } from "../audit/writer.js";
import { createLogger } from "../logger.js";
import type { AnyDb } from "../db/client.js";

const log = createLogger({ component: "SessionResolver" });

export interface ResolveSessionOptsParams {
  /** Stage label used for the policy check and audit event `stage` field. */
  stage: string;
  /** Resolved model string — used by `isResumable()` to gate the Claude family check.
   *  When undefined (e.g. stage profile has no explicit model), the resume path is
   *  skipped and `{}` is returned — same guard as the original `!!resolvedModel` in executor.ts. */
  model: string | undefined;
  /** Per-run SDK session UUID, or `null` when the feature flag is off. */
  agentSessionId: string | null;
  /**
   * True only on the first resumable stage of the run. Determines whether
   * to use `sessionId` (create) vs `resume` (reuse) in the SDK call.
   */
  isFirstResumableStage: boolean;
  /** Worktree path — used to locate the JSONL transcript file. */
  workdir: string;
  /** Required (with `issueId` and `db`) to emit audit events. Optional to
   *  support deep-review's optional-audit pattern. */
  runId?: string;
  issueId?: string;
  db?: AnyDb;
}

/**
 * Resolves the SDK session options for a single stage or sub-agent call.
 *
 * Returns one of three shapes:
 *  - `{ sessionId }` — first resumable stage; creates the SDK session.
 *  - `{ resume }`   — subsequent resumable stage with transcript on disk.
 *  - `{}`           — always-fresh stage, non-Claude model, flag off, or
 *                     transcript missing (fallback + audit event).
 */
export async function resolveSessionOpts(
  params: ResolveSessionOptsParams,
): Promise<{ sessionId?: string; resume?: string }> {
  const { stage, model, agentSessionId, isFirstResumableStage, workdir, runId, issueId, db } =
    params;

  // Early returns narrow agentSessionId to string and model to string for the rest of the function.
  if (agentSessionId === null || !model || !isResumable(stage, model)) {
    return {};
  }

  if (isFirstResumableStage) {
    return { sessionId: agentSessionId };
  }

  const exists = transcriptExists({
    projectsRoot: defaultProjectsRoot(),
    cwd: workdir,
    sessionId: agentSessionId,
  });

  if (exists) {
    if (db && runId && issueId) {
      try {
        const tp = transcriptPath({
          projectsRoot: defaultProjectsRoot(),
          cwd: workdir,
          sessionId: agentSessionId,
        });
        const priorMessageCount = readFileSync(tp, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0).length;
        void logAuditEvent(
          db,
          agentSessionResumedEvent({ runId, issueId, sessionId: agentSessionId, stage, priorMessageCount }),
        );
      } catch (err) {
        log.warn(
          { err: (err as Error).message, stage },
          "failed to count prior session messages — emitting resumed event with count=0",
        );
        void logAuditEvent(
          db,
          agentSessionResumedEvent({ runId, issueId, sessionId: agentSessionId, stage, priorMessageCount: 0 }),
        );
      }
    }
    return { resume: agentSessionId };
  } else {
    if (db && runId && issueId) {
      void logAuditEvent(
        db,
        agentSessionMissingFallbackEvent({ runId, issueId, sessionId: agentSessionId, reason: "jsonl-not-found" }),
      );
    }
    log.warn(
      { runId, sessionId: agentSessionId, stage, cwd: workdir },
      "agent session JSONL missing — falling back to fresh session",
    );
    return {};
  }
}

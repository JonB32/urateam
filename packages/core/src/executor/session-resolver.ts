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

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { isResumable } from "./session-policy.js";
import { transcriptExists, defaultProjectsRoot, transcriptPath } from "./session-store.js";
import { agentSessionResumedEvent } from "../audit/index.js";
import { logAuditEvent } from "../audit/writer.js";
import { createLogger } from "../logger.js";
import type { AnyDb } from "../db/client.js";

const log = createLogger({ component: "SessionResolver" });

function countLines(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    rl.on("line", () => count++);
    rl.on("close", () => resolve(count));
    rl.on("error", reject);
  });
}

export interface ResolveSessionOptsParams {
  /** Stage label used for the policy check and audit event `stage` field. */
  stage: string;
  /** Resolved model string — used by `isResumable()` to gate the Claude family check.
   *  When undefined (e.g. stage profile has no explicit model), the resume path is
   *  skipped and `{}` is returned — same guard as the original `!!resolvedModel` in executor.ts. */
  model: string | undefined;
  /** Per-run SDK session UUID, or `null` when the feature flag is off. */
  agentSessionId: string | null;
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
 * BEC-231 — the shape is derived from ON-DISK state (transcriptExists), not
 * from an in-memory `isFirstResumableStage` flag. The flag flipped before the
 * SDK had written a single message, so first-stage failures (auth 401, MCP
 * init error, pre-stream stall) left every subsequent stage stuck on the
 * `resume:` shape pointing at a non-existent JSONL — session lost for the
 * run's lifetime.
 *
 * Returns one of three shapes:
 *  - `{ sessionId }` — transcript absent: create (or re-create after failure)
 *                       the SDK session. The SDK pre-assigns our UUID and
 *                       writes a fresh transcript when the first message lands.
 *  - `{ resume }`   — transcript on disk: continue the existing conversation.
 *  - `{}`           — always-fresh stage, non-Claude model, or flag off.
 */
export async function resolveSessionOpts(
  params: ResolveSessionOptsParams,
): Promise<{ sessionId?: string; resume?: string }> {
  const { stage, model, agentSessionId, workdir, runId, issueId, db } = params;

  // Early returns narrow agentSessionId to string and model to string for the rest of the function.
  if (agentSessionId === null || !model || !isResumable(stage, model)) {
    return {};
  }

  const exists = transcriptExists({
    projectsRoot: defaultProjectsRoot(),
    cwd: workdir,
    sessionId: agentSessionId,
  });

  if (!exists) {
    // Transcript absent — (re-)create the session. Could be the first
    // resumable stage of a fresh run, OR a re-attempt after the first stage
    // failed before writing anything to disk. Either way, `sessionId:` is
    // the right shape.
    return { sessionId: agentSessionId };
  }

  // Transcript present — resume the conversation. Emit the audit event with
  // the prior message count so operators can see how much context inherited.
  if (db && runId && issueId) {
    try {
      const tp = transcriptPath({
        projectsRoot: defaultProjectsRoot(),
        cwd: workdir,
        sessionId: agentSessionId,
      });
      const priorMessageCount = await countLines(tp);
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
}

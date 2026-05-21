import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { pipelineRunDecisions } from "./schema.js";
import type { AnyDb } from "./client.js";
import type { DecisionArtifact } from "../types.js";

/**
 * BEC-227 Phase 4 / Track D. Persists one row to `pipeline_run_decisions`.
 * Never throws — the caller (extract-handoff / runner) MUST NOT have a
 * pipeline failure mode that depends on this writing successfully.
 */
export async function persistDecisionArtifact(
  db: AnyDb,
  args: {
    pipelineRunId: string;
    iteration: number;
    stage: string;
    payload: DecisionArtifact | Record<string, unknown>;
  },
): Promise<void> {
  try {
    await (db as any)
      .insert(pipelineRunDecisions)
      .values({
        id: randomUUID(),
        pipelineRunId: args.pipelineRunId,
        iteration: args.iteration,
        stage: args.stage,
        payload: JSON.stringify(args.payload),
        createdAt: new Date(),
      });
  } catch {
    // Best-effort write; fall through silently per Track D's "graceful
    // degradation" contract. The caller has already audit-logged
    // anything that matters.
  }
}

/**
 * BEC-227 Phase 4 / Track D. Returns the highest-iteration decision
 * artifact for a run, or null when none exists. Consumed by the
 * surgical-review-fix path (Track B) — the LATEST decisions are the
 * ones the review-fix agent should be reminded of.
 */
export async function getLatestDecisionArtifact(
  db: AnyDb,
  pipelineRunId: string,
): Promise<{ iteration: number; stage: string; payload: DecisionArtifact } | null> {
  const rows = await (db as any)
    .select()
    .from(pipelineRunDecisions)
    .where(eq(pipelineRunDecisions.pipelineRunId, pipelineRunId))
    .orderBy(desc(pipelineRunDecisions.iteration))
    .limit(1);
  if (!rows[0]) return null;
  try {
    return {
      iteration: rows[0].iteration as number,
      stage: rows[0].stage as string,
      payload: JSON.parse(rows[0].payload as string),
    };
  } catch {
    // Corrupted payload — return null rather than crashing the
    // review-fix loop. The audit log already shows the stage ran.
    return null;
  }
}

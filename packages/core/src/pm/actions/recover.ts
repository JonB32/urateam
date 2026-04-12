import type { AnyDb } from "../../db/client.js";
import { pipelineRuns } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { createLogger } from "../../logger.js";
import { MAX_TRANSIENT_RETRIES } from "../../pipeline/error-classifier.js";

const log = createLogger({ component: "PmAgent:recover" });

export interface RecoverInput {
  db: AnyDb;
  runner: { resume: (issueId: string) => Promise<void> };
  maxRetries?: number;
}

export interface RecoverResult {
  recovered: string[];
  exhausted: string[];
}

/**
 * Query for pipeline runs with status "retriable" and either requeue them
 * (if under max retries) or mark them as permanently failed.
 */
export async function recoverRetriableRuns(input: RecoverInput): Promise<RecoverResult> {
  const { db, runner, maxRetries = MAX_TRANSIENT_RETRIES } = input;

  const rows = await db
    .select()
    .from(pipelineRuns)
    .where(eq(pipelineRuns.status, "retriable"));

  const recovered: string[] = [];
  const exhausted: string[] = [];

  for (const run of rows) {
    const retryCount = (run as any).retryCount ?? 0;

    if (retryCount >= maxRetries) {
      log.warn(
        { runId: run.id, issueId: run.issueId, retryCount },
        "retriable run exhausted max retries — marking as failed",
      );
      await db
        .update(pipelineRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorMessage: `${run.errorMessage ?? "unknown"} [max retries exhausted after ${retryCount} attempts]`,
        })
        .where(eq(pipelineRuns.id, run.id));
      exhausted.push(run.issueId);
      continue;
    }

    try {
      // Set status back to "paused" so runner.resume() can pick it up
      // (resume() queries for status === "paused")
      await db
        .update(pipelineRuns)
        .set({ status: "paused" })
        .where(eq(pipelineRuns.id, run.id));

      await runner.resume(run.issueId);
      recovered.push(run.issueId);
      log.info(
        { runId: run.id, issueId: run.issueId, retryCount },
        "retriable run requeued for resume",
      );
    } catch (err) {
      // Roll back to retriable so the next tick can retry
      await db
        .update(pipelineRuns)
        .set({ status: "retriable" })
        .where(eq(pipelineRuns.id, run.id))
        .catch(() => {}); // best-effort rollback
      log.error(
        { runId: run.id, issueId: run.issueId, err },
        "failed to requeue retriable run — rolled back to retriable",
      );
    }
  }

  return { recovered, exhausted };
}

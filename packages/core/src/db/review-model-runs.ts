import { reviewModelRuns } from "./schema.js";
import type { ReviewModelRun } from "../executor/review/review-provider.js";
import { randomUUID } from "node:crypto";
import type { AnyDb } from "./client.js";

export async function insertReviewModelRuns(
  db: AnyDb,
  stageRunId: string,
  runs: ReviewModelRun[],
): Promise<void> {
  if (runs.length === 0) return;
  const now = new Date();
  const rows = runs.map((r) => ({
    id: randomUUID(),
    stageRunId,
    providerId: r.providerId,
    modelId: r.modelId,
    status: r.status,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    durationMs: r.durationMs,
    errorMessage: r.errorMessage,
    truncatedFiles: r.truncatedFiles ?? 0,
    startedAt: now,
    completedAt: now,
  }));
  // AnyDb escape-hatch: Drizzle's insert returns a Promise on postgres-js and
  // a sync builder on better-sqlite3. Awaiting works correctly for both drivers.
  await (db as any).insert(reviewModelRuns).values(rows);
}

import { reviewModelRuns } from "./schema.js";
import type { ReviewModelRun } from "../executor/review/review-provider.js";
import { randomUUID } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export type Db = BetterSQLite3Database | PostgresJsDatabase;

export function insertReviewModelRuns(
  db: Db,
  stageRunId: string,
  runs: ReviewModelRun[],
): void {
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
  // Drizzle's insert is sync on better-sqlite3, async on postgres-js. Both
  // accept this shape via type-narrowing: cast through unknown for the call site.
  (db as unknown as BetterSQLite3Database).insert(reviewModelRuns).values(rows).run();
}

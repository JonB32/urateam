import { and, desc, eq, gte } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";

export interface TriageQualityPayload {
  hasV2Prediction: boolean;
  predicted: number;
  actual: number;
  intersection: number;
  missed: string[];
  unexpected: string[];
}

export interface TriageQualityEvent {
  id: string;
  timestamp: Date;
  runId: string | null;
  issueId: string | null;
  payload: TriageQualityPayload;
}

export interface ReadTriageQualityEventsOpts {
  /** Only return events at or after this epoch-ms timestamp. */
  sinceMs?: number;
  /** Maximum number of events to return. Defaults to 500. */
  limit?: number;
}

/**
 * Reads `pm.triage_quality_score` audit events from the database.
 *
 * Returns events sorted descending by timestamp (most recent first).
 * Handles both `hasV2Prediction: true` (full prediction data) and
 * `hasV2Prediction: false` (triage v1 ran, counts are zero) payloads.
 *
 * @param db  - The database connection (SQLite or Postgres).
 * @param opts - Optional filter/limit options.
 */
export async function readTriageQualityEvents(
  db: AnyDb,
  opts: ReadTriageQualityEventsOpts = {},
): Promise<TriageQualityEvent[]> {
  const limit = opts.limit ?? 500;
  const conditions: any[] = [
    eq(auditEvents.eventType, "pm.triage_quality_score"),
  ];

  if (opts.sinceMs !== undefined) {
    conditions.push(gte(auditEvents.timestamp, new Date(opts.sinceMs)));
  }

  const rows = await (db as any)
    .select()
    .from(auditEvents)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(auditEvents.timestamp))
    .limit(limit);

  return rows.map((row: any): TriageQualityEvent => {
    let payload: TriageQualityPayload;
    try {
      const parsed = JSON.parse(row.payload ?? "{}");
      payload = {
        hasV2Prediction: Boolean(parsed.hasV2Prediction),
        predicted: Number(parsed.predicted ?? 0),
        actual: Number(parsed.actual ?? 0),
        intersection: Number(parsed.intersection ?? 0),
        missed: Array.isArray(parsed.missed) ? (parsed.missed as string[]) : [],
        unexpected: Array.isArray(parsed.unexpected)
          ? (parsed.unexpected as string[])
          : [],
      };
    } catch {
      payload = {
        hasV2Prediction: false,
        predicted: 0,
        actual: 0,
        intersection: 0,
        missed: [],
        unexpected: [],
      };
    }
    return {
      id: row.id as string,
      timestamp: row.timestamp as Date,
      runId: (row.runId as string | null) ?? null,
      issueId: (row.issueId as string | null) ?? null,
      payload,
    };
  });
}

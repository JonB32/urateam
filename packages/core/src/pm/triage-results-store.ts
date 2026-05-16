import { eq } from "drizzle-orm";
import { triageResults } from "../db/schema.js";
import type { AnyDb } from "../db/client.js";
import { createLogger } from "../logger.js";
import type { TriageV2Extensions } from "./types.js";

const log = createLogger({ component: "triage-results-store" });

/**
 * Persist the v2 prediction extracted by triage v2 (affectedFiles, examples,
 * etc.) for an issue. Upsert keyed by `issue_id` so re-triage replaces the
 * prior prediction. Empty `prediction` objects are still written so the
 * runner can distinguish "triage v2 ran but emitted nothing" (record present,
 * no `affectedFiles`) from "triage hasn't run for this issue" (no record).
 *
 * Fail-open: any error is logged and swallowed — telemetry never blocks the
 * triage path.
 */
export async function upsertTriageResult(
  db: AnyDb,
  issueId: string,
  prediction: TriageV2Extensions,
): Promise<void> {
  try {
    const json = JSON.stringify(prediction);
    await db
      .insert(triageResults)
      .values({
        issueId,
        v2Prediction: json,
      })
      .onConflictDoUpdate({
        target: triageResults.issueId,
        set: {
          v2Prediction: json,
          triagedAt: new Date(),
        },
      });
  } catch (err) {
    log.warn({ err, issueId }, "upsertTriageResult failed");
  }
}

/**
 * Read the most recent v2 prediction for an issue. Returns `undefined` when
 * no record exists (no triage v2 run yet) OR when the stored JSON fails to
 * parse (defensive — malformed rows shouldn't crash the runner).
 */
export async function getTriageResult(
  db: AnyDb,
  issueId: string,
): Promise<TriageV2Extensions | undefined> {
  try {
    const rows = await db
      .select()
      .from(triageResults)
      .where(eq(triageResults.issueId, issueId))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return JSON.parse(row.v2Prediction) as TriageV2Extensions;
  } catch (err) {
    log.warn({ err, issueId }, "getTriageResult failed — treating as missing");
    return undefined;
  }
}

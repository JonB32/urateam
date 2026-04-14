import type { AnyDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { createLogger } from "../logger.js";
import type { AuditEvent } from "../types.js";

const log = createLogger({ component: "audit.writer" });

async function insertAuditEvent(db: AnyDb, event: AuditEvent): Promise<void> {
  try {
    await (db as any).insert(auditEvents).values({
      id: event.id,
      timestamp: event.timestamp,
      eventType: event.eventType,
      actor: event.actor,
      actorType: event.actorType,
      scope: event.scope,
      runId: event.runId,
      issueId: event.issueId,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      payload: JSON.stringify(event.payload ?? {}),
    });
  } catch (err) {
    log.warn(
      { err, eventType: event.eventType, id: event.id },
      "audit event write failed",
    );
  }
}

/**
 * Fire-and-forget insert of an audit event. Write failures are logged but
 * never propagated — audit writes must not crash the caller.
 *
 * Gated on the `audit-log` enterprise feature (spec §8): when unlicensed,
 * this is a no-op so OSS/Pro deployments do not accumulate audit_events rows
 * indefinitely (retention sweep is also gated).
 *
 * Uses a dynamic import of `../license.js` to avoid a circular-import cycle
 * (license.ts calls into this module to record license-validation failures
 * via `logAuditEventUnchecked`).
 *
 * Callers should use `void logAuditEvent(...)` when they don't await.
 */
export async function logAuditEvent(
  db: AnyDb,
  event: AuditEvent,
): Promise<void> {
  const { isFeatureLicensed } = await import("../license.js");
  if (!isFeatureLicensed("audit-log")) return;
  await insertAuditEvent(db, event);
}

/**
 * Unchecked writer used by the license-validation failure path itself.
 * Bypasses the `audit-log` feature gate because (a) recording why a license
 * was rejected must not depend on that license being valid, and (b) the
 * event is emitted at most once per process (license status is cached).
 * Do not use this from other call sites.
 */
export async function logAuditEventUnchecked(
  db: AnyDb,
  event: AuditEvent,
): Promise<void> {
  await insertAuditEvent(db, event);
}

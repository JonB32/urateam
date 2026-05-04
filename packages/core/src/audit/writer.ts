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
 * Gated on the `audit-log` enterprise feature: when unlicensed, this is a
 * no-op. This gate exists so events from Enterprise-only features (cost
 * rollups, RBAC, SSO, org-policy) do not accumulate rows on Pro/OSS
 * deployments that have no way to query, prune, or export them.
 *
 * **Pro-tier features (PM agent, Release Manager) emit their audit events
 * via `logAuditEventUnchecked` instead** — those rows must appear in the
 * audit table whenever the feature itself is licensed, regardless of
 * whether the Enterprise audit-log dashboard is unlocked.
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
 * Unchecked writer that bypasses the `audit-log` Enterprise feature gate.
 *
 * Used by:
 * 1. The license-validation failure path itself — recording why a license
 *    was rejected must not depend on that license being valid. (Bonus: the
 *    event fires at most once per process, since license status is cached.)
 * 2. Pro-tier feature events (PM agent decisions, Release Manager
 *    fire/skip/approval/conflict events) — these must appear in the audit
 *    table whenever the Pro feature is licensed, independent of the
 *    Enterprise audit-log dashboard being unlocked.
 *
 * Use sparingly. Enterprise-only features should continue to use
 * `logAuditEvent` so their events are properly gated.
 */
export async function logAuditEventUnchecked(
  db: AnyDb,
  event: AuditEvent,
): Promise<void> {
  await insertAuditEvent(db, event);
}

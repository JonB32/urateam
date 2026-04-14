import type { AnyDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { createLogger } from "../logger.js";
import type { AuditEvent } from "../types.js";

const log = createLogger({ component: "audit.writer" });

/**
 * Fire-and-forget insert of an audit event. Write failures are logged but
 * never propagated — audit writes must not crash the caller.
 *
 * Callers should use `void logAuditEvent(...)` when they don't await.
 */
export async function logAuditEvent(
  db: AnyDb,
  event: AuditEvent,
): Promise<void> {
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

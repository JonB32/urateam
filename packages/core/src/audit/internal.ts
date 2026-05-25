import { randomUUID } from "node:crypto";
import type { AuditEvent } from "../types.js";

export function base(
  partial: Partial<AuditEvent> & Pick<AuditEvent, "eventType" | "actor" | "actorType">,
): AuditEvent {
  return {
    id: `evt_${randomUUID()}`,
    timestamp: new Date(),
    scope: partial.scope ?? null,
    runId: partial.runId ?? null,
    issueId: partial.issueId ?? null,
    inputTokens: partial.inputTokens ?? 0,
    outputTokens: partial.outputTokens ?? 0,
    payload: partial.payload ?? {},
    ...partial,
  };
}

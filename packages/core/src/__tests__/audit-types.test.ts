import { describe, it, expect } from "vitest";
import { AuditEventSchema, AuditEventTypeSchema, AuditActorTypeSchema } from "../types.js";

describe("audit event zod schemas", () => {
  it("accepts all v1 event types", () => {
    const types = [
      "run.started","run.completed","run.failed","run.auto_merged","run.auto_merge_skipped",
      "pm.approval_requested","pm.approval_resolved",
      "pm.issue_promoted","pm.issue_deprioritized","pm.issue_cancelled","pm.triage_classified",
      "budget.alert_fired","budget.run_refused",
      "license.validation_failed","config.loaded","dashboard.manual_action",
    ];
    for (const t of types) expect(AuditEventTypeSchema.parse(t)).toBe(t);
  });

  it("rejects unknown event type", () => {
    expect(() => AuditEventTypeSchema.parse("nope")).toThrow();
  });

  it("parses a minimal valid audit event", () => {
    const evt = AuditEventSchema.parse({
      id: "evt_1",
      timestamp: new Date(),
      eventType: "pm.issue_promoted",
      actor: "pm-agent",
      actorType: "pm-agent",
      scope: null,
      runId: null,
      issueId: "BEC-1",
      inputTokens: 0,
      outputTokens: 0,
      payload: { issueId: "BEC-1" },
    });
    expect(evt.eventType).toBe("pm.issue_promoted");
  });
});

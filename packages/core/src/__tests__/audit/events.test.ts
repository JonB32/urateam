import { describe, it, expect } from "vitest";
import {
  pmPromotedEvent, pmDeprioritizedEvent, pmCancelledEvent, pmTriageClassifiedEvent,
  budgetRefusedEvent, licenseValidationFailedEvent, configLoadedEvent,
} from "../../audit/events.js";
import { AuditEventSchema } from "../../types.js";

describe("audit event builders", () => {
  it("pmPromotedEvent produces a valid event", () => {
    const evt = pmPromotedEvent({
      issueId: "BEC-1", fromState: "Backlog", toState: "Todo",
      priority: 2, reason: "top-of-queue",
    });
    const parsed = AuditEventSchema.parse(evt);
    expect(parsed.eventType).toBe("pm.issue_promoted");
    expect(parsed.actor).toBe("pm-agent");
    expect(parsed.actorType).toBe("pm-agent");
    expect(parsed.issueId).toBe("BEC-1");
    expect(parsed.payload).toMatchObject({ fromState: "Backlog", toState: "Todo" });
  });

  it("budgetRefusedEvent includes scope breakdown", () => {
    const evt = budgetRefusedEvent({
      scope: "team:T1", scopeType: "team",
      tokensUsed: 100000, limit: 100000, utilization: 100,
    });
    const parsed = AuditEventSchema.parse(evt);
    expect(parsed.eventType).toBe("budget.run_refused");
    expect(parsed.scope).toBe("team:T1");
    expect(parsed.payload).toMatchObject({ tokensUsed: 100000, limit: 100000 });
  });

  it("licenseValidationFailedEvent sets actor=system", () => {
    const evt = licenseValidationFailedEvent({ invalidReason: "expired" });
    expect(evt.actor).toBe("system");
    expect(evt.actorType).toBe("system");
    expect(evt.eventType).toBe("license.validation_failed");
  });

  it("configLoadedEvent includes path + sha256 + tier", () => {
    const evt = configLoadedEvent({ path: "/tmp/ura.yaml", sha256: "abc123", tier: "enterprise" });
    expect(evt.eventType).toBe("config.loaded");
    expect(evt.payload).toMatchObject({ path: "/tmp/ura.yaml", sha256: "abc123", tier: "enterprise" });
  });

  it("all builders return new ids and recent timestamps", () => {
    const a = pmCancelledEvent({ issueId: "BEC-1", approvalId: "a1", reason: "stale" });
    const b = pmCancelledEvent({ issueId: "BEC-2", approvalId: "a2", reason: "dup" });
    expect(a.id).not.toBe(b.id);
    expect(Date.now() - a.timestamp.getTime()).toBeLessThan(1000);
  });
});

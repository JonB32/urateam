import { describe, it, expect } from "vitest";
import { pmSkippedCircuitBreakerEvent } from "../../audit/events.js";

describe("pmSkippedCircuitBreakerEvent (BEC-181)", () => {
  it("returns an audit event with the documented shape", () => {
    const event = pmSkippedCircuitBreakerEvent({
      issueId: "BEC-157",
      failureCount: 4,
      threshold: 3,
      source: "promote",
    });
    expect(event.eventType).toBe("pm.skipped_circuit_breaker");
    expect(event.actor).toBe("pm-agent");
    expect(event.actorType).toBe("pm-agent");
    expect(event.issueId).toBe("BEC-157");
    expect(event.payload).toEqual({
      failureCount: 4,
      threshold: 3,
      source: "promote",
    });
    expect(event.id).toMatch(/^evt_/);
  });

  it("captures source as 'start-todo' when fired from start-todo path", () => {
    const event = pmSkippedCircuitBreakerEvent({
      issueId: "BEC-999",
      failureCount: 5,
      threshold: 3,
      source: "start-todo",
    });
    expect((event.payload as { source: string }).source).toBe("start-todo");
  });
});

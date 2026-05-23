import { describe, expect, it } from "vitest";
import {
  pmCircuitBreakerProbeEvent,
  pmCircuitBreakerRecoveredEvent,
  pmCircuitBreakerResetManualEvent,
} from "../audit/events.js";

describe("circuit-breaker audit event constructors", () => {
  it("pmCircuitBreakerProbeEvent returns correct shape", () => {
    const ev = pmCircuitBreakerProbeEvent({
      issueId: "BEC-1",
      consecutiveFailures: 4,
      lastFailureAgeMin: 90,
      probeAttempts: 1,
    });

    expect(ev.eventType).toBe("pm.circuit_breaker_probe");
    expect(ev.actorType).toBe("pm-agent");
    expect(ev.issueId).toBe("BEC-1");
    expect(ev.payload).toMatchObject({
      consecutiveFailures: 4,
      lastFailureAgeMin: 90,
      probeAttempts: 1,
    });
    expect(ev.id).toMatch(/^evt_/);
    expect(ev.timestamp).toBeInstanceOf(Date);
  });

  it("pmCircuitBreakerRecoveredEvent returns correct shape", () => {
    const ev = pmCircuitBreakerRecoveredEvent({
      issueId: "BEC-2",
      probeAttempts: 2,
    });

    expect(ev.eventType).toBe("pm.circuit_breaker_recovered");
    expect(ev.actorType).toBe("pm-agent");
    expect(ev.issueId).toBe("BEC-2");
    expect(ev.payload).toMatchObject({
      probeAttempts: 2,
    });
    expect(ev.id).toMatch(/^evt_/);
    expect(ev.timestamp).toBeInstanceOf(Date);
  });

  it("pmCircuitBreakerResetManualEvent returns correct shape", () => {
    const ev = pmCircuitBreakerResetManualEvent({
      issueId: "BEC-3",
      scope: "single",
      failedRunsDeleted: 3,
    });

    expect(ev.eventType).toBe("pm.circuit_breaker_reset_manual");
    expect(ev.actorType).toBe("cli");
    expect(ev.issueId).toBe("BEC-3");
    expect(ev.payload).toMatchObject({
      scope: "single",
      failedRunsDeleted: 3,
    });
    expect(ev.id).toMatch(/^evt_/);
    expect(ev.timestamp).toBeInstanceOf(Date);
  });
});

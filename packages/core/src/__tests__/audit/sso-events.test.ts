import { describe, it, expect } from "vitest";
import {
  dashboardLoginEvent,
  dashboardLogoutEvent,
  dashboardLoginDeniedEvent,
} from "../../audit/events.js";

describe("SSO audit event builders", () => {
  describe("dashboardLoginEvent", () => {
    it("builds a dashboard.login event with user details in payload", () => {
      const evt = dashboardLoginEvent({
        userId: "user_123",
        email: "alice@example.com",
        workosUserId: "workos_abc",
      });

      expect(evt.eventType).toBe("dashboard.login");
      expect(evt.actorType).toBe("dashboard-user");
      expect(evt.actor).toBe("dashboard:alice@example.com");
      expect(evt.payload).toEqual({
        userId: "user_123",
        email: "alice@example.com",
        workosUserId: "workos_abc",
      });
      expect(evt.id).toMatch(/^evt_/);
      expect(evt.timestamp).toBeInstanceOf(Date);
    });
  });

  describe("dashboardLogoutEvent", () => {
    it("builds a dashboard.logout event with userId in payload", () => {
      const evt = dashboardLogoutEvent({
        userId: "user_123",
        email: "alice@example.com",
      });

      expect(evt.eventType).toBe("dashboard.logout");
      expect(evt.actorType).toBe("dashboard-user");
      expect(evt.actor).toBe("dashboard:alice@example.com");
      expect(evt.payload).toEqual({ userId: "user_123" });
    });
  });

  describe("dashboardLoginDeniedEvent", () => {
    it("builds a dashboard.login_denied event without userId", () => {
      const evt = dashboardLoginDeniedEvent({
        email: "intruder@evil.example",
        reason: "domain-mismatch",
      });

      expect(evt.eventType).toBe("dashboard.login_denied");
      expect(evt.actorType).toBe("dashboard-user");
      expect(evt.actor).toBe("dashboard:intruder@evil.example");
      expect(evt.payload).toEqual({ reason: "domain-mismatch" });
      expect(evt.payload).not.toHaveProperty("userId");
    });
  });
});

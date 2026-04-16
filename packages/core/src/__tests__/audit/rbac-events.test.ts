import { describe, it, expect } from "vitest";
import {
  dashboardGrantRoleEvent,
  dashboardRevokeRoleEvent,
  dashboardBootstrapAdminEvent,
  dashboardRetryRunEvent,
} from "../../audit/events.js";
import { AuditEventSchema } from "../../types.js";

describe("rbac audit event builders", () => {
  it("dashboardGrantRoleEvent", () => {
    const evt = dashboardGrantRoleEvent({
      targetUserId: "u_1",
      targetEmail: "a@b.com",
      oldRole: "viewer",
      newRole: "operator",
      actorUserId: "u_admin",
      actorEmail: "admin@b.com",
    });
    const p = AuditEventSchema.parse(evt);
    expect(p.eventType).toBe("dashboard.manual_action");
    expect(p.actor).toBe("dashboard:admin@b.com");
    expect((p.payload as any).action).toBe("grant_role");
    expect((p.payload as any).oldRole).toBe("viewer");
    expect((p.payload as any).newRole).toBe("operator");
  });

  it("dashboardRevokeRoleEvent", () => {
    const evt = dashboardRevokeRoleEvent({
      targetUserId: "u_1",
      targetEmail: "a@b.com",
      oldRole: "operator",
      newRole: "viewer",
      actorUserId: "u_admin",
      actorEmail: "admin@b.com",
    });
    expect((evt.payload as any).action).toBe("revoke_role");
  });

  it("dashboardBootstrapAdminEvent", () => {
    const evt = dashboardBootstrapAdminEvent({
      targetUserId: "u_1",
      targetEmail: "alice@acme.com",
    });
    expect(evt.eventType).toBe("dashboard.manual_action");
    expect(evt.actor).toBe("system");
    expect(evt.actorType).toBe("system");
    expect((evt.payload as any).action).toBe("bootstrap_admin");
  });

  it("dashboardRetryRunEvent", () => {
    const evt = dashboardRetryRunEvent({
      runId: "run_1",
      issueId: "BEC-42",
      previousStatus: "failed",
      actorUserId: "u_op",
      actorEmail: "op@b.com",
    });
    expect((evt.payload as any).action).toBe("retry_run");
    expect(evt.runId).toBe("run_1");
    expect(evt.issueId).toBe("BEC-42");
    expect(evt.actor).toBe("dashboard:op@b.com");
  });
});

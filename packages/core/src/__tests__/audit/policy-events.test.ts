import { describe, it, expect } from "vitest";
import {
  policyPathBlockedEvent,
  policyCostExceededEvent,
  policyOverrideUsedEvent,
  policyReviewersRequestedEvent,
} from "../../audit/events.js";
import { AuditEventSchema } from "../../types.js";

describe("policy audit event builders", () => {
  it("policyPathBlockedEvent", () => {
    const evt = policyPathBlockedEvent({
      runId: "r_1",
      path: "infra/main.tf",
      pattern: "infra/**",
      hadOverride: false,
    });
    const p = AuditEventSchema.parse(evt);
    expect(p.eventType).toBe("policy.path_blocked");
    expect(p.runId).toBe("r_1");
    expect(p.payload).toMatchObject({ path: "infra/main.tf", pattern: "infra/**" });
  });

  it("policyCostExceededEvent", () => {
    const evt = policyCostExceededEvent({
      runId: "r_1",
      tokensUsed: 600000,
      limit: 500000,
      stage: "implement",
      hadOverride: false,
    });
    expect(evt.eventType).toBe("policy.cost_exceeded");
    expect(evt.payload).toMatchObject({ tokensUsed: 600000, limit: 500000, stage: "implement" });
  });

  it("policyOverrideUsedEvent", () => {
    const evt = policyOverrideUsedEvent({
      runId: "r_1",
      issueId: "BEC-1",
      gateType: "path",
      label: "policy-override",
    });
    expect(evt.eventType).toBe("policy.override_used");
    expect(evt.payload).toMatchObject({ gateType: "path", label: "policy-override" });
  });

  it("policyReviewersRequestedEvent", () => {
    const evt = policyReviewersRequestedEvent({
      runId: "r_1",
      prUrl: "https://github.com/x/y/pull/1",
      users: ["alice"],
      teams: ["security"],
    });
    expect(evt.eventType).toBe("policy.reviewers_requested");
    expect(evt.payload).toMatchObject({ users: ["alice"], teams: ["security"] });
  });
});

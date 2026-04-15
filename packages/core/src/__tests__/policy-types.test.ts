import { describe, it, expect } from "vitest";
import { PolicySchema, PipelineConfigSchema, AuditEventTypeSchema } from "../types.js";

describe("PolicySchema", () => {
  it("parses a full policy block", () => {
    const parsed = PolicySchema.parse({
      pathBlocklist: ["infra/**", "**/migrations/**"],
      maxTokensPerIssue: 500000,
      overrideLabel: "policy-override",
      mandatoryReviewers: { users: ["alice"], teams: ["security"] },
    });
    expect(parsed.pathBlocklist).toEqual(["infra/**", "**/migrations/**"]);
    expect(parsed.maxTokensPerIssue).toBe(500000);
    expect(parsed.overrideLabel).toBe("policy-override");
    expect(parsed.mandatoryReviewers?.users).toEqual(["alice"]);
  });

  it("defaults overrideLabel to 'policy-override' when omitted", () => {
    const parsed = PolicySchema.parse({});
    expect(parsed.overrideLabel).toBe("policy-override");
    expect(parsed.pathBlocklist).toEqual([]);
  });

  it("rejects non-positive maxTokensPerIssue", () => {
    expect(() => PolicySchema.parse({ maxTokensPerIssue: 0 })).toThrow();
    expect(() => PolicySchema.parse({ maxTokensPerIssue: -1 })).toThrow();
  });
});

describe("PipelineConfigSchema", () => {
  it("accepts optional policy field", () => {
    const cfg = PipelineConfigSchema.parse({
      name: "auto-implement",
      stages: ["implement"],
      retry: { maxAttempts: 1, strategy: "fail-fast" },
      review: { requiredApprovals: 0 },
      prStrategy: "ready",
      policy: { pathBlocklist: ["secrets/**"] },
    } as any);
    expect(cfg.policy?.pathBlocklist).toEqual(["secrets/**"]);
  });
});

describe("AuditEventTypeSchema", () => {
  it("accepts all 4 policy event types", () => {
    for (const t of [
      "policy.path_blocked", "policy.cost_exceeded",
      "policy.override_used", "policy.reviewers_requested",
    ]) {
      expect(AuditEventTypeSchema.parse(t)).toBe(t);
    }
  });
});

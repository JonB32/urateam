import { describe, it, expect } from "vitest";
import { buildReviewerRequest } from "../../policy/reviewer-gate.js";

describe("reviewer request threading", () => {
  it("buildReviewerRequest returns null → runner does not pass reviewers", () => {
    expect(buildReviewerRequest(undefined)).toBeNull();
  });

  it("buildReviewerRequest returns non-null → runner passes through to createPR", () => {
    const req = buildReviewerRequest({
      pathBlocklist: [],
      overrideLabel: "x",
      mandatoryReviewers: { users: ["alice"], teams: ["security"] },
    } as any);
    expect(req).toEqual({ users: ["alice"], teams: ["security"] });
  });

  it("buildReviewerRequest returns null when both lists are empty", () => {
    const req = buildReviewerRequest({
      pathBlocklist: [],
      overrideLabel: "x",
      mandatoryReviewers: { users: [], teams: [] },
    } as any);
    expect(req).toBeNull();
  });
});

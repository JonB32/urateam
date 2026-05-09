import { describe, it, expect } from "vitest";
import { applyReviewFeedbackProfileOverride } from "../../executor/executor.js";

const baseProfile = {
  tools: ["Read", "Write", "Edit"],
  maxInputTokens: 100_000,
  maxTurns: 100,
  model: "claude-sonnet-4-6",
};

describe("applyReviewFeedbackProfileOverride (BEC-182)", () => {
  it("caps maxTurns + maxInputTokens for implement stage when review-feedback context is present", () => {
    const out = applyReviewFeedbackProfileOverride(baseProfile, "implement", true);
    expect(out.maxTurns).toBe(30);
    expect(out.maxInputTokens).toBe(60_000);
    // Other fields preserved
    expect(out.tools).toEqual(baseProfile.tools);
    expect(out.model).toBe(baseProfile.model);
  });

  it("returns the profile unchanged on non-implement stages even with review-feedback context", () => {
    const out = applyReviewFeedbackProfileOverride(baseProfile, "test", true);
    expect(out).toEqual(baseProfile);
  });

  it("returns the profile unchanged when review-feedback context is absent", () => {
    const out = applyReviewFeedbackProfileOverride(baseProfile, "implement", false);
    expect(out).toEqual(baseProfile);
  });

  it("does not mutate the input profile", () => {
    const before = JSON.parse(JSON.stringify(baseProfile));
    applyReviewFeedbackProfileOverride(baseProfile, "implement", true);
    expect(baseProfile).toEqual(before);
  });
});

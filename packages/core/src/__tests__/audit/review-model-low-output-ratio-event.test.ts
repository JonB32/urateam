import { describe, it, expect } from "vitest";
import { reviewModelLowOutputRatioEvent } from "../../audit/events.js";

describe("reviewModelLowOutputRatioEvent", () => {
  it("returns an audit event with the documented shape", () => {
    const event = reviewModelLowOutputRatioEvent({
      modelId: "gpt-oss-120b:free",
      outputRatio: 0.011,
      runs: 10,
      threshold: 0.05,
    });
    expect(event.eventType).toBe("review.model_low_output_ratio");
    expect(event.actor).toBe("system");
    expect(event.actorType).toBe("system");
    expect(event.payload).toEqual({
      modelId: "gpt-oss-120b:free",
      outputRatio: 0.011,
      runs: 10,
      threshold: 0.05,
    });
    expect(event.id).toMatch(/^evt_/);
  });
});

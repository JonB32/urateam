import { describe, it, expect } from "vitest";
import { DecisionArtifactSchema, AuditEventTypeSchema } from "../types.js";

describe("DecisionArtifactSchema (BEC-227 Phase 4 / Track D)", () => {
  it("accepts a fully populated payload", () => {
    const ok = DecisionArtifactSchema.parse({
      decisions: [
        { choice: "use Zod refinement", reason: "preserves error path", alternativesConsidered: ["preprocess"] },
      ],
      leftUnhandled: [
        { case: "future schema version", reason: "out of scope per AC #3" },
      ],
      keyFiles: ["packages/core/src/types.ts"],
    });
    expect(ok.decisions).toHaveLength(1);
    expect(ok.leftUnhandled).toHaveLength(1);
    expect(ok.keyFiles).toEqual(["packages/core/src/types.ts"]);
  });

  it("accepts an empty payload (all arrays optional, default to empty)", () => {
    const ok = DecisionArtifactSchema.parse({});
    expect(ok.decisions).toEqual([]);
    expect(ok.leftUnhandled).toEqual([]);
    expect(ok.keyFiles).toEqual([]);
  });

  it("rejects a decision missing the required `choice` field", () => {
    expect(() =>
      DecisionArtifactSchema.parse({ decisions: [{ reason: "no choice" }] }),
    ).toThrow();
  });

  it("rejects a leftUnhandled item missing the required `case` field", () => {
    expect(() =>
      DecisionArtifactSchema.parse({ leftUnhandled: [{ reason: "no case" }] }),
    ).toThrow();
  });

  it("alternativesConsidered defaults to empty array when omitted", () => {
    const ok = DecisionArtifactSchema.parse({
      decisions: [{ choice: "x", reason: "y" }],
    });
    expect(ok.decisions[0]!.alternativesConsidered).toEqual([]);
  });
});

describe("AuditEventTypeSchema includes pipeline.surgical_review_fix", () => {
  it("accepts the new event type", () => {
    expect(() => AuditEventTypeSchema.parse("pipeline.surgical_review_fix")).not.toThrow();
  });

  it("rejects an unknown event type", () => {
    expect(() => AuditEventTypeSchema.parse("pipeline.surgical_review_fix_v2")).toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { hasOverrideLabel } from "../../policy/override.js";

function stubIssue(labels: string[]) {
  return {
    labels: async () => ({ nodes: labels.map((name) => ({ name })) }),
  } as any;
}

describe("hasOverrideLabel", () => {
  it("returns false when no labels", async () => {
    expect(await hasOverrideLabel(stubIssue([]), "policy-override")).toBe(false);
  });

  it("returns true on exact match", async () => {
    expect(await hasOverrideLabel(stubIssue(["policy-override"]), "policy-override")).toBe(true);
  });

  it("returns true on case-insensitive match", async () => {
    expect(await hasOverrideLabel(stubIssue(["Policy-Override"]), "policy-override")).toBe(true);
    expect(await hasOverrideLabel(stubIssue(["policy-override"]), "Policy-Override")).toBe(true);
  });

  it("returns false when the label is absent", async () => {
    expect(await hasOverrideLabel(stubIssue(["bug", "p0"]), "policy-override")).toBe(false);
  });

  it("returns true when one of many labels matches", async () => {
    expect(
      await hasOverrideLabel(stubIssue(["bug", "policy-override", "p0"]), "policy-override"),
    ).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { bumpFromConfigAndCommits } from "../release-manager/versioning.js";

describe("bumpFromConfigAndCommits", () => {
  describe("policy=patch", () => {
    it("always bumps patch", () => {
      expect(bumpFromConfigAndCommits("v1.2.3", [{ message: "feat: anything" }], "patch")).toBe("v1.2.4");
      expect(bumpFromConfigAndCommits("v1.2.3", [{ message: "BREAKING CHANGE: removed X" }], "patch")).toBe("v1.2.4");
      expect(bumpFromConfigAndCommits("0.1.16", [], "patch")).toBe("v0.1.17");
    });
    it("bumps from null/missing tag to v0.0.1", () => {
      expect(bumpFromConfigAndCommits(null, [], "patch")).toBe("v0.0.1");
    });
  });

  describe("policy=minor", () => {
    it("always bumps minor and resets patch to 0", () => {
      expect(bumpFromConfigAndCommits("v1.2.3", [{ message: "fix: x" }], "minor")).toBe("v1.3.0");
      expect(bumpFromConfigAndCommits("v0.1.16", [{ message: "feat!: breaking" }], "minor")).toBe("v0.2.0");
    });
    it("bumps from null/missing tag to v0.1.0", () => {
      expect(bumpFromConfigAndCommits(null, [], "minor")).toBe("v0.1.0");
    });
  });

  describe("policy=conventional-commits", () => {
    it("returns major when any commit has BREAKING CHANGE in body", () => {
      expect(
        bumpFromConfigAndCommits(
          "v1.2.3",
          [{ message: "feat: foo\n\nBREAKING CHANGE: removed flag" }],
          "conventional-commits",
        ),
      ).toBe("v2.0.0");
    });
    it("returns major when any commit subject has '!:'", () => {
      expect(
        bumpFromConfigAndCommits("v1.2.3", [{ message: "feat!: rewrite" }], "conventional-commits"),
      ).toBe("v2.0.0");
      expect(
        bumpFromConfigAndCommits(
          "v1.2.3",
          [{ message: "fix(api)!: change request shape" }],
          "conventional-commits",
        ),
      ).toBe("v2.0.0");
    });
    it("returns minor when any commit is feat: but none are breaking", () => {
      expect(
        bumpFromConfigAndCommits(
          "v1.2.3",
          [{ message: "feat: add X" }, { message: "fix: bug" }],
          "conventional-commits",
        ),
      ).toBe("v1.3.0");
    });
    it("returns minor for feat(scope):", () => {
      expect(
        bumpFromConfigAndCommits("v1.2.3", [{ message: "feat(api): new endpoint" }], "conventional-commits"),
      ).toBe("v1.3.0");
    });
    it("returns patch for fix:/refactor:/perf: only", () => {
      expect(
        bumpFromConfigAndCommits(
          "v1.2.3",
          [{ message: "fix: a" }, { message: "perf: b" }, { message: "refactor: c" }],
          "conventional-commits",
        ),
      ).toBe("v1.2.4");
    });
    it("returns patch for non-conforming commits (no error)", () => {
      expect(
        bumpFromConfigAndCommits(
          "v1.2.3",
          [{ message: "wip" }, { message: "merge branch 'foo'" }],
          "conventional-commits",
        ),
      ).toBe("v1.2.4");
    });
  });

  describe("leading-v handling", () => {
    it("strips leading v on input and always emits leading v", () => {
      expect(bumpFromConfigAndCommits("1.2.3", [], "patch")).toBe("v1.2.4");
      expect(bumpFromConfigAndCommits("v1.2.3", [], "patch")).toBe("v1.2.4");
    });
  });
});

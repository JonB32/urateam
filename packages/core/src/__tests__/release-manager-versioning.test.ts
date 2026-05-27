import { describe, it, expect } from "vitest";
import { bumpFromConfigAndCommits, isPrereleaseTag } from "../release-manager/versioning.js";

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

  describe("prereleaseChannel=beta", () => {
    it("starts at .1 when current tag is plain semver", () => {
      expect(bumpFromConfigAndCommits("v1.2.3", [], "patch", "beta")).toBe("v1.2.4-beta.1");
    });
    it("increments N on consecutive fires with same channel", () => {
      expect(bumpFromConfigAndCommits("v1.2.4-beta.1", [], "patch", "beta")).toBe("v1.2.4-beta.2");
      expect(bumpFromConfigAndCommits("v1.2.4-beta.2", [], "patch", "beta")).toBe("v1.2.4-beta.3");
      expect(bumpFromConfigAndCommits("v1.2.4-beta.9", [], "patch", "beta")).toBe("v1.2.4-beta.10");
    });
    it("bumps from null to v0.0.1-beta.1", () => {
      expect(bumpFromConfigAndCommits(null, [], "patch", "beta")).toBe("v0.0.1-beta.1");
    });
    it("respects minor policy when starting a new prerelease series", () => {
      expect(bumpFromConfigAndCommits("v1.2.3", [], "minor", "beta")).toBe("v1.3.0-beta.1");
    });
    it("respects conventional-commits minor when starting a prerelease series", () => {
      expect(
        bumpFromConfigAndCommits("v1.2.3", [{ message: "feat: new feature" }], "conventional-commits", "beta"),
      ).toBe("v1.3.0-beta.1");
    });
  });

  describe("prereleaseChannel=rc", () => {
    it("starts at .1 when current tag is plain semver", () => {
      expect(bumpFromConfigAndCommits("v2.0.0", [], "patch", "rc")).toBe("v2.0.1-rc.1");
    });
    it("increments N on consecutive fires", () => {
      expect(bumpFromConfigAndCommits("v2.0.1-rc.1", [], "patch", "rc")).toBe("v2.0.1-rc.2");
      expect(bumpFromConfigAndCommits("v2.0.1-rc.2", [], "patch", "rc")).toBe("v2.0.1-rc.3");
    });
  });

  describe("prereleaseChannel=alpha", () => {
    it("starts at .1 when current tag is plain semver", () => {
      expect(bumpFromConfigAndCommits("v0.5.0", [], "patch", "alpha")).toBe("v0.5.1-alpha.1");
    });
    it("increments N on consecutive fires", () => {
      expect(bumpFromConfigAndCommits("v0.5.1-alpha.1", [], "patch", "alpha")).toBe("v0.5.1-alpha.2");
    });
  });

  describe("promotion (prerelease → none)", () => {
    it("strips beta suffix, emitting plain base version", () => {
      expect(bumpFromConfigAndCommits("v1.2.4-beta.5", [], "patch", "none")).toBe("v1.2.4");
    });
    it("strips rc suffix", () => {
      expect(bumpFromConfigAndCommits("v2.0.1-rc.3", [], "patch", "none")).toBe("v2.0.1");
    });
    it("strips alpha suffix", () => {
      expect(bumpFromConfigAndCommits("v0.5.1-alpha.2", [], "patch", "none")).toBe("v0.5.1");
    });
    it("normal plain bump after promotion (last tag is now plain)", () => {
      // After promoting v1.2.4-beta.5 → v1.2.4 the tag in the repo is v1.2.4
      // The next plain bump should be v1.2.5.
      expect(bumpFromConfigAndCommits("v1.2.4", [], "patch", "none")).toBe("v1.2.5");
    });
  });

  describe("channel switch (different channel on existing prerelease)", () => {
    it("bumps the base and starts new channel at .1", () => {
      // Switching from beta to rc bumps the base and restarts at .1
      expect(bumpFromConfigAndCommits("v1.2.4-beta.5", [], "patch", "rc")).toBe("v1.2.5-rc.1");
    });
  });
});

describe("isPrereleaseTag", () => {
  it("returns true for prerelease tags", () => {
    expect(isPrereleaseTag("v1.2.3-beta.1")).toBe(true);
    expect(isPrereleaseTag("v0.0.1-rc.2")).toBe(true);
    expect(isPrereleaseTag("v10.20.30-alpha.99")).toBe(true);
  });
  it("returns false for plain semver tags", () => {
    expect(isPrereleaseTag("v1.2.3")).toBe(false);
    expect(isPrereleaseTag("1.2.3")).toBe(false);
  });
  it("returns false for empty or malformed strings", () => {
    expect(isPrereleaseTag("")).toBe(false);
    expect(isPrereleaseTag("v1.2")).toBe(false);
  });
});

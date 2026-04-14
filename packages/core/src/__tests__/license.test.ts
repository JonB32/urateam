import { describe, it, expect, beforeEach } from "vitest";
import {
  checkLicense,
  isFeatureLicensed,
  _resetLicenseCache,
} from "../license.js";

describe("checkLicense — OSS path", () => {
  beforeEach(() => {
    _resetLicenseCache();
    delete process.env.URATEAM_LICENSE_KEY;
  });

  it("returns oss tier when URATEAM_LICENSE_KEY is unset", () => {
    const status = checkLicense();
    expect(status.licensed).toBe(false);
    expect(status.tier).toBe("oss");
    expect(status.invalidReason).toBeUndefined();
    expect(status.features.size).toBe(0);
  });

  it("caches the result for the process lifetime", () => {
    const first = checkLicense();
    process.env.URATEAM_LICENSE_KEY = "anything";
    const second = checkLicense();
    expect(second).toBe(first); // same object reference
  });
});

describe("isFeatureLicensed — OSS path", () => {
  beforeEach(() => {
    _resetLicenseCache();
    delete process.env.URATEAM_LICENSE_KEY;
  });

  it("returns false for commercial features without a key", () => {
    for (const feat of [
      "slack-interface",
      "deep-review",
      "conflict-detection",
      "multi-repo",
      "stage-models",
      "advanced-automerge",
      "approval-workflows",
    ]) {
      expect(isFeatureLicensed(feat)).toBe(false);
    }
  });

  it("returns true for non-commercial / unknown features", () => {
    expect(isFeatureLicensed("pipeline-runner")).toBe(true);
    expect(isFeatureLicensed("basic-pm")).toBe(true);
    expect(isFeatureLicensed("unknown-feature")).toBe(true);
  });
});

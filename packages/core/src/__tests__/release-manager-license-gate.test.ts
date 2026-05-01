import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isFeatureLicensed, _resetLicenseCache } from "../license.js";

describe("release-manager license gate", () => {
  const originalKey = process.env.URATEAM_LICENSE_KEY;

  beforeEach(() => {
    delete process.env.URATEAM_LICENSE_KEY;
    _resetLicenseCache();
  });

  afterEach(() => {
    if (originalKey) {
      process.env.URATEAM_LICENSE_KEY = originalKey;
    } else {
      delete process.env.URATEAM_LICENSE_KEY;
    }
    _resetLicenseCache();
  });

  it("release-manager is gated (returns false without a license)", () => {
    expect(isFeatureLicensed("release-manager")).toBe(false);
  });

  it("non-commercial features still pass without a license", () => {
    expect(isFeatureLicensed("not-a-real-feature")).toBe(true);
  });
});

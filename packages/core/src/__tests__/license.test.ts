import { describe, it, expect, beforeEach } from "vitest";
import { checkLicense, isFeatureLicensed, _resetLicenseCache } from "../license.js";

describe("checkLicense", () => {
  beforeEach(() => {
    _resetLicenseCache();
    delete process.env.URATEAM_LICENSE_KEY;
  });

  it("returns unlicensed when URATEAM_LICENSE_KEY is not set", () => {
    const status = checkLicense();
    expect(status.licensed).toBe(false);
    expect(status.tier).toBe("free");
  });

  it("returns licensed when URATEAM_LICENSE_KEY is set", () => {
    process.env.URATEAM_LICENSE_KEY = "test-key-123";
    const status = checkLicense();
    expect(status.licensed).toBe(true);
    expect(status.tier).toBe("pro");
  });

  it("caches the result", () => {
    const first = checkLicense();
    process.env.URATEAM_LICENSE_KEY = "test-key-123";
    const second = checkLicense();
    expect(second.licensed).toBe(first.licensed); // cached, not re-read
  });
});

describe("isFeatureLicensed", () => {
  beforeEach(() => {
    _resetLicenseCache();
    delete process.env.URATEAM_LICENSE_KEY;
  });

  it("returns false for commercial features without key", () => {
    expect(isFeatureLicensed("slack-interface")).toBe(false);
    expect(isFeatureLicensed("deep-review")).toBe(false);
    expect(isFeatureLicensed("conflict-detection")).toBe(false);
    expect(isFeatureLicensed("multi-repo")).toBe(false);
    expect(isFeatureLicensed("stage-models")).toBe(false);
    expect(isFeatureLicensed("advanced-automerge")).toBe(false);
    expect(isFeatureLicensed("approval-workflows")).toBe(false);
  });

  it("returns true for commercial features with key", () => {
    process.env.URATEAM_LICENSE_KEY = "test-key-123";
    expect(isFeatureLicensed("slack-interface")).toBe(true);
    expect(isFeatureLicensed("deep-review")).toBe(true);
    expect(isFeatureLicensed("conflict-detection")).toBe(true);
  });

  it("always returns true for free features regardless of key", () => {
    expect(isFeatureLicensed("pipeline-runner")).toBe(true);
    expect(isFeatureLicensed("basic-pm")).toBe(true);
    expect(isFeatureLicensed("auto-merge-basic")).toBe(true);
    expect(isFeatureLicensed("unknown-feature")).toBe(true);
  });
});

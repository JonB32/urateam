import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { _resetLicenseCache, isFeatureLicensed } from "../license.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

beforeEach(() => {
  _resetLicenseCache();
});
afterEach(async () => {
  await restoreLicense();
});

describe("org-policy feature flag", () => {
  it("licensed at enterprise tier", async () => {
    await installTestProLicense("enterprise");
    expect(isFeatureLicensed("org-policy")).toBe(true);
  });

  it("not licensed at pro tier", async () => {
    await installTestProLicense("pro");
    expect(isFeatureLicensed("org-policy")).toBe(false);
  });

  it("not licensed without a license", async () => {
    await restoreLicense();
    expect(isFeatureLicensed("org-policy")).toBe(false);
  });

  it("policy module is re-exported from @urateam/core barrel", async () => {
    const mod = await import("../index.js");
    expect(typeof (mod as any).evaluatePathBlocklist).toBe("function");
    expect(typeof (mod as any).evaluateCostGate).toBe("function");
    expect(typeof (mod as any).hasOverrideLabel).toBe("function");
    expect(typeof (mod as any).buildReviewerRequest).toBe("function");
  });
});

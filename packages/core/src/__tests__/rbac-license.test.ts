import { describe, it, expect, afterEach } from "vitest";
import { _resetLicenseCache, isFeatureLicensed } from "../license.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

afterEach(async () => {
  _resetLicenseCache();
  await restoreLicense();
});

describe("rbac feature flag", () => {
  it("licensed at enterprise tier", async () => {
    await installTestProLicense("enterprise");
    expect(isFeatureLicensed("rbac")).toBe(true);
  });

  it("not licensed at pro tier", async () => {
    await installTestProLicense("pro");
    expect(isFeatureLicensed("rbac")).toBe(false);
  });

  it("not licensed without a license", async () => {
    expect(isFeatureLicensed("rbac")).toBe(false);
  });

  it("rbac module is re-exported from @urateam/core", async () => {
    const mod = await import("../index.js");
    expect(typeof (mod as any).canAccess).toBe("function");
    expect(typeof (mod as any).setUserRole).toBe("function");
    expect(typeof (mod as any).applyBootstrapAdmins).toBe("function");
  });
});

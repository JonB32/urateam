import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isFeatureLicensed, checkLicense } from "../../license.js";
import { installTestProLicense, restoreLicense } from "../helpers/license.js";

describe("sso feature flag", () => {
  afterEach(async () => {
    await restoreLicense();
  });

  it("is licensed under enterprise tier", async () => {
    await installTestProLicense("enterprise");
    expect(checkLicense().tier).toBe("enterprise");
    expect(isFeatureLicensed("sso")).toBe(true);
  });

  it("is NOT licensed under pro tier", async () => {
    await installTestProLicense("pro");
    expect(checkLicense().tier).toBe("pro");
    expect(isFeatureLicensed("sso")).toBe(false);
  });

  it("is NOT licensed under oss (no license)", async () => {
    // restore first to ensure no license env
    await restoreLicense();
    delete process.env.URATEAM_LICENSE_KEY;
    const { _resetLicenseCache } = await import("../../license.js");
    _resetLicenseCache();
    expect(checkLicense().tier).toBe("oss");
    expect(isFeatureLicensed("sso")).toBe(false);
  });

  it("is re-exported from the @urateam/core barrel", async () => {
    const core = await import("../../index.js");
    expect(typeof (core as Record<string, unknown>).upsertUser).toBe("function");
    expect(typeof (core as Record<string, unknown>).createSession).toBe("function");
  });
});

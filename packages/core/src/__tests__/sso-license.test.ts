import { describe, it, expect, afterEach } from "vitest";
import { _resetLicenseCache, LicenseRequiredError } from "../license.js";
import { getDefaultWorkosClient, _resetWorkosClient } from "../auth/workos-client.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

afterEach(async () => {
  _resetWorkosClient();
  _resetLicenseCache();
  await restoreLicense();
});

describe("getDefaultWorkosClient license gate", () => {
  it("rejects with LicenseRequiredError in OSS mode", async () => {
    await expect(getDefaultWorkosClient("sk_test_unused")).rejects.toBeInstanceOf(
      LicenseRequiredError,
    );
  });

  it("LicenseRequiredError carries feature + actual tier (oss in OSS mode)", async () => {
    try {
      await getDefaultWorkosClient("sk_test_unused");
      expect.fail("expected LicenseRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(LicenseRequiredError);
      expect((err as LicenseRequiredError).feature).toBe("sso");
      expect((err as LicenseRequiredError).actualTier).toBe("oss");
    }
  });

  it("does not attempt to import the WorkOS SDK in OSS mode", async () => {
    // The SDK package is not declared as a dep of @urateam/core (intentional —
    // dashboard provides it at runtime). If the gate didn't fire, the dynamic
    // import would throw a "Cannot find module" error rather than our typed
    // LicenseRequiredError. Asserting the typed error implicitly proves the
    // gate runs before the import.
    await expect(getDefaultWorkosClient("sk_test_unused")).rejects.toMatchObject({
      name: "LicenseRequiredError",
      feature: "sso",
    });
  });

  it("rejects with actualTier='pro' when license is pro (sso is enterprise-only)", async () => {
    await installTestProLicense("pro");
    await expect(getDefaultWorkosClient("sk_test_unused")).rejects.toMatchObject({
      name: "LicenseRequiredError",
      feature: "sso",
      actualTier: "pro",
    });
  });

  // Note: positive-path "with enterprise license, returns a client" is not
  // asserted here because the @workos-inc/node SDK is not installed in
  // @urateam/core's node_modules. The dashboard's own integration tests
  // exercise the licensed path with the SDK present.
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { checkLicense, _resetLicenseCache } from "../license.js";
// Direct relative import into the CLI package's compiled output. This
// deliberately avoids declaring @urateam/cli as a devDep of @urateam/core
// to keep the dependency direction one-way (cli depends on core, not the
// reverse). The CLI must be built (`pnpm --filter @urateam/cli build`)
// before this test runs — pnpm test runs cli's build task in parallel.
// @ts-ignore — relative path into a sibling package's dist/
import { issueLicense } from "../../../cli/dist/commands/license.js";

describe("license end-to-end (CLI issue → core validate)", () => {
  let originalSigningKey: string | undefined;
  let originalLicenseKey: string | undefined;
  let originalPublicKey: string | undefined;

  beforeEach(async () => {
    _resetLicenseCache();
    originalSigningKey = process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
    originalLicenseKey = process.env.URATEAM_LICENSE_KEY;

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64 = Buffer.from(
      privateKey.export({ format: "der", type: "pkcs8" }),
    ).toString("base64");

    const mod = await import("../license-public-key.js");
    originalPublicKey = (mod as { LICENSE_PUBLIC_KEY_DER_B64: string }).LICENSE_PUBLIC_KEY_DER_B64;
    Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
      value: Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(async () => {
    process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64 = originalSigningKey;
    if (originalLicenseKey === undefined) delete process.env.URATEAM_LICENSE_KEY;
    else process.env.URATEAM_LICENSE_KEY = originalLicenseKey;

    if (originalPublicKey !== undefined) {
      const mod = await import("../license-public-key.js");
      Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
        value: originalPublicKey,
        writable: true,
        configurable: true,
      });
    }
  });

  it("CLI-issued enterprise JWT validates and unlocks enterprise features", () => {
    const token = issueLicense({
      customerId: "cust_e2e",
      tier: "enterprise",
      seats: null,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    process.env.URATEAM_LICENSE_KEY = token;

    const status = checkLicense();
    expect(status.licensed).toBe(true);
    expect(status.tier).toBe("enterprise");
    expect(status.customerId).toBe("cust_e2e");
    expect(status.features.has("sso")).toBe(true);
    expect(status.features.has("audit-log")).toBe(true);
  });
});

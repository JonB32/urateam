import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { checkLicense, _resetLicenseCache } from "../license.js";

// Direct relative import into the CLI package's compiled output. This
// deliberately avoids declaring @urateam/cli as a devDep of @urateam/core
// to keep the dependency direction one-way (cli depends on core, not the
// reverse). The CLI must be built (`pnpm --filter @urateam/cli build`)
// before this test runs. We use a dynamic import inside beforeAll so the
// guard can build cli on-demand if its dist/ is missing — a static import
// would be hoisted and fail at module-load time before the guard runs.
type IssueLicenseFn = (args: {
  customerId: string;
  tier: "enterprise" | "team" | "personal";
  seats: number | null;
  expiresAt: Date;
}) => string;

describe("license end-to-end (CLI issue → core validate)", () => {
  let originalSigningKey: string | undefined;
  let originalLicenseKey: string | undefined;
  let originalPublicKey: string | undefined;
  let issueLicense: IssueLicenseFn;

  // The CLI package's compiled output must exist before this test can import
  // issueLicense() from it. turbo's task graph does not express this dependency
  // (core:test does not depend on cli:build — see PR #34 cross-task review),
  // so a `pnpm clean && pnpm test` run could otherwise execute this test before
  // cli is built and fail with ERR_MODULE_NOT_FOUND. We make the test
  // self-sufficient by building cli on-demand if its dist/ is missing.
  beforeAll(async () => {
    const cliDist = resolve(__dirname, "..", "..", "..", "cli", "dist", "commands", "license.js");
    if (!existsSync(cliDist)) {
      execFileSync("pnpm", ["--filter", "@urateam/cli", "build"], {
        stdio: "inherit",
        cwd: resolve(__dirname, "..", "..", "..", ".."),
      });
    }
    // @ts-ignore — relative path into a sibling package's dist/
    const mod = await import("../../../cli/dist/commands/license.js");
    issueLicense = (mod as { issueLicense: IssueLicenseFn }).issueLicense;
  }, 60_000);

  beforeEach(async () => {
    _resetLicenseCache();
    originalSigningKey = process.env.URATEAM_LICENSE_SIGNING_KEY;
    originalLicenseKey = process.env.URATEAM_LICENSE_KEY;

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    process.env.URATEAM_LICENSE_SIGNING_KEY = Buffer.from(
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
    process.env.URATEAM_LICENSE_SIGNING_KEY = originalSigningKey;
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

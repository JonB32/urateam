/**
 * Test helper: install a valid signed pro-tier license JWT for tests that
 * exercise license-gated features. Generates a fresh ed25519 keypair, patches
 * the embedded public key, and signs a pro-tier JWT into URATEAM_LICENSE_KEY.
 *
 * Use in `beforeEach`:
 *
 *   import { installTestProLicense, restoreLicense } from "./helpers/license.js";
 *   beforeEach(async () => { await installTestProLicense(); });
 *   afterEach(async () => { await restoreLicense(); });
 */
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { _resetLicenseCache } from "../../license.js";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(privateKey: KeyObject, payload: object): string {
  const header = { alg: "EdDSA", typ: "JWT" };
  const headerB64 = b64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

let originalPublicKey: string | undefined;
let originalEnv: string | undefined;

export async function installTestProLicense(
  tier: "pro" | "enterprise" = "pro",
): Promise<void> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyB64 = Buffer.from(
    publicKey.export({ format: "der", type: "spki" }),
  ).toString("base64");

  const mod = await import("../../license-public-key.js");
  if (originalPublicKey === undefined) {
    originalPublicKey = (mod as { LICENSE_PUBLIC_KEY_DER_B64: string })
      .LICENSE_PUBLIC_KEY_DER_B64;
  }
  Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
    value: publicKeyB64,
    writable: true,
    configurable: true,
  });

  const now = Math.floor(Date.now() / 1000);
  const jwt = makeJwt(privateKey, {
    iss: "urateams.com",
    sub: "cust_test",
    tier,
    seats: 25,
    iat: now,
    exp: now + 86_400,
  });

  if (originalEnv === undefined) {
    originalEnv = process.env.URATEAM_LICENSE_KEY;
  }
  process.env.URATEAM_LICENSE_KEY = jwt;
  _resetLicenseCache();
}

export async function restoreLicense(): Promise<void> {
  if (originalPublicKey !== undefined) {
    const mod = await import("../../license-public-key.js");
    Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
      value: originalPublicKey,
      writable: true,
      configurable: true,
    });
    originalPublicKey = undefined;
  }
  if (originalEnv === undefined) {
    delete process.env.URATEAM_LICENSE_KEY;
  } else {
    process.env.URATEAM_LICENSE_KEY = originalEnv;
    originalEnv = undefined;
  }
  _resetLicenseCache();
}

import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { _resetLicenseCache } from "@urateam/core/dist/license.js";

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(privateKey: KeyObject, payload: object): string {
  const header = { alg: "EdDSA", typ: "JWT" };
  const headerB64 = b64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

let savedPublicKey: string | undefined;
let savedEnv: string | undefined;

/**
 * Install a test license at the requested tier, replacing the embedded
 * public key with a generated one so the JWT verifies. Used by dashboard
 * tests for enterprise-tier features (audit-log, sso).
 */
export async function installTestProLicense(
  tier: "pro" | "enterprise" = "enterprise",
): Promise<void> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyB64 = Buffer.from(
    publicKey.export({ format: "der", type: "spki" }),
  ).toString("base64");

  const mod = await import("@urateam/core/dist/license-public-key.js");
  if (savedPublicKey === undefined) {
    savedPublicKey = (mod as { LICENSE_PUBLIC_KEY_DER_B64: string })
      .LICENSE_PUBLIC_KEY_DER_B64;
  }
  Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
    value: publicKeyB64,
    writable: true,
    configurable: true,
  });

  const now = Math.floor(Date.now() / 1000);
  const jwt = makeJwt(privateKey, {
    iss: "urateam.dev",
    sub: "cust_test",
    tier,
    seats: 25,
    iat: now,
    exp: now + 86_400,
  });

  if (savedEnv === undefined) savedEnv = process.env.URATEAM_LICENSE_KEY;
  process.env.URATEAM_LICENSE_KEY = jwt;
  _resetLicenseCache();
}

export async function restoreLicense(): Promise<void> {
  if (savedPublicKey !== undefined) {
    const mod = await import("@urateam/core/dist/license-public-key.js");
    Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
      value: savedPublicKey,
      writable: true,
      configurable: true,
    });
    savedPublicKey = undefined;
  }
  if (savedEnv === undefined) {
    delete process.env.URATEAM_LICENSE_KEY;
  } else {
    process.env.URATEAM_LICENSE_KEY = savedEnv;
    savedEnv = undefined;
  }
  _resetLicenseCache();
}

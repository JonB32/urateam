import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import {
  checkLicense,
  isFeatureLicensed,
  _resetLicenseCache,
} from "../license.js";

describe("checkLicense — OSS path", () => {
  beforeEach(() => {
    _resetLicenseCache();
    delete process.env.URATEAM_LICENSE_KEY;
  });

  it("returns oss tier when URATEAM_LICENSE_KEY is unset", () => {
    const status = checkLicense();
    expect(status.licensed).toBe(false);
    expect(status.tier).toBe("oss");
    expect(status.invalidReason).toBeUndefined();
    expect(status.features.size).toBe(0);
  });

  it("caches the result for the process lifetime", () => {
    const first = checkLicense();
    process.env.URATEAM_LICENSE_KEY = "anything";
    const second = checkLicense();
    expect(second).toBe(first); // same object reference
  });
});

describe("isFeatureLicensed — OSS path", () => {
  beforeEach(() => {
    _resetLicenseCache();
    delete process.env.URATEAM_LICENSE_KEY;
  });

  it("returns false for commercial features without a key", () => {
    for (const feat of [
      "slack-interface",
      "deep-review",
      "conflict-detection",
      "multi-repo",
      "stage-models",
      "advanced-automerge",
      "approval-workflows",
    ]) {
      expect(isFeatureLicensed(feat)).toBe(false);
    }
  });

  it("returns true for non-commercial / unknown features", () => {
    expect(isFeatureLicensed("pipeline-runner")).toBe(true);
    expect(isFeatureLicensed("basic-pm")).toBe(true);
    expect(isFeatureLicensed("unknown-feature")).toBe(true);
  });
});

// --- Test helpers: locally generated keypair, used to sign sample JWTs ---
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(privateKey: ReturnType<typeof createPrivateKey>, payload: object): string {
  const header = { alg: "EdDSA", typ: "JWT" };
  const headerB64 = b64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

describe("checkLicense — JWT validation", () => {
  let publicKeyB64: string;
  let privateKey: ReturnType<typeof createPrivateKey>;
  let originalPublicKey: string | undefined;

  beforeEach(async () => {
    _resetLicenseCache();
    delete process.env.URATEAM_LICENSE_KEY;

    const { publicKey, privateKey: priv } = generateKeyPairSync("ed25519");
    publicKeyB64 = Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64");
    privateKey = priv;

    const mod = await import("../license-public-key.js");
    originalPublicKey = (mod as { LICENSE_PUBLIC_KEY_DER_B64: string }).LICENSE_PUBLIC_KEY_DER_B64;
    Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
      value: publicKeyB64,
      writable: true,
      configurable: true,
    });
  });

  afterEach(async () => {
    if (originalPublicKey !== undefined) {
      const mod = await import("../license-public-key.js");
      Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
        value: originalPublicKey,
        writable: true,
        configurable: true,
      });
    }
  });

  const now = () => Math.floor(Date.now() / 1000);

  it("accepts a valid pro JWT", () => {
    process.env.URATEAM_LICENSE_KEY = makeJwt(privateKey, {
      iss: "urateam.dev",
      sub: "cust_test",
      tier: "pro",
      seats: 25,
      iat: now(),
      exp: now() + 86_400,
    });
    const status = checkLicense();
    expect(status.licensed).toBe(true);
    expect(status.tier).toBe("pro");
    expect(status.customerId).toBe("cust_test");
    expect(status.seats).toBe(25);
    expect(status.features.has("slack-interface")).toBe(true);
    expect(status.features.has("sso")).toBe(false);
  });

  it("accepts a valid enterprise JWT and unlocks enterprise features", () => {
    process.env.URATEAM_LICENSE_KEY = makeJwt(privateKey, {
      iss: "urateam.dev",
      sub: "cust_acme",
      tier: "enterprise",
      seats: null,
      iat: now(),
      exp: now() + 86_400,
    });
    const status = checkLicense();
    expect(status.licensed).toBe(true);
    expect(status.tier).toBe("enterprise");
    expect(status.features.has("sso")).toBe(true);
    expect(status.features.has("audit-log")).toBe(true);
    expect(status.features.has("slack-interface")).toBe(true);
  });

  it("respects an explicit `features` override array in the JWT", () => {
    process.env.URATEAM_LICENSE_KEY = makeJwt(privateKey, {
      iss: "urateam.dev",
      sub: "cust_partial",
      tier: "pro",
      seats: 5,
      iat: now(),
      exp: now() + 86_400,
      features: ["slack-interface", "sso"],
    });
    const status = checkLicense();
    expect(status.licensed).toBe(true);
    expect(status.features.has("slack-interface")).toBe(true);
    expect(status.features.has("sso")).toBe(true);
    expect(status.features.has("multi-repo")).toBe(false);
  });

  it("rejects an expired JWT with invalidReason='expired'", () => {
    process.env.URATEAM_LICENSE_KEY = makeJwt(privateKey, {
      iss: "urateam.dev",
      sub: "cust_test",
      tier: "pro",
      seats: 25,
      iat: now() - 100_000,
      exp: now() - 1,
    });
    const status = checkLicense();
    expect(status.licensed).toBe(false);
    expect(status.tier).toBe("oss");
    expect(status.invalidReason).toBe("expired");
  });

  it("rejects a wrong-issuer JWT with invalidReason='wrong-issuer'", () => {
    process.env.URATEAM_LICENSE_KEY = makeJwt(privateKey, {
      iss: "evil.dev",
      sub: "cust_test",
      tier: "enterprise",
      seats: null,
      iat: now(),
      exp: now() + 86_400,
    });
    const status = checkLicense();
    expect(status.tier).toBe("oss");
    expect(status.invalidReason).toBe("wrong-issuer");
  });

  it("rejects a JWT signed with the wrong key (bad signature)", () => {
    const { privateKey: otherPriv } = generateKeyPairSync("ed25519");
    process.env.URATEAM_LICENSE_KEY = makeJwt(otherPriv, {
      iss: "urateam.dev",
      sub: "cust_test",
      tier: "enterprise",
      seats: null,
      iat: now(),
      exp: now() + 86_400,
    });
    const status = checkLicense();
    expect(status.tier).toBe("oss");
    expect(status.invalidReason).toBe("bad-signature");
  });

  it("rejects a malformed JWT (not three parts) with invalidReason='malformed'", () => {
    process.env.URATEAM_LICENSE_KEY = "this.is-not-a-jwt";
    const status = checkLicense();
    expect(status.tier).toBe("oss");
    expect(status.invalidReason).toBe("malformed");
  });
});

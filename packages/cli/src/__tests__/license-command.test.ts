import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { issueLicense } from "../commands/license.js";

describe("issueLicense", () => {
  let publicKeyDer: Buffer;
  let originalSigningKey: string | undefined;

  beforeEach(() => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    publicKeyDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
    originalSigningKey = process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
    process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64 = Buffer.from(
      privateKey.export({ format: "der", type: "pkcs8" }),
    ).toString("base64");
  });

  afterEach(() => {
    if (originalSigningKey === undefined) {
      delete process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
    } else {
      process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64 = originalSigningKey;
    }
  });

  function decodeJwt(token: string): { header: object; payload: Record<string, unknown> } {
    const [h, p] = token.split(".");
    const fromB64Url = (s: string) =>
      Buffer.from(
        s.replace(/-/g, "+").replace(/_/g, "/") +
          "=".repeat((4 - (s.length % 4)) % 4),
        "base64",
      ).toString("utf-8");
    return { header: JSON.parse(fromB64Url(h)), payload: JSON.parse(fromB64Url(p)) };
  }

  it("issues a signed JWT with the requested claims", () => {
    const token = issueLicense({
      customerId: "cust_acme",
      tier: "enterprise",
      seats: 100,
      expiresAt: new Date("2027-04-13T00:00:00Z"),
    });

    const { header, payload } = decodeJwt(token);
    expect(header).toEqual({ alg: "EdDSA", typ: "JWT" });
    expect(payload.iss).toBe("urateams.com");
    expect(payload.sub).toBe("cust_acme");
    expect(payload.tier).toBe("enterprise");
    expect(payload.seats).toBe(100);
    expect(payload.exp).toBe(Math.floor(new Date("2027-04-13T00:00:00Z").getTime() / 1000));
  });

  it("produces a JWT whose signature verifies with the matching public key", () => {
    const token = issueLicense({
      customerId: "cust_test",
      tier: "pro",
      seats: 25,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const [h, p, s] = token.split(".");
    const signingInput = Buffer.from(`${h}.${p}`);
    const fromB64Url = (str: string) =>
      Buffer.from(
        str.replace(/-/g, "+").replace(/_/g, "/") +
          "=".repeat((4 - (str.length % 4)) % 4),
        "base64",
      );
    const sig = fromB64Url(s);
    const pk = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    expect(verify(null, signingInput, pk, sig)).toBe(true);
  });

  it("throws when URATEAM_LICENSE_SIGNING_KEY_DER_B64 is not set", () => {
    delete process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
    expect(() =>
      issueLicense({
        customerId: "cust_test",
        tier: "pro",
        seats: 25,
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ).toThrow(/URATEAM_LICENSE_SIGNING_KEY_DER_B64/);
  });
});

describe("licenseCommand action", () => {
  let originalSigningKey: string | undefined;

  beforeEach(() => {
    const { privateKey } = generateKeyPairSync("ed25519");
    originalSigningKey = process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
    process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64 = Buffer.from(
      privateKey.export({ format: "der", type: "pkcs8" }),
    ).toString("base64");
  });

  afterEach(() => {
    if (originalSigningKey === undefined) {
      delete process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
    } else {
      process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64 = originalSigningKey;
    }
  });

  it("rejects --seats 0 instead of silently issuing an unlimited license", async () => {
    const { licenseCommand } = await import("../commands/license.js");
    licenseCommand.exitOverride(); // throw instead of process.exit on commander errors

    await expect(
      licenseCommand.parseAsync(
        [
          "issue",
          "--customer-id", "cust_test",
          "--tier", "pro",
          "--expires", "2027-12-31",
          "--seats", "0",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow(/--seats must be a positive integer/);
  });

  it("rejects an unknown --tier value", async () => {
    const { licenseCommand } = await import("../commands/license.js");
    licenseCommand.exitOverride();

    await expect(
      licenseCommand.parseAsync(
        [
          "issue",
          "--customer-id", "cust_test",
          "--tier", "free",
          "--expires", "2027-12-31",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow(/tier must be 'pro' or 'enterprise'/);
  });

  it("rejects an unparseable --expires", async () => {
    const { licenseCommand } = await import("../commands/license.js");
    licenseCommand.exitOverride();

    await expect(
      licenseCommand.parseAsync(
        [
          "issue",
          "--customer-id", "cust_test",
          "--tier", "pro",
          "--expires", "not-a-date",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow(/invalid --expires/);
  });
});

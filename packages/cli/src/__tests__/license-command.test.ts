import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { issueLicense } from "../commands/license.js";

const SIGNING_KEY_VARS = ["URATEAM_LICENSE_SIGNING_KEY", "URATEAM_LICENSE_SIGNING_KEY_DER_B64"] as const;

function snapshotSigningKeyEnv(): Record<string, string | undefined> {
  return Object.fromEntries(SIGNING_KEY_VARS.map((k) => [k, process.env[k]]));
}

function restoreSigningKeyEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of SIGNING_KEY_VARS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
}

describe("issueLicense", () => {
  let publicKeyDer: Buffer;
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    publicKeyDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
    envSnapshot = snapshotSigningKeyEnv();
    delete process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
    process.env.URATEAM_LICENSE_SIGNING_KEY = Buffer.from(
      privateKey.export({ format: "der", type: "pkcs8" }),
    ).toString("base64");
  });

  afterEach(() => {
    restoreSigningKeyEnv(envSnapshot);
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

  it("accepts a PEM-wrapped PKCS8 key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
    process.env.URATEAM_LICENSE_SIGNING_KEY = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();

    const token = issueLicense({
      customerId: "cust_pem",
      tier: "pro",
      seats: 5,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const [h, p, s] = token.split(".");
    const sig = Buffer.from(
      s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4),
      "base64",
    );
    const pk = createPublicKey({ key: pubDer, format: "der", type: "spki" });
    expect(verify(null, Buffer.from(`${h}.${p}`), pk, sig)).toBe(true);
  });

  it("tolerates whitespace around a DER-base64 key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const b64 = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64");
    process.env.URATEAM_LICENSE_SIGNING_KEY = `\n  ${b64}\n`;

    expect(() =>
      issueLicense({
        customerId: "cust_ws",
        tier: "pro",
        seats: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ).not.toThrow();
  });

  it("falls back to deprecated URATEAM_LICENSE_SIGNING_KEY_DER_B64 with a warning", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    delete process.env.URATEAM_LICENSE_SIGNING_KEY;
    process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64 = Buffer.from(
      privateKey.export({ format: "der", type: "pkcs8" }),
    ).toString("base64");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() =>
      issueLicense({
        customerId: "cust_legacy",
        tier: "pro",
        seats: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("deprecated"));
    warnSpy.mockRestore();
  });

  it("rejects a non-Ed25519 key (e.g. RSA) before producing a mismatched JWT", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.URATEAM_LICENSE_SIGNING_KEY = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();

    expect(() =>
      issueLicense({
        customerId: "cust_rsa",
        tier: "pro",
        seats: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ).toThrow(/must be an Ed25519 key, got rsa/);
  });

  it("throws when no signing key env var is set", () => {
    delete process.env.URATEAM_LICENSE_SIGNING_KEY;
    delete process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
    expect(() =>
      issueLicense({
        customerId: "cust_test",
        tier: "pro",
        seats: 25,
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ).toThrow(/URATEAM_LICENSE_SIGNING_KEY/);
  });
});

describe("licenseCommand action", () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    const { privateKey } = generateKeyPairSync("ed25519");
    envSnapshot = snapshotSigningKeyEnv();
    delete process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
    process.env.URATEAM_LICENSE_SIGNING_KEY = Buffer.from(
      privateKey.export({ format: "der", type: "pkcs8" }),
    ).toString("base64");
  });

  afterEach(() => {
    restoreSigningKeyEnv(envSnapshot);
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

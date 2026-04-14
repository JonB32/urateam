import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { checkLicense, _resetLicenseCache } from "../license.js";

describe("checkLicense — audit event on invalid license", () => {
  beforeEach(() => {
    _resetLicenseCache();
    delete process.env.URATEAM_LICENSE_KEY;
  });

  afterEach(() => {
    _resetLicenseCache();
    delete process.env.URATEAM_LICENSE_KEY;
  });

  it("emits license.validation_failed when license key is bad-signature", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    // A syntactically-valid JWT shape (three parts, EdDSA header) but bogus
    // signature — verifyJwt returns { ok: false, reason: "bad-signature" }.
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "urateam.dev",
        sub: "cust",
        tier: "pro",
        iat: 1,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const sig = "AAAA";
    process.env.URATEAM_LICENSE_KEY = `${header}.${payload}.${sig}`;

    const status = checkLicense(db as any);
    expect(status.licensed).toBe(false);
    expect(status.tier).toBe("oss");
    expect(status.invalidReason).toBe("bad-signature");

    // void logAuditEvent — flush microtask
    await new Promise((r) => setImmediate(r));

    const rows = await (db as any).select().from(auditEvents);
    const failures = rows.filter(
      (r: any) => r.eventType === "license.validation_failed",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].actor).toBe("system");
    expect(failures[0].actorType).toBe("system");
    const payloadJson = JSON.parse(failures[0].payload);
    expect(payloadJson.invalidReason).toBe("bad-signature");
  });

  it("does not emit an audit event when no license key is set (OSS mode)", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const status = checkLicense(db as any);
    expect(status.tier).toBe("oss");
    expect(status.invalidReason).toBeUndefined();

    await new Promise((r) => setImmediate(r));
    const rows = await (db as any).select().from(auditEvents);
    expect(rows).toHaveLength(0);
  });
});

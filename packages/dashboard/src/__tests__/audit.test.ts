import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { Hono } from "hono";
import { createDashboard } from "../server.js";
import { createDb } from "@urateam/core";
import type { Db } from "@urateam/core";
import { auditEvents } from "@urateam/core/dist/db/schema.js";
import { _resetLicenseCache } from "@urateam/core/dist/license.js";

// ---------------- license test helper (inlined) ----------------
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

async function installEnterpriseLicense(): Promise<void> {
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
    tier: "enterprise",
    seats: 25,
    iat: now,
    exp: now + 86_400,
  });

  if (savedEnv === undefined) savedEnv = process.env.URATEAM_LICENSE_KEY;
  process.env.URATEAM_LICENSE_KEY = jwt;
  _resetLicenseCache();
}

async function restoreLicense(): Promise<void> {
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

function basicAuthHeader(u: string, p: string): string {
  return "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
}

const AUTH = { Authorization: basicAuthHeader("admin", "secret") };

async function seedAuditEvent(db: Db): Promise<void> {
  await (db as any).insert(auditEvents).values({
    id: "evt-test-1",
    timestamp: new Date(),
    eventType: "pm.issue_promoted",
    actor: "pm-agent",
    actorType: "pm-agent",
    scope: "pm",
    runId: null,
    issueId: "ISS-1",
    inputTokens: 0,
    outputTokens: 0,
    payload: JSON.stringify({ reason: "ready" }),
  });
}

// ---------------- tests ----------------
describe("audit route — unlicensed", () => {
  beforeEach(async () => {
    await restoreLicense(); // ensure no license
  });

  it("returns 404 for GET /audit when feature is not licensed", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const app = createDashboard({
      db,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: { username: "admin", password: "secret" },
    });

    const res = await app.request("/audit", { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it("returns 404 for GET /audit/export.csv when feature is not licensed", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const app = createDashboard({
      db,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: { username: "admin", password: "secret" },
    });

    const res = await app.request("/audit/export.csv", { headers: AUTH });
    expect(res.status).toBe(404);
  });
});

describe("audit route — licensed (enterprise)", () => {
  beforeEach(async () => {
    await installEnterpriseLicense();
  });
  afterEach(async () => {
    await restoreLicense();
  });

  // Enterprise tier enables `rbac`, so `requirePermission("audit.view")`
  // requires a `user` in context. Wrap the dashboard in an outer Hono and
  // inject a stub admin user so tests that run in enterprise mode pass.
  function wrapWithAdminUser(inner: Hono): Hono {
    const outer = new Hono();
    outer.use("*", async (c, next) => {
      c.set("user" as never, {
        id: "u_admin",
        email: "admin@b.com",
        role: "admin",
      } as any);
      await next();
    });
    outer.route("/", inner);
    return outer;
  }

  it("GET /audit returns 200 and renders a seeded event", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await seedAuditEvent(db);

    const app = wrapWithAdminUser(
      createDashboard({
        db,
        pipelineConfigs: {},
        repoConfigs: {},
        auth: { username: "admin", password: "secret" },
      }),
    );

    const res = await app.request("/audit", { headers: AUTH });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("pm.issue_promoted");
    expect(html).toContain("Audit Log");
  });

  it("GET /audit/event/:id returns detail row with full payload", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await seedAuditEvent(db);

    const app = wrapWithAdminUser(
      createDashboard({
        db,
        pipelineConfigs: {},
        repoConfigs: {},
        auth: { username: "admin", password: "secret" },
      }),
    );

    const res = await app.request("/audit/event/evt-test-1", { headers: AUTH });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("audit-detail-row");
    expect(html).toContain("evt-test-1");
    // Full payload JSON must be present (formatted with 2-space indent).
    expect(html).toContain("&quot;reason&quot;: &quot;ready&quot;");
  });

  it("GET /audit/event/:id returns 404 for missing event", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    const app = wrapWithAdminUser(
      createDashboard({
        db,
        pipelineConfigs: {},
        repoConfigs: {},
        auth: { username: "admin", password: "secret" },
      }),
    );

    // Return 200 (not 404) so HTMX renders the error fragment in the DOM.
    const res = await app.request("/audit/event/does-not-exist", { headers: AUTH });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Event not found");
  });

  it("GET /audit includes expand button with hx-get pointing to /audit/event/:id", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await seedAuditEvent(db);

    const app = wrapWithAdminUser(
      createDashboard({
        db,
        pipelineConfigs: {},
        repoConfigs: {},
        auth: { username: "admin", password: "secret" },
      }),
    );

    const res = await app.request("/audit", { headers: AUTH });
    const html = await res.text();
    expect(html).toContain('hx-get="/audit/event/evt-test-1"');
    expect(html).toContain('hx-swap="afterend"');
  });

  it("GET /audit/export.csv returns 200 text/csv with the header row", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await seedAuditEvent(db);

    const app = wrapWithAdminUser(
      createDashboard({
        db,
        pipelineConfigs: {},
        repoConfigs: {},
        auth: { username: "admin", password: "secret" },
      }),
    );

    const res = await app.request("/audit/export.csv", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/csv");

    const body = await res.text();
    expect(body).toContain(
      "timestamp_utc,event_type,actor,actor_type,scope,run_id,issue_id,input_tokens,output_tokens,payload_json",
    );
    expect(body).toContain("pm.issue_promoted");
  });
});

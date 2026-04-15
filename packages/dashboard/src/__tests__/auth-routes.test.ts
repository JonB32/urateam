import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createDb, signState } from "@urateam/core";
import type { WorkosClient } from "@urateam/core";
import {
  auditEvents,
  dashboardSessions,
} from "@urateam/core/dist/db/schema.js";
import { createAuthRouter } from "../routes/auth.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

let db: any;
const ssoConfig = {
  enabled: true,
  workosApiKey: "sk_test",
  workosClientId: "client_test",
  redirectUri: "https://x/auth/callback",
  allowedDomain: undefined as string | undefined,
  sessionDurationHours: 24,
  cookieName: "urateam_session",
  cookieSecure: false,
  stateSigningSecret: "0123456789abcdef0123456789abcdef",
};

const stubWorkos: WorkosClient = {
  async getAuthorizationUrl(args) {
    return `https://workos.example/auth?state=${args.state}&client=${args.clientId}`;
  },
  async authenticateWithCode(_args) {
    return {
      user: {
        id: "wu_test",
        email: "alice@acme.com",
        firstName: "Alice",
        lastName: "X",
      },
    };
  },
};

beforeEach(async () => {
  await installTestProLicense("enterprise");
  db = await createDb({ connectionString: ":memory:" });
});

afterEach(async () => {
  await restoreLicense();
});

function buildApp() {
  const app = new Hono();
  app.route(
    "/",
    createAuthRouter({ db, sso: ssoConfig as any, workos: stubWorkos }),
  );
  return app;
}

// flush fire-and-forget audit writes
async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("/auth/login", () => {
  it("returns 302 to a workos url with a signed state", async () => {
    const res = await buildApp().request("/auth/login?next=/runs");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("workos.example");
    expect(loc).toContain("state=");
  });
});

describe("/auth/callback", () => {
  it("creates a session, sets cookie, writes audit event, redirects to next", async () => {
    const state = signState(
      { next: "/runs", nonce: "n" },
      ssoConfig.stateSigningSecret,
    );
    const res = await buildApp().request(
      `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/runs");
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain("urateam_session=");
    expect(setCookie).toContain("HttpOnly");
    const sessions = await db.select().from(dashboardSessions);
    expect(sessions).toHaveLength(1);
    await tick();
    const events = await db.select().from(auditEvents);
    expect(
      events.find((e: any) => e.eventType === "dashboard.login"),
    ).toBeDefined();
  });

  it("returns 400 on state mismatch", async () => {
    const res = await buildApp().request(
      `/auth/callback?code=abc&state=garbage`,
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 + audit event when allowedDomain rejects", async () => {
    ssoConfig.allowedDomain = "evil.com";
    const state = signState(
      { next: "/", nonce: "n" },
      ssoConfig.stateSigningSecret,
    );
    const res = await buildApp().request(
      `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(403);
    await tick();
    const events = await db.select().from(auditEvents);
    expect(
      events.find((e: any) => e.eventType === "dashboard.login_denied"),
    ).toBeDefined();
    ssoConfig.allowedDomain = undefined;
  });
});

describe("/auth/logout", () => {
  it("deletes session, clears cookie, writes logout event", async () => {
    const state = signState(
      { next: "/", nonce: "n" },
      ssoConfig.stateSigningSecret,
    );
    const cb = await buildApp().request(
      `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    const cookieHeader = cb.headers.get("set-cookie")!;
    const sid = cookieHeader.match(/urateam_session=([^;]+)/)![1];

    const res = await buildApp().request("/auth/logout", {
      method: "POST",
      headers: { cookie: `urateam_session=${sid}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
    const sessions = await db.select().from(dashboardSessions);
    expect(sessions).toHaveLength(0);
    await tick();
    const events = await db.select().from(auditEvents);
    expect(
      events.find((e: any) => e.eventType === "dashboard.logout"),
    ).toBeDefined();
  });
});

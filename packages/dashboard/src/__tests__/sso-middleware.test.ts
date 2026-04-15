import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createDb, upsertUser, createSession } from "@urateam/core";
import { createSsoMiddleware } from "../middleware/sso.js";

let db: any;
let userId: string;

const ssoConfig = {
  enabled: true,
  workosApiKey: "sk_test",
  workosClientId: "client_test",
  redirectUri: "https://x/auth/callback",
  sessionDurationHours: 24,
  cookieName: "urateam_session",
  cookieSecure: false,
  stateSigningSecret: "0123456789abcdef0123456789abcdef",
} as const;

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
  userId = await upsertUser(db, {
    email: "a@b.com",
    name: "A",
    workosUserId: null,
  });
});

function appWithSso() {
  const app = new Hono();
  app.use("*", createSsoMiddleware({ db, sso: ssoConfig as any }));
  app.get("/runs", (c) => c.text(`hello ${(c.get("user" as never) as any).email}`));
  app.post("/webhooks/linear", (c) => c.text("ok"));
  app.get("/auth/login", (c) => c.text("login page"));
  return app;
}

describe("ssoMiddleware", () => {
  it("redirects to /auth/login when no cookie present", async () => {
    const res = await appWithSso().request("/runs");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/login");
    expect(res.headers.get("location")).toContain("next=%2Fruns");
  });

  it("allows /auth/* paths through without a cookie", async () => {
    const res = await appWithSso().request("/auth/login");
    expect(res.status).toBe(200);
  });

  it("allows /webhooks/* paths through without a cookie", async () => {
    const res = await appWithSso().request("/webhooks/linear", {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  it("returns 200 with c.get('user') populated when valid session cookie present", async () => {
    const sid = await createSession(db, { userId, durationHours: 24 });
    const res = await appWithSso().request("/runs", {
      headers: { cookie: `urateam_session=${sid}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello a@b.com");
  });

  it("clears cookie and redirects when session id is unknown", async () => {
    const res = await appWithSso().request("/runs", {
      headers: { cookie: `urateam_session=unknown` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("urateam_session=;");
  });
});

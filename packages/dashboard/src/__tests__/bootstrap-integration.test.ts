import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb, signState } from "@urateam/core";
import { dashboardUsers } from "@urateam/core/dist/db/schema.js";
import { Hono } from "hono";
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

const stubWorkos = {
  async getAuthorizationUrl() {
    return "https://workos.example/auth";
  },
  async authenticateWithCode() {
    return {
      user: {
        id: "wu_1",
        email: "alice@acme.com",
        firstName: "Alice",
        lastName: "X",
      },
    };
  },
} as any;

beforeEach(async () => {
  await installTestProLicense("enterprise");
  db = await createDb({ connectionString: ":memory:" });
});

afterEach(async () => {
  await restoreLicense();
  vi.unstubAllEnvs();
});

describe("SSO callback bootstrap admin integration", () => {
  it("promotes alice@acme.com when URATEAM_ADMIN_EMAILS matches", async () => {
    vi.stubEnv("URATEAM_ADMIN_EMAILS", "alice@acme.com");
    const app = new Hono();
    app.route(
      "/",
      createAuthRouter({ db, sso: ssoConfig as any, workos: stubWorkos }),
    );
    const state = signState(
      { next: "/", nonce: "n" },
      ssoConfig.stateSigningSecret,
    );
    const res = await app.request(
      `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    const users = await db.select().from(dashboardUsers);
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe("admin");
  });

  it("leaves role as viewer when email does not match", async () => {
    vi.stubEnv("URATEAM_ADMIN_EMAILS", "bob@acme.com");
    const app = new Hono();
    app.route(
      "/",
      createAuthRouter({ db, sso: ssoConfig as any, workos: stubWorkos }),
    );
    const state = signState(
      { next: "/", nonce: "n" },
      ssoConfig.stateSigningSecret,
    );
    const res = await app.request(
      `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    const users = await db.select().from(dashboardUsers);
    expect(users[0].role).toBe("viewer");
  });

  it("does not promote when URATEAM_ADMIN_EMAILS is unset", async () => {
    vi.stubEnv("URATEAM_ADMIN_EMAILS", "");
    const app = new Hono();
    app.route(
      "/",
      createAuthRouter({ db, sso: ssoConfig as any, workos: stubWorkos }),
    );
    const state = signState(
      { next: "/", nonce: "n" },
      ssoConfig.stateSigningSecret,
    );
    const res = await app.request(
      `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    const users = await db.select().from(dashboardUsers);
    expect(users[0].role).toBe("viewer");
  });
});

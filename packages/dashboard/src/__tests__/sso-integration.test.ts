import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "@urateam/core";
import type { WorkosClient } from "@urateam/core";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";
import { createDashboard } from "../server.js";

let db: any;

const ssoConfig = {
  enabled: true,
  workosApiKey: "sk_test",
  workosClientId: "client_test",
  redirectUri: "https://x/auth/callback",
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
  db = await createDb({ connectionString: ":memory:" });
});

afterEach(async () => {
  await restoreLicense();
});

describe("server with SSO", () => {
  it("redirects /runs to /auth/login when SSO is licensed and enabled with no cookie", async () => {
    await installTestProLicense("enterprise");
    const app = createDashboard({
      db,
      pipelineConfigs: {},
      repoConfigs: {},
      sso: ssoConfig as any,
      workos: stubWorkos,
    });
    const res = await app.request("/runs");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/login");
  });

  it("falls back to basic auth when SSO is not licensed even if enabled", async () => {
    await restoreLicense();
    const app = createDashboard({
      db,
      pipelineConfigs: {},
      repoConfigs: {},
      sso: ssoConfig as any,
      workos: stubWorkos,
      auth: { username: "u", password: "p" },
    });
    const res = await app.request("/runs");
    expect(res.status).toBe(401); // basic auth challenge
  });

  it("uses basic auth when SSO is licensed but disabled", async () => {
    await installTestProLicense("enterprise");
    const app = createDashboard({
      db,
      pipelineConfigs: {},
      repoConfigs: {},
      sso: { ...ssoConfig, enabled: false } as any,
      workos: stubWorkos,
      auth: { username: "u", password: "p" },
    });
    const res = await app.request("/runs");
    expect(res.status).toBe(401);
  });

  it("serves /auth/login (302 to WorkOS) without basic auth when SSO active", async () => {
    await installTestProLicense("enterprise");
    const app = createDashboard({
      db,
      pipelineConfigs: {},
      repoConfigs: {},
      sso: ssoConfig as any,
      workos: stubWorkos,
    });
    const res = await app.request("/auth/login?next=/runs");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("workos.example");
  });
});

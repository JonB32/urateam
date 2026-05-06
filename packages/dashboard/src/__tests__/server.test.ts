import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDashboard, type DashboardConfig } from "../server.js";
import type { Db } from "@urateam/core";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

/**
 * Build a mock Db whose chainable query-builder methods (.select(), .from(),
 * .where(), .orderBy(), .groupBy(), .innerJoin(), .limit(), .offset(), etc.)
 * all resolve to an empty array.  This is enough for every dashboard route to
 * return a valid HTML page with no data rows.
 */
function createMockDb(): Db {
  // A recursive proxy: every property access / function call returns the same
  // proxy, except `.then` which makes it resolve like `Promise.resolve([])`.
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (prop === "then") {
        // Make the proxy thenable — resolves to []
        return (resolve: (v: any) => void) => resolve([]);
      }
      // Return a function that returns the proxy (for chaining)
      return (..._args: any[]) => new Proxy(() => {}, handler);
    },
    apply() {
      return new Proxy(() => {}, handler);
    },
  };

  return new Proxy(() => {}, handler) as unknown as Db;
}

/** Base64-encode Basic auth credentials for request headers. */
function basicAuthHeader(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

describe("createDashboard — credentials not configured", () => {
  it("blocks all requests with 503 when no credentials are configured", async () => {
    const app = createDashboard({
      db: createMockDb(),
      pipelineConfigs: {},
      repoConfigs: {},
      // auth intentionally omitted
    });

    const res = await app.request("/");
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("DASHBOARD_USER");
  });
});

describe("createDashboard — with credentials configured", () => {
  let app: ReturnType<typeof createDashboard>;
  let mockDb: Db;

  beforeEach(() => {
    mockDb = createMockDb();

    app = createDashboard({
      db: mockDb,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: { username: "admin", password: "secret" },
    });
  });

  it("returns 401 for unauthenticated requests", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(401);
  });

  it("serves the runs page at / with valid credentials", async () => {
    const res = await app.request("/", {
      headers: { Authorization: basicAuthHeader("admin", "secret") },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("urateam");
  });

  it("serves the tokens page with valid credentials", async () => {
    const res = await app.request("/tokens", {
      headers: { Authorization: basicAuthHeader("admin", "secret") },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("urateam");
  });

  it("serves the errors page with valid credentials", async () => {
    const res = await app.request("/errors", {
      headers: { Authorization: basicAuthHeader("admin", "secret") },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("urateam");
  });

  it("serves the config page with valid credentials", async () => {
    const res = await app.request("/config", {
      headers: { Authorization: basicAuthHeader("admin", "secret") },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("urateam");
  });

  it("serves the coordination page with valid credentials", async () => {
    const res = await app.request("/coordination", {
      headers: { Authorization: basicAuthHeader("admin", "secret") },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("urateam");
  });

  it("returns 404 for unknown routes (with valid credentials)", async () => {
    const res = await app.request("/nonexistent", {
      headers: { Authorization: basicAuthHeader("admin", "secret") },
    });
    expect(res.status).toBe(404);
  });

  it("returns 401 for wrong credentials", async () => {
    const res = await app.request("/", {
      headers: { Authorization: basicAuthHeader("admin", "wrongpassword") },
    });
    expect(res.status).toBe(401);
  });
});

describe("createDashboard — basePath navigation links", () => {
  let mockDb: Db;
  const AUTH = { username: "admin", password: "secret" };
  const authHeader = { Authorization: basicAuthHeader("admin", "secret") };

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it("nav links contain /ateam prefix when basePath is '/ateam'", async () => {
    const app = createDashboard({
      db: mockDb,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: AUTH,
      basePath: "/ateam",
    });

    // urateam#130: when basePath is set, routes mount at <basePath>/...,
    // so the request path must include the prefix. Pre-fix dashboards
    // returned 404 here because every router was mounted at `/` regardless
    // of basePath.
    const res = await app.request("/ateam", { headers: authHeader });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/ateam/tokens"');
    expect(html).toContain('href="/ateam/errors"');
    expect(html).toContain('href="/ateam/config"');
    expect(html).toContain('href="/ateam/coordination"');
  });

  it("tokens page nav links contain /ateam prefix when basePath is '/ateam'", async () => {
    const app = createDashboard({
      db: mockDb,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: AUTH,
      basePath: "/ateam",
    });

    const res = await app.request("/ateam/tokens", { headers: authHeader });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/ateam/tokens"');
    expect(html).toContain('href="/ateam/errors"');
  });

  it("errors page nav links contain /ateam prefix when basePath is '/ateam'", async () => {
    const app = createDashboard({
      db: mockDb,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: AUTH,
      basePath: "/ateam",
    });

    const res = await app.request("/ateam/errors", { headers: authHeader });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/ateam/tokens"');
    expect(html).toContain('href="/ateam/errors"');
  });

  it("SSO middleware redirects to <basePath>/auth/login when no cookie + basePath set", async () => {
    // Regression test for the bug surfaced in PR #130 review: SSO middleware
    // hard-coded `/auth/login` as the redirect target, which 404s when the
    // dashboard mounts under a basePath.
    const { createSsoMiddleware } = await import("../middleware/sso.js");
    const { Hono } = await import("hono");
    const app = new Hono();
    const fakeSso = {
      enabled: true,
      cookieName: "session",
      cookieSecure: true,
      stateSigningSecret: "x",
      workosApiKey: "x",
      workosClientId: "x",
      redirectUri: "x",
      sessionDurationHours: 8,
    };
    app.use("*", createSsoMiddleware({ db: createMockDb(), sso: fakeSso, basePath: "/ateam" }));
    app.get("/ateam/runs", (c) => c.text("ok"));

    const res = await app.request("/ateam/runs");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/ateam/auth/login");
    expect(res.headers.get("location")).not.toMatch(/^\/auth\/login/);
  });

  it("SSO middleware exempts <basePath>/auth/* from auth check", async () => {
    const { createSsoMiddleware } = await import("../middleware/sso.js");
    const { Hono } = await import("hono");
    const app = new Hono();
    const fakeSso = {
      enabled: true,
      cookieName: "session",
      cookieSecure: true,
      stateSigningSecret: "x",
      workosApiKey: "x",
      workosClientId: "x",
      redirectUri: "x",
      sessionDurationHours: 8,
    };
    app.use("*", createSsoMiddleware({ db: createMockDb(), sso: fakeSso, basePath: "/ateam" }));
    app.get("/ateam/auth/login", (c) => c.text("login-page"));

    const res = await app.request("/ateam/auth/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("login-page");
  });

  it("returns 404 at root when basePath is set (routes only at the prefix)", async () => {
    // The flip side of mounting at basePath: bare `/` no longer matches
    // any route. Ensures operators don't accidentally point Caddy at the
    // wrong path and get a misleading 200.
    const app = createDashboard({
      db: mockDb,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: AUTH,
      basePath: "/ateam",
    });
    const res = await app.request("/", { headers: authHeader });
    expect(res.status).toBe(404);
  });

  it("static style.css actually serves at <basePath>/static/style.css", async () => {
    // Strict version — actually fetch the real CSS file (committed to the
    // repo at packages/dashboard/src/static/style.css; in dev tests the
    // module dir resolves to src/, where the file lives next to dist/).
    // Pre-fix: serveStatic joined c.req.path directly with root, so the
    // lookup fell out as `<root>/ateam/static/style.css` (404). This test
    // would fail without rewriteRequestPath.
    const app = createDashboard({
      db: mockDb,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: AUTH,
      basePath: "/ateam",
    });
    const res = await app.request("/ateam/static/style.css", {
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(100); // sanity — it's the real CSS, not an empty file
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toMatch(/text\/css/);

    // Bare /static/style.css must NOT match when basePath is set.
    const resBare = await app.request("/static/style.css", {
      headers: authHeader,
    });
    expect(resBare.status).toBe(404);
  });

  it("static dialog.js actually serves at <basePath>/static/dialog.js", async () => {
    // Mirrors the style.css test: ensures the dialog-trigger script is
    // reachable under a non-empty basePath. Without it the retry-confirm
    // modal silently fails to open in production.
    const app = createDashboard({
      db: mockDb,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: AUTH,
      basePath: "/ateam",
    });
    const res = await app.request("/ateam/static/dialog.js", {
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("data-open-dialog");

    // Bare /static/dialog.js must NOT match when basePath is set.
    const resBare = await app.request("/static/dialog.js", {
      headers: authHeader,
    });
    expect(resBare.status).toBe(404);
  });

  it("HTMX poll URL has no trailing slash when basePath is set (avoids 404 every 5s)", async () => {
    // urateam#131 follow-up: run-feed.ts used to emit hx-get="${basePath}/"
    // which produced "/ateam/" for non-empty basePath — Hono mounts the runs
    // router at "/ateam" (no trailing slash), so the poll 404s on every tick.
    // run-feed reads basePath via getBasePath() (env var), so set it here.
    const previousEnv = process.env.DASHBOARD_BASE_PATH;
    process.env.DASHBOARD_BASE_PATH = "/ateam";
    try {
      const app = createDashboard({
        db: mockDb,
        pipelineConfigs: {},
        repoConfigs: {},
        auth: AUTH,
        basePath: "/ateam",
      });
      const res = await app.request("/ateam", { headers: authHeader });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('hx-get="/ateam"');
      expect(html).not.toContain('hx-get="/ateam/"');
      // Brand link too.
      expect(html).toContain('class="brand" href="/ateam"');
    } finally {
      if (previousEnv === undefined) delete process.env.DASHBOARD_BASE_PATH;
      else process.env.DASHBOARD_BASE_PATH = previousEnv;
    }
  });

  it("HTMX poll URL is / when basePath is empty (root)", async () => {
    const previousEnv = process.env.DASHBOARD_BASE_PATH;
    delete process.env.DASHBOARD_BASE_PATH;
    try {
      const app = createDashboard({
        db: mockDb,
        pipelineConfigs: {},
        repoConfigs: {},
        auth: AUTH,
      });
      const res = await app.request("/", { headers: authHeader });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('hx-get="/"');
    } finally {
      if (previousEnv !== undefined) process.env.DASHBOARD_BASE_PATH = previousEnv;
    }
  });

  it("static style.css serves at /static/style.css when basePath is empty (root mount)", async () => {
    const app = createDashboard({
      db: mockDb,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: AUTH,
    });
    const res = await app.request("/static/style.css", { headers: authHeader });
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toMatch(/text\/css/);
  });

  it("static dialog.js serves at /static/dialog.js when basePath is empty (root mount)", async () => {
    const app = createDashboard({
      db: mockDb,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: AUTH,
    });
    const res = await app.request("/static/dialog.js", { headers: authHeader });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("data-open-dialog");
  });

  it("nav links have no double slashes when basePath is '/'", async () => {
    const app = createDashboard({
      db: mockDb,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: AUTH,
      basePath: "/",
    });

    const res = await app.request("/", { headers: authHeader });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Trailing slash stripped so links are /tokens not //tokens
    expect(html).toContain('href="/tokens"');
    expect(html).not.toContain('href="//tokens"');
    expect(html).toContain('href="/errors"');
    expect(html).not.toContain('href="//errors"');
  });

  it("nav links have no prefix when basePath is '' (root)", async () => {
    const app = createDashboard({
      db: mockDb,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: AUTH,
      basePath: "",
    });

    const res = await app.request("/", { headers: authHeader });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/tokens"');
    expect(html).toContain('href="/errors"');
  });

  it("trailing slash in basePath is stripped from rendered output", async () => {
    const app = createDashboard({
      db: mockDb,
      pipelineConfigs: {},
      repoConfigs: {},
      auth: AUTH,
      basePath: "/ateam/",
    });

    // The trailing slash is stripped before mount-prefix resolution, so the
    // routes are at /ateam/* and the request must address them there.
    const res = await app.request("/ateam", { headers: authHeader });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should be /ateam/tokens, not /ateam//tokens
    expect(html).toContain('href="/ateam/tokens"');
    expect(html).not.toContain('href="/ateam//tokens"');
  });

  describe("DASHBOARD_BASE_PATH env var handling", () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.DASHBOARD_BASE_PATH;
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.DASHBOARD_BASE_PATH;
      } else {
        process.env.DASHBOARD_BASE_PATH = originalEnv;
      }
    });

    it("falls back to DASHBOARD_BASE_PATH env var when config.basePath is not set", async () => {
      process.env.DASHBOARD_BASE_PATH = "/ateam";
      const app = createDashboard({
        db: mockDb,
        pipelineConfigs: {},
        repoConfigs: {},
        auth: AUTH,
        // no basePath in config — should fall back to env var
      });

      const res = await app.request("/ateam", { headers: authHeader });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('href="/ateam/tokens"');
      expect(html).toContain('href="/ateam/errors"');
    });

    it("config.basePath overrides DASHBOARD_BASE_PATH env var", async () => {
      process.env.DASHBOARD_BASE_PATH = "/other";
      const app = createDashboard({
        db: mockDb,
        pipelineConfigs: {},
        repoConfigs: {},
        auth: AUTH,
        basePath: "/ateam",
      });

      const res = await app.request("/ateam", { headers: authHeader });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('href="/ateam/tokens"');
      expect(html).not.toContain('href="/other/tokens"');
    });

    it("does not crash when DASHBOARD_BASE_PATH is not set", () => {
      delete process.env.DASHBOARD_BASE_PATH;
      expect(() =>
        createDashboard({ db: mockDb, pipelineConfigs: {}, repoConfigs: {} })
      ).not.toThrow();
    });

    it("does not crash when DASHBOARD_BASE_PATH is empty string", () => {
      process.env.DASHBOARD_BASE_PATH = "";
      expect(() =>
        createDashboard({ db: mockDb, pipelineConfigs: {}, repoConfigs: {} })
      ).not.toThrow();
    });

    it("does not crash when DASHBOARD_BASE_PATH is set to /ateam", () => {
      process.env.DASHBOARD_BASE_PATH = "/ateam";
      expect(() =>
        createDashboard({ db: mockDb, pipelineConfigs: {}, repoConfigs: {} })
      ).not.toThrow();
    });
  });
});

// BEC-156: on Enterprise tier with basic auth (no SSO), the RBAC middleware
// looked for c.user — which only the SSO middleware sets — and 401'd every
// request even after basicAuth had verified the credentials. The fix
// synthesizes a user object after basicAuth succeeds so RBAC has something
// to check.
describe("createDashboard — Enterprise tier + basic auth (BEC-156)", () => {
  let app: ReturnType<typeof createDashboard>;

  beforeEach(async () => {
    await installTestProLicense("enterprise");
    app = createDashboard({
      db: createMockDb(),
      pipelineConfigs: {},
      repoConfigs: {},
      auth: { username: "admin", password: "secret" },
    });
  });

  afterEach(async () => {
    await restoreLicense();
  });

  it("serves the runs page at / with valid basic-auth credentials", async () => {
    const res = await app.request("/", {
      headers: { Authorization: basicAuthHeader("admin", "secret") },
    });
    expect(res.status).toBe(200);
  });

  it("serves the coordination page with valid basic-auth credentials", async () => {
    const res = await app.request("/coordination", {
      headers: { Authorization: basicAuthHeader("admin", "secret") },
    });
    expect(res.status).toBe(200);
  });

  it("serves the tokens page (RBAC-gated) with valid basic-auth credentials", async () => {
    const res = await app.request("/tokens", {
      headers: { Authorization: basicAuthHeader("admin", "secret") },
    });
    expect(res.status).toBe(200);
  });

  it("serves the config page (admin-only RBAC gate) with valid basic-auth credentials", async () => {
    // /config requires `config.view` which is admin-only. This test verifies
    // the synthetic role MUST be `admin` — a future regression that downgrades
    // it to `viewer` would silently fail this gate.
    const res = await app.request("/config", {
      headers: { Authorization: basicAuthHeader("admin", "secret") },
    });
    expect(res.status).toBe(200);
  });

  it("still rejects unauthenticated requests with 401", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(401);
  });

  it("still rejects wrong-password requests with 401", async () => {
    const res = await app.request("/", {
      headers: { Authorization: basicAuthHeader("admin", "wrongpassword") },
    });
    expect(res.status).toBe(401);
  });
});

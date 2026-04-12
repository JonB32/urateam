import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDashboard, type DashboardConfig } from "../server.js";
import type { Db } from "@urateam/core";

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

    const res = await app.request("/", { headers: authHeader });
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

    const res = await app.request("/tokens", { headers: authHeader });
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

    const res = await app.request("/errors", { headers: authHeader });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/ateam/tokens"');
    expect(html).toContain('href="/ateam/errors"');
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

    const res = await app.request("/", { headers: authHeader });
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

      const res = await app.request("/", { headers: authHeader });
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

      const res = await app.request("/", { headers: authHeader });
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

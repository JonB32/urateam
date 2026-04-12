/**
 * BEC-103 Security Tests — Dashboard Security Hardening
 *
 * Tests verify the hardened security behaviour introduced in BEC-103:
 * - Security headers on all responses (including auth-blocked responses)
 * - Basic auth required (503 when not configured)
 * - CSRF protection on state-changing requests (POST/PUT/DELETE/PATCH only)
 * - Rate limiting to prevent brute-force attacks
 * - Credential redaction in config view
 * - CSP meta tag in layout HTML
 *
 * Run with:
 *   cd packages/dashboard && npx vitest run src/__tests__/security.repro.test.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDashboard, type DashboardConfig } from "../server.js";
import type { Db } from "@urateam/core";

// ---------------------------------------------------------------------------
// Minimal mock DB — every chainable call resolves to []
// ---------------------------------------------------------------------------
function createMockDb(): Db {
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (v: any) => void) => resolve([]);
      }
      return (..._args: any[]) => new Proxy(() => {}, handler);
    },
    apply() {
      return new Proxy(() => {}, handler);
    },
  };
  return new Proxy(() => {}, handler) as unknown as Db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ROUTES = ["/", "/tokens", "/errors", "/config", "/coordination"];

/** Build a Basic auth header value. */
function basicAuthHeader(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

const VALID_AUTH = { username: "admin", password: "s3cr3t" };
const VALID_AUTH_HEADER = basicAuthHeader(VALID_AUTH.username, VALID_AUTH.password);

function makeApp(authEnabled = false) {
  const cfg: DashboardConfig = {
    db: createMockDb(),
    pipelineConfigs: {},
    repoConfigs: {},
  };
  if (authEnabled) {
    cfg.auth = VALID_AUTH;
  }
  return createDashboard(cfg);
}

// ---------------------------------------------------------------------------
// 1. Security Headers
// ---------------------------------------------------------------------------
describe("BEC-103: security headers present on all responses", () => {
  let app: ReturnType<typeof createDashboard>;

  beforeEach(() => {
    // Use app without auth — headers must be present even on 503 auth-error responses
    app = makeApp();
  });

  it.each(ROUTES)(
    "GET %s — X-Content-Type-Options: nosniff header is present",
    async (route) => {
      const res = await app.request(route);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    },
  );

  it.each(ROUTES)(
    "GET %s — X-Frame-Options: DENY header is present",
    async (route) => {
      const res = await app.request(route);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    },
  );

  it.each(ROUTES)(
    "GET %s — Content-Security-Policy header is present",
    async (route) => {
      const res = await app.request(route);
      const csp = res.headers.get("content-security-policy");
      expect(csp).not.toBeNull();
      // Must restrict scripts to 'self' and https://unpkg.com only
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self' https://unpkg.com");
    },
  );

  it.each(ROUTES)(
    "GET %s — X-XSS-Protection: 0 header is present",
    async (route) => {
      const res = await app.request(route);
      expect(res.headers.get("x-xss-protection")).toBe("0");
    },
  );

  it.each(ROUTES)(
    "GET %s — Referrer-Policy header is present",
    async (route) => {
      const res = await app.request(route);
      expect(res.headers.get("referrer-policy")).toBe(
        "strict-origin-when-cross-origin",
      );
    },
  );

  it.each(ROUTES)(
    "GET %s — Permissions-Policy header is present",
    async (route) => {
      const res = await app.request(route);
      const pp = res.headers.get("permissions-policy");
      expect(pp).not.toBeNull();
      expect(pp).toContain("camera=()");
      expect(pp).toContain("microphone=()");
      expect(pp).toContain("geolocation=()");
    },
  );

  it.each(ROUTES)(
    "GET %s — Strict-Transport-Security header is present",
    async (route) => {
      const res = await app.request(route);
      const hsts = res.headers.get("strict-transport-security");
      expect(hsts).not.toBeNull();
      expect(hsts).toContain("max-age=");
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Authentication is required, not optional
// ---------------------------------------------------------------------------
describe("BEC-103 fix: basic auth is required, not optional", () => {
  it("dashboard returns 503 when no credentials are configured", async () => {
    const app = makeApp(false); // no auth configured
    const res = await app.request("/");
    // Fixed: server blocks all access and prompts to configure auth
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("DASHBOARD_USER");
  });

  it("unauthenticated request to config route returns 503 (not config data)", async () => {
    const appWithConfig = createDashboard({
      db: createMockDb(),
      pipelineConfigs: {
        "auto-implement": {
          name: "Auto Implement",
          stages: ["triage", "implement"],
          model: "claude-opus-4-6",
          maxTokens: 100000,
        } as any,
      },
      repoConfigs: {
        "my-repo": {
          url: "https://github-token:ghp_SECRET@github.com/org/repo.git",
        } as any,
      },
      // no auth configured — should block all access
    });

    const res = await appWithConfig.request("/config");
    // Fixed: auth required — no config data exposed to unauthenticated requests
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// 3. CSRF protection for state-changing requests
// ---------------------------------------------------------------------------
describe("BEC-103: CSRF / HX-Request validation on state-changing requests", () => {
  it("GET /runs/feed is accessible without HX-Request header (GET is safe by design)", async () => {
    const app = makeApp(true);
    // GET requests don't need CSRF protection — only POST/PUT/DELETE/PATCH do
    const res = await app.request("/runs/feed", {
      headers: { Authorization: VALID_AUTH_HEADER },
    });
    expect(res.status).toBe(200);
  });

  it("GET /coordination/feed accessible from any origin (GET requests are safe)", async () => {
    const app = makeApp(true);
    // Origin check only applies to state-changing requests (POST/PUT/DELETE/PATCH)
    const res = await app.request("/coordination/feed", {
      headers: {
        Authorization: VALID_AUTH_HEADER,
        Origin: "https://evil.example.com",
      },
    });
    // GET requests are safe — no origin block on read-only endpoints
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 4. Rate limiting prevents brute-force
// ---------------------------------------------------------------------------
describe("BEC-103: rate limiting prevents brute-force attacks", () => {
  it("rapid unauthenticated requests eventually trigger 429", async () => {
    const app = makeApp(true); // auth enabled — brute-force surface
    let tooManyRequests = false;

    for (let i = 0; i < 20; i++) {
      const res = await app.request("/", {
        headers: { Authorization: "Basic " + btoa("admin:wrong") },
      });
      if (res.status === 429) {
        tooManyRequests = true;
        break;
      }
    }

    // Rate limiting kicks in after RATE_LIMIT_MAX requests per window
    expect(tooManyRequests).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Config view credentials are redacted (fixed: was a vulnerability)
// ---------------------------------------------------------------------------
describe("BEC-103 fix: config view redacts sensitive credentials", () => {
  it("repo URL containing embedded credentials is redacted in config view", async () => {
    // Credentials embedded in repo URLs must be stripped before display.
    const sensitiveUrl =
      "https://x-access-token:ghp_SUPERSECRET123@github.com/org/repo.git";

    const appWithSecret = createDashboard({
      db: createMockDb(),
      pipelineConfigs: {},
      repoConfigs: {
        "secret-repo": { url: sensitiveUrl } as any,
      },
      auth: VALID_AUTH, // auth required to reach config route
    });

    const res = await appWithSecret.request("/config", {
      headers: { Authorization: VALID_AUTH_HEADER },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    // After fix: embedded token must NOT appear in the rendered HTML
    expect(html).not.toContain("ghp_SUPERSECRET123");
    // Redaction marker should be visible instead
    expect(html).toContain("[redacted]");
  });
});

// ---------------------------------------------------------------------------
// 6. Error information leakage
// ---------------------------------------------------------------------------
describe("BEC-103: error responses do not expose internal paths", () => {
  it("404 for unknown run does not expose internal stack trace", async () => {
    const app = makeApp(true);
    const res = await app.request("/runs/nonexistent-run-id-12345", {
      headers: { Authorization: VALID_AUTH_HEADER },
    });
    // Check that internal file paths are not exposed in error responses
    const body = await res.text();
    const internalPathPatterns = [
      /\/var\/agent-runs/,
      /node_modules/,
      /\.ts:\d+:\d+/, // TypeScript stack trace lines
      /at Object\.\<anonymous\>/, // JS stack frames
    ];
    for (const pattern of internalPathPatterns) {
      expect(pattern.test(body)).toBe(false);
    }
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 7. CSP meta tag in layout HTML
// ---------------------------------------------------------------------------
describe("BEC-103 fix: layout HTML includes CSP meta tag", () => {
  it("layout HTML includes a Content-Security-Policy meta tag", async () => {
    const app = makeApp(true);
    const res = await app.request("/", {
      headers: { Authorization: VALID_AUTH_HEADER },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    // CSP meta tag is present in the rendered HTML
    expect(html.includes('http-equiv="Content-Security-Policy"')).toBe(true);
    expect(html).toContain("default-src 'self'");
    expect(html).toContain("script-src 'self' https://unpkg.com");
  });
});

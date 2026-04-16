// SPDX-License-Identifier: BUSL-1.1
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { serveStatic } from "@hono/node-server/serve-static";
import { createLogger, isFeatureLicensed } from "@urateam/core";
import type {
  Db,
  PipelineConfig,
  RepoConfig,
  SsoConfig,
  WorkosClient,
  CostsConfig,
} from "@urateam/core";
import { createRunsRouter } from "./routes/runs.js";
import { createTokensRouter } from "./routes/tokens.js";
import { createErrorsRouter } from "./routes/errors.js";
import { createConfigRouter } from "./routes/config.js";
import { createCoordinationRouter } from "./routes/coordination.js";
import { createAuditRouter } from "./routes/audit.js";
import { createAuthRouter } from "./routes/auth.js";
import { createSsoMiddleware } from "./middleware/sso.js";
import { createCostRouter } from "./routes/cost.js";

const logger = createLogger({ component: "dashboard" });

export interface DashboardConfig {
  db: Db;
  pipelineConfigs: Record<string, PipelineConfig>;
  repoConfigs: Record<string, RepoConfig>;
  /** Optional costs config for the Cost & ROI dashboard (enterprise). */
  costs?: CostsConfig;
  auth?: { username: string; password: string };
  /**
   * Optional SSO configuration. When the `sso` feature is licensed AND
   * `sso.enabled === true`, the dashboard mounts the WorkOS auth router
   * and the session-validating SSO middleware in place of basic auth.
   * Callers must also pass `workos` (a `WorkosClient` instance) — typically
   * obtained from `getDefaultWorkosClient(sso.workosApiKey)`. This keeps
   * `createDashboard` synchronous and lets tests inject a stub client.
   */
  sso?: SsoConfig;
  workos?: WorkosClient;
  /**
   * Root path prefix for all dashboard navigation links (e.g. `"/ateam"`).
   * No trailing slash. Falls back to the `DASHBOARD_BASE_PATH` environment
   * variable, then to `""` (serve at root `/`).
   */
  basePath?: string;
}

// Rate limiter constants
const RATE_LIMIT_MAX = 10; // requests per window
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

export function createDashboard(config: DashboardConfig): Hono {
  // Resolve basePath: explicit config takes priority over env var.
  const rawBasePath =
    config.basePath ?? process.env.DASHBOARD_BASE_PATH ?? "";
  // Strip trailing slashes so downstream code gets a clean prefix.
  const basePath = rawBasePath.replace(/\/+$/, "");
  if (!basePath) {
    logger.warn(
      "DASHBOARD_BASE_PATH is not set. Navigation links will use root paths. " +
        "Set DASHBOARD_BASE_PATH=/ateam (no trailing slash) if the dashboard is " +
        "served under a path prefix via a reverse proxy."
    );
  } else {
    logger.info({ basePath }, "Dashboard base path configured");
  }

  const app = new Hono();

  // Per-instance rate limit tracker (keyed by IP address)
  const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

  // Security headers middleware — runs after all handlers so headers are always set
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self'",
    );
    c.res.headers.set("X-XSS-Protection", "0");
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    c.res.headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    c.res.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  });

  // Rate limiting middleware — before auth to protect against brute-force
  app.use("*", async (c, next) => {
    const ip =
      c.req.header("x-forwarded-for") ||
      c.req.header("x-real-ip") ||
      "127.0.0.1";
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (entry && now - entry.windowStart < RATE_LIMIT_WINDOW_MS) {
      entry.count++;
      if (entry.count > RATE_LIMIT_MAX) {
        return c.text("Too Many Requests", 429);
      }
    } else {
      rateLimitMap.set(ip, { count: 1, windowStart: now });
    }

    await next();
  });

  // CSRF / Origin validation for state-changing requests
  app.use("*", async (c, next) => {
    const method = c.req.method;
    // /auth/login and /auth/callback are GET-based OAuth handoffs with no
    // body — they cannot be targets of CSRF. /auth/logout is POST and MUST
    // go through CSRF (either HX-Request or a token) so an attacker can't
    // embed a <form action="/auth/logout"> on a third-party site and force
    // a logout.
    const path = c.req.path;
    const csrfExempt =
      path === "/auth/login" || path === "/auth/callback";
    if (
      ["POST", "PUT", "DELETE", "PATCH"].includes(method) &&
      !csrfExempt
    ) {
      // Require HX-Request header on HTMX-driven state-changing endpoints
      if (!c.req.header("HX-Request")) {
        return c.text("Forbidden: HTMX header required", 403);
      }
      // Validate Origin header if present
      const origin = c.req.header("Origin");
      if (origin) {
        const allowedOrigin = process.env.DASHBOARD_ORIGIN;
        if (allowedOrigin && origin !== allowedOrigin) {
          return c.text("Forbidden: invalid origin", 403);
        }
      }
    }
    await next();
  });

  // Authentication: SSO (Enterprise) takes priority over basic auth when
  // licensed AND enabled. Otherwise fall back to basic auth, or 503 if no
  // credentials are configured.
  const ssoActive =
    isFeatureLicensed("sso") && config.sso?.enabled === true;

  // Warn when sso config is present but the feature is not licensed —
  // operators with `sso.enabled: true` in their config but no enterprise
  // license would otherwise silently get basicAuth with no clue why.
  if (config.sso?.enabled === true && !isFeatureLicensed("sso")) {
    logger.warn(
      "SSO is configured (sso.enabled=true) but the 'sso' feature is not licensed — falling back to basic auth",
    );
  }

  if (ssoActive) {
    if (!config.workos) {
      throw new Error(
        "SSO is licensed and enabled, but no WorkosClient was provided to createDashboard(). " +
          "Pass `workos: await getDefaultWorkosClient(sso.workosApiKey)`.",
      );
    }
    logger.info("Mounting SSO auth router and session middleware");
    const authRouter = createAuthRouter({
      db: config.db,
      sso: config.sso!,
      workos: config.workos,
    });
    app.route("/", authRouter);
    app.use(
      "*",
      createSsoMiddleware({ db: config.db, sso: config.sso! }),
    );
  } else if (config.auth?.username && config.auth?.password) {
    app.use(
      "*",
      basicAuth({
        username: config.auth.username,
        password: config.auth.password,
      }),
    );
  } else {
    app.use("*", async (c) => {
      return c.text(
        "Dashboard authentication is required but not configured. " +
          "Set DASHBOARD_USER and DASHBOARD_PASSWORD environment variables and restart.",
        503,
      );
    });
  }

  // Static files
  app.use("/static/*", serveStatic({ root: "./packages/dashboard/src/" }));

  // Mount routes — pass basePath so every layout() call uses the correct prefix.
  const runsRouter = createRunsRouter(config.db, basePath);
  app.route("/", runsRouter);

  const tokensRouter = createTokensRouter(config.db, basePath);
  app.route("/", tokensRouter);

  const errorsRouter = createErrorsRouter(config.db, basePath);
  app.route("/", errorsRouter);

  const configRouter = createConfigRouter(
    config.pipelineConfigs,
    config.repoConfigs,
    basePath,
  );
  app.route("/", configRouter);

  const coordinationRouter = createCoordinationRouter(config.db, basePath);
  app.route("/", coordinationRouter);

  const auditRouter = createAuditRouter(config.db, basePath);
  app.route("/", auditRouter);

  const costRouter = createCostRouter({
    db: config.db,
    costs: config.costs,
    pipelineConfigs: config.pipelineConfigs,
    basePath,
  });
  app.route("/", costRouter);

  return app;
}

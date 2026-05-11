// SPDX-License-Identifier: BUSL-1.1
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
import { createUsersRouter } from "./routes/users.js";
import { createAuthRouter } from "./routes/auth.js";
import { createSsoMiddleware } from "./middleware/sso.js";
import { createCostRouter } from "./routes/cost.js";

const logger = createLogger({ component: "dashboard" });

export interface DashboardConfig {
  db: Db;
  pipelineConfigs: Record<string, PipelineConfig>;
  repoConfigs: Record<string, RepoConfig>;
  /**
   * Optional reference to the pipeline runner. Wires the stop/halt buttons
   * (and the audit-logged routes behind them) to the live in-process runner.
   * When absent (e.g. read-only dashboard deployments), the buttons render
   * only if the user has the right role but the POST handlers respond 500
   * with "Runner not configured" — visible failure rather than silent no-op.
   */
  runner?: {
    resume: (runOrIssueId: string) => Promise<void>;
    start: (...args: any[]) => Promise<void>;
    requestStop?: (runId: string, mode: "cancel" | "graceful") => { issueId: string | null; mode: "cancel" | "graceful" };
    haltAll?: () => { cancelledRunIds: string[] };
  };
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
  // Resolve the (possibly prefixed) auth paths once so we can match them
  // exactly. Same value as `mountPrefix` below — duplicated here because
  // this middleware is registered BEFORE the mountPrefix declaration in the
  // call graph. Cheap to re-derive.
  const csrfExemptBase = (basePath ?? "").replace(/\/+$/, "");
  const csrfExemptPaths = new Set([
    `${csrfExemptBase}/auth/login`,
    `${csrfExemptBase}/auth/callback`,
  ]);
  app.use("*", async (c, next) => {
    const method = c.req.method;
    // /auth/login and /auth/callback are GET-based OAuth handoffs with no
    // body — they cannot be targets of CSRF. /auth/logout is POST and MUST
    // go through CSRF (either HX-Request or a token) so an attacker can't
    // embed a <form action="/auth/logout"> on a third-party site and force
    // a logout.
    const path = c.req.path;
    const csrfExempt = csrfExemptPaths.has(path);
    // /cli/* endpoints carry their own shared-secret auth (X-Ura-Cli-Token)
    // and are not browser-reachable forms — CSRF doesn't apply. The token
    // check inside the /cli/* router rejects unauthenticated requests.
    const isCliPath = path.startsWith(`${csrfExemptBase}/cli/`);
    if (
      ["POST", "PUT", "DELETE", "PATCH"].includes(method) &&
      !csrfExempt &&
      !isCliPath
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

  // Mount-prefix used for ALL sub-routers and the static-file middleware.
  // Hono's `app.route(prefix, subApp)` mounts the sub-app such that its
  // internal routes are accessible under <prefix>/<route>. With `/ateam` set,
  // the runs router's `/` becomes `/ateam`, `/runs/:id` becomes
  // `/ateam/runs/:id`, etc. Empty basePath → mount at root.
  // Without this, DASHBOARD_BASE_PATH only affected layout link generation
  // but routes still mounted at `/` — operators reverse-proxying `/ateam`
  // to the dashboard hit 404 on every request. urateam#130 reproduction:
  //   Caddy: handle { reverse_proxy agent:3001 }
  //   Operator visits https://host/ateam → Caddy forwards as `GET /ateam`
  //   Dashboard pre-fix: no route at /ateam → 404
  const mountPrefix = basePath || "/";

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
      basePath,
    });
    app.route(mountPrefix, authRouter);
    app.use(
      "*",
      createSsoMiddleware({ db: config.db, sso: config.sso!, basePath }),
    );
  } else if (config.auth?.username && config.auth?.password) {
    // Skip basic auth for /cli/* — those routes guard themselves with the
    // X-Ura-Cli-Token shared secret. Without this skip, the CLI would have
    // to know DASHBOARD_PASSWORD on top of URATEAM_CLI_TOKEN.
    const cliPrefix = `${basePath}/cli/`;
    app.use("*", async (c, next) => {
      if (c.req.path.startsWith(cliPrefix)) return next();
      return basicAuth({
        username: config.auth!.username,
        password: config.auth!.password,
      })(c, next);
    });
    // BEC-156: synthesize an admin user after basicAuth verifies credentials.
    // Without this, the RBAC middleware (`requirePermission`) on Enterprise
    // tier looks for c.user — which only the SSO middleware sets — and 401's
    // every dashboard route. SSO is the path for differentiated multi-user
    // permissions; basic-auth-authenticated requests get implicit-admin
    // access (they already proved knowledge of the shared DASHBOARD_PASSWORD).
    //
    // This middleware only runs when basicAuth's await-next() chain is
    // reached — basicAuth throws HTTPException(401) on failed credentials,
    // which short-circuits the chain before this middleware fires. Safe to
    // grant admin unconditionally here.
    //
    // The synthetic email uses an explicit `@basic-auth.local` suffix so audit
    // rows (audit-log Enterprise feature) record `actorEmail` as a clearly
    // non-real-user value rather than a bare username string that could be
    // mistaken for a malformed real email.
    const basicAuthUsername = config.auth.username;
    app.use("*", async (c, next) => {
      c.set("user" as never, {
        id: `basic-auth:${basicAuthUsername}`,
        email: `${basicAuthUsername}@basic-auth.local`,
        role: "admin" as const,
      } as never);
      await next();
    });
  } else {
    const cliPrefix = `${basePath}/cli/`;
    app.use("*", async (c, next) => {
      // Even with no dashboard auth configured, /cli/* must still be reachable
      // (its own token check enforces access). Without this carve-out the
      // 503 here would shadow the CLI control plane.
      if (c.req.path.startsWith(cliPrefix)) return next();
      return c.text(
        "Dashboard authentication is required but not configured. " +
          "Set DASHBOARD_USER and DASHBOARD_PASSWORD environment variables and restart.",
        503,
      );
    });
  }

  // Static files. Resolve `static/` relative to this module's installed
  // location, not the consumer's cwd. Without this, npm-installed users
  // (every operator running from a `.urateam/` sidecar) hit a startup
  // warning because `./packages/dashboard/src/` is repo-relative and
  // doesn't exist outside the urateam monorepo. See urateam#101.
  //
  // After build, `import.meta.url` resolves to dist/server.js, so the
  // join lands at dist/static/ — where the build script copies src/static/
  // before publishing.
  const dashboardModuleDir = dirname(fileURLToPath(import.meta.url));
  // Static middleware needs to see the prefixed path AND strip the URL
  // prefix before resolving the file under `root`. @hono/node-server's
  // serveStatic joins `c.req.path` directly with `root` — so a request
  // for `/ateam/static/style.css` against `root: dist/static` would look
  // up `dist/static/ateam/static/style.css` (404). The same surprise hit
  // even without basePath: `/static/style.css` would look up
  // `dist/static/static/style.css`. Use rewriteRequestPath to strip the
  // entire URL-side prefix so the lookup lands at `dist/static/<file>`.
  const staticUrlPrefix = basePath ? `${basePath}/static` : "/static";
  app.use(
    `${staticUrlPrefix}/*`,
    serveStatic({
      root: join(dashboardModuleDir, "static"),
      rewriteRequestPath: (path) => path.replace(staticUrlPrefix, ""),
    }),
  );

  // Mount each sub-router at the basePath prefix. basePath also continues to
  // get passed INTO each router so layout() emits correct hrefs — the two
  // concerns (mount vs. link generation) are separate but share the value.
  const runsRouter = createRunsRouter({
    db: config.db,
    runner: config.runner,
    basePath,
  });
  app.route(mountPrefix, runsRouter);

  const tokensRouter = createTokensRouter(config.db, basePath);
  app.route(mountPrefix, tokensRouter);

  const errorsRouter = createErrorsRouter(config.db, basePath);
  app.route(mountPrefix, errorsRouter);

  const configRouter = createConfigRouter(
    config.pipelineConfigs,
    config.repoConfigs,
    basePath,
  );
  app.route(mountPrefix, configRouter);

  const coordinationRouter = createCoordinationRouter(config.db, basePath);
  app.route(mountPrefix, coordinationRouter);

  const auditRouter = createAuditRouter(config.db, basePath);
  app.route(mountPrefix, auditRouter);

  const costRouter = createCostRouter({
    db: config.db,
    costs: config.costs,
    pipelineConfigs: config.pipelineConfigs,
    basePath,
  });
  app.route(mountPrefix, costRouter);

  const usersRouter = createUsersRouter({ db: config.db, basePath });
  app.route(mountPrefix, usersRouter);

  return app;
}

import { getCookie, setCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import {
  getSession,
  getUserById,
  deleteSession,
  touchSessionLastSeen,
} from "@urateam/core";
import type { SsoConfig } from "@urateam/core";

interface SsoMiddlewareDeps {
  db: any;
  sso: SsoConfig;
  /**
   * Path prefix the dashboard is mounted under (e.g. `/ateam`). Must match
   * the value passed to createDashboard so the redirect target lands on the
   * actually-mounted auth router. Empty string = mounted at root.
   */
  basePath?: string;
}

// CSRF note: the session cookie uses SameSite=Lax. This prevents
// cross-origin POST from third-party sites (CSRF), but allows top-level
// navigations (GET). The dashboard CSRF middleware separately rejects
// state-changing requests without the HX-Request header.
export function createSsoMiddleware(
  deps: SsoMiddlewareDeps,
): MiddlewareHandler {
  // Normalize: strip trailing slashes so we don't get /ateam//auth/login.
  const basePath = (deps.basePath ?? "").replace(/\/+$/, "");
  const authPrefix = `${basePath}/auth/`;
  const webhookPrefix = `${basePath}/webhooks/`;
  // /cli/* endpoints use a shared-secret token check inside the route handler
  // rather than session-cookie auth; skipping SSO here lets `ura stop`/`ura
  // halt` work without a logged-in user.
  const cliPrefix = `${basePath}/cli/`;
  const loginPath = `${basePath}/auth/login`;

  return async (c, next) => {
    const path = c.req.path;
    if (path.startsWith(authPrefix)) return next();
    if (path.startsWith(webhookPrefix)) return next();
    if (path.startsWith(cliPrefix)) return next();

    const cookie = getCookie(c, deps.sso.cookieName);
    if (!cookie) {
      return c.redirect(
        `${loginPath}?next=${encodeURIComponent(path)}`,
        302,
      );
    }

    const session = await getSession(deps.db, cookie);
    if (!session) {
      setCookie(c, deps.sso.cookieName, "", {
        maxAge: 0,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: deps.sso.cookieSecure,
      });
      return c.redirect(
        `${loginPath}?next=${encodeURIComponent(path)}`,
        302,
      );
    }

    const user = await getUserById(deps.db, session.userId);
    if (!user) {
      await deleteSession(deps.db, cookie);
      setCookie(c, deps.sso.cookieName, "", {
        maxAge: 0,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: deps.sso.cookieSecure,
      });
      return c.redirect(loginPath, 302);
    }

    c.set("user", user);
    c.set("session", session);
    void touchSessionLastSeen(deps.db, cookie);
    return next();
  };
}

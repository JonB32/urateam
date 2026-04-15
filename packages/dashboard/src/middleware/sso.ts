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
}

export function createSsoMiddleware(
  deps: SsoMiddlewareDeps,
): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (path.startsWith("/auth/")) return next();
    if (path.startsWith("/webhooks/")) return next();

    const cookie = getCookie(c, deps.sso.cookieName);
    if (!cookie) {
      return c.redirect(
        `/auth/login?next=${encodeURIComponent(path)}`,
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
        `/auth/login?next=${encodeURIComponent(path)}`,
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
      return c.redirect(`/auth/login`, 302);
    }

    c.set("user", user);
    c.set("session", session);
    void touchSessionLastSeen(deps.db, cookie);
    return next();
  };
}

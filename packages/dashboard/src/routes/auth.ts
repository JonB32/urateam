import { Hono } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import {
  signState,
  verifyState,
  validateNextPath,
  upsertUser,
  createSession,
  deleteSession,
  getSession,
  getUserById,
  logAuditEvent,
  dashboardLoginEvent,
  dashboardLogoutEvent,
  dashboardLoginDeniedEvent,
} from "@urateam/core";
import type { SsoConfig, WorkosClient } from "@urateam/core";
import { createLogger } from "@urateam/core";

const log = createLogger({ component: "dashboard.auth" });

interface AuthRouterDeps {
  db: any;
  sso: SsoConfig;
  workos: WorkosClient;
}

export function createAuthRouter(deps: AuthRouterDeps): Hono {
  const app = new Hono();

  app.get("/auth/login", async (c) => {
    const next = validateNextPath(c.req.query("next"));
    const state = signState(
      { next, nonce: randomUUID() },
      deps.sso.stateSigningSecret,
    );
    const url = await deps.workos.getAuthorizationUrl({
      clientId: deps.sso.workosClientId,
      redirectUri: deps.sso.redirectUri,
      state,
    });
    return c.redirect(url, 302);
  });

  app.get("/auth/callback", async (c) => {
    const code = c.req.query("code");
    const stateRaw = c.req.query("state");
    if (!code || !stateRaw) return c.text("Missing code or state", 400);
    const state = verifyState(stateRaw, deps.sso.stateSigningSecret);
    if (!state) return c.text("Invalid login state. Please try again.", 400);

    let result;
    try {
      result = await deps.workos.authenticateWithCode({
        clientId: deps.sso.workosClientId,
        code,
      });
    } catch (err) {
      log.warn({ err }, "WorkOS authenticateWithCode failed");
      return c.text(
        "SSO provider error. Try again or contact your administrator.",
        503,
      );
    }

    const email = result.user.email.toLowerCase();
    if (deps.sso.allowedDomain) {
      const expected = "@" + deps.sso.allowedDomain.toLowerCase();
      if (!email.endsWith(expected)) {
        void logAuditEvent(
          deps.db,
          dashboardLoginDeniedEvent({ email, reason: "domain-mismatch" }),
        );
        return c.text(
          `Access denied. ${email} is not in the allowed domain. Contact your administrator.`,
          403,
        );
      }
    }

    const fullName =
      [result.user.firstName, result.user.lastName]
        .filter(Boolean)
        .join(" ")
        .trim() || null;
    const userId = await upsertUser(deps.db, {
      email,
      name: fullName,
      workosUserId: result.user.id,
    });
    const sessionId = await createSession(deps.db, {
      userId,
      durationHours: deps.sso.sessionDurationHours,
    });

    setCookie(c, deps.sso.cookieName, sessionId, {
      httpOnly: true,
      sameSite: "Lax",
      secure: deps.sso.cookieSecure,
      path: "/",
      maxAge: deps.sso.sessionDurationHours * 3600,
    });

    void logAuditEvent(
      deps.db,
      dashboardLoginEvent({
        userId,
        email,
        workosUserId: result.user.id,
      }),
    );

    return c.redirect(validateNextPath(state.next), 302);
  });

  app.post("/auth/logout", async (c) => {
    const sid = getCookie(c, deps.sso.cookieName);
    if (sid) {
      const session = await getSession(deps.db, sid);
      if (session) {
        const user = await getUserById(deps.db, session.userId);
        await deleteSession(deps.db, sid);
        if (user) {
          void logAuditEvent(
            deps.db,
            dashboardLogoutEvent({ userId: user.id, email: user.email }),
          );
        }
      }
    }
    setCookie(c, deps.sso.cookieName, "", { maxAge: 0, path: "/" });
    return c.redirect("/auth/login", 302);
  });

  return app;
}

import type { MiddlewareHandler } from "hono";
import {
  isFeatureLicensed,
  canAccess,
  type PermissionKey,
  type Role,
} from "@urateam/core";
import { renderForbidden } from "../views/forbidden.js";

export function requirePermission(action: PermissionKey): MiddlewareHandler {
  return async (c, next) => {
    if (!isFeatureLicensed("rbac")) return next();

    const user = c.get("user" as never) as
      | { id: string; email: string; role: Role }
      | undefined;
    if (!user) return c.text("Unauthorized", 401);

    if (!canAccess(user.role, action)) {
      return c.html(
        renderForbidden({
          email: user.email,
          role: user.role,
          action,
          basePath: "",
        }),
        403,
      );
    }
    return next();
  };
}

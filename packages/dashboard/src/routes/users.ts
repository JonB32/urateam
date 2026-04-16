import { Hono } from "hono";
import type { Db, Role } from "@urateam/core";
import {
  listUsers,
  setUserRole,
  SelfDemoteError,
  LastAdminError,
  isFeatureLicensed,
} from "@urateam/core";
import { requirePermission } from "../middleware/rbac.js";
import { renderUsersPage } from "../views/users.js";

const VALID_ROLES: readonly Role[] = ["admin", "operator", "viewer"] as const;
function parseRole(v: unknown): Role | null {
  return typeof v === "string" && (VALID_ROLES as readonly string[]).includes(v)
    ? (v as Role)
    : null;
}

export interface UsersRouterDeps {
  db: Db;
  basePath: string;
}

export function createUsersRouter(deps: UsersRouterDeps): Hono {
  const app = new Hono();

  // Feature gate — when RBAC is unlicensed, /users returns 404
  app.use("/users", async (c, next) => {
    if (!isFeatureLicensed("rbac")) return c.notFound();
    await next();
  });
  app.use("/users/*", async (c, next) => {
    if (!isFeatureLicensed("rbac")) return c.notFound();
    await next();
  });

  app.get("/users", requirePermission("users.view"), async (c) => {
    const user = c.get("user" as never) as
      | { id: string; email: string; role?: string }
      | undefined;
    const users = await listUsers(deps.db as any);
    return c.html(
      renderUsersPage({
        users,
        currentUserId: user?.id ?? "",
        basePath: deps.basePath,
        userEmail: user?.email,
        userRole: user?.role,
      }),
    );
  });

  app.post(
    "/users/:id/role",
    requirePermission("users.manage"),
    async (c) => {
      const targetId = c.req.param("id");
      const form = await c.req.parseBody();
      const newRole = parseRole(form.role);
      if (!newRole) return c.text("Invalid role", 400);

      const user = c.get("user" as never) as
        | { id: string; email: string }
        | undefined;
      if (!user) return c.text("Unauthorized", 401);

      try {
        await setUserRole(deps.db as any, {
          userId: targetId,
          newRole: newRole,
          actorUserId: user.id,
        });
      } catch (err) {
        if (err instanceof SelfDemoteError) {
          return c.text("Cannot demote yourself", 400);
        }
        if (err instanceof LastAdminError) {
          return c.text("Cannot demote the last remaining admin", 400);
        }
        return c.text(
          `Role update failed: ${(err as Error).message}`,
          500,
        );
      }

      return c.redirect(`${deps.basePath}/users`, 302);
    },
  );

  return app;
}

import { Hono } from "hono";
import type { Db } from "@urateam/core";
import { getActiveWork } from "@urateam/core";
import { layout } from "../views/layout.js";
import { coordinationView } from "../views/coordination.js";
import { requirePermission } from "../middleware/rbac.js";

export function createCoordinationRouter(db: Db, basePath = ""): Hono {
  const router = new Hono();

  router.get("/coordination", requirePermission("coordination.view"), async (c) => {
    const entries = await getActiveWork(db as any);
    const content = coordinationView(entries);

    if (c.req.header("HX-Request")) {
      return c.html(content);
    }

    const user = c.get("user" as never) as { email?: string } | undefined;
    return c.html(layout("Coordination", content, basePath, { userEmail: user?.email }));
  });

  // HTMX partial: active coordination feed (polled every 10s)
  router.get("/coordination/feed", requirePermission("coordination.view"), async (c) => {
    const entries = await getActiveWork(db as any);
    return c.html(coordinationView(entries));
  });

  return router;
}

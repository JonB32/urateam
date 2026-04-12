import { Hono } from "hono";
import type { Db } from "@urateam/core";
import { getActiveWork } from "@urateam/core";
import { layout } from "../views/layout.js";
import { coordinationView } from "../views/coordination.js";

export function createCoordinationRouter(db: Db, basePath = ""): Hono {
  const router = new Hono();

  router.get("/coordination", async (c) => {
    const entries = await getActiveWork(db as any);
    const content = coordinationView(entries);

    if (c.req.header("HX-Request")) {
      return c.html(content);
    }

    return c.html(layout("Coordination", content, basePath));
  });

  // HTMX partial: active coordination feed (polled every 10s)
  router.get("/coordination/feed", async (c) => {
    const entries = await getActiveWork(db as any);
    return c.html(coordinationView(entries));
  });

  return router;
}

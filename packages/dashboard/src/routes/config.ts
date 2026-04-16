import { Hono } from "hono";
import type { PipelineConfig, RepoConfig } from "@urateam/core";
import { layout } from "../views/layout.js";
import { configView } from "../views/config.js";
import { requirePermission } from "../middleware/rbac.js";

export function createConfigRouter(
  pipelineConfigs: Record<string, PipelineConfig>,
  repoConfigs: Record<string, RepoConfig>,
  basePath = ""
): Hono {
  const router = new Hono();

  router.get("/config", requirePermission("config.view"), (c) => {
    const content = configView(pipelineConfigs, repoConfigs);
    const user = c.get("user" as never) as { email?: string } | undefined;
    return c.html(layout("Configuration", content, basePath, { userEmail: user?.email }));
  });

  return router;
}

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
    return c.html(layout("Configuration", content, basePath));
  });

  return router;
}

import { Hono } from "hono";
import type { Db, CostsConfig, PipelineConfig } from "@urateam/core";
import { isFeatureLicensed, aggregateHybrid, snapToUtcDayStart, streamCostCsv } from "@urateam/core";
import { layout } from "../views/layout.js";
import { renderCostPage } from "../views/cost.js";

export interface CostRouterDeps {
  db: Db;
  costs?: CostsConfig;
  pipelineConfigs?: Record<string, PipelineConfig>;
  basePath?: string;
}

function parseWindow(url: URL): { from: Date; to: Date; preset: string } {
  const preset = url.searchParams.get("window") ?? "30d";
  const now = new Date();
  let from: Date;
  // Half-open interval [from, to) — add 1s to "now" so runs completing at the
  // current second are still included in the window. SQLite stores timestamps
  // as epoch seconds (integer), so a 1ms buffer would still floor to the same
  // second and exclude runs that completed within the current second.
  let to: Date = new Date(now.getTime() + 1000);
  if (preset === "custom") {
    const fromStr = url.searchParams.get("from");
    const toStr = url.searchParams.get("to");
    from = fromStr ? new Date(fromStr) : new Date(now.getTime() - 30 * 86_400_000);
    to = toStr ? new Date(toStr) : new Date(now.getTime() + 1000);
    if (isNaN(from.getTime())) from = new Date(now.getTime() - 30 * 86_400_000);
    if (isNaN(to.getTime())) to = now;
  } else {
    // For preset windows: snap `from` to UTC day start so `aggregateHybrid`
    // can read pre-computed rollup rows without boundary slicing. The window
    // effectively becomes "last N complete UTC days + today-so-far".
    const days = preset === "7d" ? 7 : preset === "90d" ? 90 : preset === "365d" ? 365 : 30;
    from = new Date(snapToUtcDayStart(now).getTime() - days * 86_400_000);
  }
  return { from, to, preset };
}

export function createCostRouter(deps: CostRouterDeps): Hono {
  const router = new Hono();
  const basePath = deps.basePath ?? "";
  const costs = deps.costs ?? {
    modelPricing: {},
    hourlyEngRate: 50,
    timeSavedPerPrDefault: 4,
  };
  const pipelineConfigs = deps.pipelineConfigs ?? {};

  // Gate every cost route behind the license feature flag.
  router.use("/cost", async (c, next) => {
    if (!isFeatureLicensed("cost-roi")) return c.notFound();
    await next();
  });
  router.use("/cost/*", async (c, next) => {
    if (!isFeatureLicensed("cost-roi")) return c.notFound();
    await next();
  });

  router.get("/cost", async (c) => {
    const url = new URL(c.req.url);
    const filters = parseWindow(url);
    const result = await aggregateHybrid(
      deps.db as any,
      { from: filters.from, to: filters.to },
      { costs, pipelineConfigs },
      // Rollup-backed reads only for preset windows (where `from` is snapped
      // to UTC midnight). Custom ranges go through live aggregation.
      { enableRollups: filters.preset !== "custom" },
    );
    const content = renderCostPage({ result, filters, costs, basePath });
    if (c.req.header("HX-Request")) return c.html(content);
    const user = c.get("user" as never) as { email?: string } | undefined;
    return c.html(layout("Cost & ROI", content, basePath, { userEmail: user?.email }));
  });

  router.get("/cost/page", async (c) => {
    const url = new URL(c.req.url);
    const filters = parseWindow(url);
    const result = await aggregateHybrid(
      deps.db as any,
      { from: filters.from, to: filters.to },
      { costs, pipelineConfigs },
      { enableRollups: filters.preset !== "custom" },
    );
    return c.html(renderCostPage({ result, filters, costs, basePath, partial: true }));
  });

  router.get("/cost/export.csv", async (c) => {
    const url = new URL(c.req.url);
    const { from, to } = parseWindow(url);

    const iter = streamCostCsv(
      deps.db as any,
      { from, to },
      { costs, pipelineConfigs },
    )[Symbol.asyncIterator]();

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await iter.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(value));
      },
      async cancel() {
        if (typeof iter.return === "function") await iter.return();
      },
    });

    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="cost-${fromStr}-${toStr}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  });

  return router;
}

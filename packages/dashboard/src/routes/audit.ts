import { Hono } from "hono";
import type { Db, AuditEventType } from "@urateam/core";
import {
  isFeatureLicensed,
  listAuditEvents,
  streamAuditCsv,
} from "@urateam/core";
import { layout } from "../views/layout.js";
import { renderAuditPage, type AuditFilters } from "../views/audit.js";

function parseFilters(query: Record<string, string | undefined>): AuditFilters & {
  cursor?: string;
  from?: string;
  to?: string;
} {
  return {
    from: query.from || undefined,
    to: query.to || undefined,
    scope: query.scope || undefined,
    eventType: query.eventType || undefined,
    actor: query.actor || undefined,
    runId: query.runId || undefined,
    issueId: query.issueId || undefined,
    q: query.q || undefined,
    cursor: query.cursor || undefined,
  };
}

function buildReaderFilters(q: Record<string, string | undefined>) {
  const f: {
    from?: Date;
    to?: Date;
    scope?: string;
    eventTypes?: AuditEventType[];
    actor?: string;
    runId?: string;
    issueId?: string;
    q?: string;
    cursor?: string;
    limit?: number;
  } = {};
  if (q.from) {
    const d = new Date(q.from);
    if (!isNaN(d.getTime())) f.from = d;
  }
  if (q.to) {
    const d = new Date(q.to);
    if (!isNaN(d.getTime())) f.to = d;
  }
  if (q.scope) f.scope = q.scope;
  if (q.eventType) f.eventTypes = [q.eventType as AuditEventType];
  if (q.actor) f.actor = q.actor;
  if (q.runId) f.runId = q.runId;
  if (q.issueId) f.issueId = q.issueId;
  if (q.q) f.q = q.q;
  if (q.cursor) f.cursor = q.cursor;
  f.limit = 50;
  return f;
}

export function createAuditRouter(db: Db, basePath = ""): Hono {
  const router = new Hono();

  // Gate every audit route behind the license feature flag.
  router.use("/audit", async (c, next) => {
    if (!isFeatureLicensed("audit-log")) return c.notFound();
    await next();
  });
  router.use("/audit/*", async (c, next) => {
    if (!isFeatureLicensed("audit-log")) return c.notFound();
    await next();
  });

  router.get("/audit", async (c) => {
    const query = c.req.query();
    const filters = parseFilters(query);
    const readerFilters = buildReaderFilters(query);
    const { events, nextCursor } = await listAuditEvents(db as any, readerFilters);
    const content = renderAuditPage({ events, nextCursor, filters });
    if (c.req.header("HX-Request")) return c.html(content);
    return c.html(layout("Audit Log", content, basePath));
  });

  // HTMX partial used by the "Load more" link to append rows.
  router.get("/audit/page", async (c) => {
    const query = c.req.query();
    const filters = parseFilters(query);
    const readerFilters = buildReaderFilters(query);
    const { events, nextCursor } = await listAuditEvents(db as any, readerFilters);
    return c.html(renderAuditPage({ events, nextCursor, filters, partial: true }));
  });

  router.get("/audit/export.csv", async (c) => {
    const query = c.req.query();
    const readerFilters = buildReaderFilters(query);
    // Export ignores the paginated limit; streamAuditCsv walks its own cursor.
    delete (readerFilters as { limit?: number }).limit;
    delete (readerFilters as { cursor?: string }).cursor;

    const iter = streamAuditCsv(db as any, readerFilters);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await iter.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(value + "\n"));
      },
      async cancel() {
        if (typeof iter.return === "function") await iter.return();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="audit-export.csv"',
        "Cache-Control": "no-store",
      },
    });
  });

  return router;
}

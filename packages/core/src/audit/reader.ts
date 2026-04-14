import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { auditEvents, pipelineRuns, pmApprovals, budgetAlerts } from "../db/schema.js";
import type { AuditEvent, AuditEventType } from "../types.js";
import { projectPipelineRun, projectPmApproval, projectBudgetAlert } from "./projection.js";

export interface ListAuditEventsFilters {
  from?: Date;
  to?: Date;
  scope?: string;
  eventTypes?: AuditEventType[];
  actor?: string;
  runId?: string;
  issueId?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface ListAuditEventsResult {
  events: AuditEvent[];
  nextCursor: string | null;
}

interface Cursor {
  ts: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(s: string): Cursor {
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
}

function parseNativeRow(row: any): AuditEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    eventType: row.eventType,
    actor: row.actor,
    actorType: row.actorType,
    scope: row.scope ?? null,
    runId: row.runId ?? null,
    issueId: row.issueId ?? null,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    payload: (() => {
      try {
        return JSON.parse(row.payload ?? "{}");
      } catch {
        return {};
      }
    })(),
  };
}

/**
 * Lists audit events by merging native `audit_events` rows with events
 * projected from `pipeline_runs`, `pm_approvals`, and `budget_alerts`.
 *
 * Supports filtering by time window, scope, event type, actor prefix, run/issue id,
 * and full-text search on payload/actor. Paginates via opaque cursor, sorted desc
 * by (timestamp, id).
 */
export async function listAuditEvents(
  db: AnyDb,
  filters: ListAuditEventsFilters = {},
): Promise<ListAuditEventsResult> {
  const limit = Math.min(filters.limit ?? 50, 500);
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  const cursorTs = cursor ? new Date(cursor.ts) : null;

  // Native audit_events query
  const nativeConditions: any[] = [];
  if (filters.from) nativeConditions.push(gte(auditEvents.timestamp, filters.from));
  if (filters.to) nativeConditions.push(lte(auditEvents.timestamp, filters.to));
  if (filters.scope) nativeConditions.push(eq(auditEvents.scope, filters.scope));
  if (filters.eventTypes?.length)
    nativeConditions.push(inArray(auditEvents.eventType, filters.eventTypes));
  if (filters.runId) nativeConditions.push(eq(auditEvents.runId, filters.runId));
  if (filters.issueId) nativeConditions.push(eq(auditEvents.issueId, filters.issueId));
  if (cursorTs) nativeConditions.push(lte(auditEvents.timestamp, cursorTs));

  const nativeRows = await (db as any)
    .select()
    .from(auditEvents)
    .where(nativeConditions.length ? and(...nativeConditions) : undefined)
    .orderBy(desc(auditEvents.timestamp))
    .limit(limit * 4);

  // Projected: pipeline_runs
  const runConditions: any[] = [];
  if (filters.from) runConditions.push(gte(pipelineRuns.startedAt, filters.from));
  if (filters.to) runConditions.push(lte(pipelineRuns.startedAt, filters.to));
  if (filters.runId) runConditions.push(eq(pipelineRuns.id, filters.runId));
  if (filters.issueId) runConditions.push(eq(pipelineRuns.issueId, filters.issueId));
  if (cursorTs) runConditions.push(lte(pipelineRuns.startedAt, cursorTs));
  const runRows = await (db as any)
    .select()
    .from(pipelineRuns)
    .where(runConditions.length ? and(...runConditions) : undefined)
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(limit * 4);

  // Projected: pm_approvals (filter by createdAt)
  const apprConditions: any[] = [];
  if (filters.from) apprConditions.push(gte(pmApprovals.createdAt, filters.from));
  if (filters.to) apprConditions.push(lte(pmApprovals.createdAt, filters.to));
  if (cursorTs) apprConditions.push(lte(pmApprovals.createdAt, cursorTs));
  const apprRows = await (db as any)
    .select()
    .from(pmApprovals)
    .where(apprConditions.length ? and(...apprConditions) : undefined)
    .orderBy(desc(pmApprovals.createdAt))
    .limit(limit * 4);

  // Projected: budget_alerts (filter by firedAt)
  const alertConditions: any[] = [];
  if (filters.from) alertConditions.push(gte(budgetAlerts.firedAt, filters.from));
  if (filters.to) alertConditions.push(lte(budgetAlerts.firedAt, filters.to));
  if (cursorTs) alertConditions.push(lte(budgetAlerts.firedAt, cursorTs));
  const alertRows = await (db as any)
    .select()
    .from(budgetAlerts)
    .where(alertConditions.length ? and(...alertConditions) : undefined)
    .orderBy(desc(budgetAlerts.firedAt))
    .limit(limit * 4);

  const merged: AuditEvent[] = [
    ...nativeRows.map(parseNativeRow),
    ...runRows.flatMap((r: any) => projectPipelineRun(r)),
    ...apprRows.flatMap((r: any) => projectPmApproval(r)),
    ...alertRows.map((r: any) => projectBudgetAlert(r)),
  ];

  // Apply filters that weren't pushed to SQL (actor prefix, q, eventType on projected,
  // scope on projected, and the cursor tiebreak).
  const filtered = merged.filter((e) => {
    if (filters.from && e.timestamp < filters.from) return false;
    if (filters.to && e.timestamp > filters.to) return false;
    if (filters.scope && e.scope !== filters.scope) return false;
    if (filters.eventTypes?.length && !filters.eventTypes.includes(e.eventType)) return false;
    if (filters.actor && !e.actor.startsWith(filters.actor)) return false;
    if (filters.runId && e.runId !== filters.runId) return false;
    if (filters.issueId && e.issueId !== filters.issueId) return false;
    if (filters.q) {
      const hay = JSON.stringify(e.payload) + " " + e.actor;
      if (!hay.toLowerCase().includes(filters.q.toLowerCase())) return false;
    }
    if (cursor) {
      const cTs = new Date(cursor.ts).getTime();
      if (e.timestamp.getTime() > cTs) return false;
      if (e.timestamp.getTime() === cTs && e.id >= cursor.id) return false;
    }
    return true;
  });

  // Sort desc by (timestamp, id)
  filtered.sort((a, b) => {
    const d = b.timestamp.getTime() - a.timestamp.getTime();
    return d !== 0 ? d : b.id > a.id ? 1 : -1;
  });

  const page = filtered.slice(0, limit);
  const nextCursor =
    filtered.length > limit
      ? encodeCursor({
          ts: page[page.length - 1].timestamp.toISOString(),
          id: page[page.length - 1].id,
        })
      : null;

  return { events: page, nextCursor };
}

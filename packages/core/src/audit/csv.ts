import type { AnyDb } from "../db/client.js";
import type { AuditEvent } from "../types.js";
import { listAuditEvents, type ListAuditEventsFilters } from "./reader.js";

const CSV_HEADER =
  "timestamp_utc,event_type,actor,actor_type,scope,run_id,issue_id,input_tokens,output_tokens,payload_json";

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function eventToCsvRow(e: AuditEvent): string {
  const fields = [
    e.timestamp.toISOString(),
    e.eventType,
    e.actor,
    e.actorType,
    e.scope ?? "",
    e.runId ?? "",
    e.issueId ?? "",
    String(e.inputTokens ?? 0),
    String(e.outputTokens ?? 0),
    JSON.stringify(e.payload ?? {}),
  ];
  return fields.map(escapeCsvField).join(",");
}

/**
 * Streams audit events as CSV rows. Yields the header row first, then data
 * rows, paging through `listAuditEvents` via cursor to keep memory bounded.
 */
export async function* streamAuditCsv(
  db: AnyDb,
  filters: ListAuditEventsFilters = {},
  pageSize = 500,
): AsyncGenerator<string, void, void> {
  yield CSV_HEADER;
  let cursor: string | null = null;
  const seen = new Set<string>();
  // safety bound to prevent infinite loops from broken cursors
  let pages = 0;
  const maxPages = 100000;
  while (true) {
    const { events, nextCursor }: { events: AuditEvent[]; nextCursor: string | null } =
      await listAuditEvents(db, {
        ...filters,
        limit: pageSize,
        cursor: cursor ?? undefined,
      });
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      yield eventToCsvRow(e);
    }
    if (!nextCursor || events.length === 0) break;
    cursor = nextCursor;
    if (++pages > maxPages) break;
  }
}

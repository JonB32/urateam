import type { AuditEvent } from "@urateam/core";
import { escapeHtml, getBasePath } from "./layout.js";

export interface AuditFilters {
  from?: string;
  to?: string;
  scope?: string;
  eventType?: string;
  actor?: string;
  runId?: string;
  issueId?: string;
  q?: string;
}

export interface RenderAuditPageArgs {
  events: AuditEvent[];
  nextCursor: string | null;
  filters: AuditFilters;
  /** When true, render only the table + load-more marker (HTMX partial). */
  partial?: boolean;
}

function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

function toRelativeTime(date: Date): string {
  const ms = Date.now() - date.getTime();
  if (ms < 0) return "just now";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderRow(e: AuditEvent): string {
  const basePath = getBasePath();
  const payloadJson = (() => {
    try {
      return JSON.stringify(e.payload ?? {});
    } catch {
      return "{}";
    }
  })();
  const idEnc = encodeURIComponent(e.id);
  return `<tr>
      <td><button type="button"
        hx-get="${basePath}/audit/event/${escapeHtml(idEnc)}"
        hx-target="closest tr"
        hx-swap="afterend"
        title="Show full payload"
        style="background:none;border:none;cursor:pointer;font-size:0.9em;">+</button></td>
      <td title="${escapeHtml(e.timestamp.toISOString())}">${escapeHtml(toRelativeTime(e.timestamp))}</td>
      <td><code>${escapeHtml(e.eventType)}</code></td>
      <td>${escapeHtml(e.actor)}</td>
      <td>${escapeHtml(e.actorType)}</td>
      <td>${escapeHtml(e.scope ?? "")}</td>
      <td>${escapeHtml(e.runId ?? "")}</td>
      <td>${escapeHtml(e.issueId ?? "")}</td>
      <td><code>${escapeHtml(truncate(payloadJson))}</code></td>
    </tr>`;
}

/**
 * Render a detail row inserted via HTMX after a row. Shows the full formatted
 * payload plus any fields truncated in the compact row (timestamp, tokens).
 */
export function renderEventDetailRow(e: AuditEvent): string {
  const payloadFormatted = (() => {
    try {
      return JSON.stringify(e.payload ?? {}, null, 2);
    } catch {
      return "{}";
    }
  })();
  return `<tr class="audit-detail-row">
    <td></td>
    <td colspan="8" style="background:#f8f9fa;padding:1rem;">
      <div style="font-size:0.85em;color:#666;margin-bottom:0.5rem;">
        <strong>Event ID:</strong> <code>${escapeHtml(e.id)}</code>
        &nbsp;|&nbsp;
        <strong>Timestamp:</strong> ${escapeHtml(e.timestamp.toISOString())}
        &nbsp;|&nbsp;
        <strong>Tokens:</strong> ${e.inputTokens} in / ${e.outputTokens} out
      </div>
      <pre style="background:#fff;border:1px solid #e0e0e0;padding:0.75rem;overflow:auto;margin:0;font-size:0.85em;">${escapeHtml(payloadFormatted)}</pre>
    </td>
  </tr>`;
}

function buildQueryString(filters: AuditFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...filters, ...extra })) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const s = params.toString();
  return s ? "?" + s : "";
}

/**
 * Render the audit log page. When `partial` is true, emits only the table
 * body rows + load-more marker so HTMX can swap into the tbody.
 */
export function renderAuditPage(args: RenderAuditPageArgs): string {
  const basePath = getBasePath();
  const { events, nextCursor, filters, partial } = args;

  const rows = events.map(renderRow).join("\n");

  const loadMore = nextCursor
    ? `<tr id="audit-load-more"><td colspan="9" style="text-align:center;padding:1rem;">
        <a href="${basePath}/audit${escapeHtml(buildQueryString(filters, { cursor: nextCursor }))}"
           hx-get="${basePath}/audit/page${escapeHtml(buildQueryString(filters, { cursor: nextCursor }))}"
           hx-target="#audit-load-more"
           hx-swap="outerHTML">Load more</a>
      </td></tr>`
    : "";

  if (partial) {
    return rows + loadMore;
  }

  const exportHref = `${basePath}/audit/export.csv${escapeHtml(buildQueryString(filters))}`;

  const filterBar = `<form method="get" action="${basePath}/audit" class="audit-filters">
    <input type="text" name="eventType" placeholder="event type" value="${escapeHtml(filters.eventType ?? "")}">
    <input type="text" name="scope" placeholder="scope" value="${escapeHtml(filters.scope ?? "")}">
    <input type="text" name="actor" placeholder="actor prefix" value="${escapeHtml(filters.actor ?? "")}">
    <input type="text" name="runId" placeholder="run id" value="${escapeHtml(filters.runId ?? "")}">
    <input type="text" name="issueId" placeholder="issue id" value="${escapeHtml(filters.issueId ?? "")}">
    <input type="text" name="q" placeholder="search payload" value="${escapeHtml(filters.q ?? "")}">
    <input type="datetime-local" name="from" value="${escapeHtml(filters.from ?? "")}">
    <input type="datetime-local" name="to" value="${escapeHtml(filters.to ?? "")}">
    <button type="submit">Filter</button>
    <a class="btn" href="${exportHref}">Export CSV</a>
  </form>`;

  return `<div id="audit">
  ${filterBar}
  <div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <th></th>
          <th>Time</th>
          <th>Event</th>
          <th>Actor</th>
          <th>Actor type</th>
          <th>Scope</th>
          <th>Run</th>
          <th>Issue</th>
          <th>Payload</th>
        </tr>
      </thead>
      <tbody id="audit-rows">
        ${rows.length > 0 ? rows : '<tr><td colspan="9" style="text-align:center;color:#999;padding:2rem;">No audit events</td></tr>'}
        ${loadMore}
      </tbody>
    </table>
  </div>
</div>`;
}

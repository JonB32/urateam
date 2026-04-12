import { escapeHtml, getBasePath } from "./layout.js";
import type { ActiveWorkEntry } from "@urateam/core";

export function coordinationView(entries: ActiveWorkEntry[]): string {
  if (entries.length === 0) {
    return `<p class="empty">No agents currently active.</p>`;
  }

  const basePath = getBasePath();
  const rows = entries
    .map((e) => {
      const files = e.filesModified ?? [];
      const fileList =
        files.length > 0
          ? files.map((f) => `<code>${escapeHtml(f)}</code>`).join(", ")
          : "<em>none recorded yet</em>";

      return `
    <tr>
      <td>${escapeHtml(e.issueId)}</td>
      <td>${escapeHtml(e.runId)}</td>
      <td><span class="badge badge-stage">${escapeHtml(e.stage)}</span></td>
      <td class="files">${fileList}</td>
      <td>${escapeHtml(toRelativeTime(e.startedAt))}</td>
      <td>${escapeHtml(toRelativeTime(e.updatedAt))}</td>
    </tr>`;
    })
    .join("\n");

  return `
<p hx-get="${basePath}/coordination" hx-trigger="every 10s" hx-swap="outerHTML" style="margin-bottom:1rem;color:var(--color-text-muted);font-size:0.875rem;">
  Showing ${entries.length} active agent${entries.length !== 1 ? "s" : ""}.
  Auto-refreshes every 10 seconds.
</p>
<div class="table-wrapper">
  <table>
    <thead>
      <tr>
        <th>Issue</th>
        <th>Run ID</th>
        <th>Stage</th>
        <th>Files Modified</th>
        <th>Started</th>
        <th>Last Updated</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</div>`;
}

function toRelativeTime(date: Date | null | undefined): string {
  if (!date) return "–";
  const now = Date.now();
  const ms = now - new Date(date).getTime();
  if (ms < 0) return "just now";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

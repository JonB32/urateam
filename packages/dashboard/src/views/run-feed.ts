import { escapeHtml, getBasePath } from "./layout.js";

export interface RunRow {
  id: string;
  issueId: string;
  issueTitle: string;
  pipelineKey: string;
  repoUrl: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  totalInputTokens: number;
  totalOutputTokens: number;
}

function statusBadge(status: string): string {
  const cls = `badge badge-${status}`;
  return `<span class="${cls}">${escapeHtml(status)}</span>`;
}

function formatDuration(start: Date, end: Date | null): string {
  const endMs = end ? end.getTime() : Date.now();
  const diffSec = Math.floor((endMs - start.getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const min = Math.floor(diffSec / 60);
  const sec = diffSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function formatTokens(input: number, output: number): string {
  const total = input + output;
  if (total === 0) return "-";
  if (total < 1000) return String(total);
  return `${(total / 1000).toFixed(1)}k`;
}

function repoName(url: string): string {
  const parts = url.split("/");
  return parts[parts.length - 1] || url;
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

export function runFeedView(runs: RunRow[]): string {
  const basePath = getBasePath();
  const rows = runs
    .map(
      (r) => `<tr>
      <td>${statusBadge(r.status)}</td>
      <td><a href="${basePath}/runs/${encodeURIComponent(r.id)}">${escapeHtml(r.issueId)}: ${escapeHtml(r.issueTitle)}</a></td>
      <td>${escapeHtml(r.pipelineKey)}</td>
      <td>${escapeHtml(repoName(r.repoUrl))}</td>
      <td>${formatDuration(r.startedAt, r.completedAt)}</td>
      <td title="${escapeHtml(r.startedAt.toISOString())}">${toRelativeTime(r.startedAt)}</td>
      <td>${formatTokens(r.totalInputTokens, r.totalOutputTokens)}</td>
    </tr>`
    )
    .join("\n");

  // basePath || "/" not basePath + "/" — Hono mounts the runs router at
  // <basePath> (no trailing slash), so "/ateam/" 404s but "/ateam" matches.
  // The empty-basePath case still resolves to "/" so root-mounted dashboards
  // continue to work.
  const pollUrl = basePath || "/";
  return `<div id="run-feed" hx-get="${pollUrl}" hx-trigger="every 5s" hx-swap="innerHTML" hx-target="#run-feed">
  <div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Issue</th>
          <th>Pipeline</th>
          <th>Repo</th>
          <th>Duration</th>
          <th>Started</th>
          <th>Tokens</th>
        </tr>
      </thead>
      <tbody>
        ${rows.length > 0 ? rows : '<tr><td colspan="7" style="text-align:center;color:#999;padding:2rem;">No runs yet</td></tr>'}
      </tbody>
    </table>
  </div>
</div>`;
}

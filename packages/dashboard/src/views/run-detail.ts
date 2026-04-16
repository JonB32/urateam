import { escapeHtml, getBasePath } from "./layout.js";

export interface RunInfo {
  id: string;
  issueId: string;
  issueTitle: string;
  pipelineKey: string;
  repoUrl: string;
  branch: string | null;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  prUrl: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  errorMessage: string | null;
}

export interface StageInfo {
  id: string;
  stage: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  handoffArtifact: string | null;
  errorMessage: string | null;
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  type: string;
  content: string;
}

function statusBadge(status: string): string {
  return `<span class="badge badge-${status}">${escapeHtml(status)}</span>`;
}

function formatTime(d: Date | null): string {
  if (!d) return "-";
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function toRelativeTime(d: Date | null): string {
  if (!d) return "-";
  const ms = Date.now() - new Date(d).getTime();
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

function formatJson(raw: string | null): string {
  if (!raw) return "";
  try {
    const obj = JSON.parse(raw) as unknown;
    return escapeHtml(JSON.stringify(obj, null, 2));
  } catch {
    return escapeHtml(raw);
  }
}

export function runDetailView(
  run: RunInfo,
  stages: StageInfo[],
  logs: LogEntry[],
  page: number,
  totalLogs: number,
  canRetry: boolean = false,
): string {
  const basePath = getBasePath();
  const logsPerPage = 50;
  const totalPages = Math.max(1, Math.ceil(totalLogs / logsPerPage));
  const duration = formatDuration(run.startedAt, run.completedAt);
  const isInFlight = run.status === "running" || run.status === "queued";

  const metaHtml = `<div class="card">
    <h2>Run Details</h2>
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1.25rem;flex-wrap:wrap;">
      ${statusBadge(run.status)}
      <span class="duration-badge" title="Total run duration">⏱ ${duration}${isInFlight ? " (running)" : ""}</span>
      ${run.prUrl ? `<a href="${escapeHtml(run.prUrl)}" target="_blank" rel="noopener" style="font-size:0.875rem;">↗ Pull Request</a>` : ""}
      ${
        canRetry && (run.status === "failed" || run.status === "retriable")
          ? `<form method="post" action="${basePath}/runs/${encodeURIComponent(run.id)}/retry" hx-post="${basePath}/runs/${encodeURIComponent(run.id)}/retry" hx-headers='{"HX-Request":"true"}' style="display:inline;margin:0;">
          <button type="submit" class="button-primary">Retry</button>
        </form>`
          : ""
      }
    </div>
    <dl class="meta">
      <div><dt>Issue</dt><dd>${escapeHtml(run.issueId)}: ${escapeHtml(run.issueTitle)}</dd></div>
      <div><dt>Pipeline</dt><dd>${escapeHtml(run.pipelineKey)}</dd></div>
      <div><dt>Repo</dt><dd>${escapeHtml(run.repoUrl)}</dd></div>
      <div><dt>Branch</dt><dd>${escapeHtml(run.branch || "-")}</dd></div>
      <div><dt>Started</dt><dd title="${escapeHtml(formatTime(run.startedAt))}">${toRelativeTime(run.startedAt)}</dd></div>
      <div><dt>Completed</dt><dd title="${run.completedAt ? escapeHtml(formatTime(run.completedAt)) : ""}">${toRelativeTime(run.completedAt)}</dd></div>
      <div><dt>Tokens (total)</dt><dd>${(run.totalInputTokens + run.totalOutputTokens).toLocaleString()}</dd></div>
      <div><dt>Tokens in / out</dt><dd>${run.totalInputTokens.toLocaleString()} / ${run.totalOutputTokens.toLocaleString()}</dd></div>
      ${run.errorMessage ? `<div style="grid-column:1/-1"><dt>Error</dt><dd style="color:var(--color-red)">${escapeHtml(run.errorMessage)}</dd></div>` : ""}
    </dl>
  </div>`;

  const stageHtml = `<div class="card">
    <h2>Stage Timeline</h2>
    <div class="timeline">
      ${stages
        .map(
          (s) => `<div class="timeline-item ${s.status}">
          <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
            <strong>${escapeHtml(s.stage)}</strong>
            ${statusBadge(s.status)}
          </div>
          <div class="timeline-meta">
            <span>⏱ ${formatDuration(s.startedAt, s.completedAt)}</span>
            <span>🔤 ${(s.inputTokens + s.outputTokens).toLocaleString()} tokens</span>
            <span>↩ ${s.turns} turn${s.turns !== 1 ? "s" : ""}</span>
          </div>
          ${s.errorMessage ? `<div style="color:var(--color-red);font-size:0.8125rem;margin-top:0.5rem;padding:0.375rem 0.5rem;background:color-mix(in srgb,var(--color-red) 8%,transparent);border-radius:4px;">${escapeHtml(s.errorMessage)}</div>` : ""}
          ${
            s.handoffArtifact
              ? `<details style="margin-top:0.5rem;">
              <summary>Handoff Artifact</summary>
              <pre><code>${formatJson(s.handoffArtifact)}</code></pre>
            </details>`
              : ""
          }
        </div>`
        )
        .join("\n")}
    </div>
  </div>`;

  const logEntries = logs.length > 0
    ? logs
        .map(
          (l) =>
            `<div class="log-entry"><span class="log-time" title="${escapeHtml(formatTime(l.timestamp))}">${toRelativeTime(l.timestamp)}</span><span class="log-type log-type-${l.type}">[${escapeHtml(l.type)}]</span>${escapeHtml(l.content)}</div>`
        )
        .join("\n")
    : '<p style="color:var(--color-text-muted);padding:1rem;">No logs recorded</p>';

  const pagination = totalPages > 1
    ? `<div class="pagination">
        ${page > 1 ? `<a href="${basePath}/runs/${encodeURIComponent(run.id)}?page=${page - 1}">← Prev</a>` : ""}
        ${Array.from({ length: totalPages }, (_, i) => i + 1)
          .slice(Math.max(0, page - 3), page + 2)
          .map((p) =>
            p === page
              ? `<span>${p}</span>`
              : `<a href="${basePath}/runs/${encodeURIComponent(run.id)}?page=${p}">${p}</a>`
          )
          .join("")}
        ${page < totalPages ? `<a href="${basePath}/runs/${encodeURIComponent(run.id)}?page=${page + 1}">Next →</a>` : ""}
      </div>`
    : "";

  const logHtml = `<div class="card">
    <details class="log-section" open>
      <summary>Agent Logs <span style="font-weight:400;font-size:0.8125rem;color:var(--color-text-muted);">(${totalLogs} total)</span></summary>
      <div class="log-entries">
        ${logEntries}
      </div>
      ${pagination}
    </details>
  </div>`;

  return `<p style="margin-bottom:1rem;"><a href="${basePath}/">← Back to runs</a></p>${metaHtml}${stageHtml}${logHtml}`;
}

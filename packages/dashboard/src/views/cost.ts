import type { AggregateResult, BreakdownRow, CostsConfig, DailyRow } from "@urateam/core";
import { escapeHtml } from "./layout.js";

export interface CostFilters {
  from: Date;
  to: Date;
  preset: string;
}

export interface RenderCostPageArgs {
  result: AggregateResult;
  filters: CostFilters;
  costs: CostsConfig;
  basePath?: string;
  /** When true, render only the body (HTMX partial). */
  partial?: boolean;
}

function fmtNumber(n: number): string {
  if (!isFinite(n)) return "∞";
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtHours(n: number): string {
  if (!isFinite(n)) return "∞";
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function fmtDollars(n: number): string {
  if (!isFinite(n)) return "∞";
  return "$" + n.toFixed(2);
}

function fmtRoi(n: number): string {
  if (!isFinite(n)) return "∞";
  return n.toFixed(1) + "×";
}

/**
 * Render a simple SVG trend chart of daily dollars over the window.
 * Inline SVG avoids any external script/dep — CSP-safe.
 *
 * Returns an empty string when there are fewer than 2 data points (a single
 * dot isn't meaningful and tiny polylines collapse to invisible).
 */
export function renderCostChart(byDay: DailyRow[]): string {
  if (byDay.length < 2) return "";

  const width = 600;
  const height = 80;
  const padX = 8;
  const padY = 8;
  const usableW = width - padX * 2;
  const usableH = height - padY * 2;

  const maxDollars = Math.max(...byDay.map((d) => d.dollars));
  // When the max is zero, avoid divide-by-zero and render a flat baseline.
  const effMax = maxDollars > 0 ? maxDollars : 1;

  const n = byDay.length;
  const points = byDay
    .map((d, i) => {
      const x = padX + (i / (n - 1)) * usableW;
      const y = padY + usableH - (d.dollars / effMax) * usableH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // Simple axis labels: first and last date, max dollars on Y axis.
  const firstDate = byDay[0].date;
  const lastDate = byDay[byDay.length - 1].date;
  const totalDollars = byDay.reduce((sum, d) => sum + d.dollars, 0);

  return `<div class="cost-chart" style="margin:1rem 0;">
    <div style="display:flex;justify-content:space-between;font-size:0.85em;color:#666;margin-bottom:0.25rem;">
      <span>Daily cost — ${escapeHtml(firstDate)} to ${escapeHtml(lastDate)}</span>
      <span>Total: ${fmtDollars(totalDollars)} · peak: ${fmtDollars(maxDollars)}</span>
    </div>
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" style="border:1px solid #e0e0e0;background:#fafbfc;">
      <polyline fill="none" stroke="#3a7afe" stroke-width="2" points="${points}" />
    </svg>
  </div>`;
}

function renderBreakdownTable(title: string, rows: BreakdownRow[]): string {
  const body =
    rows.length === 0
      ? '<tr><td colspan="7" style="text-align:center;color:#999;padding:1rem;">No data</td></tr>'
      : rows
          .map(
            (r) => `<tr>
            <td>${escapeHtml(r.label)}</td>
            <td>${fmtNumber(r.runs)}</td>
            <td>${fmtNumber(r.prsMerged)}</td>
            <td>${fmtHours(r.timeSavedHours)}</td>
            <td>${fmtNumber(r.inputTokens + r.outputTokens)}</td>
            <td>${fmtDollars(r.dollars)}</td>
            <td>${fmtRoi(r.roiMultiplier)}</td>
          </tr>`,
          )
          .join("\n");

  return `<h3>${escapeHtml(title)}</h3>
    <div class="table-wrapper">
      <table class="cost-breakdown">
        <thead>
          <tr>
            <th>Name</th>
            <th>Runs</th>
            <th>PRs merged</th>
            <th>Hours saved</th>
            <th>Tokens</th>
            <th>Cost</th>
            <th>ROI</th>
          </tr>
        </thead>
        <tbody>
          ${body}
        </tbody>
      </table>
    </div>`;
}

function buildExportHref(
  basePath: string,
  filters: CostFilters,
): string {
  const from = filters.from.toISOString().slice(0, 10);
  const to = filters.to.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    window: filters.preset,
    from,
    to,
  });
  return `${basePath}/cost/export.csv?${params.toString()}`;
}

/**
 * Render the cost & ROI page. When `partial` is true, emits only the body
 * (summary + tables) so HTMX can swap it into #cost-body.
 */
export function renderCostPage(args: RenderCostPageArgs): string {
  const { result, filters, costs, partial } = args;
  const basePath = args.basePath ?? "";
  const { summary, byTeam, byRepo, byPipeline, byDay } = result;
  const hourlyRate = costs.hourlyEngRate ?? 50;
  const value = summary.timeSavedHours * hourlyRate;

  const bodyInner = `${summary.truncated ? `<div class="warning-banner">⚠ Window exceeds 10,000 runs. Results truncated to the 10,000 most recent. Narrow your date range for complete totals.</div>` : ""}
    <div class="summary-card">
      <p><strong>${fmtNumber(summary.prsMerged)} PRs merged</strong>
         &middot; <strong>${fmtHours(summary.timeSavedHours)}h saved</strong>
         &middot; <strong>${fmtNumber(summary.runs)} runs</strong></p>
      <p>${fmtNumber(summary.inputTokens + summary.outputTokens)} tokens
         &middot; ${fmtDollars(summary.dollars)} cost</p>
      <p><strong>ROI:</strong> ${fmtHours(summary.timeSavedHours)}h &times; ${fmtDollars(hourlyRate)}/h
         = ${fmtDollars(value)} value &divide; ${fmtDollars(summary.dollars)} cost
         = ${fmtRoi(summary.roiMultiplier)}</p>
    </div>
    ${summary.truncated ? "" : renderCostChart(byDay ?? [])}
    ${renderBreakdownTable("By team", byTeam)}
    ${renderBreakdownTable("By repo", byRepo)}
    ${renderBreakdownTable("By pipeline", byPipeline)}
    <details class="cost-formula">
      <summary>Formula</summary>
      <p>Time saved per PR is ${fmtNumber(costs.timeSavedPerPrDefault ?? 4)}h by default, overridable per pipeline via <code>timeSavedPerPr</code>.</p>
      <p>Dollar cost is computed per-stage from each stage's model:</p>
      <ul>
        ${Object.entries(costs.modelPricing ?? {})
          .map(
            ([model, rate]) =>
              `<li><code>${escapeHtml(model)}</code>: $${escapeHtml(String(rate.inputPerMillion))}/M input, $${escapeHtml(String(rate.outputPerMillion))}/M output</li>`,
          )
          .join("")}
      </ul>
      <p>Hourly engineer rate (for ROI): ${fmtDollars(hourlyRate)}</p>
      <p>ROI = (hours saved &times; hourly rate) &divide; dollar cost</p>
    </details>`;

  if (partial) {
    return bodyInner;
  }

  const exportHref = buildExportHref(basePath, filters);
  const opt = (val: string, label: string) =>
    `<option value="${val}"${filters.preset === val ? " selected" : ""}>${escapeHtml(label)}</option>`;

  return `<div id="cost">
    <form method="get" action="${basePath}/cost" class="cost-filters"
          hx-get="${basePath}/cost/page" hx-trigger="change" hx-target="#cost-body">
      <label>Window
        <select name="window">
          ${opt("7d", "Last 7 days")}
          ${opt("30d", "Last 30 days")}
          ${opt("90d", "Last 90 days")}
          ${opt("365d", "Last 365 days")}
          ${opt("custom", "Custom")}
        </select>
      </label>
      ${
        filters.preset === "custom"
          ? `<input type="date" name="from" value="${escapeHtml(filters.from.toISOString().slice(0, 10))}">
             <input type="date" name="to" value="${escapeHtml(filters.to.toISOString().slice(0, 10))}">`
          : ""
      }
      <button type="submit">Apply</button>
      <a class="btn" href="${escapeHtml(exportHref)}">Export CSV</a>
    </form>
    <div id="cost-body">
      ${bodyInner}
    </div>
  </div>`;
}

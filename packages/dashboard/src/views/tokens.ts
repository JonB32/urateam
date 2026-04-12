import { escapeHtml } from "./layout.js";

interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
}

interface GroupedUsage {
  key: string;
  inputTokens: number;
  outputTokens: number;
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function barChart(items: { label: string; input: number; output: number }[], maxVal: number): string {
  if (maxVal === 0) maxVal = 1;
  return `<div class="bar-chart">
    ${items
      .map(
        (item) => `<div class="bar-row">
        <span class="bar-label">${escapeHtml(item.label)}</span>
        <div class="bar-track">
          <div class="bar-fill bar-fill-input" style="width:${((item.input / maxVal) * 100).toFixed(1)}%"></div>
        </div>
        <div class="bar-track">
          <div class="bar-fill bar-fill-output" style="width:${((item.output / maxVal) * 100).toFixed(1)}%"></div>
        </div>
        <span class="bar-value">in: ${formatTokenCount(item.input)} / out: ${formatTokenCount(item.output)}</span>
      </div>`
      )
      .join("\n")}
  </div>
  <div style="font-size:0.75rem;color:var(--color-text-muted);margin-bottom:1rem;">
    <span style="display:inline-block;width:0.75rem;height:0.75rem;background:var(--color-blue);border-radius:2px;vertical-align:middle;margin-right:0.25rem;"></span> Input
    <span style="display:inline-block;width:0.75rem;height:0.75rem;background:#8b5cf6;border-radius:2px;vertical-align:middle;margin-left:0.75rem;margin-right:0.25rem;"></span> Output
  </div>`;
}

export function tokensView(
  daily: DailyUsage[],
  byPipeline: GroupedUsage[],
  byStage: GroupedUsage[]
): string {
  const totalInput = daily.reduce((s, d) => s + d.inputTokens, 0);
  const totalOutput = daily.reduce((s, d) => s + d.outputTokens, 0);

  const dailyMax = Math.max(...daily.map((d) => Math.max(d.inputTokens, d.outputTokens)), 1);
  const pipelineMax = Math.max(...byPipeline.map((p) => Math.max(p.inputTokens, p.outputTokens)), 1);
  const stageMax = Math.max(...byStage.map((s) => Math.max(s.inputTokens, s.outputTokens)), 1);

  return `
  <div class="card">
    <h2>Summary</h2>
    <p>Total input tokens: <strong>${formatTokenCount(totalInput)}</strong> &middot;
    Total output tokens: <strong>${formatTokenCount(totalOutput)}</strong> &middot;
    Combined: <strong>${formatTokenCount(totalInput + totalOutput)}</strong></p>
  </div>

  <div class="card">
    <h2>Daily Usage (last 30 days)</h2>
    ${
      daily.length > 0
        ? barChart(
            daily.map((d) => ({ label: d.date, input: d.inputTokens, output: d.outputTokens })),
            dailyMax
          )
        : '<p style="color:var(--color-text-muted)">No data</p>'
    }
  </div>

  <div class="card">
    <h2>By Pipeline</h2>
    ${
      byPipeline.length > 0
        ? barChart(
            byPipeline.map((p) => ({ label: p.key, input: p.inputTokens, output: p.outputTokens })),
            pipelineMax
          )
        : '<p style="color:var(--color-text-muted)">No data</p>'
    }
  </div>

  <div class="card">
    <h2>By Stage</h2>
    ${
      byStage.length > 0
        ? barChart(
            byStage.map((s) => ({ label: s.key, input: s.inputTokens, output: s.outputTokens })),
            stageMax
          )
        : '<p style="color:var(--color-text-muted)">No data</p>'
    }
  </div>`;
}

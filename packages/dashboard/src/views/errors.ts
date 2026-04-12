import { escapeHtml } from "./layout.js";

interface StageFailure {
  stage: string;
  totalRuns: number;
  failedRuns: number;
  failureRate: number;
}

interface ErrorPattern {
  stage: string;
  errorMessage: string;
  count: number;
}

export function errorsView(
  stageFailures: StageFailure[],
  errorPatterns: ErrorPattern[]
): string {
  const failureTable =
    stageFailures.length > 0
      ? `<table>
      <thead>
        <tr><th>Stage</th><th>Total Runs</th><th>Failed</th><th>Failure Rate</th></tr>
      </thead>
      <tbody>
        ${stageFailures
          .map(
            (f) => `<tr>
            <td>${escapeHtml(f.stage)}</td>
            <td>${f.totalRuns}</td>
            <td>${f.failedRuns}</td>
            <td>
              <div class="bar-track" style="width:6rem;display:inline-block;vertical-align:middle;">
                <div class="bar-fill" style="width:${Number(f.failureRate).toFixed(1)}%;background:var(--color-red);"></div>
              </div>
              ${Number(f.failureRate).toFixed(1)}%
            </td>
          </tr>`
          )
          .join("\n")}
      </tbody>
    </table>`
      : '<p style="color:var(--color-text-muted)">No stage data</p>';

  const patternTable =
    errorPatterns.length > 0
      ? `<table>
      <thead>
        <tr><th>Stage</th><th>Error Message</th><th>Count</th></tr>
      </thead>
      <tbody>
        ${errorPatterns
          .map(
            (e) => `<tr>
            <td>${escapeHtml(e.stage)}</td>
            <td><code>${escapeHtml(e.errorMessage)}</code></td>
            <td>${e.count}</td>
          </tr>`
          )
          .join("\n")}
      </tbody>
    </table>`
      : '<p style="color:var(--color-text-muted)">No errors recorded</p>';

  return `
  <div class="card">
    <h2>Failure Rates by Stage</h2>
    ${failureTable}
  </div>

  <div class="card">
    <h2>Common Error Patterns</h2>
    ${patternTable}
  </div>`;
}

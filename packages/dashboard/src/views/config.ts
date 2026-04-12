import { escapeHtml } from "./layout.js";
import type { PipelineConfig, RepoConfig } from "@urateam/core";

/**
 * Redact embedded credentials (user:password@) from URLs before display.
 * Matches the pattern used in the core logger: url.replace(/:\/\/[^@]+@/, "://[redacted]@")
 */
function redactUrl(url: string): string {
  return url.replace(/:\/\/[^@]+@/, "://[redacted]@");
}

/**
 * Deep-clone a repo config and redact any embedded credentials from the URL.
 */
function sanitizeRepoConfig(cfg: RepoConfig): Record<string, unknown> {
  const obj = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  if (typeof obj["url"] === "string") {
    obj["url"] = redactUrl(obj["url"]);
  }
  return obj;
}

export function configView(
  pipelines: Record<string, PipelineConfig>,
  repos: Record<string, RepoConfig>
): string {
  return `
  <div class="card">
    <h2>Pipeline Configurations</h2>
    ${Object.entries(pipelines)
      .map(
        ([key, cfg]) => `<details>
        <summary>${escapeHtml(key)} - ${escapeHtml(cfg.name)}</summary>
        <pre><code>${escapeHtml(JSON.stringify(cfg, null, 2))}</code></pre>
      </details>`
      )
      .join("\n")}
    ${Object.keys(pipelines).length === 0 ? '<p style="color:var(--color-text-muted)">No pipeline configs loaded</p>' : ""}
  </div>

  <div class="card">
    <h2>Repository Configurations</h2>
    ${Object.entries(repos)
      .map(([key, cfg]) => {
        const sanitized = sanitizeRepoConfig(cfg);
        const redactedUrl = typeof sanitized["url"] === "string" ? sanitized["url"] : cfg.url;
        return `<details>
        <summary>${escapeHtml(key)} - ${escapeHtml(redactedUrl)}</summary>
        <pre><code>${escapeHtml(JSON.stringify(sanitized, null, 2))}</code></pre>
      </details>`;
      })
      .join("\n")}
    ${Object.keys(repos).length === 0 ? '<p style="color:var(--color-text-muted)">No repo configs loaded</p>' : ""}
  </div>`;
}

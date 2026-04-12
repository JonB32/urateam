// Base path for all dashboard links and asset references.
// Set DASHBOARD_BASE_PATH=/ateam (no trailing slash) when the dashboard is
// served under a path prefix (e.g. via a Caddy strip_prefix proxy).
export function getBasePath(): string {
  return (process.env.DASHBOARD_BASE_PATH ?? "").replace(/\/+$/, "");
}

/**
 * Normalize a basePath value so it has no trailing slash and starts with
 * a leading slash (or is empty string for root).
 *
 * Examples:
 *   ""        → ""
 *   "/"       → ""
 *   "/ateam"  → "/ateam"
 *   "/ateam/" → "/ateam"
 */
function normalizeBasePath(basePath: string): string {
  // Strip all trailing slashes; collapse bare "/" to ""
  return basePath.replace(/\/+$/, "");
}

/**
 * Render the full HTML shell (head + nav + main) around the given content.
 *
 * @param title    - Page title shown in <h1> and <title>.
 * @param content  - Inner HTML for the <main> element.
 * @param basePath - Root path prefix for all navigation links and static
 *                   asset references.  Must be provided without a trailing
 *                   slash (e.g. `"/ateam"` or `""`).  Every relative URL
 *                   attribute (`href`, `src`, etc.) inside this template
 *                   must use `${bp}/…` so links work correctly when the
 *                   dashboard is mounted under a reverse-proxy path prefix.
 *                   When omitted, falls back to the `DASHBOARD_BASE_PATH`
 *                   environment variable (via `getBasePath()`), then to
 *                   `""` (serve at root `/`).  Pass an explicit value
 *                   (sourced from `DashboardConfig.basePath`) to decouple
 *                   link rendering from the process environment.
 */
export function layout(title: string, content: string, basePath?: string): string {
  // Explicit parameter takes priority; fall back to env var for backward compat.
  const bp = normalizeBasePath(basePath ?? getBasePath());
  const cspContent =
    "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self'";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${cspContent}">
  <title>${escapeHtml(title)} - urateam</title>
  <!-- Favicon -->
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
  <!-- Inter font (falls back to system-ui in CSS) -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
  <link rel="stylesheet" href="${bp}/static/style.css">
  <script src="https://unpkg.com/htmx.org@2.0.0"></script>
</head>
<body>
  <nav>
    <a class="brand" href="${bp}/">⚡ urateam</a>
    <a href="${bp}/">Runs</a>
    <a href="${bp}/tokens">Tokens</a>
    <a href="${bp}/errors">Errors</a>
    <a href="${bp}/config">Config</a>
    <a href="${bp}/coordination">Coordination</a>
  </nav>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${content}
  </main>
</body>
</html>`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

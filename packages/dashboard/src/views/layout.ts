import { DASHBOARD_CSP } from "../csp.js";

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
/**
 * Optional context propagated from the request handler. When `userEmail`
 * is set the nav renders a Sign Out form (POST /auth/logout). Routes that
 * have access to `c.get("user")` should pass it; others omit and get the
 * existing layout unchanged.
 */
export interface LayoutContext {
  userEmail?: string;
  userRole?: string;
}

export function layout(
  title: string,
  content: string,
  basePath?: string,
  ctx?: LayoutContext,
): string {
  // Explicit parameter takes priority; fall back to env var for backward compat.
  const bp = normalizeBasePath(basePath ?? getBasePath());
  // Logout goes through the dashboard CSRF middleware (which requires an
  // HX-Request header on all state-changing routes). Using hx-post with an
  // explicit HX-Request header on the button ensures the request is not
  // forgeable from a third-party origin via a plain <form> submission.
  const signOut = ctx?.userEmail
    ? `<button type="button" class="link signout-btn" hx-post="${bp}/auth/logout" hx-headers='{"HX-Request":"true"}' hx-push-url="true" hx-swap="none">Sign out (${escapeHtml(ctx.userEmail)})</button>`
    : "";
  const cspContent = DASHBOARD_CSP;
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
  <script src="${bp}/static/dialog.js" defer></script>
</head>
<body>
  <nav>
    <a class="brand" href="${bp || "/"}">⚡ urateam</a>
    <a href="${bp || "/"}">Runs</a>
    <a href="${bp}/tokens">Tokens</a>
    <a href="${bp}/errors">Errors</a>
    <a href="${bp}/audit">Audit</a>
    <a href="${bp}/cost">Cost</a>
    <a href="${bp}/config">Config</a>
    <a href="${bp}/coordination">Coordination</a>
    ${ctx?.userRole === "admin" ? `<a href="${bp}/users">Users</a>` : ""}
    ${signOut}
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

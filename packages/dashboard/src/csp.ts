/**
 * Dashboard Content-Security-Policy string.
 *
 * Applied in two places that must stay in sync:
 *   1. HTTP response header — server.ts security middleware
 *   2. HTML meta tag      — views/layout.ts
 *
 * Policy rationale (BEC-131):
 *   - style-src 'unsafe-inline': dashboard views use 55+ inline style="..."
 *     attributes, several with dynamic values (e.g. percentage widths) that
 *     cannot be moved to a static stylesheet without significant refactoring.
 *   - style-src https://fonts.googleapis.com: layout loads the Inter font via
 *     a Google Fonts stylesheet link.
 *   - font-src https://fonts.gstatic.com: the Google Fonts CSS fetches the
 *     actual font files from this CDN; without an explicit font-src it falls
 *     back to default-src 'self' and is blocked.
 */
export const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com";

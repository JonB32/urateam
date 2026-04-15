function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderForbidden(args: {
  email: string;
  role: string;
  action: string;
  basePath: string;
}): string {
  return `<!DOCTYPE html>
<html><head><title>Forbidden</title></head><body>
  <h1>403 — Access denied</h1>
  <p>Your account (<strong>${escapeHtml(args.email)}</strong>, role <strong>${escapeHtml(args.role)}</strong>) does not have permission to access this page (requires <code>${escapeHtml(args.action)}</code>).</p>
  <p>Contact your administrator.</p>
  <p><a href="${escapeHtml(args.basePath)}/auth/logout">Sign out</a></p>
</body></html>`;
}

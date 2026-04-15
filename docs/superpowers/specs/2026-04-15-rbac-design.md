# Design: RBAC / multi-user (Enterprise feature 4.4)

**Date**: 2026-04-15
**Status**: Draft for review
**Parent strategy**: `docs/superpowers/specs/2026-04-13-enterprise-tier-design.md` § 4.4
**Scope**: Add a global role model (`admin` | `operator` | `viewer`) to the dashboard on top of feature 4.1's SSO foundation, gate every existing route by a static permission matrix, ship one new operator-gated write action (manual retry), and provide both a dashboard admin UI and a CLI for role management. License-gated by `isFeatureLicensed("rbac")`.

---

## 1. Goals and non-goals

### Goals
- Build on feature 4.1's `dashboard_users` table with a single `role` column — no new tables in v1, schema ready to extend for scoped roles in v2
- Define a permission matrix as **data, not code branches** — one source of truth that can be unit-tested per role × permission
- Ship the permission model with **at least one real write action** (manual retry) so the `operator` role has concrete meaning at launch
- Support both a `/users` admin dashboard page and a `ura admin` CLI so admins can manage roles without requiring shell access, and can recover without requiring dashboard access
- Bootstrap the first admin deterministically via `URATEAM_ADMIN_EMAILS` env var, avoiding the chicken-and-egg problem of "nobody can promote anyone without being an admin"
- Zero behavior change on deployments without the `rbac` license flag — the middleware is a no-op, the admin surface is 404, the CLI commands refuse

### Non-goals
- **Per-team or per-repo scoped role overrides.** Deferred to v2. The v1 schema is a single `role` column; v2 will add a `user_scope_roles` table without migrating the existing column
- **Additional write actions** (abort, approve, cancel, manual promote). Retry is the only v1 write. The middleware can gate these later without architectural changes
- **Bulk role assignment / CSV import.** Admins promote users one at a time
- **Role expiration / time-limited grants.** No TTL on roles; admins must manually revoke
- **Audit log filtered view** for role changes only. The existing audit feed with event-type filter is sufficient
- **A "read-only dashboard" mode** for unlicensed deployments that still want to hide `/config`. Unlicensed = SSO-binary-gate only

## 2. Roles and permission matrix

Three roles, plus the implicit "unauthorized" state for users not yet in the `dashboard_users` table:

| Route / Action | `admin` | `operator` | `viewer` |
|---|---|---|---|
| `GET /` redirect to `/runs` | ✓ | ✓ | ✓ |
| `GET /runs` | ✓ | ✓ | ✓ |
| `GET /runs/:id` | ✓ | ✓ | ✓ |
| `GET /tokens` | ✓ | ✓ | ✓ |
| `GET /errors` | ✓ | ✓ | ✓ |
| `GET /audit` (feature 4.2) | ✓ | ✓ | — |
| `GET /audit/export.csv` | ✓ | ✓ | — |
| `GET /cost` (feature 4.5) | ✓ | ✓ | — |
| `GET /cost/export.csv` | ✓ | ✓ | — |
| `GET /coordination` | ✓ | ✓ | — |
| `GET /config` | ✓ | — | — |
| `POST /runs/:id/retry` (**new**) | ✓ | ✓ | — |
| `GET /users` (**new**) | ✓ | — | — |
| `POST /users/:id/role` (**new**) | ✓ | — | — |
| `POST /auth/logout` | ✓ | ✓ | ✓ |

Non-obvious reasoning:
- **Audit, cost, coordination are operator-only.** Viewers get the run feed (day-to-day monitoring) but not the governance surface.
- **Errors is viewer-visible** — it's an operational health view, weird to hide.
- **Config is admin-only** because the view reveals secrets (Slack webhook, GitHub App IDs, WorkOS keys). Operators who need a config change ask an admin.
- **Retry is operator+admin** — the whole reason the operator role exists.
- **User management is admin-only.** Only admins assign roles.

## 3. Data model

### 3.1 Schema change

Add one column to the existing `dashboard_users` table (from feature 4.1):

```ts
// packages/core/src/db/schema.ts
export const dashboardUsers = sqliteTable("dashboard_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  workosUserId: text("workos_user_id"),
  createdAt: crossTimestamp("created_at").notNull().$defaultFn(() => new Date()),
  lastLoginAt: crossTimestamp("last_login_at"),
  role: text("role").notNull().default("viewer"),   // NEW
});
```

### 3.2 Migration

Use the existing `MIGRATION_COLUMNS` pattern in `packages/core/src/db/client.ts` — add one entry that generates driver-specific ALTER TABLE statements for both SQLite and Postgres:

```ts
{
  table: "dashboard_users",
  column: "role",
  sqliteType: "TEXT NOT NULL DEFAULT 'viewer'",
  pgType: "TEXT NOT NULL DEFAULT 'viewer'",
}
```

Also extend the `getCreateTablesDDL()` template so fresh installs get the column without depending on the ALTER path.

No separate `008_rbac.sql` / `009_rbac.sql` migration file needed — the `MIGRATION_COLUMNS` mechanism covers it. (Unlike features 4.1, 4.2, 4.5 which added new tables and needed file-based migrations.)

### 3.3 v2 extension point (documented, not implemented)

When scoped roles arrive, a new table is added:
```ts
userScopeRoles = sqliteTable("user_scope_roles", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => dashboardUsers.id),
  scopeKind: text("scope_kind").notNull(),       // "team" | "repo"
  scopeId: text("scope_id").notNull(),           // Linear team id or repo URL
  role: text("role").notNull(),
});
```

Effective-role computation becomes `max(user.role, scopeOverride)` where `max` respects the lattice `viewer < operator < admin`. The v1 `dashboard_users.role` column remains the base role — no breaking migration.

## 4. Module layout

New directory `packages/core/src/rbac/`:

```
rbac/
  index.ts            — barrel
  types.ts            — Role ("admin" | "operator" | "viewer"), PermissionKey, PermissionMatrix
  matrix.ts           — PERMISSION_MATRIX constant + canAccess(role, action) pure function
  user-role-store.ts  — setUserRole, getUserRole, listUsers, applyBootstrapAdmins
```

Each file has one responsibility. `matrix.ts` is pure data + one pure function. `user-role-store.ts` owns all DB writes to the `role` column.

### 4.1 `matrix.ts`

```ts
import type { Role } from "./types.js";

export const PERMISSION_MATRIX = {
  "runs.view":         ["admin", "operator", "viewer"],
  "runs.retry":        ["admin", "operator"],
  "tokens.view":       ["admin", "operator", "viewer"],
  "audit.view":        ["admin", "operator"],
  "audit.export":      ["admin", "operator"],
  "cost.view":         ["admin", "operator"],
  "cost.export":       ["admin", "operator"],
  "errors.view":       ["admin", "operator", "viewer"],
  "coordination.view": ["admin", "operator"],
  "config.view":       ["admin"],
  "users.view":        ["admin"],
  "users.manage":      ["admin"],
} as const satisfies Record<string, readonly Role[]>;

export type PermissionKey = keyof typeof PERMISSION_MATRIX;

export function canAccess(role: Role, action: PermissionKey): boolean {
  return (PERMISSION_MATRIX[action] as readonly Role[]).includes(role);
}
```

One source of truth. Every middleware call, every test, every role assignment validation reads from the same table.

### 4.2 `user-role-store.ts`

```ts
export async function setUserRole(
  db: AnyDb,
  args: { userId: string; newRole: Role; actorUserId: string; reason?: string },
): Promise<void>;

export async function getUserRole(db: AnyDb, userId: string): Promise<Role | null>;

export async function listUsers(
  db: AnyDb,
): Promise<Array<{ id: string; email: string; role: Role; lastLoginAt: Date | null }>>;

export async function applyBootstrapAdmins(
  db: AnyDb,
  email: string,
  userId: string,
  envAdminList: string | undefined,
): Promise<boolean>;  // returns true if role was changed
```

**`setUserRole` guardrails (enforced inside the helper so every caller inherits them):**
1. **Self-lockout prevention:** if `args.userId === args.actorUserId && args.newRole !== "admin"`, throw `SelfDemoteError`
2. **Last-admin prevention:** if the target is currently `admin` and `args.newRole !== "admin"`, run a `SELECT COUNT(*) WHERE role = 'admin'` query in the same transaction. If the count would drop to zero, throw `LastAdminError`
3. **Audit event:** after successful update, emit `dashboardGrantRoleEvent` (or `dashboardRevokeRoleEvent` if demoting to viewer) via `logAuditEvent`
4. **Idempotent:** setting a role to its current value is a no-op (no audit event, no DB write)

**`applyBootstrapAdmins` logic:**
1. If `envAdminList` is absent or empty, return `false`
2. Split on `,`, trim, lowercase each entry
3. If the normalized `email` is in the list AND the current user's role is not already `admin`, call `setUserRole({userId, newRole: "admin", actorUserId: "system"})`
4. Emit a distinct audit event subtype `action: "bootstrap_admin"` so the audit log shows "system granted admin to X via env var"

Called from `/auth/callback` right after `upsertUser` succeeds. Fire-and-forget with try/catch (a bootstrap failure must not block login).

## 5. Middleware

New file `packages/dashboard/src/middleware/rbac.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import { canAccess, type PermissionKey } from "@urateam/core";
import { isFeatureLicensed } from "@urateam/core";

export function requirePermission(action: PermissionKey): MiddlewareHandler {
  return async (c, next) => {
    // Feature-off: no gating (Pro/OSS unchanged)
    if (!isFeatureLicensed("rbac")) return next();

    const user = c.get("user") as { id: string; role: string } | undefined;
    if (!user) return c.text("Unauthorized", 401);  // SSO middleware should have caught this

    if (!canAccess(user.role as any, action)) {
      return c.html(renderForbidden(user.role, action), 403);
    }
    return next();
  };
}
```

Each existing dashboard route picks up a one-line decoration:
```ts
app.get("/audit", requirePermission("audit.view"), existingAuditHandler);
app.get("/audit/export.csv", requirePermission("audit.export"), existingCsvHandler);
app.get("/cost", requirePermission("cost.view"), existingCostHandler);
app.get("/config", requirePermission("config.view"), existingConfigHandler);
app.post("/runs/:id/retry", requirePermission("runs.retry"), retryHandler);
```

Routes that are viewer-accessible (`/runs`, `/tokens`, `/errors`) also get the decoration for consistency (`requirePermission("runs.view")` etc.) even though the matrix grants viewer access — this keeps all gating in one place.

### 5.1 Forbidden page

Minimal HTML: "Your account (`<email>`, role `<role>`) does not have permission to access this page. Contact your administrator." No link to `/` — the user might not have access to `/` either. `<a href="/auth/logout">Sign out</a>` always visible. All fields `escapeHtml`'d.

## 6. Bootstrap

### 6.1 Env var
`URATEAM_ADMIN_EMAILS=alice@acme.com,bob@acme.com` (comma-separated, case-insensitive). Read once at boot and passed to each SSO callback via the config.

### 6.2 CLI commands

`packages/cli/src/commands/admin.ts` — three subcommands:

```
ura admin list
ura admin grant <email> [--role admin|operator|viewer]    (default: operator)
ura admin revoke <email>                                  (sets role to viewer)
```

All three:
- Open the DB via `createDb({ connectionString: DATABASE_URL })`
- Call `setUserRole()` from the core barrel
- Write `dashboard.manual_action` audit events with `actor: "cli:<os_user>"`, `actorType: "cli"`
- Refuse to run with a clear error when `!isFeatureLicensed("rbac")`
- Exit non-zero on validation errors

The `revoke` command sets the target's role to `viewer` rather than deleting the row — the row is still referenced from the session table, and viewer is the minimum privilege, not absence of privilege.

## 7. `/users` admin UI

New route `packages/dashboard/src/routes/users.ts`:
- `GET /users` — renders a `<table>` of `{email, role dropdown, last_login_at}` rows. Every field through `escapeHtml`. Gated by `requirePermission("users.view")`.
- `POST /users/:id/role` — accepts form body `{role: "admin"|"operator"|"viewer"}`, validates against the three-role enum (zod), calls `setUserRole(db, {userId, newRole, actorUserId: session.user.id})`, redirects to `/users`. Gated by `requirePermission("users.manage")`. CSRF via the existing `HX-Request` header middleware (feature 4.1 BEC-103).

New view `packages/dashboard/src/views/users.ts`:
- Table rows: `<tr>` per user with HTMX-driven `<select hx-post="/users/{id}/role">`
- Self-lockout guard: the current user's own row disables the dropdown (label "You" next to their email)
- Last-admin guard: if the user is the only admin, their dropdown options exclude `operator` and `viewer` on the client side (server-side `setUserRole` also rejects)

Navigation: add "Users" to `views/layout.ts` nav, visible only when `user.role === "admin"`.

## 8. Retry endpoint

New route `POST /runs/:id/retry` in `packages/dashboard/src/routes/runs.ts` (the runs router already exists):
1. `requirePermission("runs.retry")` middleware
2. Load the run by id
3. If `status` is not `"failed"` or `"retriable"`, return 409 with `"cannot retry a run in status X"`
4. Call `runner.resume(runId)` when the run has a `resumePayload`, else `runner.start(...)` with the stored issue context
5. Emit `dashboardManualRetryEvent({runId, issueId, actorUserId, actorEmail})`
6. Redirect back to `/runs/:id` with an HTMX success banner

**UI surface:** new "Retry" button on the run detail page (`views/run-detail.ts`), rendered only when:
- `runner.isFeatureLicensed("rbac") && canAccess(session.user.role, "runs.retry")`
- `run.status in ("failed", "retriable")`

The button uses `hx-post="/runs/{id}/retry"` and reloads the page on success.

## 9. Audit integration

**No new event types in `AuditEventTypeSchema`.** Feature 4.2 reserved `dashboard.manual_action` for this exact use case. The `payload.action` field distinguishes subtypes:

| payload.action | Fired from | Payload shape |
|---|---|---|
| `"grant_role"` | `setUserRole` from dashboard or CLI | `{targetUserId, targetEmail, oldRole, newRole, actorUserId}` |
| `"revoke_role"` | `setUserRole` when `newRole === "viewer"` | same as grant_role |
| `"bootstrap_admin"` | `applyBootstrapAdmins` on SSO callback | `{targetUserId, targetEmail, envVarMatched: true}` |
| `"retry_run"` | `/runs/:id/retry` handler | `{runId, issueId, previousStatus, actorUserId}` |

New builder functions in `packages/core/src/audit/events.ts`:
- `dashboardGrantRoleEvent(args)` — builds a `dashboard.manual_action` event
- `dashboardRevokeRoleEvent(args)` — same, for demotions
- `dashboardBootstrapAdminEvent(args)` — for the env-var path
- `dashboardRetryRunEvent(args)` — for retry

All flow through the existing license-gated `logAuditEvent`.

## 10. License gate interaction

- `isFeatureLicensed("rbac") === false`:
  - `requirePermission` middleware short-circuits to `next()`, no gating
  - `/users` route returns 404
  - `POST /runs/:id/retry` returns 404
  - CLI `ura admin` commands print "RBAC is an Enterprise feature" and exit 1
  - `applyBootstrapAdmins` is a no-op (no silent admin grants)
- `isFeatureLicensed("rbac") === true && !isFeatureLicensed("sso")`:
  - Theoretically impossible in a valid license — both are Enterprise-tier
  - Defensive behavior: log a pino warning at startup, treat RBAC as off (no sessions means no users means no roles to attach)
- `isFeatureLicensed("rbac") === true && isFeatureLicensed("sso") === true`:
  - Full feature active
- OSS / Pro deployments: Basic Auth is unchanged, no user table, no role column read (the `dashboard_users` table is SSO-only so it simply doesn't exist in Basic Auth deployments)

## 11. Testing strategy

### 11.1 Unit (`packages/core/src/__tests__/rbac/`)
- `matrix.test.ts` — every role × every permission combination asserted against the spec's matrix
- `user-role-store.test.ts` — setUserRole happy path, self-lockout, last-admin guard, idempotent no-op, grant vs revoke audit event shape, listUsers ordering
- `bootstrap.test.ts` — `applyBootstrapAdmins` with match / no-match / empty env / multiple emails / already-admin / case insensitive

### 11.2 Middleware (`packages/dashboard/src/__tests__/rbac-middleware.test.ts`)
- `requirePermission("runs.view")` — admin/operator/viewer all pass; no session → 401
- `requirePermission("audit.view")` — admin/operator pass, viewer gets 403
- `requirePermission("config.view")` — only admin passes
- Feature unlicensed → all roles pass (no-op middleware)

### 11.3 Routes (`packages/dashboard/src/__tests__/users-routes.test.ts`)
- `GET /users` unlicensed → 404
- `GET /users` as viewer/operator → 403
- `GET /users` as admin → 200 with user list
- `POST /users/:id/role` as non-admin → 403
- `POST /users/:id/role` as admin, valid → 200 + audit event
- `POST /users/:id/role` self-demote → 400
- `POST /users/:id/role` last-admin demote → 400
- `POST /users/:id/role` invalid role value → 400

### 11.4 Retry endpoint (`packages/dashboard/src/__tests__/retry-route.test.ts`)
- Unlicensed → 404
- Viewer → 403
- Operator on a failed run → 200 + audit event + runner.resume called
- Operator on a completed run → 409
- Operator on a non-existent run → 404

### 11.5 CLI (`packages/cli/src/__tests__/admin-commands.test.ts`)
- `ura admin list` happy path, unlicensed refusal, correct table format
- `ura admin grant <email> --role operator` → DB row updated + audit event
- `ura admin revoke <email>` → role is viewer
- `ura admin grant <unknown-email>` → clear error, exit 1

### 11.6 End-to-end (`packages/core/src/__tests__/rbac-integration.test.ts`)
- SSO callback → `URATEAM_ADMIN_EMAILS` matches → user becomes admin → audit event
- Admin promotes second user to operator → operator can retry a failed run → audit event chain is complete
- Operator tries to access `/users` → 403

## 12. Migration and rollout

### 12.1 Schema
- `MIGRATION_COLUMNS` entry adds `role TEXT NOT NULL DEFAULT 'viewer'` on both drivers
- Fresh installs get the column via `getCreateTablesDDL()` template
- Existing SSO deployments: all current users default to `viewer` on migration — the `URATEAM_ADMIN_EMAILS` env var promotes them on their next login

### 12.2 Feature flag
- `rbac` added to the Enterprise feature set in `license.ts`
- OSS / Pro deployments unchanged (they don't use SSO, no dashboard_users table)

### 12.3 Rollout sequence for an existing Enterprise customer
1. Deploy the new binary with the migration — all current users default to `viewer`
2. **Before the dashboard comes up**, the operator sets `URATEAM_ADMIN_EMAILS` in their env for the bootstrap admins
3. Bootstrap admins log in → their role is auto-promoted to `admin`
4. They promote operators via `/users` UI
5. The remaining viewers stay viewers

The `URATEAM_ADMIN_EMAILS` env var can be removed after initial setup — existing admins persist, and new users default to viewer.

### 12.4 Operator setup guide
Append to `deploy/SSO_SETUP.md` (or a new `deploy/RBAC_SETUP.md`) a short section explaining the three roles, the bootstrap env var, and the `/users` admin page.

## 13. Open questions (deferred)

- **Scoped roles** (per-team, per-repo) — deferred to v2 with the extension-point schema documented in § 3.3
- **Additional write actions** (abort, approve, cancel, manual promote) — same middleware gates them; add in follow-up PRs
- **Bulk role assignment / CSV import** — wait for a customer with >20 users to ask
- **Role expiration / time-limited grants** — security feature for larger deployments; defer
- **"Read-only dashboard" mode** for unlicensed deployments that want `/config` hidden — conflates RBAC with feature gating
- **"Service account" roles** for machine-to-machine dashboard access (API tokens) — separate feature, no API exists yet
- **Last-admin guard under concurrent demotions** — the `SELECT COUNT` + UPDATE pattern has a TOCTOU window. v1 uses a single transaction which SQLite and Postgres both serialize; a rare race is possible but the guard is best-effort and the CLI recovery path exists as a fallback

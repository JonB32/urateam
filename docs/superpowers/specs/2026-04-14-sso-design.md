# Design: SSO via WorkOS (Enterprise feature 4.1)

**Date**: 2026-04-14
**Status**: Draft for review
**Parent strategy**: `docs/superpowers/specs/2026-04-13-enterprise-tier-design.md` § 4.1
**Scope**: Replace HTTP Basic Auth on the dashboard with a WorkOS-backed SAML/OIDC SSO flow when the SSO feature is licensed and enabled. Enterprise-tier feature, gated by `isFeatureLicensed("sso")`.

---

## 1. Goals and non-goals

### Goals
- Pass the customer's identity team review: dashboard access flows through their existing IdP (Okta, Azure AD, Google Workspace, OneLogin, etc.) via SAML or OIDC.
- One integration covers every IdP — accomplished by routing through WorkOS AuthKit so urateam never parses SAML XML or maintains per-IdP code.
- Server-side sessions backed by a DB table so an admin disabling a user in WorkOS results in their urateam dashboard session being revocable in seconds, not "whenever a JWT expires."
- Establish a `dashboard_users` table now so feature 4.4 (RBAC) lands on a real foundation, not a session-only hack.
- Audit every login, logout, and login-denied event so feature 4.2's compliance feed becomes meaningful for human dashboard activity.
- Zero behavior change on OSS/Pro deployments: Basic Auth remains exactly as today.

### Non-goals
- Per-route RBAC scoping. The SSO middleware is a binary gate: logged in or not. Roles ship in feature 4.4.
- Multi-tenant / multi-org WorkOS Organization mapping. urateam is single-tenant per deployment.
- SCIM provisioning. Out of the buyer profile per the parent strategy spec.
- Refresh tokens. 24h absolute session timeout is short enough that re-auth is acceptable and eliminates a class of token-refresh bugs.
- Idle-timeout distinction. One absolute-timeout knob (`sessionDurationHours`).
- "Remember me" extended sessions.
- Webhook authentication. Webhooks (`/webhooks/linear`, `/webhooks/github`, `/webhooks/slack`) keep their existing HMAC signature verification — correct for machine-to-machine.
- Coexistence with Basic Auth. SSO replaces Basic Auth entirely when enabled (mutually exclusive).
- Programmatic API auth. There is no `/api` namespace yet; deferred.
- DIY SAML. WorkOS abstracts it; we never touch XML.

## 2. Provider choice

**WorkOS AuthKit.** The official `@workos-inc/node` SDK exposes `userManagement.getAuthorizationUrl()` and `userManagement.authenticateWithCode()` — a two-call flow that handles SAML and OIDC behind a single API. The customer's IT team configures their IdP in the WorkOS admin UI; urateam sees only verified profiles.

Rationale (per brainstorm):
- Auth0 is significantly more expensive at the SAML-enabled tier and has a heavier SDK surface for no functional benefit at the buyer profile.
- Raw OIDC + DIY SAML (`openid-client` + `@node-saml/node-saml`) trades 2-3 days of integration work for an indefinite tail of IdP-compatibility bugs. SAML implementations are notoriously fragile across IdPs; the operational cost of debugging "why doesn't Azure AD's response validate" tickets is the actual price.
- WorkOS's free tier (1M MAU) covers all expected design-partner traffic; paid pricing folds into Enterprise contracts.

The strategy spec § 4.1 names WorkOS or Auth0 explicitly; we pick WorkOS.

## 3. Architecture

```
            Anonymous user
                  │
                  ▼ GET /runs
        ┌──────────────────────────────┐
        │ SSO middleware               │
        │ (skips /auth/*, /webhooks/*) │
        └──────────────────────────────┘
                  │ no cookie
                  ▼ 302 /auth/login?next=/runs
        ┌──────────────────────────────┐
        │ /auth/login                  │
        │ workos.getAuthorizationUrl() │
        └──────────────────────────────┘
                  │
                  ▼ 302 to WorkOS hosted UI
            ┌─────────────┐
            │   WorkOS    │ ── customer's IdP (Okta/Azure AD/Google/…)
            └─────────────┘
                  │
                  ▼ 302 /auth/callback?code=…&state=…
        ┌──────────────────────────────┐
        │ /auth/callback               │
        │ • verify state (CSRF)        │
        │ • authenticateWithCode()     │
        │ • domain allowlist check     │
        │ • upsertUser                 │
        │ • createSession              │
        │ • Set-Cookie                 │
        │ • emit dashboard.login event │
        └──────────────────────────────┘
                  │
                  ▼ 302 to validated `next` URL
              GET /runs (now with valid session cookie)
```

Webhooks bypass SSO middleware; their HMAC verification is unchanged.

## 4. Module layout

### 4.1 New core module: `packages/core/src/auth/`

```
auth/
  index.ts           — barrel
  workos-client.ts   — lazy-init wrapper over @workos-inc/node, one client per process
  session-store.ts   — createSession, getSession, deleteSession, pruneExpiredSessions
  user-store.ts      — upsertUser, getUserById
  sso-config.ts      — zod schema for the `sso` config section + signed-state helpers
```

`session-store.ts` operates on `dashboardSessions`. `user-store.ts` operates on `dashboardUsers`. Neither knows about WorkOS — they're storage primitives. `workos-client.ts` is the only file that imports the WorkOS SDK.

### 4.2 New dashboard surfaces

```
packages/dashboard/src/middleware/sso.ts   — Hono middleware: cookie → session → user → c.set("user", ...)
packages/dashboard/src/routes/auth.ts      — GET /auth/login, GET /auth/callback, POST /auth/logout
```

The existing `server.ts` wires either the SSO stack OR the Basic Auth middleware, never both.

## 5. Data model

### 5.1 Tables

```ts
export const dashboardUsers = sqliteTable("dashboard_users", {
  id: text("id").primaryKey(),                 // uuid (urateam-issued; stable across email changes)
  email: text("email").notNull().unique(),
  name: text("name"),
  workosUserId: text("workos_user_id"),
  createdAt: crossTimestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
  lastLoginAt: crossTimestamp("last_login_at"),
});

export const dashboardSessions = sqliteTable("dashboard_sessions", {
  id: text("id").primaryKey(),                 // 32-byte random, base64url
  userId: text("user_id")
    .notNull()
    .references(() => dashboardUsers.id),
  createdAt: crossTimestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: crossTimestamp("expires_at").notNull(),
  lastSeenAt: crossTimestamp("last_seen_at")
    .notNull()
    .$defaultFn(() => new Date()),
});
```

Indexes (declared in the migration files):
- `idx_dashboard_sessions_user_id` on `(user_id)`
- `idx_dashboard_sessions_expires_at` on `(expires_at)`

Drizzle schema additions in `db/schema.ts`. `getCreateTablesDDL()` in `db/client.ts` extended with both tables. New file-based migrations:
- `db/migrations/sqlite/007_sso.sql`
- `db/migrations/postgres/008_sso.sql`

### 5.2 Session lifecycle
- **Created** in `/auth/callback` after WorkOS verification + domain allowlist + user upsert
- **Read** on every request to a non-`/auth/*`, non-`/webhooks/*` route. The middleware looks up by cookie, validates `expiresAt > now()`, and updates `lastSeenAt`
- **Deleted** explicitly via `POST /auth/logout`, or via the periodic prune sweep when expired
- **Pruned** by `pruneExpiredSessions(db)` running in the PM scheduler tick

`lastSeenAt` updates on every authenticated request. To avoid write amplification, the update is best-effort (ignore failures) and could be batched in v2 if it becomes a hot path. v1 writes per-request — dashboards are not high-QPS.

## 6. Configuration

New `sso` section added to `AppConfig` zod schema in `types.ts`:

```ts
sso: z.object({
  enabled: z.boolean().default(false),
  workosApiKey: z.string(),                    // sk_test_... or sk_live_...
  workosClientId: z.string(),                  // client_...
  redirectUri: z.string().url(),               // https://<host>/auth/callback
  allowedDomain: z.string().optional(),        // "acme.com" — restricts which emails get sessions
  sessionDurationHours: z.number().int().positive().default(24),
  cookieName: z.string().default("urateam_session"),
  cookieSecure: z.boolean().default(true),
  stateSigningSecret: z.string(),              // 32+ byte random, used to HMAC the OAuth state param
}).optional()
```

`workosApiKey` and `stateSigningSecret` must come from environment variables, never from a checked-in config file. The CLI startup validates this and refuses to boot if either is configured but the other is missing.

The `enabled` boolean is independently honored from license: **both** `isFeatureLicensed("sso") === true` AND `config.sso?.enabled === true` must be true to mount the SSO stack. This lets a customer stage their SSO config before flipping it on, and lets ops disable SSO via config without touching their license.

## 7. Auth flow detail

### 7.1 GET /auth/login
1. Read `next` query param; default `/`
2. Validate `next` is a same-origin path (starts with `/`, no `//` prefix, no `\`)
3. Generate signed state: `base64url(JSON.stringify({next, nonce: randomUUID()}))` + HMAC-SHA256 with `stateSigningSecret`. Format: `<payload>.<hmac>`
4. Call `workos.userManagement.getAuthorizationUrl({clientId, redirectUri, state, provider: "authkit"})`
5. 302 to the returned URL

### 7.2 GET /auth/callback
1. Verify the `state` parameter HMAC. Reject with 400 on mismatch (CSRF guard)
2. Decode `state.next` (default `/`)
3. Call `workos.userManagement.authenticateWithCode({code, clientId})` → `{user: {id, email, firstName, lastName}, accessToken}`
4. If `sso.allowedDomain` is set, verify `user.email.toLowerCase().endsWith("@" + allowedDomain.toLowerCase())`. On mismatch:
   - Emit `dashboard.login_denied` audit event with `{email, reason: "domain-mismatch"}`
   - Render a 403 page: "Access denied. Your email <email> is not in the allowed domain. Contact your administrator."
5. `upsertUser({email, name: firstName + " " + lastName, workosUserId: user.id})` → `userId`
6. `createSession({userId, durationHours: config.sso.sessionDurationHours})` → `sessionId`
7. Set-Cookie:
   `<cookieName>=<sessionId>; HttpOnly; SameSite=Lax; Secure (if cookieSecure); Path=/; Max-Age=<seconds>`
8. Emit `dashboard.login` audit event with `{userId, email, workosUserId}`
9. 302 to `state.next`

### 7.3 POST /auth/logout
1. Read session cookie
2. If present, delete the session row by id
3. Emit `dashboard.logout` audit event with `{userId}`
4. Clear the cookie (Set-Cookie with `Max-Age=0`)
5. 302 to `/auth/login`

The form on the dashboard nav posts here with a CSRF token. The dashboard already has CSRF middleware; the logout form uses it.

### 7.4 SSO middleware
```ts
async function ssoMiddleware(c, next) {
  const path = c.req.path;
  if (path.startsWith("/auth/")) return next();
  if (path.startsWith("/webhooks/")) return next();

  const cookie = getCookie(c, config.sso.cookieName);
  if (!cookie) return c.redirect(`/auth/login?next=${encodeURIComponent(path)}`, 302);

  const session = await getSession(db, cookie);
  if (!session || session.expiresAt < new Date()) {
    deleteCookie(c, config.sso.cookieName);
    return c.redirect(`/auth/login?next=${encodeURIComponent(path)}`, 302);
  }

  const user = await getUserById(db, session.userId);
  if (!user) {  // edge case: user deleted but session still exists
    await deleteSession(db, cookie);
    deleteCookie(c, config.sso.cookieName);
    return c.redirect(`/auth/login`, 302);
  }

  c.set("user", user);
  c.set("session", session);
  void touchSessionLastSeen(db, cookie);  // fire-and-forget
  return next();
}
```

## 8. Wiring in `server.ts`

```ts
const ssoActive = isFeatureLicensed("sso") && config.sso?.enabled === true;

if (ssoActive) {
  // Mount /auth/* routes (no SSO middleware)
  const authRouter = createAuthRouter({ db: config.db, sso: config.sso, basePath });
  app.route("/", authRouter);

  // SSO middleware on everything else (skips /auth/* and /webhooks/* internally)
  app.use("*", ssoMiddleware({ db: config.db, sso: config.sso }));
} else if (config.auth?.username && config.auth?.password) {
  app.use("*", basicAuth({ username: config.auth.username, password: config.auth.password }));
} else {
  app.use("*", async (c) => c.text("Dashboard authentication required but not configured.", 503));
}
```

Order matters: webhook routes that mount under the same Hono app must be registered **before** the SSO middleware OR the middleware must skip `/webhooks/*` (it does, by path prefix check). Existing dashboard tests that boot the server without `sso.enabled` are unaffected.

## 9. Audit integration

Three new event types added to `AuditEventTypeSchema` in `types.ts`:

| Event | Where | Payload |
|---|---|---|
| `dashboard.login` | `/auth/callback` after session created | `{userId, email, workosUserId}` |
| `dashboard.logout` | `/auth/logout` after session deleted | `{userId}` |
| `dashboard.login_denied` | `/auth/callback` after domain mismatch | `{email, reason: "domain-mismatch"}` |

These are written via `logAuditEvent` (gated by `isFeatureLicensed("audit-log")` per feature 4.2), so a deployment with SSO licensed but audit-log unlicensed simply has no audit trail — same gating model as the rest of the audit module.

The `dashboard.manual_action` event reserved in feature 4.2 is **still** unwritten in v1. Feature 4.4 (RBAC) will start writing it once there are role-aware actions to attribute.

Actor field: `actor = "dashboard:" + email`, `actorType = "dashboard-user"`.

## 10. PM scheduler tick integration

Add `pruneExpiredSessions(db)` as a new step after `pruneAuditLog`:

> budget check → recover retriable → recover stuck → startTodoIssues → triage → resolve approvals → promote → deprioritize → cancel → digest → pruneAuditLog → **pruneExpiredSessions**

Gated on `isFeatureLicensed("sso")`. No-op otherwise. Wrapped in try/catch — sweep failure must not crash the tick.

## 11. Error handling

| Failure mode | Response |
|---|---|
| WorkOS API down at `/auth/login` | Render error page "SSO provider unreachable. Try again or contact your administrator." 503. No fallback to Basic Auth. |
| WorkOS API down at `/auth/callback` | Same as above. The user re-tries; nothing was persisted. |
| `state` HMAC mismatch | 400 "Invalid login state. Please try again." |
| `state` payload malformed | 400 same as above |
| Domain allowlist mismatch | 403 with the denied-access page; audit event written |
| Invalid session cookie format | Treat as no cookie (clear it, redirect to login) |
| Session row not found | Same as above |
| Session expired | Same as above |
| User row missing despite valid session (edge case) | Delete session, clear cookie, redirect to login |
| `pruneExpiredSessions` throws | pino warn; tick continues |
| `touchSessionLastSeen` throws | pino warn; request continues |

## 12. Security considerations

- **Session id entropy:** 32 bytes from `crypto.randomBytes`, base64url encoded. ~256 bits of entropy. Stored as opaque text in DB; not hashed (the cookie value IS the lookup key — hashing would prevent O(1) lookup and the threat model is database compromise, in which case the rest of the audit data is also exposed).
- **Cookie attributes:** `HttpOnly` (no JS access), `SameSite=Lax` (allows top-level GET navigation from email links but blocks cross-site POST CSRF), `Secure` (default true; configurable for local dev over plain HTTP), `Path=/`, `Max-Age` matching session duration.
- **CSRF on logout:** existing dashboard CSRF middleware (BEC-103) handles this. The logout form includes the CSRF token.
- **Open redirect on `next`:** the `next` param is validated to be a same-origin absolute path (`/foo/bar`), rejecting `//evil.com`, `https://evil.com`, and backslashes. Tested.
- **State parameter:** HMAC-SHA256 with `stateSigningSecret`. Includes a nonce so reusing a state value (CSRF replay) doesn't validate twice — the nonce isn't tracked server-side in v1; the state is single-use only via the cookie redirect, and short-lived. Sufficient for v1.
- **Secrets at rest:** `workosApiKey` and `stateSigningSecret` come from env vars. The CLI startup validates presence and refuses to boot if either is missing when `sso.enabled === true`.
- **Email case sensitivity:** `email` stored lowercase. Lookups normalize to lowercase. The unique constraint is on the lowercase form.
- **Logout doesn't revoke WorkOS session:** intentional. Logout clears the urateam session only; if the user re-clicks login, WorkOS may return them silently if their IdP session is still active. This is normal SSO UX and matches user expectations.

## 13. Testing strategy

### 13.1 Unit (`packages/core/src/__tests__/auth/`)
- `session-store.test.ts` — create / get / delete / expire / prune
- `user-store.test.ts` — upsert (insert + update by email), getById, lowercased email
- `sso-config.test.ts` — zod parse, missing required fields, signed state HMAC round-trip
- `workos-client.test.ts` — lazy init, single-instance per process

### 13.2 Middleware (`packages/dashboard/src/__tests__/sso-middleware.test.ts`)
- No cookie → 302 to `/auth/login?next=<path>`
- Invalid cookie → cleared, 302
- Expired session → cleared, 302
- Valid session → `c.get("user")` populated, next() called
- `/auth/*` and `/webhooks/*` paths bypass middleware
- Open-redirect protection: `next=//evil.com`, `next=https://evil.com`, `next=\\evil.com` all rejected

### 13.3 Routes (`packages/dashboard/src/__tests__/auth-routes.test.ts`)
- `GET /auth/login` returns 302 to a WorkOS URL; state is signed; next param is preserved
- `GET /auth/callback` with valid stubbed WorkOS response: session created, cookie set, audit event written, 302 to next
- `GET /auth/callback` with state mismatch: 400
- `GET /auth/callback` with domain mismatch: 403, `dashboard.login_denied` event written
- `POST /auth/logout` deletes session, clears cookie, audit event written

WorkOS client is stubbed via dependency injection (`createAuthRouter` accepts a `workos` client param).

### 13.4 Server integration (`packages/dashboard/src/__tests__/sso-integration.test.ts`)
- Server with `sso.enabled=false` → Basic Auth path unchanged
- Server with `sso.enabled=true, isFeatureLicensed=false` → 503 (license required)
- Server with both true: `GET /runs` redirects to `/auth/login`; after stubbed callback, `GET /runs` returns 200
- Webhooks (`POST /webhooks/linear`) bypass SSO middleware in the licensed+enabled case

### 13.5 Audit (`packages/core/src/__tests__/auth/sso-audit-events.test.ts`)
- Login flow writes `dashboard.login`
- Logout writes `dashboard.logout`
- Domain denial writes `dashboard.login_denied`
- All three are no-ops when `audit-log` is unlicensed

### 13.6 PM tick
- `packages/core/src/__tests__/pm-sso-prune-step.test.ts` — `pruneExpiredSessions` runs after `pruneAuditLog`, only when sso licensed, gracefully handles errors

## 14. Migration + rollout

### 14.1 Schema migration
- New file `db/migrations/sqlite/007_sso.sql` and `db/migrations/postgres/008_sso.sql`
- `getCreateTablesDDL(driver)` extended with both tables for fresh installs
- Drizzle schema in `schema.ts` extended

### 14.2 Backfill
None. Tables start empty. First login creates the user.

### 14.3 Feature flag
- `sso` added to the Enterprise feature set in `license.ts`
- OSS / Pro deployments: SSO config is ignored even if present; Basic Auth path unchanged
- Enterprise deployments without `sso.enabled=true`: also unchanged (Basic Auth)
- Enterprise deployments with `sso.enabled=true`: SSO replaces Basic Auth

### 14.4 Customer onboarding doc
A short README section `deploy/SSO_SETUP.md` (created by the implementation plan) walks an operator through:
1. Create a WorkOS account, get API key + client id
2. Configure their IdP via WorkOS admin UI
3. Set `URATEAM_WORKOS_API_KEY` and `URATEAM_SSO_STATE_SECRET` env vars
4. Add `sso` block to config with `enabled: true`, `redirectUri`, `allowedDomain`
5. Restart urateam
6. Verify `/auth/login` redirects to their IdP

## 15. Open questions (deferred)
- **Idle timeout vs absolute timeout:** v1 is absolute only. Add idle timeout if customers ask.
- **Session "remember me":** v1 is one fixed duration. Add longer-lived sessions if needed.
- **WorkOS Organizations:** v1 is single-tenant. Multi-org mapping is feature 4.4 territory if at all.
- **Refresh tokens:** v1 issues a 24h session and re-prompts. Acceptable for the buyer profile.
- **Webhook signature verification consolidation:** out of scope for SSO; webhook auth is unchanged.

# SSO via WorkOS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship enterprise feature 4.1 — replace HTTP Basic Auth on the dashboard with WorkOS-backed SAML/OIDC SSO when licensed and enabled — per `docs/superpowers/specs/2026-04-14-sso-design.md`.

**Architecture:** New `packages/core/src/auth/` module owns session and user storage; `packages/dashboard/src/middleware/sso.ts` and `routes/auth.ts` own the request flow; `server.ts` mounts either the SSO stack OR Basic Auth, never both. Two new tables (`dashboard_users`, `dashboard_sessions`) follow the existing Drizzle + crossTimestamp patterns. Three new audit event types (`dashboard.login`, `dashboard.logout`, `dashboard.login_denied`) are written through the existing license-gated `logAuditEvent`.

**Tech Stack:** `@workos-inc/node`, Hono, Drizzle ORM, Vitest, Zod, pino. WorkOS client is dependency-injectable so tests stub it without network calls.

---

## File Structure

### New files
- `packages/core/src/auth/index.ts` — barrel export
- `packages/core/src/auth/sso-config.ts` — zod schema for the `sso` config + `signState` / `verifyState` HMAC helpers + `validateNextPath` open-redirect guard
- `packages/core/src/auth/user-store.ts` — `upsertUser`, `getUserById` (storage primitive over `dashboardUsers`)
- `packages/core/src/auth/session-store.ts` — `createSession`, `getSession`, `deleteSession`, `pruneExpiredSessions`, `touchSessionLastSeen`
- `packages/core/src/auth/workos-client.ts` — lazy-init wrapper over `@workos-inc/node`
- `packages/core/src/db/migrations/sqlite/007_sso.sql`
- `packages/core/src/db/migrations/postgres/008_sso.sql`
- `packages/core/src/__tests__/auth/session-store.test.ts`
- `packages/core/src/__tests__/auth/user-store.test.ts`
- `packages/core/src/__tests__/auth/sso-config.test.ts`
- `packages/core/src/__tests__/auth/sso-audit-events.test.ts`
- `packages/core/src/__tests__/pm-sso-prune-step.test.ts`
- `packages/dashboard/src/middleware/sso.ts`
- `packages/dashboard/src/routes/auth.ts`
- `packages/dashboard/src/__tests__/sso-middleware.test.ts`
- `packages/dashboard/src/__tests__/auth-routes.test.ts`
- `packages/dashboard/src/__tests__/sso-integration.test.ts`
- `deploy/SSO_SETUP.md`

### Modified files
- `packages/core/src/db/schema.ts` — add `dashboardUsers`, `dashboardSessions`
- `packages/core/src/db/client.ts` — extend `getCreateTablesDDL()`
- `packages/core/src/types.ts` — `SsoConfigSchema`, extend `AppConfigSchema.sso`, add three audit event types
- `packages/core/src/audit/events.ts` — add `dashboardLoginEvent`, `dashboardLogoutEvent`, `dashboardLoginDeniedEvent`
- `packages/core/src/license.ts` — add `"sso"` to Enterprise feature set
- `packages/core/src/pm/scheduler.ts` — call `pruneExpiredSessions` after `pruneAuditLog`
- `packages/core/src/index.ts` — re-export `./auth/index.js`
- `packages/dashboard/package.json` — add `@workos-inc/node` dep
- `packages/dashboard/src/server.ts` — branch on `ssoActive` to mount SSO stack vs Basic Auth
- `packages/dashboard/src/views/layout.ts` — add "Sign out" link in nav (only when SSO is active)
- `CLAUDE.md` — new "SSO" section under Key Patterns

---

## Task 1: Schema + migration for dashboard_users and dashboard_sessions

**Files:**
- Create: `packages/core/src/db/migrations/sqlite/007_sso.sql`
- Create: `packages/core/src/db/migrations/postgres/008_sso.sql`
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/core/src/db/client.ts` (`getCreateTablesDDL`)
- Test: `packages/core/src/__tests__/db-sso-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { dashboardUsers, dashboardSessions } from "../db/schema.js";
import { sql } from "drizzle-orm";

describe("sso schema", () => {
  it("creates dashboard_users and dashboard_sessions tables on fresh SQLite db", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const userCols = (db as any).all(sql`PRAGMA table_info(dashboard_users)`) as Array<{name: string}>;
    expect(userCols.map(c => c.name).sort()).toEqual([
      "created_at", "email", "id", "last_login_at", "name", "workos_user_id",
    ]);
    const sessionCols = (db as any).all(sql`PRAGMA table_info(dashboard_sessions)`) as Array<{name: string}>;
    expect(sessionCols.map(c => c.name).sort()).toEqual([
      "created_at", "expires_at", "id", "last_seen_at", "user_id",
    ]);
  });

  it("inserts and reads back a user + session", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await (db as any).insert(dashboardUsers).values({
      id: "u_1", email: "a@b.com", name: "A B", workosUserId: "wu_1",
    });
    await (db as any).insert(dashboardSessions).values({
      id: "s_1", userId: "u_1", expiresAt: new Date(Date.now() + 3600_000),
    });
    const users = await (db as any).select().from(dashboardUsers);
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe("a@b.com");
    const sessions = await (db as any).select().from(dashboardSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].userId).toBe("u_1");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```
cd packages/core && npx vitest run src/__tests__/db-sso-schema.test.ts
```
Expected: FAIL (tables not exported from schema.ts).

- [ ] **Step 3: Add tables to `db/schema.ts`**

Append at end of `packages/core/src/db/schema.ts`:
```ts
export const dashboardUsers = sqliteTable("dashboard_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  workosUserId: text("workos_user_id"),
  createdAt: crossTimestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
  lastLoginAt: crossTimestamp("last_login_at"),
});

export const dashboardSessions = sqliteTable("dashboard_sessions", {
  id: text("id").primaryKey(),
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

- [ ] **Step 4: Create the SQLite migration file**

Create `packages/core/src/db/migrations/sqlite/007_sso.sql`:
```sql
-- Enterprise feature 4.1: SSO via WorkOS
CREATE TABLE IF NOT EXISTS dashboard_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  workos_user_id TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES dashboard_users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_user_id ON dashboard_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires_at ON dashboard_sessions(expires_at);
```

- [ ] **Step 5: Create the Postgres migration file**

Create `packages/core/src/db/migrations/postgres/008_sso.sql`:
```sql
-- Enterprise feature 4.1: SSO via WorkOS
CREATE TABLE IF NOT EXISTS dashboard_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  workos_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES dashboard_users(id),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_user_id ON dashboard_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires_at ON dashboard_sessions(expires_at);
```

- [ ] **Step 6: Extend `getCreateTablesDDL()` in `db/client.ts`**

Find the closing backtick of `getCreateTablesDDL()` and insert before it:
```sql
  CREATE TABLE IF NOT EXISTS dashboard_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    workos_user_id TEXT,
    created_at ${ts} NOT NULL,
    last_login_at ${ts}
  );
  CREATE TABLE IF NOT EXISTS dashboard_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES dashboard_users(id),
    created_at ${ts} NOT NULL,
    expires_at ${ts} NOT NULL,
    last_seen_at ${ts} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_user_id ON dashboard_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires_at ON dashboard_sessions(expires_at);
```

- [ ] **Step 7: Run the test, verify pass**

```
cd packages/core && npx vitest run src/__tests__/db-sso-schema.test.ts
```
Expected: PASS (2/2).

- [ ] **Step 8: Commit**

```
git add packages/core/src/db packages/core/src/__tests__/db-sso-schema.test.ts
git commit -m "feat(sso): add dashboard_users and dashboard_sessions tables"
```

---

## Task 2: SSO config zod schema + signed state helpers

**Files:**
- Create: `packages/core/src/auth/sso-config.ts`
- Create: `packages/core/src/auth/index.ts` (barrel, only this one export at this point)
- Modify: `packages/core/src/types.ts`
- Test: `packages/core/src/__tests__/auth/sso-config.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/auth/sso-config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { SsoConfigSchema } from "../../types.js";
import { signState, verifyState, validateNextPath } from "../../auth/sso-config.js";

const validConfig = {
  enabled: true,
  workosApiKey: "sk_test_xxx",
  workosClientId: "client_xxx",
  redirectUri: "https://example.com/auth/callback",
  stateSigningSecret: "0123456789abcdef0123456789abcdef",
};

describe("SsoConfigSchema", () => {
  it("parses a valid config", () => {
    const parsed = SsoConfigSchema.parse(validConfig);
    expect(parsed.sessionDurationHours).toBe(24);
    expect(parsed.cookieName).toBe("urateam_session");
    expect(parsed.cookieSecure).toBe(true);
  });

  it("rejects missing apiKey", () => {
    const bad = { ...validConfig } as any;
    delete bad.workosApiKey;
    expect(() => SsoConfigSchema.parse(bad)).toThrow();
  });

  it("rejects non-url redirectUri", () => {
    expect(() => SsoConfigSchema.parse({ ...validConfig, redirectUri: "not-a-url" })).toThrow();
  });
});

describe("signState / verifyState", () => {
  const secret = "0123456789abcdef0123456789abcdef";

  it("round-trips a payload", () => {
    const signed = signState({ next: "/runs", nonce: "abc" }, secret);
    const verified = verifyState(signed, secret);
    expect(verified).toEqual({ next: "/runs", nonce: "abc" });
  });

  it("rejects a tampered payload", () => {
    const signed = signState({ next: "/runs", nonce: "abc" }, secret);
    const tampered = signed.replace("/runs", "/evil");
    expect(verifyState(tampered, secret)).toBeNull();
  });

  it("rejects a wrong-secret signature", () => {
    const signed = signState({ next: "/runs", nonce: "abc" }, secret);
    expect(verifyState(signed, "different-secret-1234567890abcdef")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyState("garbage", secret)).toBeNull();
    expect(verifyState("no.dot", secret)).toBeNull();
    expect(verifyState("", secret)).toBeNull();
  });
});

describe("validateNextPath", () => {
  it("accepts same-origin absolute paths", () => {
    expect(validateNextPath("/")).toBe("/");
    expect(validateNextPath("/runs")).toBe("/runs");
    expect(validateNextPath("/runs/123")).toBe("/runs/123");
  });

  it("rejects scheme-relative URLs", () => {
    expect(validateNextPath("//evil.com")).toBe("/");
    expect(validateNextPath("//evil.com/path")).toBe("/");
  });

  it("rejects absolute URLs", () => {
    expect(validateNextPath("https://evil.com")).toBe("/");
    expect(validateNextPath("http://evil.com")).toBe("/");
  });

  it("rejects backslash variants", () => {
    expect(validateNextPath("/\\evil.com")).toBe("/");
    expect(validateNextPath("\\\\evil.com")).toBe("/");
  });

  it("falls back to / for empty / nullish", () => {
    expect(validateNextPath("")).toBe("/");
    expect(validateNextPath(undefined as any)).toBe("/");
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/auth/sso-config.test.ts
```
Expected: FAIL (modules don't exist).

- [ ] **Step 3: Add `SsoConfigSchema` to `types.ts`**

Append to `packages/core/src/types.ts`:
```ts
export const SsoConfigSchema = z.object({
  enabled: z.boolean().default(false),
  workosApiKey: z.string().min(1),
  workosClientId: z.string().min(1),
  redirectUri: z.string().url(),
  allowedDomain: z.string().optional(),
  sessionDurationHours: z.number().int().positive().default(24),
  cookieName: z.string().default("urateam_session"),
  cookieSecure: z.boolean().default(true),
  stateSigningSecret: z.string().min(16),
});
export type SsoConfig = z.infer<typeof SsoConfigSchema>;
```

Also extend `AppConfigSchema` (added by feature 4.2) to include `sso: SsoConfigSchema.optional()`.

Also append three new audit event types to `AuditEventTypeSchema`:
```ts
"dashboard.login", "dashboard.logout", "dashboard.login_denied",
```

- [ ] **Step 4: Create `auth/sso-config.ts`**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

interface StatePayload {
  next: string;
  nonce: string;
}

export function signState(payload: StatePayload, secret: string): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  const hmac = createHmac("sha256", secret).update(b64).digest("base64url");
  return `${b64}.${hmac}`;
}

export function verifyState(signed: string, secret: string): StatePayload | null {
  if (!signed || typeof signed !== "string") return null;
  const idx = signed.lastIndexOf(".");
  if (idx <= 0 || idx === signed.length - 1) return null;
  const b64 = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = createHmac("sha256", secret).update(b64).digest("base64url");
  const sigBuf = Buffer.from(sig, "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const json = Buffer.from(b64, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (typeof parsed?.next !== "string" || typeof parsed?.nonce !== "string") return null;
    return parsed as StatePayload;
  } catch {
    return null;
  }
}

/**
 * Validate that `next` is a same-origin absolute path. Reject scheme-relative
 * (`//evil.com`), absolute (`https://evil.com`), and backslash variants.
 * Falls back to "/" on any rejection.
 */
export function validateNextPath(next: string | undefined | null): string {
  if (!next || typeof next !== "string") return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//")) return "/";
  if (next.startsWith("/\\") || next.includes("\\")) return "/";
  return next;
}
```

- [ ] **Step 5: Create the barrel `auth/index.ts`**

```ts
export * from "./sso-config.js";
```

- [ ] **Step 6: Run tests, verify pass**

```
cd packages/core && npx vitest run src/__tests__/auth/sso-config.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```
git add packages/core/src/auth packages/core/src/types.ts packages/core/src/__tests__/auth/sso-config.test.ts
git commit -m "feat(sso): config schema and signed state helpers"
```

---

## Task 3: User store

**Files:**
- Create: `packages/core/src/auth/user-store.ts`
- Modify: `packages/core/src/auth/index.ts`
- Test: `packages/core/src/__tests__/auth/user-store.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../../db/client.js";
import { upsertUser, getUserById } from "../../auth/user-store.js";

let db: any;
beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
});

describe("upsertUser", () => {
  it("inserts a new user and returns its id", async () => {
    const id = await upsertUser(db, { email: "a@b.com", name: "Alice", workosUserId: "wu_1" });
    expect(id).toBeTruthy();
    const user = await getUserById(db, id);
    expect(user?.email).toBe("a@b.com");
    expect(user?.name).toBe("Alice");
    expect(user?.workosUserId).toBe("wu_1");
  });

  it("updates an existing user (matched by email) and returns the same id", async () => {
    const id1 = await upsertUser(db, { email: "a@b.com", name: "Alice", workosUserId: "wu_1" });
    const id2 = await upsertUser(db, { email: "a@b.com", name: "Alice Renamed", workosUserId: "wu_1" });
    expect(id2).toBe(id1);
    const user = await getUserById(db, id1);
    expect(user?.name).toBe("Alice Renamed");
  });

  it("normalizes email to lowercase", async () => {
    const id = await upsertUser(db, { email: "MIXED@Case.COM", name: null, workosUserId: null });
    const user = await getUserById(db, id);
    expect(user?.email).toBe("mixed@case.com");
  });

  it("getUserById returns null for unknown id", async () => {
    expect(await getUserById(db, "nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/auth/user-store.test.ts
```

- [ ] **Step 3: Create `auth/user-store.ts`**

```ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { dashboardUsers } from "../db/schema.js";

export interface UpsertUserInput {
  email: string;
  name: string | null;
  workosUserId: string | null;
}

export interface DashboardUser {
  id: string;
  email: string;
  name: string | null;
  workosUserId: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export async function upsertUser(db: AnyDb, input: UpsertUserInput): Promise<string> {
  const email = input.email.toLowerCase();
  const existing = await db.select().from(dashboardUsers).where(eq(dashboardUsers.email, email));
  if (existing.length > 0) {
    const row = existing[0];
    await db.update(dashboardUsers)
      .set({
        name: input.name,
        workosUserId: input.workosUserId,
        lastLoginAt: new Date(),
      })
      .where(eq(dashboardUsers.id, row.id));
    return row.id;
  }
  const id = `usr_${randomUUID()}`;
  await db.insert(dashboardUsers).values({
    id,
    email,
    name: input.name,
    workosUserId: input.workosUserId,
    lastLoginAt: new Date(),
  });
  return id;
}

export async function getUserById(db: AnyDb, id: string): Promise<DashboardUser | null> {
  const rows = await db.select().from(dashboardUsers).where(eq(dashboardUsers.id, id));
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    email: r.email,
    name: r.name ?? null,
    workosUserId: r.workosUserId ?? null,
    createdAt: r.createdAt,
    lastLoginAt: r.lastLoginAt ?? null,
  };
}
```

Add `export * from "./user-store.js";` to `auth/index.ts`.

- [ ] **Step 4: Run, verify pass**

```
cd packages/core && npx vitest run src/__tests__/auth/user-store.test.ts
```

- [ ] **Step 5: Commit**

```
git add packages/core/src/auth/user-store.ts packages/core/src/auth/index.ts packages/core/src/__tests__/auth/user-store.test.ts
git commit -m "feat(sso): user store with upsert by email"
```

---

## Task 4: Session store

**Files:**
- Create: `packages/core/src/auth/session-store.ts`
- Modify: `packages/core/src/auth/index.ts`
- Test: `packages/core/src/__tests__/auth/session-store.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../../db/client.js";
import { upsertUser } from "../../auth/user-store.js";
import {
  createSession, getSession, deleteSession, pruneExpiredSessions, touchSessionLastSeen,
} from "../../auth/session-store.js";

let db: any;
let userId: string;
beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
  userId = await upsertUser(db, { email: "a@b.com", name: "A", workosUserId: null });
});

describe("session-store", () => {
  it("creates a session and reads it back", async () => {
    const sid = await createSession(db, { userId, durationHours: 24 });
    expect(sid).toBeTruthy();
    expect(sid.length).toBeGreaterThan(20);
    const s = await getSession(db, sid);
    expect(s?.userId).toBe(userId);
    expect(s?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns null for unknown session id", async () => {
    expect(await getSession(db, "nope")).toBeNull();
  });

  it("returns null for expired sessions", async () => {
    const sid = await createSession(db, { userId, durationHours: 24 });
    // manually set expires_at into the past via a re-insert
    await deleteSession(db, sid);
    const { dashboardSessions } = await import("../../db/schema.js");
    await (db as any).insert(dashboardSessions).values({
      id: sid, userId, expiresAt: new Date(Date.now() - 1000),
    });
    expect(await getSession(db, sid)).toBeNull();
  });

  it("deleteSession removes the row", async () => {
    const sid = await createSession(db, { userId, durationHours: 24 });
    await deleteSession(db, sid);
    expect(await getSession(db, sid)).toBeNull();
  });

  it("pruneExpiredSessions removes only expired rows", async () => {
    const live = await createSession(db, { userId, durationHours: 24 });
    const dead = "sess_dead";
    const { dashboardSessions } = await import("../../db/schema.js");
    await (db as any).insert(dashboardSessions).values({
      id: dead, userId, expiresAt: new Date(Date.now() - 1000),
    });
    const deleted = await pruneExpiredSessions(db);
    expect(deleted).toBe(1);
    expect(await getSession(db, live)).not.toBeNull();
  });

  it("touchSessionLastSeen updates lastSeenAt", async () => {
    const sid = await createSession(db, { userId, durationHours: 24 });
    const before = (await getSession(db, sid))!.lastSeenAt;
    await new Promise(r => setTimeout(r, 50));
    await touchSessionLastSeen(db, sid);
    const after = (await getSession(db, sid))!.lastSeenAt;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/auth/session-store.test.ts
```

- [ ] **Step 3: Create `auth/session-store.ts`**

```ts
import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { dashboardSessions } from "../db/schema.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "auth.session" });

export interface DashboardSession {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
}

export async function createSession(
  db: AnyDb,
  args: { userId: string; durationHours: number },
): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + args.durationHours * 3600_000);
  await db.insert(dashboardSessions).values({
    id, userId: args.userId, expiresAt, lastSeenAt: new Date(),
  });
  return id;
}

export async function getSession(db: AnyDb, id: string): Promise<DashboardSession | null> {
  const rows = await db.select().from(dashboardSessions)
    .where(and(eq(dashboardSessions.id, id), gt(dashboardSessions.expiresAt, new Date())));
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id, userId: r.userId, createdAt: r.createdAt,
    expiresAt: r.expiresAt, lastSeenAt: r.lastSeenAt,
  };
}

export async function deleteSession(db: AnyDb, id: string): Promise<void> {
  await db.delete(dashboardSessions).where(eq(dashboardSessions.id, id));
}

export async function pruneExpiredSessions(db: AnyDb): Promise<number> {
  const result = await db.delete(dashboardSessions)
    .where(lt(dashboardSessions.expiresAt, new Date()));
  const n = (result as any)?.changes ?? (result as any)?.rowCount ?? 0;
  log.info({ deleted: n }, "expired sessions pruned");
  return n;
}

export async function touchSessionLastSeen(db: AnyDb, id: string): Promise<void> {
  try {
    await db.update(dashboardSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(dashboardSessions.id, id));
  } catch (err) {
    log.warn({ err, id }, "touchSessionLastSeen failed");
  }
}
```

Add `export * from "./session-store.js";` to `auth/index.ts`.

- [ ] **Step 4: Run, verify pass**

```
cd packages/core && npx vitest run src/__tests__/auth/session-store.test.ts
```

- [ ] **Step 5: Commit**

```
git add packages/core/src/auth/session-store.ts packages/core/src/auth/index.ts packages/core/src/__tests__/auth/session-store.test.ts
git commit -m "feat(sso): session store with prune sweep"
```

---

## Task 5: Audit event builders for SSO

**Files:**
- Modify: `packages/core/src/audit/events.ts`
- Test: `packages/core/src/__tests__/audit/sso-events.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { dashboardLoginEvent, dashboardLogoutEvent, dashboardLoginDeniedEvent } from "../../audit/events.js";
import { AuditEventSchema } from "../../types.js";

describe("dashboard auth event builders", () => {
  it("dashboardLoginEvent", () => {
    const evt = dashboardLoginEvent({ userId: "u_1", email: "a@b.com", workosUserId: "wu_1" });
    const parsed = AuditEventSchema.parse(evt);
    expect(parsed.eventType).toBe("dashboard.login");
    expect(parsed.actorType).toBe("dashboard-user");
    expect(parsed.actor).toBe("dashboard:a@b.com");
    expect(parsed.payload).toMatchObject({ userId: "u_1", workosUserId: "wu_1" });
  });

  it("dashboardLogoutEvent", () => {
    const evt = dashboardLogoutEvent({ userId: "u_1", email: "a@b.com" });
    expect(evt.eventType).toBe("dashboard.logout");
    expect(evt.actor).toBe("dashboard:a@b.com");
  });

  it("dashboardLoginDeniedEvent uses system actor (no user yet)", () => {
    const evt = dashboardLoginDeniedEvent({ email: "intruder@evil.com", reason: "domain-mismatch" });
    expect(evt.eventType).toBe("dashboard.login_denied");
    expect(evt.actor).toBe("dashboard:intruder@evil.com");
    expect(evt.payload).toMatchObject({ reason: "domain-mismatch" });
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Append builders to `audit/events.ts`**

```ts
export function dashboardLoginEvent(args: {
  userId: string; email: string; workosUserId: string | null;
}): AuditEvent {
  return base({
    eventType: "dashboard.login",
    actor: `dashboard:${args.email}`,
    actorType: "dashboard-user",
    payload: { userId: args.userId, workosUserId: args.workosUserId },
  });
}

export function dashboardLogoutEvent(args: {
  userId: string; email: string;
}): AuditEvent {
  return base({
    eventType: "dashboard.logout",
    actor: `dashboard:${args.email}`,
    actorType: "dashboard-user",
    payload: { userId: args.userId },
  });
}

export function dashboardLoginDeniedEvent(args: {
  email: string; reason: "domain-mismatch";
}): AuditEvent {
  return base({
    eventType: "dashboard.login_denied",
    actor: `dashboard:${args.email}`,
    actorType: "dashboard-user",
    payload: { reason: args.reason },
  });
}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add packages/core/src/audit/events.ts packages/core/src/__tests__/audit/sso-events.test.ts
git commit -m "feat(sso): audit event builders for dashboard login/logout/denied"
```

---

## Task 6: WorkOS client wrapper (with stub-friendly DI)

**Files:**
- Create: `packages/core/src/auth/workos-client.ts`
- Modify: `packages/core/src/auth/index.ts`
- Modify: `packages/dashboard/package.json` (add dep)
- Test: `packages/core/src/__tests__/auth/workos-client.test.ts`

- [ ] **Step 1: Add the dependency**

```
cd packages/dashboard && pnpm add @workos-inc/node
cd ../..
```

Note: place the dep in `dashboard` not `core` because only the dashboard imports it. The core wrapper accepts an injected client.

- [ ] **Step 2: Write failing test**

The wrapper exposes a `WorkosClient` interface with two methods (`getAuthorizationUrl`, `authenticateWithCode`). The default impl uses the SDK; tests pass a stub. Test:

```ts
import { describe, it, expect } from "vitest";
import { type WorkosClient } from "../../auth/workos-client.js";

describe("WorkosClient interface", () => {
  it("the type allows a stub implementation", () => {
    const stub: WorkosClient = {
      async getAuthorizationUrl(args) {
        return `https://workos.example/authz?state=${args.state}&client=${args.clientId}`;
      },
      async authenticateWithCode(args) {
        return {
          user: { id: "wu_test", email: "a@b.com", firstName: "A", lastName: "B" },
        };
      },
    };
    expect(stub).toBeDefined();
  });
});
```

- [ ] **Step 3: Run, confirm failure**

- [ ] **Step 4: Create `auth/workos-client.ts`**

```ts
/**
 * Thin interface over @workos-inc/node so tests can inject a stub
 * without importing the SDK or hitting the network.
 */
export interface WorkosAuthorizeArgs {
  clientId: string;
  redirectUri: string;
  state: string;
}

export interface WorkosAuthenticateArgs {
  clientId: string;
  code: string;
}

export interface WorkosUserProfile {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface WorkosAuthenticateResult {
  user: WorkosUserProfile;
}

export interface WorkosClient {
  getAuthorizationUrl(args: WorkosAuthorizeArgs): Promise<string>;
  authenticateWithCode(args: WorkosAuthenticateArgs): Promise<WorkosAuthenticateResult>;
}

let cached: WorkosClient | null = null;

/**
 * Default WorkOS client. Lazily instantiates the SDK on first use so test
 * environments that never call this never need the SDK installed.
 */
export async function getDefaultWorkosClient(apiKey: string): Promise<WorkosClient> {
  if (cached) return cached;
  // Dynamic import so the dep is loaded only when actually used.
  const { WorkOS } = await import("@workos-inc/node");
  const workos = new WorkOS(apiKey);
  cached = {
    async getAuthorizationUrl(args) {
      return workos.userManagement.getAuthorizationUrl({
        clientId: args.clientId,
        redirectUri: args.redirectUri,
        state: args.state,
        provider: "authkit",
      });
    },
    async authenticateWithCode(args) {
      const result = await workos.userManagement.authenticateWithCode({
        clientId: args.clientId,
        code: args.code,
      });
      return {
        user: {
          id: result.user.id,
          email: result.user.email,
          firstName: result.user.firstName ?? null,
          lastName: result.user.lastName ?? null,
        },
      };
    },
  };
  return cached;
}

/** Test-only: reset the cached client. */
export function _resetWorkosClient(): void {
  cached = null;
}
```

Add `export * from "./workos-client.js";` to `auth/index.ts`.

- [ ] **Step 5: Run test, verify pass**

```
cd packages/core && npx vitest run src/__tests__/auth/workos-client.test.ts
```

- [ ] **Step 6: Commit**

```
git add packages/core/src/auth/workos-client.ts packages/core/src/auth/index.ts packages/dashboard/package.json packages/dashboard/pnpm-lock.yaml packages/core/src/__tests__/auth/workos-client.test.ts
git commit -m "feat(sso): workos client interface with DI seam"
```

(If the lockfile lives at the repo root rather than per-package, adjust the `git add` to `pnpm-lock.yaml`.)

---

## Task 7: Re-export auth + add `sso` to Enterprise feature set

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/license.ts`
- Test: `packages/core/src/__tests__/auth/sso-feature-flag.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { _resetLicenseCache, isFeatureLicensed } from "../../license.js";
import { installTestProLicense, restoreLicense } from "../helpers/license.js";

beforeEach(() => { _resetLicenseCache(); });

describe("sso feature flag", () => {
  it("is licensed at the enterprise tier", async () => {
    await installTestProLicense("enterprise");
    expect(isFeatureLicensed("sso")).toBe(true);
    await restoreLicense();
  });

  it("is not licensed at the pro tier", async () => {
    await installTestProLicense("pro");
    expect(isFeatureLicensed("sso")).toBe(false);
    await restoreLicense();
  });

  it("is not licensed without a license", async () => {
    await restoreLicense();
    expect(isFeatureLicensed("sso")).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Add `"sso"` to the enterprise feature set in `license.ts`**

Find `ENTERPRISE_FEATURES` and add `"sso"` to the array. Run grep first to confirm location.

- [ ] **Step 4: Re-export auth from core barrel**

In `packages/core/src/index.ts` add:
```ts
export * from "./auth/index.js";
```

- [ ] **Step 5: Run test, verify pass**

- [ ] **Step 6: Commit**

```
git add packages/core/src/license.ts packages/core/src/index.ts packages/core/src/__tests__/auth/sso-feature-flag.test.ts
git commit -m "feat(sso): add sso to enterprise feature set"
```

---

## Task 8: Dashboard SSO middleware

**Files:**
- Create: `packages/dashboard/src/middleware/sso.ts`
- Test: `packages/dashboard/src/__tests__/sso-middleware.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { createDb, upsertUser, createSession } from "@urateam/core";
import { createSsoMiddleware } from "../middleware/sso.js";

let db: any;
let userId: string;

const ssoConfig = {
  enabled: true,
  workosApiKey: "sk_test", workosClientId: "client_test",
  redirectUri: "https://x/auth/callback",
  sessionDurationHours: 24, cookieName: "urateam_session",
  cookieSecure: false, stateSigningSecret: "0123456789abcdef0123456789abcdef",
} as const;

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
  userId = await upsertUser(db, { email: "a@b.com", name: "A", workosUserId: null });
});

function appWithSso() {
  const app = new Hono();
  app.use("*", createSsoMiddleware({ db, sso: ssoConfig as any }));
  app.get("/runs", (c) => c.text(`hello ${(c.get("user") as any).email}`));
  app.post("/webhooks/linear", (c) => c.text("ok"));
  app.get("/auth/login", (c) => c.text("login page"));
  return app;
}

describe("ssoMiddleware", () => {
  it("redirects to /auth/login when no cookie present", async () => {
    const res = await appWithSso().request("/runs");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/login");
    expect(res.headers.get("location")).toContain("next=%2Fruns");
  });

  it("allows /auth/* paths through without a cookie", async () => {
    const res = await appWithSso().request("/auth/login");
    expect(res.status).toBe(200);
  });

  it("allows /webhooks/* paths through without a cookie", async () => {
    const res = await appWithSso().request("/webhooks/linear", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("returns 200 with c.get('user') populated when valid session cookie present", async () => {
    const sid = await createSession(db, { userId, durationHours: 24 });
    const res = await appWithSso().request("/runs", {
      headers: { cookie: `urateam_session=${sid}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello a@b.com");
  });

  it("clears cookie and redirects when session id is unknown", async () => {
    const res = await appWithSso().request("/runs", {
      headers: { cookie: `urateam_session=unknown` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("urateam_session=;");
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Create `middleware/sso.ts`**

```ts
import { getCookie, setCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { getSession, getUserById, deleteSession, touchSessionLastSeen } from "@urateam/core";
import type { SsoConfig } from "@urateam/core";

interface SsoMiddlewareDeps {
  db: any;
  sso: SsoConfig;
}

export function createSsoMiddleware(deps: SsoMiddlewareDeps): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (path.startsWith("/auth/")) return next();
    if (path.startsWith("/webhooks/")) return next();

    const cookie = getCookie(c, deps.sso.cookieName);
    if (!cookie) {
      return c.redirect(`/auth/login?next=${encodeURIComponent(path)}`, 302);
    }

    const session = await getSession(deps.db, cookie);
    if (!session) {
      setCookie(c, deps.sso.cookieName, "", { maxAge: 0, path: "/" });
      return c.redirect(`/auth/login?next=${encodeURIComponent(path)}`, 302);
    }

    const user = await getUserById(deps.db, session.userId);
    if (!user) {
      await deleteSession(deps.db, cookie);
      setCookie(c, deps.sso.cookieName, "", { maxAge: 0, path: "/" });
      return c.redirect(`/auth/login`, 302);
    }

    c.set("user", user);
    c.set("session", session);
    void touchSessionLastSeen(deps.db, cookie);
    return next();
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

```
cd packages/dashboard && npx vitest run src/__tests__/sso-middleware.test.ts
```

- [ ] **Step 5: Commit**

```
git add packages/dashboard/src/middleware/sso.ts packages/dashboard/src/__tests__/sso-middleware.test.ts
git commit -m "feat(sso): dashboard middleware with cookie/session check"
```

---

## Task 9: Dashboard auth routes (login / callback / logout)

**Files:**
- Create: `packages/dashboard/src/routes/auth.ts`
- Test: `packages/dashboard/src/__tests__/auth-routes.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  createDb, auditEvents, dashboardSessions,
  signState,
} from "@urateam/core";
import type { WorkosClient } from "@urateam/core";
import { createAuthRouter } from "../routes/auth.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

let db: any;
const ssoConfig = {
  enabled: true,
  workosApiKey: "sk_test", workosClientId: "client_test",
  redirectUri: "https://x/auth/callback",
  allowedDomain: undefined as string | undefined,
  sessionDurationHours: 24,
  cookieName: "urateam_session", cookieSecure: false,
  stateSigningSecret: "0123456789abcdef0123456789abcdef",
};

const stubWorkos: WorkosClient = {
  async getAuthorizationUrl(args) {
    return `https://workos.example/auth?state=${args.state}&client=${args.clientId}`;
  },
  async authenticateWithCode(args) {
    return {
      user: { id: "wu_test", email: "alice@acme.com", firstName: "Alice", lastName: "X" },
    };
  },
};

beforeEach(async () => {
  await installTestProLicense("enterprise");
  db = await createDb({ connectionString: ":memory:" });
});

function buildApp() {
  const app = new Hono();
  app.route("/", createAuthRouter({ db, sso: ssoConfig as any, workos: stubWorkos }));
  return app;
}

describe("/auth/login", () => {
  it("returns 302 to a workos url with a signed state", async () => {
    const res = await buildApp().request("/auth/login?next=/runs");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("workos.example");
    expect(loc).toContain("state=");
  });
});

describe("/auth/callback", () => {
  it("creates a session, sets cookie, writes audit event, redirects to next", async () => {
    const state = signState({ next: "/runs", nonce: "n" }, ssoConfig.stateSigningSecret);
    const res = await buildApp().request(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/runs");
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain("urateam_session=");
    expect(setCookie).toContain("HttpOnly");
    const sessions = await db.select().from(dashboardSessions);
    expect(sessions).toHaveLength(1);
    const events = await db.select().from(auditEvents);
    expect(events.find((e: any) => e.eventType === "dashboard.login")).toBeDefined();
  });

  it("returns 400 on state mismatch", async () => {
    const res = await buildApp().request(`/auth/callback?code=abc&state=garbage`);
    expect(res.status).toBe(400);
  });

  it("returns 403 + audit event when allowedDomain rejects", async () => {
    ssoConfig.allowedDomain = "evil.com";
    const state = signState({ next: "/", nonce: "n" }, ssoConfig.stateSigningSecret);
    const res = await buildApp().request(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(403);
    const events = await db.select().from(auditEvents);
    expect(events.find((e: any) => e.eventType === "dashboard.login_denied")).toBeDefined();
    ssoConfig.allowedDomain = undefined;
  });
});

describe("/auth/logout", () => {
  it("deletes session, clears cookie, writes logout event", async () => {
    // first log in
    const state = signState({ next: "/", nonce: "n" }, ssoConfig.stateSigningSecret);
    const cb = await buildApp().request(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
    const cookieHeader = cb.headers.get("set-cookie")!;
    const sid = cookieHeader.match(/urateam_session=([^;]+)/)![1];

    const res = await buildApp().request("/auth/logout", {
      method: "POST",
      headers: { cookie: `urateam_session=${sid}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
    const sessions = await db.select().from(dashboardSessions);
    expect(sessions).toHaveLength(0);
    const events = await db.select().from(auditEvents);
    expect(events.find((e: any) => e.eventType === "dashboard.logout")).toBeDefined();
  });
});

afterEach(async () => { await restoreLicense(); });
```

Note the import of `installTestProLicense` from a local helper file under `__tests__/helpers/license.ts`. The audit-log feature uses this same pattern; copy/adapt the helper.

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Create `routes/auth.ts`**

```ts
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import {
  signState, verifyState, validateNextPath,
  upsertUser, createSession, deleteSession, getSession, getUserById,
  logAuditEvent, dashboardLoginEvent, dashboardLogoutEvent, dashboardLoginDeniedEvent,
} from "@urateam/core";
import type { SsoConfig, WorkosClient } from "@urateam/core";

interface AuthRouterDeps {
  db: any;
  sso: SsoConfig;
  workos: WorkosClient;
}

export function createAuthRouter(deps: AuthRouterDeps): Hono {
  const app = new Hono();

  app.get("/auth/login", async (c) => {
    const next = validateNextPath(c.req.query("next"));
    const state = signState({ next, nonce: randomUUID() }, deps.sso.stateSigningSecret);
    const url = await deps.workos.getAuthorizationUrl({
      clientId: deps.sso.workosClientId,
      redirectUri: deps.sso.redirectUri,
      state,
    });
    return c.redirect(url, 302);
  });

  app.get("/auth/callback", async (c) => {
    const code = c.req.query("code");
    const stateRaw = c.req.query("state");
    if (!code || !stateRaw) return c.text("Missing code or state", 400);
    const state = verifyState(stateRaw, deps.sso.stateSigningSecret);
    if (!state) return c.text("Invalid login state. Please try again.", 400);

    let result;
    try {
      result = await deps.workos.authenticateWithCode({
        clientId: deps.sso.workosClientId,
        code,
      });
    } catch (err) {
      return c.text("SSO provider error. Try again or contact your administrator.", 503);
    }

    const email = result.user.email.toLowerCase();
    if (deps.sso.allowedDomain) {
      const expected = "@" + deps.sso.allowedDomain.toLowerCase();
      if (!email.endsWith(expected)) {
        void logAuditEvent(deps.db, dashboardLoginDeniedEvent({ email, reason: "domain-mismatch" }));
        return c.text(
          `Access denied. ${email} is not in the allowed domain. Contact your administrator.`,
          403,
        );
      }
    }

    const fullName = [result.user.firstName, result.user.lastName].filter(Boolean).join(" ").trim() || null;
    const userId = await upsertUser(deps.db, {
      email, name: fullName, workosUserId: result.user.id,
    });
    const sessionId = await createSession(deps.db, {
      userId, durationHours: deps.sso.sessionDurationHours,
    });

    setCookie(c, deps.sso.cookieName, sessionId, {
      httpOnly: true,
      sameSite: "Lax",
      secure: deps.sso.cookieSecure,
      path: "/",
      maxAge: deps.sso.sessionDurationHours * 3600,
    });

    void logAuditEvent(deps.db, dashboardLoginEvent({
      userId, email, workosUserId: result.user.id,
    }));

    return c.redirect(validateNextPath(state.next), 302);
  });

  app.post("/auth/logout", async (c) => {
    const cookie = c.req.header("cookie");
    const match = cookie?.match(new RegExp(`${deps.sso.cookieName}=([^;]+)`));
    const sid = match?.[1];
    if (sid) {
      const session = await getSession(deps.db, sid);
      if (session) {
        const user = await getUserById(deps.db, session.userId);
        await deleteSession(deps.db, sid);
        if (user) {
          void logAuditEvent(deps.db, dashboardLogoutEvent({
            userId: user.id, email: user.email,
          }));
        }
      }
    }
    setCookie(c, deps.sso.cookieName, "", { maxAge: 0, path: "/" });
    return c.redirect("/auth/login", 302);
  });

  return app;
}
```

- [ ] **Step 4: Run, verify pass**

```
cd packages/dashboard && npx vitest run src/__tests__/auth-routes.test.ts
```

- [ ] **Step 5: Commit**

```
git add packages/dashboard/src/routes/auth.ts packages/dashboard/src/__tests__/auth-routes.test.ts packages/dashboard/src/__tests__/helpers
git commit -m "feat(sso): /auth/login, /auth/callback, /auth/logout routes"
```

---

## Task 10: Wire SSO stack into `server.ts`

**Files:**
- Modify: `packages/dashboard/src/server.ts`
- Modify: `packages/dashboard/src/views/layout.ts` (add Sign Out link when SSO active)
- Test: `packages/dashboard/src/__tests__/sso-integration.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "@urateam/core";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";
import { buildServer } from "../server.js";

let db: any;

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
});
afterEach(async () => { await restoreLicense(); });

describe("server with SSO", () => {
  const ssoConfig = {
    enabled: true,
    workosApiKey: "sk_test", workosClientId: "client_test",
    redirectUri: "https://x/auth/callback",
    sessionDurationHours: 24, cookieName: "urateam_session",
    cookieSecure: false, stateSigningSecret: "0123456789abcdef0123456789abcdef",
  };

  it("redirects /runs to /auth/login when SSO is licensed and enabled with no cookie", async () => {
    await installTestProLicense("enterprise");
    const app = buildServer({ db, sso: ssoConfig as any });
    const res = await app.request("/runs");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/login");
  });

  it("falls back to basic auth when SSO is not licensed even if enabled", async () => {
    await restoreLicense();
    const app = buildServer({
      db,
      sso: ssoConfig as any,
      auth: { username: "u", password: "p" },
    });
    const res = await app.request("/runs");
    expect(res.status).toBe(401); // basic auth challenge
  });

  it("uses basic auth when SSO is licensed but disabled", async () => {
    await installTestProLicense("enterprise");
    const app = buildServer({
      db,
      sso: { ...ssoConfig, enabled: false } as any,
      auth: { username: "u", password: "p" },
    });
    const res = await app.request("/runs");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Modify `server.ts`**

Read it first to understand the structure. Then add at the top, before the existing `if (config.auth?.username && config.auth?.password)` block:

```ts
import { isFeatureLicensed, getDefaultWorkosClient } from "@urateam/core";
import { createSsoMiddleware } from "./middleware/sso.js";
import { createAuthRouter } from "./routes/auth.js";

// ... inside buildServer(...)
const ssoActive = isFeatureLicensed("sso") && config.sso?.enabled === true;

if (ssoActive) {
  // Lazy-load WorkOS client; SDK is only required when SSO is active.
  const workos = await getDefaultWorkosClient(config.sso!.workosApiKey);
  const authRouter = createAuthRouter({ db: config.db, sso: config.sso!, workos });
  app.route("/", authRouter);
  app.use("*", createSsoMiddleware({ db: config.db, sso: config.sso! }));
} else if (config.auth?.username && config.auth?.password) {
  app.use("*", basicAuth({ username: config.auth.username, password: config.auth.password }));
} else {
  app.use("*", async (c) => c.text(
    "Dashboard authentication is required but not configured. " +
      "Set DASHBOARD_USER and DASHBOARD_PASSWORD environment variables and restart.",
    503,
  ));
}
```

Note: `buildServer` may currently be a synchronous function. Making it `async` to allow `await getDefaultWorkosClient(...)` is acceptable; if the existing call sites pass it through `app.fetch` directly (synchronous startup), refactor those call sites to `await buildServer(...)`. Look at `packages/dashboard/src/index.ts` (or wherever the entry point lives) and update the boot sequence accordingly. If turning it async is invasive, an alternative is to instantiate the WorkOS client synchronously by importing the SDK at the top of `server.ts` instead of dynamically — at the cost of always loading the SDK even on Basic Auth deployments.

Pick the dynamic-import async approach if `buildServer` is already async; otherwise switch to the static import.

- [ ] **Step 4: Add Sign Out link to layout**

In `layout.ts`, find the nav block. Add a conditional:
```ts
${user ? html`<form method="post" action="${bp}/auth/logout"><button class="link">Sign out (${escapeHtml(user.email)})</button></form>` : ""}
```

The `user` is read from `c.get("user")` — propagate it through the layout's input props.

- [ ] **Step 5: Run tests, verify pass**

```
cd packages/dashboard && npx vitest run src/__tests__/sso-integration.test.ts
```

- [ ] **Step 6: Commit**

```
git add packages/dashboard/src/server.ts packages/dashboard/src/views/layout.ts packages/dashboard/src/__tests__/sso-integration.test.ts
git commit -m "feat(sso): wire sso stack into dashboard server"
```

---

## Task 11: Scheduler tick — pruneExpiredSessions step

**Files:**
- Modify: `packages/core/src/pm/scheduler.ts`
- Test: `packages/core/src/__tests__/pm-sso-prune-step.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { createDb, upsertUser } from "@urateam/core";
import { dashboardSessions } from "../db/schema.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";
// ... import the tick entry as in pm-audit-retention-step.test.ts

describe("pm tick prunes expired sessions", () => {
  it("deletes expired dashboard_sessions when sso licensed", async () => {
    await installTestProLicense("enterprise");
    const db = await createDb({ connectionString: ":memory:" }) as any;
    const userId = await upsertUser(db, { email: "a@b.com", name: null, workosUserId: null });
    await db.insert(dashboardSessions).values({
      id: "s_old", userId, expiresAt: new Date(Date.now() - 1000),
    });
    await db.insert(dashboardSessions).values({
      id: "s_live", userId, expiresAt: new Date(Date.now() + 3600_000),
    });

    // call the tick
    // ... (mirror pm-audit-retention-step.test.ts pattern)

    const remaining = await db.select().from(dashboardSessions);
    expect(remaining.find((r: any) => r.id === "s_old")).toBeUndefined();
    expect(remaining.find((r: any) => r.id === "s_live")).toBeDefined();
    await restoreLicense();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Add the step to `pm/scheduler.ts`**

After the `pruneAuditLog` step block, add:
```ts
try {
  if (isFeatureLicensed("sso")) {
    const { pruneExpiredSessions } = await import("../auth/index.js");
    await pruneExpiredSessions(db);
  }
} catch (err) {
  log.warn({ err }, "session prune failed");
}
```

(If a static import is preferable and doesn't create a cycle, use one — match Task 13 style from feature 4.2.)

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add packages/core/src/pm/scheduler.ts packages/core/src/__tests__/pm-sso-prune-step.test.ts
git commit -m "feat(sso): prune expired sessions in pm tick"
```

---

## Task 12: Operator setup doc

**Files:**
- Create: `deploy/SSO_SETUP.md`

- [ ] **Step 1: Write the doc**

```markdown
# SSO setup (Enterprise)

urateam supports SSO via WorkOS AuthKit. This routes dashboard authentication
through your existing IdP (Okta, Azure AD, Google Workspace, OneLogin, ...).

## Prerequisites
- An Enterprise license
- A WorkOS account (https://workos.com)

## Steps

### 1. Create a WorkOS project
- Sign up / log in at https://dashboard.workos.com
- Create an environment (one per urateam deployment is fine)
- Note the API key (sk_live_... or sk_test_...) and Client ID (client_...)

### 2. Configure your IdP in WorkOS
- In the WorkOS dashboard, go to Authentication → AuthKit
- Add a Connection for your IdP
- Follow the WorkOS guide for your specific provider — they handle the SAML
  metadata exchange or OIDC discovery for you

### 3. Set environment variables
On the urateam host:
```
URATEAM_WORKOS_API_KEY=sk_live_...
URATEAM_SSO_STATE_SECRET=$(openssl rand -hex 32)
```

`URATEAM_SSO_STATE_SECRET` is used to sign the OAuth state parameter to prevent
CSRF. Generate a fresh 32-byte random string and keep it secret.

### 4. Update urateam config
Add the `sso` block to your urateam config (e.g. `config.yaml`):
```yaml
sso:
  enabled: true
  workosApiKey: ${URATEAM_WORKOS_API_KEY}
  workosClientId: client_xxxxxxxxxxxxxxxx
  redirectUri: https://urateam.acme.com/auth/callback
  allowedDomain: acme.com
  sessionDurationHours: 24
  stateSigningSecret: ${URATEAM_SSO_STATE_SECRET}
```

`allowedDomain` (optional) restricts which email addresses can complete login.
Omit to allow any email your IdP authenticates.

### 5. Add the redirect URI to WorkOS
- Back in the WorkOS dashboard, add `https://urateam.acme.com/auth/callback`
  as an allowed redirect URI for the connection.

### 6. Restart urateam
- The dashboard should now redirect anonymous visitors to `/auth/login`,
  which forwards them through WorkOS to your IdP.

### Verification
- Hit `https://urateam.acme.com/runs` in a browser — you should be redirected
  through your IdP and back, and land on the dashboard with a session cookie.
- Check the audit log at `/audit` (if licensed) — you should see a
  `dashboard.login` event for the user who just logged in.

## Troubleshooting
- **400 Invalid login state:** the cookie or signing secret was rotated mid-flow.
  Try again from `/auth/login`.
- **403 Access denied for <email>:** the email's domain doesn't match
  `allowedDomain`. Either remove the restriction or use a different account.
- **503 SSO provider error:** WorkOS API is unreachable or returned an error.
  Check WorkOS status page and your API key.
- **Loop between /auth/login and the dashboard:** likely a cookie attribute
  problem (e.g. Secure=true on a non-HTTPS deployment). Set
  `sso.cookieSecure: false` in development only.

## Notes
- SSO replaces Basic Auth entirely when enabled. Make sure SSO is working
  before disabling your `DASHBOARD_USER`/`DASHBOARD_PASSWORD` fallback.
- Sessions are stored in the urateam database. Logging out invalidates the
  server-side session, not the WorkOS / IdP session — re-clicking login may
  silently reauthenticate via your IdP.
```

- [ ] **Step 2: Commit**

```
git add deploy/SSO_SETUP.md
git commit -m "docs(sso): operator setup guide"
```

---

## Task 13: Full build + test sweep + holistic review + CLAUDE.md + PR

- [ ] **Step 1: Build everything**

```
pnpm build
```
Expected: zero errors.

- [ ] **Step 2: Run unit tests**

```
pnpm test
```
Expected: all pass (the known-flaky cli `run.test.ts` may fail under turbo parallel load — verify it passes when run standalone with `cd packages/cli && npx vitest run src/__tests__/run.test.ts`).

- [ ] **Step 3: Run integration tests**

```
pnpm test:integration
```

- [ ] **Step 4: Dispatch holistic external review**

Launch a fresh `feature-dev:code-reviewer` subagent with:
- Spec: `docs/superpowers/specs/2026-04-14-sso-design.md`
- Plan: `docs/superpowers/plans/2026-04-14-sso-via-workos.md`
- Diff: `git diff main...HEAD`

Ask it to specifically check:
- Open redirect bypass (`next` param edge cases)
- Session cookie attribute correctness (HttpOnly, SameSite, Secure)
- State HMAC timing-safe comparison
- Concurrent login: two tabs both completing /auth/callback at once — does upsertUser race correctly?
- Cookie value injection: a malicious `next` query param can't be reflected unescaped in HTML error pages
- License gate consistency: every SSO surface (middleware, routes, scheduler step) checks `isFeatureLicensed("sso")`
- Postgres parity: the new tables / migration / `getCreateTablesDDL` are correct on both drivers
- Whether the WorkOS dynamic import still works in production (the `buildServer` async refactor lands properly)
- Whether the dashboard's CSP allows the WorkOS redirect to work

Address any high-confidence findings.

- [ ] **Step 5: Update CLAUDE.md**

Append a new section under "Key Patterns":
```
### SSO (Enterprise feature 4.1)
- Module: `packages/core/src/auth/` — `sso-config.ts` (zod schema, `signState`/`verifyState`/`validateNextPath`), `user-store.ts` (`upsertUser`, `getUserById`), `session-store.ts` (`createSession`, `getSession`, `deleteSession`, `pruneExpiredSessions`, `touchSessionLastSeen`), `workos-client.ts` (DI seam over `@workos-inc/node`)
- Tables: `dashboard_users` (id, email, name, workos_user_id, created_at, last_login_at) and `dashboard_sessions` (id, user_id, created_at, expires_at, last_seen_at)
- Dashboard middleware: `packages/dashboard/src/middleware/sso.ts` — cookie → session → user → `c.set("user", ...)`. Skips `/auth/*` and `/webhooks/*`
- Routes: `packages/dashboard/src/routes/auth.ts` — `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`
- Server wiring: `server.ts` mounts SSO stack iff `isFeatureLicensed("sso") && config.sso?.enabled === true`. Otherwise falls back to Basic Auth (or 503 if neither configured). The two auth modes are mutually exclusive
- Audit events: `dashboard.login`, `dashboard.logout`, `dashboard.login_denied` flow through the existing license-gated `logAuditEvent`
- Retention: PM tick calls `pruneExpiredSessions` after `pruneAuditLog`, gated on the SSO feature
- Setup doc: `deploy/SSO_SETUP.md`
```

- [ ] **Step 6: Commit and open PR**

```
git add CLAUDE.md
git commit -m "docs(claude.md): sso feature notes"
git push -u origin feat/sso
gh pr create --title "feat: sso via workos (enterprise 4.1)" --body "$(cat <<'EOF'
## Summary
- Replaces dashboard HTTP Basic Auth with WorkOS AuthKit SSO when licensed and enabled
- New tables: dashboard_users, dashboard_sessions
- Three new audit event types: dashboard.login / .logout / .login_denied
- Optional domain allowlist (sso.allowedDomain)
- Server-side sessions = revocable in seconds via /auth/logout or admin DB delete
- Webhooks bypass SSO middleware (HMAC verification unchanged)
- OSS / Pro deployments unchanged — Basic Auth path is untouched

Spec: docs/superpowers/specs/2026-04-14-sso-design.md
Plan: docs/superpowers/plans/2026-04-14-sso-via-workos.md

## Test plan
- [ ] pnpm test (unit)
- [ ] pnpm test:integration
- [ ] Manual: stub WorkOS callback flow end-to-end against a dev instance
- [ ] Manual: verify Basic Auth still works on a deployment with sso.enabled=false

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** Every spec section has a task — § 3 architecture (Tasks 8–10), § 4 module layout (Tasks 2–6), § 5 data model (Task 1), § 6 config (Task 2), § 7 auth flow (Task 9), § 8 server wiring (Task 10), § 9 audit (Task 5), § 10 PM tick (Task 11), § 11 error handling (Tasks 8 + 9 cover all rows), § 12 security considerations (Tasks 2, 4, 8, 9 — open redirect, signed state, session entropy, cookie attributes), § 13 testing (each subsection mapped to a task), § 14 migration + setup doc (Tasks 1 + 12).
- **Placeholders:** None. Task 11 has one placeholder reference to "mirror pm-audit-retention-step.test.ts pattern" — that's a deliberate pointer because the existing test pattern is the source of truth for tick test setup; the implementer should read it before writing the new test.
- **Type consistency:** `SsoConfig` zod schema, `WorkosClient` interface, `DashboardUser`/`DashboardSession` row types, `createSsoMiddleware`/`createAuthRouter` factory signatures all defined once and referenced consistently. Audit event builders match the event type strings.
- **Open dependency:** Task 10 may require flipping `buildServer` to async. The plan calls this out explicitly and offers a static-import fallback. The implementer should make a judgment call after reading the existing entry point.

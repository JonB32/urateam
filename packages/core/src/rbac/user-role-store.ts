import { and, eq, ne, count, sql } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { isPostgres } from "../db/client.js";
import { dashboardUsers } from "../db/schema.js";
import {
  logAuditEvent,
  dashboardGrantRoleEvent,
  dashboardRevokeRoleEvent,
  dashboardBootstrapAdminEvent,
} from "../audit/index.js";
import type { Role } from "./types.js";
import { SelfDemoteError, LastAdminError } from "./errors.js";

export interface SetUserRoleArgs {
  userId: string;
  newRole: Role;
  actorUserId: string;
  reason?: string;
}

export async function setUserRole(db: AnyDb, args: SetUserRoleArgs): Promise<void> {
  // The SELECT current / SELECT COUNT / UPDATE sequence MUST share a
  // transaction to close the TOCTOU race on the last-admin guard. Two
  // concurrent demotions must not both see `otherAdmins > 0`.
  //
  // Driver note: drizzle's `db.transaction(async ...)` is NOT supported on
  // better-sqlite3 (it throws "Transaction function cannot return a
  // promise"). For SQLite we issue `BEGIN IMMEDIATE` / `COMMIT` manually,
  // which acquires a RESERVED lock and serializes concurrent writers.
  // For Postgres we use the native drizzle transaction API.
  // `logAuditEvent` is fire-and-forget and runs outside the transaction.
  let oldRole: Role;
  let actorEmail = "unknown";
  let targetEmail: string;

  const body = async (handle: any): Promise<void> => {
    const currentRows = await handle
      .select()
      .from(dashboardUsers)
      .where(eq(dashboardUsers.id, args.userId));
    if (currentRows.length === 0)
      throw new Error(`user not found: ${args.userId}`);
    const current = currentRows[0] as { id: string; email: string; role: Role };
    oldRole = current.role;
    targetEmail = current.email;

    // Idempotent no-op
    if (oldRole === args.newRole) return;

    // Self-lockout
    if (args.userId === args.actorUserId && args.newRole !== "admin") {
      throw new SelfDemoteError();
    }

    // Last-admin guard: if target is currently admin and we're demoting, count other admins
    if (oldRole === "admin" && args.newRole !== "admin") {
      const [row] = await handle
        .select({ n: count() })
        .from(dashboardUsers)
        .where(
          and(eq(dashboardUsers.role, "admin"), ne(dashboardUsers.id, args.userId)),
        );
      const otherAdmins = Number((row as any)?.n ?? 0);
      if (otherAdmins === 0) throw new LastAdminError();
    }

    await handle
      .update(dashboardUsers)
      .set({ role: args.newRole })
      .where(eq(dashboardUsers.id, args.userId));

    const actorRows = await handle
      .select()
      .from(dashboardUsers)
      .where(eq(dashboardUsers.id, args.actorUserId));
    actorEmail = (actorRows[0] as any)?.email ?? "unknown";
  };

  if (isPostgres(db as any)) {
    await (db as any).transaction(async (tx: any) => {
      await body(tx);
    });
  } else {
    // SQLite path — manual transaction. Use BEGIN IMMEDIATE to grab the
    // RESERVED lock up front, avoiding SQLITE_BUSY under contention.
    await (db as any).run(sql`BEGIN IMMEDIATE`);
    try {
      await body(db);
      await (db as any).run(sql`COMMIT`);
    } catch (err) {
      try {
        await (db as any).run(sql`ROLLBACK`);
      } catch {
        // ignore rollback errors
      }
      throw err;
    }
  }

  // Early-exit idempotent no-op: skip audit write.
  if (oldRole! === args.newRole) return;

  const isRevoke = args.newRole === "viewer";
  const builder = isRevoke ? dashboardRevokeRoleEvent : dashboardGrantRoleEvent;
  await logAuditEvent(
    db,
    builder({
      targetUserId: args.userId,
      targetEmail: targetEmail!,
      oldRole: oldRole!,
      newRole: args.newRole,
      actorUserId: args.actorUserId,
      actorEmail,
    }),
  );
}

export async function getUserRole(db: AnyDb, userId: string): Promise<Role | null> {
  const rows = await (db as any)
    .select()
    .from(dashboardUsers)
    .where(eq(dashboardUsers.id, userId));
  if (rows.length === 0) return null;
  return (rows[0] as any).role as Role;
}

/**
 * If the user's email matches `envAdminList` (comma-separated, case-insensitive),
 * promote them to admin. Idempotent — already-admin users are not re-promoted
 * and no audit event is written. Emits a `dashboard.manual_action` event with
 * `action: "bootstrap_admin"` on successful promotion.
 *
 * Returns true if the role was changed.
 */
export async function applyBootstrapAdmins(
  db: AnyDb,
  email: string,
  userId: string,
  envAdminList: string | undefined,
): Promise<boolean> {
  if (!envAdminList || envAdminList.trim() === "") return false;

  const normalizedEmail = email.trim().toLowerCase();
  const adminSet = new Set(
    envAdminList
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!adminSet.has(normalizedEmail)) return false;

  // Already admin? No-op.
  const currentRole = await getUserRole(db, userId);
  if (currentRole === "admin") return false;

  // Promote. Bypass setUserRole because the actor is "system", not a user, and
  // the self-demote/last-admin guards don't apply.
  await (db as any)
    .update(dashboardUsers)
    .set({ role: "admin" as Role })
    .where(eq(dashboardUsers.id, userId));

  await logAuditEvent(
    db,
    dashboardBootstrapAdminEvent({
      targetUserId: userId,
      targetEmail: normalizedEmail,
    }),
  );
  return true;
}

export async function listUsers(db: AnyDb): Promise<
  Array<{
    id: string;
    email: string;
    name: string | null;
    role: Role;
    lastLoginAt: Date | null;
  }>
> {
  const rows = await (db as any).select().from(dashboardUsers);
  const mapped = rows.map((r: any) => ({
    id: r.id,
    email: r.email,
    name: r.name ?? null,
    role: r.role as Role,
    lastLoginAt: r.lastLoginAt ?? null,
  }));
  return mapped.sort((a: { email: string }, b: { email: string }) =>
    a.email.localeCompare(b.email),
  );
}

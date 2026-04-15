import { and, eq, ne, count } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AnyDb } from "../db/client.js";
import { dashboardUsers } from "../db/schema.js";
import { logAuditEvent } from "../audit/index.js";
import type { Role } from "./types.js";
import { SelfDemoteError, LastAdminError } from "./errors.js";

export interface SetUserRoleArgs {
  userId: string;
  newRole: Role;
  actorUserId: string;
  reason?: string;
}

export async function setUserRole(db: AnyDb, args: SetUserRoleArgs): Promise<void> {
  const currentRows = await (db as any)
    .select()
    .from(dashboardUsers)
    .where(eq(dashboardUsers.id, args.userId));
  if (currentRows.length === 0) throw new Error(`user not found: ${args.userId}`);
  const current = currentRows[0] as { id: string; email: string; role: Role };
  const oldRole = current.role;

  // Idempotent no-op
  if (oldRole === args.newRole) return;

  // Self-lockout
  if (args.userId === args.actorUserId && args.newRole !== "admin") {
    throw new SelfDemoteError();
  }

  // Last-admin guard: if target is currently admin and we're demoting, count other admins
  if (oldRole === "admin" && args.newRole !== "admin") {
    const [row] = await (db as any)
      .select({ n: count() })
      .from(dashboardUsers)
      .where(and(eq(dashboardUsers.role, "admin"), ne(dashboardUsers.id, args.userId)));
    const otherAdmins = Number((row as any)?.n ?? 0);
    if (otherAdmins === 0) throw new LastAdminError();
  }

  await (db as any)
    .update(dashboardUsers)
    .set({ role: args.newRole })
    .where(eq(dashboardUsers.id, args.userId));

  const isRevoke = args.newRole === "viewer";
  await logAuditEvent(db, {
    id: `evt_${randomUUID()}`,
    timestamp: new Date(),
    eventType: "dashboard.manual_action",
    actor: `dashboard:${args.actorUserId}`,
    actorType: "dashboard-user",
    scope: null,
    runId: null,
    issueId: null,
    inputTokens: 0,
    outputTokens: 0,
    payload: {
      action: isRevoke ? "revoke_role" : "grant_role",
      targetUserId: args.userId,
      targetEmail: current.email,
      oldRole,
      newRole: args.newRole,
      actorUserId: args.actorUserId,
      reason: args.reason,
    },
  });
}

export async function getUserRole(db: AnyDb, userId: string): Promise<Role | null> {
  const rows = await (db as any)
    .select()
    .from(dashboardUsers)
    .where(eq(dashboardUsers.id, userId));
  if (rows.length === 0) return null;
  return (rows[0] as any).role as Role;
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

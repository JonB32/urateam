import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { dashboardUsers } from "../db/schema.js";

export interface DashboardUser {
  id: string;
  email: string;
  name: string | null;
  workosUserId: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface UpsertUserInput {
  email: string;
  name: string | null;
  workosUserId: string | null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Insert or update a dashboard user by normalized email. Returns the
 * canonical user id. On update, `name`, `workosUserId`, and `lastLoginAt`
 * are refreshed; `id` and `createdAt` are preserved.
 *
 * Implemented as an atomic upsert (`onConflictDoUpdate` on the unique
 * `email` column) so that two concurrent `/auth/callback` requests for the
 * same email cannot both see `existing.length === 0` and race on INSERT.
 * The generated `id` is only used if no row exists; on conflict we read
 * back the canonical id from the surviving row.
 */
export async function upsertUser(
  db: AnyDb,
  input: UpsertUserInput,
): Promise<string> {
  const email = normalizeEmail(input.email);
  const now = new Date();
  const id = `usr_${randomUUID()}`;

  await db
    .insert(dashboardUsers)
    .values({
      id,
      email,
      name: input.name,
      workosUserId: input.workosUserId,
      createdAt: now,
      lastLoginAt: now,
    })
    .onConflictDoUpdate({
      target: dashboardUsers.email,
      set: {
        name: input.name,
        workosUserId: input.workosUserId,
        lastLoginAt: now,
      },
    });

  // Read back the canonical id — it may be a pre-existing row's id, not
  // the one we just generated above.
  const rows = await db
    .select()
    .from(dashboardUsers)
    .where(eq(dashboardUsers.email, email))
    .limit(1);
  return rows[0]!.id;
}

/**
 * Look up a dashboard user by id. Returns `null` when not found.
 */
export async function getUserById(
  db: AnyDb,
  id: string,
): Promise<DashboardUser | null> {
  const rows = await db
    .select()
    .from(dashboardUsers)
    .where(eq(dashboardUsers.id, id))
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? null,
    workosUserId: row.workosUserId ?? null,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt ?? null,
  };
}

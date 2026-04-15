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
 * resulting row. On update, `name`, `workosUserId`, and `lastLoginAt` are
 * refreshed; `id` and `createdAt` are preserved.
 */
export async function upsertUser(
  db: AnyDb,
  input: UpsertUserInput,
): Promise<DashboardUser> {
  const email = normalizeEmail(input.email);
  const now = new Date();

  const existing = await db
    .select()
    .from(dashboardUsers)
    .where(eq(dashboardUsers.email, email))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0]!;
    await db
      .update(dashboardUsers)
      .set({
        name: input.name,
        workosUserId: input.workosUserId,
        lastLoginAt: now,
      })
      .where(eq(dashboardUsers.id, row.id));
    return {
      id: row.id,
      email,
      name: input.name,
      workosUserId: input.workosUserId,
      createdAt: row.createdAt,
      lastLoginAt: now,
    };
  }

  const id = `usr_${randomUUID()}`;
  await db.insert(dashboardUsers).values({
    id,
    email,
    name: input.name,
    workosUserId: input.workosUserId,
    createdAt: now,
    lastLoginAt: now,
  });

  return {
    id,
    email,
    name: input.name,
    workosUserId: input.workosUserId,
    createdAt: now,
    lastLoginAt: now,
  };
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

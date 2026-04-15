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
    id,
    userId: args.userId,
    expiresAt,
    lastSeenAt: new Date(),
  });
  return id;
}

export async function getSession(
  db: AnyDb,
  id: string,
): Promise<DashboardSession | null> {
  const rows = await db
    .select()
    .from(dashboardSessions)
    .where(
      and(
        eq(dashboardSessions.id, id),
        gt(dashboardSessions.expiresAt, new Date()),
      ),
    );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    id: r.id,
    userId: r.userId,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    lastSeenAt: r.lastSeenAt,
  };
}

export async function deleteSession(db: AnyDb, id: string): Promise<void> {
  await db.delete(dashboardSessions).where(eq(dashboardSessions.id, id));
}

export async function pruneExpiredSessions(db: AnyDb): Promise<number> {
  const result = await db
    .delete(dashboardSessions)
    .where(lt(dashboardSessions.expiresAt, new Date()));
  const n =
    (result as { changes?: number; rowCount?: number })?.changes ??
    (result as { changes?: number; rowCount?: number })?.rowCount ??
    0;
  log.info({ deleted: n }, "expired sessions pruned");
  return n;
}

export async function touchSessionLastSeen(
  db: AnyDb,
  id: string,
): Promise<void> {
  try {
    await db
      .update(dashboardSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(dashboardSessions.id, id));
  } catch (err) {
    // Session IDs are bearer credentials — never log them in full. Log a
    // short prefix for correlation only.
    log.warn(
      { err, idPrefix: id.slice(0, 8) + "…" },
      "touchSessionLastSeen failed",
    );
  }
}

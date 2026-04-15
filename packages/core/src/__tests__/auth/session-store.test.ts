import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../../db/client.js";
import { upsertUser } from "../../auth/user-store.js";
import {
  createSession,
  getSession,
  deleteSession,
  pruneExpiredSessions,
  touchSessionLastSeen,
} from "../../auth/session-store.js";

let db: any;
let userId: string;
beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
  userId = await upsertUser(db, {
    email: "a@b.com",
    name: "A",
    workosUserId: null,
  });
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
    await deleteSession(db, sid);
    const { dashboardSessions } = await import("../../db/schema.js");
    await (db as any).insert(dashboardSessions).values({
      id: sid,
      userId,
      expiresAt: new Date(Date.now() - 1000),
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
      id: dead,
      userId,
      expiresAt: new Date(Date.now() - 1000),
    });
    const deleted = await pruneExpiredSessions(db);
    expect(deleted).toBe(1);
    expect(await getSession(db, live)).not.toBeNull();
  });

  it("touchSessionLastSeen updates lastSeenAt", async () => {
    const sid = await createSession(db, { userId, durationHours: 24 });
    const before = (await getSession(db, sid))!.lastSeenAt;
    await new Promise((r) => setTimeout(r, 50));
    await touchSessionLastSeen(db, sid);
    const after = (await getSession(db, sid))!.lastSeenAt;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});

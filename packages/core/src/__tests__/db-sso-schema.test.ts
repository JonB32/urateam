import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { dashboardUsers, dashboardSessions } from "../db/schema.js";
import { sql } from "drizzle-orm";

describe("sso schema", () => {
  it("creates dashboard_users and dashboard_sessions tables on fresh SQLite db", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const userCols = (db as any).all(
      sql`PRAGMA table_info(dashboard_users)`,
    ) as Array<{ name: string }>;
    expect(userCols.map((c) => c.name).sort()).toEqual([
      "created_at",
      "email",
      "id",
      "last_login_at",
      "name",
      "workos_user_id",
    ]);
    const sessionCols = (db as any).all(
      sql`PRAGMA table_info(dashboard_sessions)`,
    ) as Array<{ name: string }>;
    expect(sessionCols.map((c) => c.name).sort()).toEqual([
      "created_at",
      "expires_at",
      "id",
      "last_seen_at",
      "user_id",
    ]);
  });

  it("inserts and reads back a user + session", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await (db as any).insert(dashboardUsers).values({
      id: "u_1",
      email: "a@b.com",
      name: "A B",
      workosUserId: "wu_1",
    });
    await (db as any).insert(dashboardSessions).values({
      id: "s_1",
      userId: "u_1",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const users = await (db as any).select().from(dashboardUsers);
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe("a@b.com");
    const sessions = await (db as any).select().from(dashboardSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].userId).toBe("u_1");
  });
});

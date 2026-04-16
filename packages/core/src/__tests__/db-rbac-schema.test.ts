import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { dashboardUsers } from "../db/schema.js";
import { sql } from "drizzle-orm";

describe("dashboard_users.role column", () => {
  it("includes role in the table schema with default 'viewer'", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const cols = (db as any).all(sql`PRAGMA table_info(dashboard_users)`) as Array<{name: string}>;
    expect(cols.map(c => c.name).sort()).toContain("role");
  });

  it("defaults new rows to 'viewer'", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await (db as any).insert(dashboardUsers).values({
      id: "u_1", email: "a@b.com", name: "A B", workosUserId: "wu_1",
    });
    const rows = await (db as any).select().from(dashboardUsers);
    expect(rows[0].role).toBe("viewer");
  });

  it("accepts explicit role values", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await (db as any).insert(dashboardUsers).values({
      id: "u_admin", email: "admin@b.com", name: null, workosUserId: null, role: "admin",
    });
    await (db as any).insert(dashboardUsers).values({
      id: "u_op", email: "op@b.com", name: null, workosUserId: null, role: "operator",
    });
    const rows = await (db as any).select().from(dashboardUsers);
    const roles = rows.map((r: any) => r.role).sort();
    expect(roles).toEqual(["admin", "operator"]);
  });
});

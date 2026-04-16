import { describe, it, expect } from "vitest";
import { createDb } from "../../db/client.js";
import { dashboardUsers } from "../../db/schema.js";
import { getUserById } from "../../auth/user-store.js";

describe("getUserById role round-trip", () => {
  it("returns role when admin", async () => {
    const db = (await createDb({ connectionString: ":memory:" })) as any;
    await db.insert(dashboardUsers).values({
      id: "u_1",
      email: "a@b.com",
      name: null,
      workosUserId: null,
      role: "admin",
    });
    const user = await getUserById(db, "u_1");
    expect(user?.role).toBe("admin");
  });

  it("defaults to viewer when role is missing", async () => {
    const db = (await createDb({ connectionString: ":memory:" })) as any;
    await db.insert(dashboardUsers).values({
      id: "u_1",
      email: "a@b.com",
      name: null,
      workosUserId: null,
    });
    const user = await getUserById(db, "u_1");
    expect(user?.role).toBe("viewer");
  });
});

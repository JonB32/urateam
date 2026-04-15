import { describe, it, expect } from "vitest";
import { createDb } from "../../db/client.js";
import { upsertUser, getUserById } from "../../auth/user-store.js";

describe("user-store", () => {
  it("inserts a new user and returns a usr_ id", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const id = await upsertUser(db, {
      email: "alice@example.com",
      name: "Alice",
      workosUserId: "workos_1",
    });
    expect(id).toMatch(/^usr_/);
    const user = await getUserById(db, id);
    expect(user).not.toBeNull();
    expect(user!.email).toBe("alice@example.com");
    expect(user!.name).toBe("Alice");
    expect(user!.workosUserId).toBe("workos_1");
    expect(user!.createdAt).toBeInstanceOf(Date);
  });

  it("normalizes email to lowercase on insert", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const id = await upsertUser(db, {
      email: "Bob@Example.COM",
      name: "Bob",
      workosUserId: "workos_2",
    });
    const user = await getUserById(db, id);
    expect(user!.email).toBe("bob@example.com");
  });

  it("updates existing user when email already exists (case-insensitive)", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const firstId = await upsertUser(db, {
      email: "carol@example.com",
      name: "Carol",
      workosUserId: "workos_3",
    });
    const secondId = await upsertUser(db, {
      email: "CAROL@example.com",
      name: "Carol Updated",
      workosUserId: "workos_3b",
    });
    expect(secondId).toBe(firstId);
    const user = await getUserById(db, secondId);
    expect(user!.name).toBe("Carol Updated");
    expect(user!.workosUserId).toBe("workos_3b");
    expect(user!.email).toBe("carol@example.com");
  });

  it("updates lastLoginAt on upsert of existing user", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const firstId = await upsertUser(db, {
      email: "dave@example.com",
      name: "Dave",
      workosUserId: "workos_4",
    });
    const first = await getUserById(db, firstId);
    expect(first!.lastLoginAt).toBeInstanceOf(Date);
    const firstLogin = first!.lastLoginAt!.getTime();
    await new Promise((r) => setTimeout(r, 5));
    const secondId = await upsertUser(db, {
      email: "dave@example.com",
      name: "Dave",
      workosUserId: "workos_4",
    });
    const second = await getUserById(db, secondId);
    expect(second!.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(firstLogin);
  });

  it("getUserById returns the user when found", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const id = await upsertUser(db, {
      email: "eve@example.com",
      name: "Eve",
      workosUserId: "workos_5",
    });
    const fetched = await getUserById(db, id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(id);
    expect(fetched!.email).toBe("eve@example.com");
  });

  it("getUserById returns null when not found", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const fetched = await getUserById(db, "usr_nonexistent");
    expect(fetched).toBeNull();
  });

  it("is race-safe when two concurrent upserts arrive for the same email", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const [idA, idB] = await Promise.all([
      upsertUser(db, {
        email: "race@example.com",
        name: "Race A",
        workosUserId: "workos_race_a",
      }),
      upsertUser(db, {
        email: "race@example.com",
        name: "Race B",
        workosUserId: "workos_race_b",
      }),
    ]);
    expect(idA).toBe(idB);
    const user = await getUserById(db, idA);
    expect(user).not.toBeNull();
    expect(user!.email).toBe("race@example.com");
    // Exactly one row in the table — no UNIQUE violation, no duplicate.
    const { dashboardUsers } = await import("../../db/schema.js");
    const rows = await (db as any).select().from(dashboardUsers);
    expect(rows).toHaveLength(1);
  });

  it("upsertUser accepts null name and workosUserId", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const id = await upsertUser(db, {
      email: "frank@example.com",
      name: null,
      workosUserId: null,
    });
    const user = await getUserById(db, id);
    expect(user!.name).toBeNull();
    expect(user!.workosUserId).toBeNull();
  });
});

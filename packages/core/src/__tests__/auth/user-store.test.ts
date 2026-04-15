import { describe, it, expect } from "vitest";
import { createDb } from "../../db/client.js";
import { upsertUser, getUserById } from "../../auth/user-store.js";

describe("user-store", () => {
  it("inserts a new user and returns it with a usr_ id", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const user = await upsertUser(db, {
      email: "alice@example.com",
      name: "Alice",
      workosUserId: "workos_1",
    });
    expect(user.id).toMatch(/^usr_/);
    expect(user.email).toBe("alice@example.com");
    expect(user.name).toBe("Alice");
    expect(user.workosUserId).toBe("workos_1");
    expect(user.createdAt).toBeInstanceOf(Date);
  });

  it("normalizes email to lowercase on insert", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const user = await upsertUser(db, {
      email: "Bob@Example.COM",
      name: "Bob",
      workosUserId: "workos_2",
    });
    expect(user.email).toBe("bob@example.com");
  });

  it("updates existing user when email already exists (case-insensitive)", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const first = await upsertUser(db, {
      email: "carol@example.com",
      name: "Carol",
      workosUserId: "workos_3",
    });
    const second = await upsertUser(db, {
      email: "CAROL@example.com",
      name: "Carol Updated",
      workosUserId: "workos_3b",
    });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Carol Updated");
    expect(second.workosUserId).toBe("workos_3b");
    expect(second.email).toBe("carol@example.com");
  });

  it("updates lastLoginAt on upsert of existing user", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const first = await upsertUser(db, {
      email: "dave@example.com",
      name: "Dave",
      workosUserId: "workos_4",
    });
    expect(first.lastLoginAt).toBeInstanceOf(Date);
    const firstLogin = first.lastLoginAt!.getTime();
    await new Promise((r) => setTimeout(r, 5));
    const second = await upsertUser(db, {
      email: "dave@example.com",
      name: "Dave",
      workosUserId: "workos_4",
    });
    expect(second.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(firstLogin);
  });

  it("getUserById returns the user when found", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const created = await upsertUser(db, {
      email: "eve@example.com",
      name: "Eve",
      workosUserId: "workos_5",
    });
    const fetched = await getUserById(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.email).toBe("eve@example.com");
  });

  it("getUserById returns null when not found", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const fetched = await getUserById(db, "usr_nonexistent");
    expect(fetched).toBeNull();
  });

  it("upsertUser accepts null name and workosUserId", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const user = await upsertUser(db, {
      email: "frank@example.com",
      name: null,
      workosUserId: null,
    });
    expect(user.name).toBeNull();
    expect(user.workosUserId).toBeNull();
  });
});

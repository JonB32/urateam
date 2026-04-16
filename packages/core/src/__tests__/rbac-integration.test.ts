import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../db/client.js";
import { dashboardUsers, auditEvents } from "../db/schema.js";
import {
  setUserRole,
  applyBootstrapAdmins,
  canAccess,
  listUsers,
} from "../rbac/index.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

let db: any;

beforeEach(async () => {
  await installTestProLicense("enterprise");
  db = await createDb({ connectionString: ":memory:" });
});

afterEach(async () => {
  await restoreLicense();
});

describe("rbac end-to-end flow", () => {
  it("bootstrap → promote → permission chain", async () => {
    // 1. First user logs in, bootstrap promotes to admin
    await db.insert(dashboardUsers).values({
      id: "u_alice",
      email: "alice@acme.com",
      name: "Alice",
      workosUserId: null,
    });
    const promoted = await applyBootstrapAdmins(
      db,
      "alice@acme.com",
      "u_alice",
      "alice@acme.com",
    );
    expect(promoted).toBe(true);

    // 2. Alice logs in, role is admin, she can view config
    const users = await listUsers(db);
    const alice = users.find((u) => u.id === "u_alice")!;
    expect(alice.role).toBe("admin");
    expect(canAccess(alice.role, "config.view")).toBe(true);

    // 3. Second user joins (viewer by default), alice promotes to operator
    await db.insert(dashboardUsers).values({
      id: "u_bob",
      email: "bob@acme.com",
      name: "Bob",
      workosUserId: null,
      role: "viewer",
    });
    await setUserRole(db, {
      userId: "u_bob",
      newRole: "operator",
      actorUserId: "u_alice",
    });

    // 4. Bob can now retry but can't manage users or view config
    const updated = await listUsers(db);
    const bob = updated.find((u) => u.id === "u_bob")!;
    expect(bob.role).toBe("operator");
    expect(canAccess(bob.role, "runs.retry")).toBe(true);
    expect(canAccess(bob.role, "users.manage")).toBe(false);
    expect(canAccess(bob.role, "config.view")).toBe(false);

    // 5. Audit trail contains bootstrap + grant events
    const events = await db.select().from(auditEvents);
    const bootstrap = events.find(
      (e: any) => JSON.parse(e.payload).action === "bootstrap_admin",
    );
    const grant = events.find(
      (e: any) => JSON.parse(e.payload).action === "grant_role",
    );
    expect(bootstrap).toBeDefined();
    expect(grant).toBeDefined();
  });
});

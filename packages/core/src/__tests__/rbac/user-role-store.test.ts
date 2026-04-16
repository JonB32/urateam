import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../../db/client.js";
import { dashboardUsers, auditEvents } from "../../db/schema.js";
import {
  setUserRole,
  getUserRole,
  listUsers,
} from "../../rbac/user-role-store.js";
import { SelfDemoteError, LastAdminError } from "../../rbac/errors.js";
import { installTestProLicense, restoreLicense } from "../helpers/license.js";

let db: any;

beforeEach(async () => {
  await installTestProLicense("enterprise");
  db = await createDb({ connectionString: ":memory:" });
  await db.insert(dashboardUsers).values([
    { id: "u_admin", email: "admin@b.com", name: "Admin", workosUserId: null, role: "admin" },
    { id: "u_op",    email: "op@b.com",    name: "Op",    workosUserId: null, role: "operator" },
    { id: "u_view",  email: "view@b.com",  name: "View",  workosUserId: null, role: "viewer" },
  ]);
});

afterEach(async () => {
  await restoreLicense();
});

describe("setUserRole", () => {
  it("updates role and writes audit event", async () => {
    await setUserRole(db, { userId: "u_view", newRole: "operator", actorUserId: "u_admin" });
    expect(await getUserRole(db, "u_view")).toBe("operator");
    const events = await db.select().from(auditEvents);
    const grant = events.find((e: any) => e.eventType === "dashboard.manual_action");
    expect(grant).toBeDefined();
    const payload = JSON.parse(grant.payload);
    expect(payload.action).toBe("grant_role");
    expect(payload.targetUserId).toBe("u_view");
    expect(payload.oldRole).toBe("viewer");
    expect(payload.newRole).toBe("operator");
  });

  it("is idempotent — same role is a no-op, no audit event", async () => {
    await setUserRole(db, { userId: "u_view", newRole: "viewer", actorUserId: "u_admin" });
    const events = await db.select().from(auditEvents);
    expect(events).toHaveLength(0);
  });

  it("prevents self-demote", async () => {
    await expect(
      setUserRole(db, { userId: "u_admin", newRole: "viewer", actorUserId: "u_admin" }),
    ).rejects.toBeInstanceOf(SelfDemoteError);
  });

  it("prevents demoting the last admin", async () => {
    await expect(
      setUserRole(db, { userId: "u_admin", newRole: "viewer", actorUserId: "u_op" }),
    ).rejects.toBeInstanceOf(LastAdminError);
  });

  it("allows demoting an admin when another admin exists", async () => {
    await db.insert(dashboardUsers).values({
      id: "u_admin2", email: "admin2@b.com", name: null, workosUserId: null, role: "admin",
    });
    await setUserRole(db, { userId: "u_admin", newRole: "viewer", actorUserId: "u_admin2" });
    expect(await getUserRole(db, "u_admin")).toBe("viewer");
  });

  it("emits 'revoke_role' action for demotions to viewer", async () => {
    await setUserRole(db, { userId: "u_op", newRole: "viewer", actorUserId: "u_admin" });
    const events = await db.select().from(auditEvents);
    const event = events.find((e: any) => e.eventType === "dashboard.manual_action");
    const payload = JSON.parse(event.payload);
    expect(payload.action).toBe("revoke_role");
  });
});

describe("getUserRole", () => {
  it("returns the role for a known user", async () => {
    expect(await getUserRole(db, "u_op")).toBe("operator");
  });

  it("returns null for an unknown user", async () => {
    expect(await getUserRole(db, "u_nope")).toBeNull();
  });
});

describe("listUsers", () => {
  it("returns all users sorted by email", async () => {
    const users = await listUsers(db);
    expect(users).toHaveLength(3);
    expect(users.map((u) => u.email)).toEqual([
      "admin@b.com",
      "op@b.com",
      "view@b.com",
    ]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../../db/client.js";
import { dashboardUsers, auditEvents } from "../../db/schema.js";
import {
  applyBootstrapAdmins,
  getUserRole,
} from "../../rbac/user-role-store.js";
import { installTestProLicense, restoreLicense } from "../helpers/license.js";

let db: any;

beforeEach(async () => {
  await installTestProLicense("enterprise");
  db = await createDb({ connectionString: ":memory:" });
  await db.insert(dashboardUsers).values({
    id: "u_1",
    email: "alice@acme.com",
    name: "Alice",
    workosUserId: null,
    role: "viewer",
  });
});

afterEach(async () => {
  await restoreLicense();
});

describe("applyBootstrapAdmins", () => {
  it("promotes matching email to admin", async () => {
    const changed = await applyBootstrapAdmins(
      db,
      "alice@acme.com",
      "u_1",
      "alice@acme.com,bob@acme.com",
    );
    expect(changed).toBe(true);
    expect(await getUserRole(db, "u_1")).toBe("admin");
  });

  it("is case-insensitive", async () => {
    const changed = await applyBootstrapAdmins(
      db,
      "ALICE@ACME.COM",
      "u_1",
      "Alice@Acme.com",
    );
    expect(changed).toBe(true);
    expect(await getUserRole(db, "u_1")).toBe("admin");
  });

  it("handles whitespace and empty entries in env list", async () => {
    const changed = await applyBootstrapAdmins(
      db,
      "alice@acme.com",
      "u_1",
      " ,alice@acme.com , ",
    );
    expect(changed).toBe(true);
  });

  it("returns false when no list is configured", async () => {
    expect(
      await applyBootstrapAdmins(db, "alice@acme.com", "u_1", undefined),
    ).toBe(false);
    expect(await getUserRole(db, "u_1")).toBe("viewer");
  });

  it("returns false when email does not match", async () => {
    expect(
      await applyBootstrapAdmins(db, "alice@acme.com", "u_1", "bob@acme.com"),
    ).toBe(false);
    expect(await getUserRole(db, "u_1")).toBe("viewer");
  });

  it("is idempotent — already-admin is not re-promoted", async () => {
    await applyBootstrapAdmins(db, "alice@acme.com", "u_1", "alice@acme.com");
    const before = (await db.select().from(auditEvents)).length;
    const result = await applyBootstrapAdmins(
      db,
      "alice@acme.com",
      "u_1",
      "alice@acme.com",
    );
    expect(result).toBe(false);
    const after = (await db.select().from(auditEvents)).length;
    expect(after).toBe(before);
  });

  it("writes a dashboard.manual_action event with action=bootstrap_admin", async () => {
    await applyBootstrapAdmins(db, "alice@acme.com", "u_1", "alice@acme.com");
    const events = await db.select().from(auditEvents);
    const bootstrap = events.find((e: any) => {
      const p = JSON.parse(e.payload);
      return e.eventType === "dashboard.manual_action" && p.action === "bootstrap_admin";
    });
    expect(bootstrap).toBeDefined();
  });
});

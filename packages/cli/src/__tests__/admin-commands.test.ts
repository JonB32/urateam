import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "@urateam/core";
import { dashboardUsers } from "@urateam/core/dist/db/schema.js";
import {
  runAdminList,
  runAdminGrant,
  runAdminRevoke,
} from "../commands/admin.js";
import {
  installTestProLicense,
  restoreLicense,
} from "./helpers/license.js";

let db: any;
let logs: string[];
const log = (s: string) => {
  logs.push(s);
};

beforeEach(async () => {
  logs = [];
  await installTestProLicense("enterprise");
  db = await createDb({ connectionString: ":memory:" });
  await db.insert(dashboardUsers).values([
    {
      id: "u_admin",
      email: "admin@b.com",
      name: "Admin",
      workosUserId: null,
      role: "admin",
    },
    {
      id: "u_op",
      email: "op@b.com",
      name: "Op",
      workosUserId: null,
      role: "operator",
    },
  ]);
});

afterEach(async () => {
  await restoreLicense();
});

describe("ura admin commands", () => {
  it("list prints all users", async () => {
    await runAdminList({ db, log });
    expect(logs.some((l) => l.includes("admin@b.com"))).toBe(true);
    expect(logs.some((l) => l.includes("op@b.com"))).toBe(true);
  });

  it("grant promotes by email", async () => {
    await runAdminGrant({ db, email: "op@b.com", newRole: "admin", log });
    const rows = await db.select().from(dashboardUsers);
    expect(rows.find((u: any) => u.id === "u_op").role).toBe("admin");
  });

  it("grant with unknown email errors clearly", async () => {
    await expect(
      runAdminGrant({
        db,
        email: "ghost@nowhere.com",
        newRole: "admin",
        log,
      }),
    ).rejects.toThrow(/user not found/i);
  });

  it("revoke sets role to viewer", async () => {
    // First promote op to admin so a revoke → viewer is a real change
    await runAdminGrant({ db, email: "op@b.com", newRole: "admin", log });
    await runAdminRevoke({ db, email: "op@b.com", log });
    const rows = await db.select().from(dashboardUsers);
    expect(rows.find((u: any) => u.id === "u_op").role).toBe("viewer");
  });

  it("refuses when feature is unlicensed", async () => {
    await restoreLicense();
    await expect(runAdminList({ db, log })).rejects.toThrow(/enterprise/i);
  });
});

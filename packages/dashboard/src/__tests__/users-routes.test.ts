import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createDb } from "@urateam/core";
import {
  dashboardUsers,
  auditEvents,
} from "@urateam/core/dist/db/schema.js";
import { createUsersRouter } from "../routes/users.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

let db: any;

beforeEach(async () => {
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
    {
      id: "u_view",
      email: "view@b.com",
      name: "View",
      workosUserId: null,
      role: "viewer",
    },
  ]);
});

afterEach(async () => {
  await restoreLicense();
});

function appWith(role: string | undefined, userId = "u_admin") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (role) {
      c.set("user" as never, {
        id: userId,
        email: `${role}@b.com`,
        role,
      } as any);
    }
    await next();
  });
  app.route("/", createUsersRouter({ db, basePath: "" }));
  return app;
}

describe("/users routes (licensed)", () => {
  beforeEach(async () => {
    await installTestProLicense("enterprise");
  });

  it("GET /users as admin → 200 with user list", async () => {
    const res = await appWith("admin").request("/users");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("admin@b.com");
    expect(body).toContain("op@b.com");
    expect(body).toContain("view@b.com");
  });

  it("GET /users as operator → 403", async () => {
    const res = await appWith("operator", "u_op").request("/users");
    expect(res.status).toBe(403);
  });

  it("GET /users as viewer → 403", async () => {
    const res = await appWith("viewer", "u_view").request("/users");
    expect(res.status).toBe(403);
  });

  it("POST /users/:id/role as admin → 302, role updated, audit event written", async () => {
    const res = await appWith("admin").request("/users/u_view/role", {
      method: "POST",
      headers: {
        "HX-Request": "true",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "role=operator",
    });
    expect(res.status).toBe(302);
    const rows = await db.select().from(dashboardUsers);
    expect(rows.find((u: any) => u.id === "u_view").role).toBe("operator");
    const events = await db.select().from(auditEvents);
    expect(
      events.some((e: any) => e.eventType === "dashboard.manual_action"),
    ).toBe(true);
  });

  it("POST /users/:id/role as operator → 403", async () => {
    const res = await appWith("operator", "u_op").request(
      "/users/u_view/role",
      {
        method: "POST",
        headers: {
          "HX-Request": "true",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "role=admin",
      },
    );
    expect(res.status).toBe(403);
  });

  it("POST with invalid role → 400", async () => {
    const res = await appWith("admin").request("/users/u_view/role", {
      method: "POST",
      headers: {
        "HX-Request": "true",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "role=god",
    });
    expect(res.status).toBe(400);
  });

  it("POST to demote self → 400", async () => {
    const res = await appWith("admin", "u_admin").request(
      "/users/u_admin/role",
      {
        method: "POST",
        headers: {
          "HX-Request": "true",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "role=viewer",
      },
    );
    expect(res.status).toBe(400);
  });
});

describe("/users routes (unlicensed)", () => {
  beforeEach(async () => {
    // Ensure license is not set before the unlicensed test runs
    await restoreLicense();
  });

  it("GET /users → 404", async () => {
    const res = await appWith("admin").request("/users");
    expect(res.status).toBe(404);
  });
});

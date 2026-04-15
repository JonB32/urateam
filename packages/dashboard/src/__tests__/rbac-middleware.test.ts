import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { requirePermission } from "../middleware/rbac.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

afterEach(async () => {
  await restoreLicense();
});

function appWithRoute(permission: string, role: string | undefined) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (role)
      c.set("user" as never, {
        id: "u_1",
        role,
        email: "u@b.com",
      } as never);
    await next();
  });
  app.get(
    "/test",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requirePermission(permission as any),
    (c) => c.text("ok"),
  );
  return app;
}

describe("requirePermission", () => {
  it("unlicensed → no-op, all roles pass", async () => {
    const app = appWithRoute("config.view", "viewer");
    expect((await app.request("/test")).status).toBe(200);
  });

  describe("licensed", () => {
    beforeEach(async () => {
      await installTestProLicense("enterprise");
    });

    it("admin passes runs.view", async () => {
      const res = await appWithRoute("runs.view", "admin").request("/test");
      expect(res.status).toBe(200);
    });

    it("viewer passes runs.view", async () => {
      const res = await appWithRoute("runs.view", "viewer").request("/test");
      expect(res.status).toBe(200);
    });

    it("viewer gets 403 on audit.view", async () => {
      const res = await appWithRoute("audit.view", "viewer").request("/test");
      expect(res.status).toBe(403);
    });

    it("operator gets 403 on config.view", async () => {
      const res = await appWithRoute("config.view", "operator").request(
        "/test",
      );
      expect(res.status).toBe(403);
    });

    it("admin passes config.view", async () => {
      const res = await appWithRoute("config.view", "admin").request("/test");
      expect(res.status).toBe(200);
    });

    it("no session → 401", async () => {
      const res = await appWithRoute("runs.view", undefined).request("/test");
      expect(res.status).toBe(401);
    });
  });
});

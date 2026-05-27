import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { createDb } from "@urateam/core";
import { createRunsRouter } from "../routes/runs.js";

const CLI_TOKEN = "test-token-1234567890-secret";
const AUTH_HEADERS = {
  "x-ura-cli-token": CLI_TOKEN,
  "x-ura-actor": "alice",
};

let db: any;

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
  process.env.URATEAM_CLI_TOKEN = CLI_TOKEN;
});

afterEach(() => {
  delete process.env.URATEAM_CLI_TOKEN;
  vi.restoreAllMocks();
});

function appWith(triggerPmTick?: () => Promise<void>) {
  const app = new Hono();
  app.route(
    "/",
    createRunsRouter({
      db,
      runner: { resume: vi.fn(), start: vi.fn() },
      triggerPmTick,
      basePath: "",
    }),
  );
  return app;
}

describe("POST /cli/pm/tick", () => {
  it("returns 503 when triggerPmTick is not configured", async () => {
    const app = appWith(undefined);
    const res = await app.request("/cli/pm/tick", {
      method: "POST",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(503);
  });

  it("returns 200 with triggeredAt and completedAt on success", async () => {
    const triggerPmTick = vi.fn().mockResolvedValue(undefined);
    const app = appWith(triggerPmTick);
    const res = await app.request("/cli/pm/tick", {
      method: "POST",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(triggerPmTick).toHaveBeenCalledOnce();
    const body = (await res.json()) as any;
    expect(body.triggeredAt).toBeTypeOf("string");
    expect(body.completedAt).toBeTypeOf("string");
    expect(body.errors).toEqual([]);
    expect(new Date(body.completedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(body.triggeredAt).getTime(),
    );
  });

  it("returns 200 with errors array when triggerPmTick throws", async () => {
    const triggerPmTick = vi.fn().mockRejectedValue(new Error("tick boom"));
    const app = appWith(triggerPmTick);
    const res = await app.request("/cli/pm/tick", {
      method: "POST",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.errors).toContain("tick boom");
    expect(body.completedAt).toBeTypeOf("string");
  });

  it("returns 409 when called twice concurrently (in-progress mutex)", async () => {
    let resolveTick!: () => void;
    const tickPromise = new Promise<void>((resolve) => {
      resolveTick = resolve;
    });
    const triggerPmTick = vi.fn().mockReturnValue(tickPromise);
    const app = appWith(triggerPmTick);

    // Start first tick — do NOT await it yet so it stays in-flight.
    const firstReq = app.request("/cli/pm/tick", {
      method: "POST",
      headers: AUTH_HEADERS,
    });

    // Give the router a chance to set tickInProgress = true before the second call.
    await new Promise((r) => setImmediate(r));

    // Second concurrent call should be rejected with 409.
    const secondRes = await app.request("/cli/pm/tick", {
      method: "POST",
      headers: AUTH_HEADERS,
    });
    expect(secondRes.status).toBe(409);
    const secondBody = (await secondRes.json()) as any;
    expect(secondBody.error).toMatch(/in progress/i);

    // Let the first tick finish.
    resolveTick();
    const firstRes = await firstReq;
    expect(firstRes.status).toBe(200);

    // After the first tick completes, a third call should succeed again.
    triggerPmTick.mockResolvedValue(undefined);
    const thirdRes = await app.request("/cli/pm/tick", {
      method: "POST",
      headers: AUTH_HEADERS,
    });
    expect(thirdRes.status).toBe(200);
  });

  it("returns 403 when CLI token is wrong", async () => {
    const app = appWith(vi.fn());
    const res = await app.request("/cli/pm/tick", {
      method: "POST",
      headers: { "x-ura-cli-token": "wrong-token", "x-ura-actor": "alice" },
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when URATEAM_CLI_TOKEN env var is unset", async () => {
    delete process.env.URATEAM_CLI_TOKEN;
    const app = appWith(vi.fn());
    const res = await app.request("/cli/pm/tick", {
      method: "POST",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(404);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createDashboard } from "../server.js";
import { createDb } from "@urateam/core";
import type { Db } from "@urateam/core";
import { pipelineRuns, stageRuns } from "@urateam/core/dist/db/schema.js";
import { _resetLicenseCache } from "@urateam/core/dist/license.js";

// ---------------- license test helper (inlined from audit.test.ts) ----------------
function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(privateKey: KeyObject, payload: object): string {
  const header = { alg: "EdDSA", typ: "JWT" };
  const headerB64 = b64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

let savedPublicKey: string | undefined;
let savedEnv: string | undefined;

async function installEnterpriseLicense(): Promise<void> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyB64 = Buffer.from(
    publicKey.export({ format: "der", type: "spki" }),
  ).toString("base64");

  const mod = await import("@urateam/core/dist/license-public-key.js");
  if (savedPublicKey === undefined) {
    savedPublicKey = (mod as { LICENSE_PUBLIC_KEY_DER_B64: string })
      .LICENSE_PUBLIC_KEY_DER_B64;
  }
  Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
    value: publicKeyB64,
    writable: true,
    configurable: true,
  });

  const now = Math.floor(Date.now() / 1000);
  const jwt = makeJwt(privateKey, {
    iss: "urateams.com",
    sub: "cust_test",
    tier: "enterprise",
    seats: 25,
    iat: now,
    exp: now + 86_400,
  });

  if (savedEnv === undefined) savedEnv = process.env.URATEAM_LICENSE_KEY;
  process.env.URATEAM_LICENSE_KEY = jwt;
  _resetLicenseCache();
}

async function restoreLicense(): Promise<void> {
  if (savedPublicKey !== undefined) {
    const mod = await import("@urateam/core/dist/license-public-key.js");
    Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
      value: savedPublicKey,
      writable: true,
      configurable: true,
    });
    savedPublicKey = undefined;
  }
  if (savedEnv === undefined) {
    delete process.env.URATEAM_LICENSE_KEY;
  } else {
    process.env.URATEAM_LICENSE_KEY = savedEnv;
    savedEnv = undefined;
  }
  _resetLicenseCache();
}

function basicAuthHeader(u: string, p: string): string {
  return "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
}

const AUTH = { Authorization: basicAuthHeader("admin", "secret") };

const testCosts = {
  modelPricing: {
    "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  },
  hourlyEngRate: 50,
  timeSavedPerPrDefault: 4,
};

const testPipelineConfigs: Record<string, any> = {
  "quick-fix": { profile: { model: "claude-sonnet-4-6" } },
};

async function seedCompletedRun(db: Db): Promise<void> {
  const now = new Date();
  const started = new Date(now.getTime() - 60_000);
  await (db as any).insert(pipelineRuns).values({
    id: "run-cost-1",
    issueId: "BEC-1",
    issueTitle: "seed",
    pipelineKey: "quick-fix",
    repoUrl: "https://github.com/acme/api",
    status: "completed",
    startedAt: started,
    completedAt: now,
    linearTeamId: "T1",
  });
  await (db as any).insert(stageRuns).values({
    id: "stage-cost-1",
    pipelineRunId: "run-cost-1",
    stage: "implement",
    status: "completed",
    startedAt: started,
    completedAt: now,
    inputTokens: 100_000,
    outputTokens: 50_000,
  });
}

// ---------------- tests ----------------
describe("cost route — unlicensed", () => {
  beforeEach(async () => {
    await restoreLicense();
  });

  it("returns 404 for GET /cost when feature is not licensed", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const app = createDashboard({
      db,
      pipelineConfigs: testPipelineConfigs,
      repoConfigs: {},
      costs: testCosts,
      auth: { username: "admin", password: "secret" },
    });
    const res = await app.request("/cost", { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it("returns 404 for GET /cost/page when feature is not licensed", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const app = createDashboard({
      db,
      pipelineConfigs: testPipelineConfigs,
      repoConfigs: {},
      costs: testCosts,
      auth: { username: "admin", password: "secret" },
    });
    const res = await app.request("/cost/page", { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it("returns 404 for GET /cost/export.csv when feature is not licensed", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const app = createDashboard({
      db,
      pipelineConfigs: testPipelineConfigs,
      repoConfigs: {},
      costs: testCosts,
      auth: { username: "admin", password: "secret" },
    });
    const res = await app.request("/cost/export.csv", { headers: AUTH });
    expect(res.status).toBe(404);
  });
});

describe("cost route — licensed (enterprise)", () => {
  beforeEach(async () => {
    await installEnterpriseLicense();
  });
  afterEach(async () => {
    await restoreLicense();
  });

  it("GET /cost returns 200 and renders summary with seeded run", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await seedCompletedRun(db);

    const app = createDashboard({
      db,
      pipelineConfigs: testPipelineConfigs,
      repoConfigs: {},
      costs: testCosts,
      auth: { username: "admin", password: "secret" },
    });

    const res = await app.request("/cost", { headers: AUTH });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("PRs merged");
    expect(html).toContain("quick-fix");
    expect(html).toMatch(/\$\d/);
    expect(html).toContain("Cost");
  });

  it("GET /cost/export.csv returns 200 text/csv with header row and disposition", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await seedCompletedRun(db);

    const app = createDashboard({
      db,
      pipelineConfigs: testPipelineConfigs,
      repoConfigs: {},
      costs: testCosts,
      auth: { username: "admin", password: "secret" },
    });

    const res = await app.request("/cost/export.csv", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/csv");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/attachment; filename="cost-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"/);

    const body = await res.text();
    expect(body).toContain(
      "completed_at,run_id,issue_id,pipeline_key,linear_team_id,repo_url,input_tokens,output_tokens,dollars,time_saved_hours",
    );
    expect(body).toContain("run-cost-1");
  });
});

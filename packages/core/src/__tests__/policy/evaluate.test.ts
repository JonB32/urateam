import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../../db/client.js";
import { auditEvents } from "../../db/schema.js";
import { evaluatePolicyGates } from "../../policy/evaluate.js";
import { _resetLicenseCache } from "../../license.js";
import { installTestProLicense, restoreLicense } from "../helpers/license.js";

let db: any;

beforeEach(async () => {
  _resetLicenseCache();
  await installTestProLicense("enterprise");
  db = await createDb({ connectionString: ":memory:" });
});
afterEach(async () => {
  await restoreLicense();
  _resetLicenseCache();
});

function stubIssue(labels: string[] = []) {
  return {
    id: "BEC-1",
    labels: async () => ({ nodes: labels.map((name) => ({ name })) }),
  };
}

async function flushFireAndForget() {
  // let fire-and-forget audit writes settle
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("evaluatePolicyGates", () => {
  const policy = {
    pathBlocklist: ["infra/**"],
    maxTokensPerIssue: 100,
    overrideLabel: "policy-override",
  } as any;

  it("no policy configured → no violations, no draft", async () => {
    const r = await evaluatePolicyGates({
      db,
      runId: "r1",
      issue: stubIssue(),
      policy: undefined,
      changedFiles: ["infra/main.tf"],
      tokensUsed: 200,
      stage: "implement",
    });
    expect(r.violations).toEqual([]);
    expect(r.shouldDraft).toBe(false);
    expect(r.overrideActive).toBe(false);
  });

  it("path violation → shouldDraft=true and audit event written", async () => {
    const r = await evaluatePolicyGates({
      db,
      runId: "r1",
      issue: stubIssue(),
      policy,
      changedFiles: ["infra/main.tf"],
      tokensUsed: 50,
      stage: "implement",
    });
    expect(r.shouldDraft).toBe(true);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].gate).toBe("path");
    await flushFireAndForget();
    const events = await db.select().from(auditEvents);
    expect(
      events.find((e: any) => e.eventType === "policy.path_blocked"),
    ).toBeDefined();
  });

  it("cost violation → shouldDraft=true and audit event written", async () => {
    const r = await evaluatePolicyGates({
      db,
      runId: "r1",
      issue: stubIssue(),
      policy,
      changedFiles: ["src/a.ts"],
      tokensUsed: 200,
      stage: "implement",
    });
    expect(r.shouldDraft).toBe(true);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].gate).toBe("cost");
    await flushFireAndForget();
    const events = await db.select().from(auditEvents);
    expect(
      events.find((e: any) => e.eventType === "policy.cost_exceeded"),
    ).toBeDefined();
  });

  it("override label present → no draft, override event written", async () => {
    const r = await evaluatePolicyGates({
      db,
      runId: "r1",
      issue: stubIssue(["policy-override"]),
      policy,
      changedFiles: ["infra/main.tf"],
      tokensUsed: 200,
      stage: "implement",
    });
    expect(r.shouldDraft).toBe(false);
    expect(r.overrideActive).toBe(true);
    expect(r.violations).toHaveLength(2); // path + cost
    await flushFireAndForget();
    const events = await db.select().from(auditEvents);
    // Both path and cost violations fire — expect one override event per gate type (2 total).
    const overrideEvents = events.filter((e: any) => e.eventType === "policy.override_used");
    expect(overrideEvents).toHaveLength(2);
    expect(overrideEvents.map((e: any) => JSON.parse(e.payload).gateType).sort()).toEqual(["cost", "path"]);
    expect(
      events.find((e: any) => e.eventType === "policy.path_blocked"),
    ).toBeUndefined();
    expect(
      events.find((e: any) => e.eventType === "policy.cost_exceeded"),
    ).toBeUndefined();
  });
});

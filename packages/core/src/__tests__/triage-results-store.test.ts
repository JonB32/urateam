import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createDb } from "../db/index.js";
import {
  upsertTriageResult,
  getTriageResult,
} from "../pm/triage-results-store.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/triage-results-store-test-${id}.sqlite`;
}

describe("triage-results-store", () => {
  const paths: string[] = [];

  async function makeDb() {
    const path = tmpDbPath();
    paths.push(path);
    return createDb({ driver: "sqlite", connectionString: path });
  }

  afterEach(() => {
    for (const p of paths) {
      try { unlinkSync(p); } catch { /* ignore */ }
      try { unlinkSync(p + "-wal"); } catch { /* ignore */ }
      try { unlinkSync(p + "-shm"); } catch { /* ignore */ }
    }
    paths.length = 0;
  });

  it("returns undefined when no row exists", async () => {
    const db = await makeDb() as any;
    const result = await getTriageResult(db, "BEC-999");
    expect(result).toBeUndefined();
  });

  it("upserts and reads back the v2 prediction", async () => {
    const db = await makeDb() as any;
    await upsertTriageResult(db, "BEC-100", {
      affectedFiles: ["src/foo.ts", "src/bar.ts"],
      assumptions: ["assumes happy path"],
      riskAssessment: { severity: "low", areas: ["auth"] },
    });

    const result = await getTriageResult(db, "BEC-100");
    expect(result).toEqual({
      affectedFiles: ["src/foo.ts", "src/bar.ts"],
      assumptions: ["assumes happy path"],
      riskAssessment: { severity: "low", areas: ["auth"] },
    });
  });

  it("upsert overwrites an existing row (re-triage replaces the prediction)", async () => {
    const db = await makeDb() as any;
    await upsertTriageResult(db, "BEC-200", {
      affectedFiles: ["old/path.ts"],
    });
    await upsertTriageResult(db, "BEC-200", {
      affectedFiles: ["new/path-a.ts", "new/path-b.ts"],
    });

    const result = await getTriageResult(db, "BEC-200");
    expect(result?.affectedFiles).toEqual(["new/path-a.ts", "new/path-b.ts"]);
  });

  it("empty prediction object is preserved (distinguishes 'triaged but no v2 fields' from 'no triage row')", async () => {
    const db = await makeDb() as any;
    await upsertTriageResult(db, "BEC-300", {});

    const result = await getTriageResult(db, "BEC-300");
    // Row exists, but no affectedFiles means runner's `stored?.affectedFiles`
    // resolves to undefined → hasV2Prediction=false. This is the path used
    // when v1 is forced via URATEAM_DISABLE_TRIAGE_V2=true.
    expect(result).toEqual({});
    expect(result?.affectedFiles).toBeUndefined();
  });

  it("preserves all v2 extension fields verbatim through the round trip", async () => {
    const db = await makeDb() as any;
    const full = {
      affectedFiles: ["src/a.ts", "src/b.ts"],
      assumptions: ["a1", "a2"],
      examples: [{ scenario: "POST /x {}", expected: "200" }],
      testStrategy: { unit: "x.test.ts", integration: "y.test.ts" },
      riskAssessment: { severity: "medium" as const, areas: ["auth", "db"] },
    };
    await upsertTriageResult(db, "BEC-400", full);
    const result = await getTriageResult(db, "BEC-400");
    expect(result).toEqual(full);
  });
});

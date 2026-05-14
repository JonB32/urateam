import { describe, it, expect } from "vitest";
import {
  TriageV2ExtensionsSchema,
  parseTriageV2Extensions,
} from "../pm/types.js";

describe("TriageV2ExtensionsSchema", () => {
  it("accepts a fully-populated v2 result", () => {
    const result = TriageV2ExtensionsSchema.safeParse({
      assumptions: ["Empty email is the only 500 case"],
      examples: [
        { scenario: "POST /auth/login {email:''}", expected: "HTTP 400" },
      ],
      affectedFiles: ["src/routes/auth.ts"],
      testStrategy: {
        unit: "src/__tests__/email.test.ts",
        integration: "src/__tests__/auth.test.ts",
      },
      riskAssessment: { severity: "low", areas: ["auth"] },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object (all fields optional)", () => {
    expect(TriageV2ExtensionsSchema.safeParse({}).success).toBe(true);
  });

  it("rejects severity not in the enum", () => {
    const result = TriageV2ExtensionsSchema.safeParse({
      riskAssessment: { severity: "critical", areas: ["auth"] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty strings inside string arrays", () => {
    const result = TriageV2ExtensionsSchema.safeParse({
      assumptions: ["a", ""],
    });
    expect(result.success).toBe(false);
  });
});

describe("parseTriageV2Extensions — pre-zod truncation + filter", () => {
  it("returns an empty object when input is not a plain object", () => {
    expect(parseTriageV2Extensions(null)).toEqual({});
    expect(parseTriageV2Extensions("not an object")).toEqual({});
    expect(parseTriageV2Extensions(42)).toEqual({});
  });

  it("silently truncates excess assumptions (>10 → 10)", () => {
    const tooMany = Array.from({ length: 15 }, (_, i) => `assumption ${i}`);
    const parsed = parseTriageV2Extensions({ assumptions: tooMany });
    expect(parsed.assumptions).toHaveLength(10);
    expect(parsed.assumptions?.[0]).toBe("assumption 0");
    expect(parsed.assumptions?.[9]).toBe("assumption 9");
  });

  it("silently truncates excess examples (>3 → 3)", () => {
    const tooMany = Array.from({ length: 5 }, (_, i) => ({
      scenario: `scenario ${i}`,
      expected: `expected ${i}`,
    }));
    const parsed = parseTriageV2Extensions({ examples: tooMany });
    expect(parsed.examples).toHaveLength(3);
  });

  it("silently truncates excess affectedFiles (>20 → 20)", () => {
    const tooMany = Array.from({ length: 30 }, (_, i) => `file${i}.ts`);
    const parsed = parseTriageV2Extensions({ affectedFiles: tooMany });
    expect(parsed.affectedFiles).toHaveLength(20);
  });

  it("silently truncates excess riskAssessment.areas (>5 → 5)", () => {
    const parsed = parseTriageV2Extensions({
      riskAssessment: {
        severity: "high",
        areas: ["a", "b", "c", "d", "e", "f", "g"],
      },
    });
    expect(parsed.riskAssessment?.areas).toHaveLength(5);
  });

  it("filters non-string elements from string arrays", () => {
    const parsed = parseTriageV2Extensions({
      assumptions: ["valid", 42, null, "also valid"],
      affectedFiles: ["a.ts", { wrong: "type" }, "b.ts"],
    });
    expect(parsed.assumptions).toEqual(["valid", "also valid"]);
    expect(parsed.affectedFiles).toEqual(["a.ts", "b.ts"]);
  });

  it("filters examples missing scenario or expected", () => {
    const parsed = parseTriageV2Extensions({
      examples: [
        { scenario: "ok", expected: "ok" },
        { scenario: "missing expected" },
        { expected: "missing scenario" },
        { scenario: "", expected: "" },
        null,
        "string instead of object",
      ],
    });
    expect(parsed.examples).toEqual([{ scenario: "ok", expected: "ok" }]);
  });

  it("drops riskAssessment entirely on unknown severity", () => {
    const parsed = parseTriageV2Extensions({
      riskAssessment: { severity: "critical", areas: ["auth"] },
    });
    expect(parsed.riskAssessment).toBeUndefined();
  });

  it("preserves valid riskAssessment when areas is missing (defaults to [])", () => {
    const parsed = parseTriageV2Extensions({
      riskAssessment: { severity: "medium" },
    });
    expect(parsed.riskAssessment).toEqual({ severity: "medium", areas: [] });
  });

  it("trims whitespace from string fields", () => {
    const parsed = parseTriageV2Extensions({
      assumptions: ["  spaced  "],
      affectedFiles: ["  src/foo.ts\n"],
    });
    expect(parsed.assumptions).toEqual(["spaced"]);
    expect(parsed.affectedFiles).toEqual(["src/foo.ts"]);
  });

  it("returns an empty object when none of the v2 fields are present", () => {
    expect(parseTriageV2Extensions({ priority: 1, labels: [] })).toEqual({});
  });
});

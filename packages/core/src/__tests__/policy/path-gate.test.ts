import { describe, it, expect } from "vitest";
import { evaluatePathBlocklist } from "../../policy/path-gate.js";

describe("evaluatePathBlocklist", () => {
  it("returns empty array when blocklist is empty", () => {
    expect(evaluatePathBlocklist(["a.ts", "b.ts"], [])).toEqual([]);
  });

  it("returns empty array when no files match", () => {
    expect(evaluatePathBlocklist(["src/a.ts"], ["infra/**"])).toEqual([]);
  });

  it("matches glob patterns", () => {
    const v = evaluatePathBlocklist(["infra/main.tf"], ["infra/**"]);
    expect(v).toHaveLength(1);
    expect(v[0].gate).toBe("path");
    expect(v[0].detail).toContain("infra/main.tf");
    expect(v[0].detail).toContain("infra/**");
    expect(v[0].payload).toMatchObject({ path: "infra/main.tf", pattern: "infra/**" });
  });

  it("emits one violation per file-pattern pair", () => {
    const v = evaluatePathBlocklist(
      ["a/migrations/001.sql", "b/migrations/002.sql"],
      ["**/migrations/**"],
    );
    expect(v).toHaveLength(2);
  });

  it("emits multiple violations when a file matches multiple patterns", () => {
    const v = evaluatePathBlocklist(
      ["infra/db/migrations/001.sql"],
      ["infra/**", "**/migrations/**"],
    );
    expect(v).toHaveLength(2);
  });

  it("all violations are severity=blocking", () => {
    const v = evaluatePathBlocklist(["secrets/x.key"], ["secrets/**"]);
    expect(v[0].severity).toBe("blocking");
  });
});

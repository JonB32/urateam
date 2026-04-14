/**
 * Audit log immutability lint test.
 *
 * The audit_events table is append-only by design. Only the retention sweep
 * (`audit/retention.ts`) may delete rows, and nothing should ever update them.
 *
 * This test greps the source tree for `.delete(auditEvents)` / `.update(auditEvents)`
 * calls and fails if any non-allowlisted file is found.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

describe("audit_events immutability", () => {
  it("only audit/retention.ts may delete or update audit_events rows", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const allowed = [
      "packages/core/src/audit/retention.ts",
      "packages/core/src/__tests__/audit/retention.test.ts",
      "packages/core/src/__tests__/audit-immutability.test.ts",
    ];

    const patterns = [
      "\\.delete\\s*\\(\\s*auditEvents",
      "\\.update\\s*\\(\\s*auditEvents",
    ];

    const matches: string[] = [];
    for (const pat of patterns) {
      try {
        const out = execFileSync(
          "git",
          ["grep", "-nE", pat, "--", "packages/**/*.ts"],
          { cwd: repoRoot, encoding: "utf8" },
        );
        matches.push(...out.trim().split("\n").filter(Boolean));
      } catch {
        // git grep exits non-zero when no matches; safe to ignore
      }
    }

    const offenders = matches
      .map((line) => line.split(":")[0]!)
      .filter((file) => !allowed.some((a) => file.endsWith(a) || file === a));

    expect(
      offenders,
      `Unauthorized audit_events mutation in:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

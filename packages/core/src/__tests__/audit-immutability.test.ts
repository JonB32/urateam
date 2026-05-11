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

  it("logAuditEventUnchecked is only called from license.ts or Pro-tier feature modules", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    // logAuditEventUnchecked is allowed in:
    //   1. The writer itself (definition)
    //   2. license.ts (license-validation failure path)
    //   3. Pro-tier feature modules (PM agent, Release Manager) — their audit events
    //      must appear in the audit table whenever the Pro feature is licensed,
    //      independent of the Enterprise audit-log dashboard being unlocked.
    //   4. This test file
    const allowed = [
      "packages/core/src/audit/writer.ts",
      "packages/core/src/license.ts",
      "packages/core/src/pm/scheduler.ts",
      "packages/core/src/pm/actions/triage.ts",
      "packages/core/src/pm/actions/promote.ts",
      "packages/core/src/pm/actions/start-todo.ts",
      "packages/core/src/pm/actions/resolve-approvals.ts",
      "packages/core/src/pm/actions/recover-stuck.ts",
      "packages/core/src/pipeline/review-providers-runner.ts",
      "packages/core/src/release-manager/release-tick.ts",
      "packages/core/src/release-manager/release-helpers.ts",
      "packages/core/src/release-manager/slack-handler.ts",
      "packages/core/src/repo/agent-branch-sweep-runner.ts",
      "packages/core/src/qa/github.ts",
      "packages/core/src/qa/gap.ts",
      "packages/core/src/__tests__/audit-immutability.test.ts",
    ];

    let matches: string[] = [];
    try {
      const out = execFileSync(
        "git",
        ["grep", "-nE", "logAuditEventUnchecked", "--", "packages/**/*.ts"],
        { cwd: repoRoot, encoding: "utf8" },
      );
      matches = out.trim().split("\n").filter(Boolean);
    } catch {
      // no matches
    }

    const offenders = matches
      .map((line) => line.split(":")[0]!)
      .filter((file) => !allowed.some((a) => file.endsWith(a) || file === a));

    expect(
      offenders,
      `Unauthorized logAuditEventUnchecked usage in:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

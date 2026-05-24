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
import { readFileSync } from "node:fs";
import path from "node:path";
import { AuditEventTypeSchema, AuditActorTypeSchema } from "../types.js";

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
      // BEC-252: restart-interrupt recovery is a base-tier operational signal —
      // operators need to see it regardless of Enterprise audit-log dashboard.
      "packages/core/src/pm/actions/recover.ts",
      "packages/core/src/pipeline/review-providers-runner.ts",
      "packages/core/src/release-manager/release-tick.ts",
      "packages/core/src/release-manager/release-helpers.ts",
      "packages/core/src/release-manager/slack-handler.ts",
      // BEC-207: base-tier operational signal — see auth-monitor.ts comment
      // for the rationale on bypassing the audit-log feature gate.
      "packages/core/src/executor/auth-monitor.ts",
      "packages/core/src/__tests__/auth-monitor.test.ts",
      // BEC-236: circuit-breaker probe / recovery / manual reset are base-tier
      // operational signals — operators need to see them regardless of whether
      // the Enterprise audit-log dashboard is licensed. Same rationale as
      // auth-monitor: the events drive a critical recovery loop that must be
      // observable in OSS/Pro tiers.
      "packages/core/src/pm/actions/select-probe-candidates.ts",
      "packages/core/src/pm/actions/recover-circuit-breaker.ts",
      "packages/cli/src/commands/circuit.ts",
      "packages/core/src/audit/events.ts",
      "packages/core/src/repo/agent-branch-sweep-runner.ts",
      "packages/core/src/qa/github.ts",
      "packages/core/src/qa/gap.ts",
      "packages/core/src/__tests__/audit-immutability.test.ts",
      // Tier 2: the convention-checklist text documents the
      // `audit-bypass-undocumented` category by name (`logAuditEventUnchecked`
      // appears as a literal in the prompt fragment, not as a call site).
      // The grep is intentionally loose so renames to similar identifiers
      // still trip; the allow-list entry is the right surface for "this
      // file mentions the name but does not invoke it" exceptions.
      "packages/core/src/security/review-checklist.ts",
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

  /**
   * Tier 1d — keep CLAUDE.md's claimed audit-event count in sync with
   * AuditEventTypeSchema. The autonomous pipeline has historically added new
   * event types to the schema without updating the doc count (see Tier 1a's
   * pre-existing 17→41 drift). This test fails CI when the regex match
   * `(\d+) event types` in CLAUDE.md disagrees with `AuditEventTypeSchema`'s
   * length.
   *
   * The pipeline's review-stage prompt will surface this as a blocking
   * `audit-count-drift` finding via the convention checklist (Tier 2);
   * the unit test is the deterministic backstop.
   */
  it("CLAUDE.md audit-event count matches AuditEventTypeSchema length", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const claudeMd = readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8");
    const matches = [...claudeMd.matchAll(/(\d+)\s+event\s+types/g)];
    expect(
      matches.length,
      "CLAUDE.md must contain exactly one `<N> event types` sentence so Tier 1d can lock it down",
    ).toBe(1);
    const documented = Number(matches[0]![1]);
    const actual = AuditEventTypeSchema.options.length;
    expect(
      documented,
      `CLAUDE.md says "${documented} event types" but AuditEventTypeSchema has ${actual}. Update CLAUDE.md or the schema; they must match.`,
    ).toBe(actual);
  });

  /**
   * Tier 1d — mirror of the event-type count check for the actor-type enum.
   * The actor-type list is shorter and changes less often, but the same drift
   * pattern applies (e.g. BEC-207 added a new actor without updating any doc).
   * CLAUDE.md doesn't currently cite a number for actor types, so this test
   * is gated: it only runs if a `(\d+) actor types` sentence is present, and
   * fails when present-but-stale. Removes the test gracefully when the doc
   * doesn't enumerate.
   */
  it("CLAUDE.md actor-type count matches AuditActorTypeSchema length (when present)", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const claudeMd = readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8");
    const matches = [...claudeMd.matchAll(/(\d+)\s+actor\s+types/g)];
    if (matches.length === 0) return; // not enumerated; nothing to validate
    expect(
      matches.length,
      "CLAUDE.md must contain at most one `<N> actor types` sentence",
    ).toBe(1);
    const documented = Number(matches[0]![1]);
    const actual = AuditActorTypeSchema.options.length;
    expect(
      documented,
      `CLAUDE.md says "${documented} actor types" but AuditActorTypeSchema has ${actual}.`,
    ).toBe(actual);
  });
});

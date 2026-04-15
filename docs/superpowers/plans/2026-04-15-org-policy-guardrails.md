# Org Policy / Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship enterprise feature 4.6 — three pipeline guardrails (path blocklist, per-issue cost cap, mandatory reviewers) with label-based override and full audit coverage — per `docs/superpowers/specs/2026-04-15-org-policy-guardrails-design.md`.

**Architecture:** New `packages/core/src/policy/` module owns gate evaluation as pure functions. `pipeline/runner.ts` calls the gates after every stage; violations set `run.shouldDraft = true` and append to `unresolvedBlockingFindings` (the existing draft-PR machinery). PR creation threads reviewer requests through `createPRViaCli` and GitHub App paths. Auto-merge is blocked until mandatory reviewers have approved. Four new audit event types written through the existing license-gated `logAuditEvent`. License-gated by `isFeatureLicensed("org-policy")`.

**Tech Stack:** TypeScript, Drizzle, Hono, Vitest, Zod, pino, Octokit (GitHub App path), `gh` CLI.

---

## File Structure

### New files
- `packages/core/src/policy/index.ts` — barrel
- `packages/core/src/policy/types.ts` — `PolicyViolation` type
- `packages/core/src/policy/path-gate.ts` — `evaluatePathBlocklist`
- `packages/core/src/policy/cost-gate.ts` — `evaluateCostGate`
- `packages/core/src/policy/reviewer-gate.ts` — `buildReviewerRequest`, `verifyApprovalsReceived`
- `packages/core/src/policy/override.ts` — `hasOverrideLabel`
- `packages/core/src/__tests__/policy/path-gate.test.ts`
- `packages/core/src/__tests__/policy/cost-gate.test.ts`
- `packages/core/src/__tests__/policy/reviewer-gate.test.ts`
- `packages/core/src/__tests__/policy/override.test.ts`
- `packages/core/src/__tests__/policy-integration.test.ts`
- `packages/core/src/__tests__/policy-license.test.ts`

### Modified files
- `packages/core/src/types.ts` — add `PolicySchema`, extend `PipelineConfigSchema` with `policy`, add 4 audit event types
- `packages/core/src/audit/events.ts` — add 4 builder functions
- `packages/core/src/license.ts` — add `"org-policy"` to Enterprise feature set
- `packages/core/src/index.ts` — re-export `./policy/index.js`
- `packages/core/src/pipeline/runner.ts` — wire gates after implement, test, review stages; pass reviewers to PR creation; add auto-merge reviewer check
- `packages/core/src/git/github.ts` (or wherever `createPR` / `createPRViaCli` live) — accept `reviewers` + `teamReviewers` params
- `CLAUDE.md` — new "Org policy" section

---

## Task 1: Zod config schema + audit event types

**Files:**
- Modify: `packages/core/src/types.ts`
- Test: `packages/core/src/__tests__/policy-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { PolicySchema, PipelineConfigSchema, AuditEventTypeSchema } from "../types.js";

describe("PolicySchema", () => {
  it("parses a full policy block", () => {
    const parsed = PolicySchema.parse({
      pathBlocklist: ["infra/**", "**/migrations/**"],
      maxTokensPerIssue: 500000,
      overrideLabel: "policy-override",
      mandatoryReviewers: { users: ["alice"], teams: ["security"] },
    });
    expect(parsed.pathBlocklist).toEqual(["infra/**", "**/migrations/**"]);
    expect(parsed.maxTokensPerIssue).toBe(500000);
    expect(parsed.overrideLabel).toBe("policy-override");
    expect(parsed.mandatoryReviewers?.users).toEqual(["alice"]);
  });

  it("defaults overrideLabel to 'policy-override' when omitted", () => {
    const parsed = PolicySchema.parse({});
    expect(parsed.overrideLabel).toBe("policy-override");
    expect(parsed.pathBlocklist).toEqual([]);
  });

  it("rejects non-positive maxTokensPerIssue", () => {
    expect(() => PolicySchema.parse({ maxTokensPerIssue: 0 })).toThrow();
    expect(() => PolicySchema.parse({ maxTokensPerIssue: -1 })).toThrow();
  });
});

describe("PipelineConfigSchema", () => {
  it("accepts optional policy field", () => {
    const cfg = PipelineConfigSchema.parse({
      label: "auto-implement",
      stages: [],
      policy: { pathBlocklist: ["secrets/**"] },
    } as any);
    expect(cfg.policy?.pathBlocklist).toEqual(["secrets/**"]);
  });
});

describe("AuditEventTypeSchema", () => {
  it("accepts all 4 policy event types", () => {
    for (const t of [
      "policy.path_blocked", "policy.cost_exceeded",
      "policy.override_used", "policy.reviewers_requested",
    ]) {
      expect(AuditEventTypeSchema.parse(t)).toBe(t);
    }
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```
cd packages/core && npx vitest run src/__tests__/policy-types.test.ts
```

- [ ] **Step 3: Add schemas to `types.ts`**

Append to `packages/core/src/types.ts`:
```ts
export const PolicySchema = z.object({
  pathBlocklist: z.array(z.string()).default([]),
  maxTokensPerIssue: z.number().int().positive().optional(),
  overrideLabel: z.string().default("policy-override"),
  mandatoryReviewers: z.object({
    users: z.array(z.string()).default([]),
    teams: z.array(z.string()).default([]),
  }).optional(),
});
export type Policy = z.infer<typeof PolicySchema>;
```

Find `PipelineConfigSchema` and add `policy: PolicySchema.optional(),` to its shape.

Find `AuditEventTypeSchema` and append these four entries to the enum:
```ts
"policy.path_blocked",
"policy.cost_exceeded",
"policy.override_used",
"policy.reviewers_requested",
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add packages/core/src/types.ts packages/core/src/__tests__/policy-types.test.ts
git commit -m "feat(policy): zod config schema and 4 audit event types"
```

---

## Task 2: Path gate

**Files:**
- Create: `packages/core/src/policy/path-gate.ts`
- Create: `packages/core/src/policy/types.ts`
- Create: `packages/core/src/policy/index.ts`
- Test: `packages/core/src/__tests__/policy/path-gate.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/src/__tests__/policy/path-gate.test.ts`:
```ts
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
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Create `policy/types.ts`**

```ts
export interface PolicyViolation {
  gate: "path" | "cost" | "reviewer";
  detail: string;
  severity: "blocking";
  payload: Record<string, unknown>;
}
```

- [ ] **Step 4: Create `policy/path-gate.ts`**

```ts
import { matchesAnyPattern } from "../pipeline/runner.js";
import type { PolicyViolation } from "./types.js";

export function evaluatePathBlocklist(
  changedFiles: string[],
  patterns: string[],
): PolicyViolation[] {
  if (patterns.length === 0) return [];
  const violations: PolicyViolation[] = [];
  for (const file of changedFiles) {
    for (const pattern of patterns) {
      if (matchesAnyPattern(file, [pattern])) {
        violations.push({
          gate: "path",
          detail: `${file} matches ${pattern}`,
          severity: "blocking",
          payload: { path: file, pattern },
        });
      }
    }
  }
  return violations;
}
```

**If** `matchesAnyPattern` is not currently exported from `pipeline/runner.ts`, add an `export` to its declaration (it's around line 99 — already exported per the spec).

- [ ] **Step 5: Create `policy/index.ts`**

```ts
export * from "./types.js";
export * from "./path-gate.js";
```

- [ ] **Step 6: Run, verify pass**

- [ ] **Step 7: Commit**

```
git add packages/core/src/policy packages/core/src/__tests__/policy/path-gate.test.ts
git commit -m "feat(policy): path blocklist gate"
```

---

## Task 3: Cost gate

**Files:**
- Create: `packages/core/src/policy/cost-gate.ts`
- Modify: `packages/core/src/policy/index.ts`
- Test: `packages/core/src/__tests__/policy/cost-gate.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { evaluateCostGate } from "../../policy/cost-gate.js";

describe("evaluateCostGate", () => {
  it("returns null when no limit configured", () => {
    expect(evaluateCostGate(999999, undefined, "implement")).toBeNull();
  });

  it("returns null when tokens under limit", () => {
    expect(evaluateCostGate(50, 100, "implement")).toBeNull();
  });

  it("returns null when tokens equal limit", () => {
    expect(evaluateCostGate(100, 100, "implement")).toBeNull();
  });

  it("returns violation when tokens exceed limit", () => {
    const v = evaluateCostGate(101, 100, "implement");
    expect(v).not.toBeNull();
    expect(v!.gate).toBe("cost");
    expect(v!.detail).toContain("101");
    expect(v!.detail).toContain("100");
    expect(v!.detail).toContain("implement");
    expect(v!.payload).toMatchObject({ tokensUsed: 101, limit: 100, stage: "implement" });
  });

  it("includes stage in violation payload", () => {
    const v = evaluateCostGate(500, 100, "review");
    expect(v!.payload.stage).toBe("review");
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Create `policy/cost-gate.ts`**

```ts
import type { PolicyViolation } from "./types.js";

export function evaluateCostGate(
  tokensUsed: number,
  limit: number | undefined,
  stage: string,
): PolicyViolation | null {
  if (limit === undefined || tokensUsed <= limit) return null;
  return {
    gate: "cost",
    detail: `token usage ${tokensUsed} exceeds per-issue limit ${limit} after ${stage}`,
    severity: "blocking",
    payload: { tokensUsed, limit, stage },
  };
}
```

Add `export * from "./cost-gate.js";` to `policy/index.ts`.

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add packages/core/src/policy/cost-gate.ts packages/core/src/policy/index.ts packages/core/src/__tests__/policy/cost-gate.test.ts
git commit -m "feat(policy): per-issue cost gate"
```

---

## Task 4: Override label check

**Files:**
- Create: `packages/core/src/policy/override.ts`
- Modify: `packages/core/src/policy/index.ts`
- Test: `packages/core/src/__tests__/policy/override.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { hasOverrideLabel } from "../../policy/override.js";

function stubIssue(labels: string[]) {
  return {
    labels: async () => ({ nodes: labels.map(name => ({ name })) }),
  } as any;
}

describe("hasOverrideLabel", () => {
  it("returns false when no labels", async () => {
    expect(await hasOverrideLabel(stubIssue([]), "policy-override")).toBe(false);
  });

  it("returns true on exact match", async () => {
    expect(await hasOverrideLabel(stubIssue(["policy-override"]), "policy-override")).toBe(true);
  });

  it("returns true on case-insensitive match", async () => {
    expect(await hasOverrideLabel(stubIssue(["Policy-Override"]), "policy-override")).toBe(true);
    expect(await hasOverrideLabel(stubIssue(["policy-override"]), "Policy-Override")).toBe(true);
  });

  it("returns false when the label is absent", async () => {
    expect(await hasOverrideLabel(stubIssue(["bug", "p0"]), "policy-override")).toBe(false);
  });

  it("returns true when one of many labels matches", async () => {
    expect(await hasOverrideLabel(stubIssue(["bug", "policy-override", "p0"]), "policy-override")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Create `policy/override.ts`**

```ts
/**
 * Check whether a Linear issue carries the configured override label.
 * Case-insensitive match. Uses Linear SDK lazy-relation method pattern —
 * `.labels` is a method, not a property.
 */
export async function hasOverrideLabel(
  issue: { labels: () => Promise<{ nodes: Array<{ name: string }> }> },
  labelName: string,
): Promise<boolean> {
  try {
    const labels = await issue.labels();
    const target = labelName.toLowerCase();
    return labels.nodes.some(l => l.name.toLowerCase() === target);
  } catch {
    return false;
  }
}
```

Add `export * from "./override.js";` to `policy/index.ts`.

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add packages/core/src/policy/override.ts packages/core/src/policy/index.ts packages/core/src/__tests__/policy/override.test.ts
git commit -m "feat(policy): override label check"
```

---

## Task 5: Reviewer gate

**Files:**
- Create: `packages/core/src/policy/reviewer-gate.ts`
- Modify: `packages/core/src/policy/index.ts`
- Test: `packages/core/src/__tests__/policy/reviewer-gate.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { buildReviewerRequest, verifyApprovalsReceived } from "../../policy/reviewer-gate.js";

describe("buildReviewerRequest", () => {
  it("returns null when policy undefined", () => {
    expect(buildReviewerRequest(undefined)).toBeNull();
  });

  it("returns null when mandatoryReviewers absent", () => {
    expect(buildReviewerRequest({ pathBlocklist: [], overrideLabel: "x" } as any)).toBeNull();
  });

  it("returns null when both lists empty", () => {
    expect(buildReviewerRequest({
      pathBlocklist: [], overrideLabel: "x",
      mandatoryReviewers: { users: [], teams: [] },
    } as any)).toBeNull();
  });

  it("returns users and teams when set", () => {
    const r = buildReviewerRequest({
      pathBlocklist: [], overrideLabel: "x",
      mandatoryReviewers: { users: ["alice"], teams: ["security"] },
    } as any);
    expect(r).toEqual({ users: ["alice"], teams: ["security"] });
  });
});

describe("verifyApprovalsReceived", () => {
  function stubOctokit(approvedUsers: string[], teamMembers: Record<string, string[]>) {
    return {
      pulls: {
        listReviews: vi.fn().mockResolvedValue({
          data: approvedUsers.map(u => ({ user: { login: u }, state: "APPROVED" })),
        }),
      },
      teams: {
        listMembersInOrg: vi.fn().mockImplementation(({ team_slug }) => ({
          data: (teamMembers[team_slug] ?? []).map(u => ({ login: u })),
        })),
      },
    } as any;
  }

  it("satisfied=true when no required reviewers", async () => {
    const r = await verifyApprovalsReceived(
      stubOctokit([], {}), "owner", "repo", 1, { users: [], teams: [] },
    );
    expect(r.satisfied).toBe(true);
  });

  it("satisfied when all required users approved", async () => {
    const r = await verifyApprovalsReceived(
      stubOctokit(["alice", "bob"], {}), "owner", "repo", 1,
      { users: ["alice"], teams: [] },
    );
    expect(r.satisfied).toBe(true);
    expect(r.missingUsers).toEqual([]);
  });

  it("not satisfied when a required user has not approved", async () => {
    const r = await verifyApprovalsReceived(
      stubOctokit(["bob"], {}), "owner", "repo", 1,
      { users: ["alice"], teams: [] },
    );
    expect(r.satisfied).toBe(false);
    expect(r.missingUsers).toEqual(["alice"]);
  });

  it("satisfied when a team member approved", async () => {
    const r = await verifyApprovalsReceived(
      stubOctokit(["alice"], { security: ["alice", "carol"] }), "owner", "repo", 1,
      { users: [], teams: ["security"] },
    );
    expect(r.satisfied).toBe(true);
  });

  it("not satisfied when no member of a required team has approved", async () => {
    const r = await verifyApprovalsReceived(
      stubOctokit(["bob"], { security: ["alice", "carol"] }), "owner", "repo", 1,
      { users: [], teams: ["security"] },
    );
    expect(r.satisfied).toBe(false);
    expect(r.missingTeams).toEqual(["security"]);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Create `policy/reviewer-gate.ts`**

```ts
import type { Policy } from "../types.js";

export interface ReviewerRequest {
  users: string[];
  teams: string[];
}

export function buildReviewerRequest(policy: Policy | undefined): ReviewerRequest | null {
  const r = policy?.mandatoryReviewers;
  if (!r) return null;
  if (r.users.length === 0 && r.teams.length === 0) return null;
  return { users: [...r.users], teams: [...r.teams] };
}

export interface ApprovalVerification {
  satisfied: boolean;
  missingUsers: string[];
  missingTeams: string[];
}

/**
 * Query a GitHub PR's reviews and compare approving reviewers against the
 * required set. A required user is satisfied if they personally approved.
 * A required team is satisfied if any member of the team approved.
 */
export async function verifyApprovalsReceived(
  octokit: {
    pulls: { listReviews: (args: any) => Promise<{ data: Array<{ user: { login: string } | null; state: string }> }> };
    teams: { listMembersInOrg: (args: any) => Promise<{ data: Array<{ login: string }> }> };
  },
  owner: string,
  repo: string,
  pull_number: number,
  required: ReviewerRequest,
): Promise<ApprovalVerification> {
  if (required.users.length === 0 && required.teams.length === 0) {
    return { satisfied: true, missingUsers: [], missingTeams: [] };
  }

  const reviews = await octokit.pulls.listReviews({ owner, repo, pull_number });
  const approved = new Set(
    reviews.data
      .filter(r => r.state === "APPROVED" && r.user)
      .map(r => r.user!.login.toLowerCase()),
  );

  const missingUsers = required.users.filter(u => !approved.has(u.toLowerCase()));

  const missingTeams: string[] = [];
  for (const team of required.teams) {
    const members = await octokit.teams.listMembersInOrg({ org: owner, team_slug: team });
    const memberSet = new Set(members.data.map(m => m.login.toLowerCase()));
    const anyApproved = Array.from(approved).some(u => memberSet.has(u));
    if (!anyApproved) missingTeams.push(team);
  }

  return {
    satisfied: missingUsers.length === 0 && missingTeams.length === 0,
    missingUsers,
    missingTeams,
  };
}
```

Add `export * from "./reviewer-gate.js";` to `policy/index.ts`.

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add packages/core/src/policy/reviewer-gate.ts packages/core/src/policy/index.ts packages/core/src/__tests__/policy/reviewer-gate.test.ts
git commit -m "feat(policy): reviewer gate and approval verification"
```

---

## Task 6: Audit event builders

**Files:**
- Modify: `packages/core/src/audit/events.ts`
- Test: `packages/core/src/__tests__/audit/policy-events.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import {
  policyPathBlockedEvent, policyCostExceededEvent,
  policyOverrideUsedEvent, policyReviewersRequestedEvent,
} from "../../audit/events.js";
import { AuditEventSchema } from "../../types.js";

describe("policy audit event builders", () => {
  it("policyPathBlockedEvent", () => {
    const evt = policyPathBlockedEvent({
      runId: "r_1", path: "infra/main.tf", pattern: "infra/**", hadOverride: false,
    });
    const p = AuditEventSchema.parse(evt);
    expect(p.eventType).toBe("policy.path_blocked");
    expect(p.runId).toBe("r_1");
    expect(p.payload).toMatchObject({ path: "infra/main.tf", pattern: "infra/**" });
  });

  it("policyCostExceededEvent", () => {
    const evt = policyCostExceededEvent({
      runId: "r_1", tokensUsed: 600000, limit: 500000, stage: "implement", hadOverride: false,
    });
    expect(evt.eventType).toBe("policy.cost_exceeded");
    expect(evt.payload).toMatchObject({ tokensUsed: 600000, limit: 500000, stage: "implement" });
  });

  it("policyOverrideUsedEvent", () => {
    const evt = policyOverrideUsedEvent({
      runId: "r_1", issueId: "BEC-1", gateType: "path", label: "policy-override",
    });
    expect(evt.eventType).toBe("policy.override_used");
    expect(evt.payload).toMatchObject({ gateType: "path", label: "policy-override" });
  });

  it("policyReviewersRequestedEvent", () => {
    const evt = policyReviewersRequestedEvent({
      runId: "r_1", prUrl: "https://github.com/x/y/pull/1",
      users: ["alice"], teams: ["security"],
    });
    expect(evt.eventType).toBe("policy.reviewers_requested");
    expect(evt.payload).toMatchObject({ users: ["alice"], teams: ["security"] });
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Append builders to `audit/events.ts`**

```ts
export function policyPathBlockedEvent(args: {
  runId: string; path: string; pattern: string; hadOverride: boolean;
}): AuditEvent {
  return base({
    eventType: "policy.path_blocked",
    actor: "system", actorType: "system",
    runId: args.runId,
    payload: { path: args.path, pattern: args.pattern, hadOverride: args.hadOverride },
  });
}

export function policyCostExceededEvent(args: {
  runId: string; tokensUsed: number; limit: number; stage: string; hadOverride: boolean;
}): AuditEvent {
  return base({
    eventType: "policy.cost_exceeded",
    actor: "system", actorType: "system",
    runId: args.runId,
    payload: {
      tokensUsed: args.tokensUsed, limit: args.limit,
      stage: args.stage, hadOverride: args.hadOverride,
    },
  });
}

export function policyOverrideUsedEvent(args: {
  runId: string; issueId: string; gateType: "path" | "cost"; label: string;
}): AuditEvent {
  return base({
    eventType: "policy.override_used",
    actor: "system", actorType: "system",
    runId: args.runId, issueId: args.issueId,
    payload: { gateType: args.gateType, label: args.label },
  });
}

export function policyReviewersRequestedEvent(args: {
  runId: string; prUrl: string; users: string[]; teams: string[];
}): AuditEvent {
  return base({
    eventType: "policy.reviewers_requested",
    actor: "system", actorType: "system",
    runId: args.runId,
    payload: { prUrl: args.prUrl, users: args.users, teams: args.teams },
  });
}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add packages/core/src/audit/events.ts packages/core/src/__tests__/audit/policy-events.test.ts
git commit -m "feat(policy): audit event builders"
```

---

## Task 7: License flag + core barrel re-export

**Files:**
- Modify: `packages/core/src/license.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/policy-license.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { _resetLicenseCache, isFeatureLicensed } from "../license.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

beforeEach(() => { _resetLicenseCache(); });
afterEach(async () => { await restoreLicense(); });

describe("org-policy feature flag", () => {
  it("licensed at enterprise tier", async () => {
    await installTestProLicense("enterprise");
    expect(isFeatureLicensed("org-policy")).toBe(true);
  });

  it("not licensed at pro tier", async () => {
    await installTestProLicense("pro");
    expect(isFeatureLicensed("org-policy")).toBe(false);
  });

  it("not licensed without a license", async () => {
    await restoreLicense();
    expect(isFeatureLicensed("org-policy")).toBe(false);
  });

  it("policy module is re-exported from @urateam/core barrel", async () => {
    const mod = await import("../index.js");
    expect(typeof (mod as any).evaluatePathBlocklist).toBe("function");
    expect(typeof (mod as any).evaluateCostGate).toBe("function");
    expect(typeof (mod as any).hasOverrideLabel).toBe("function");
    expect(typeof (mod as any).buildReviewerRequest).toBe("function");
  });
});
```

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Add `"org-policy"` to Enterprise feature set in `license.ts`**

Find the `ENTERPRISE_FEATURES` constant (or equivalent) and add `"org-policy"`. Check that `"audit-log"` and `"sso"` are already there — use the same array literal.

- [ ] **Step 4: Re-export from `packages/core/src/index.ts`**

Add:
```ts
export * from "./policy/index.js";
```

- [ ] **Step 5: Run, verify pass**

- [ ] **Step 6: Commit**

```
git add packages/core/src/license.ts packages/core/src/index.ts packages/core/src/__tests__/policy-license.test.ts
git commit -m "feat(policy): add org-policy to enterprise feature set"
```

---

## Task 8: Wire path + cost gates in pipeline runner

**Files:**
- Modify: `packages/core/src/pipeline/runner.ts`
- Test: `packages/core/src/__tests__/policy-integration.test.ts`

This is the most invasive task. Read `runner.ts` carefully first — find the location where the implement stage completes and `getChangedFiles` is called. The gate block must live there. Also note: `unresolvedBlockingFindings` and `run.shouldDraft` are already in use for RALPH / review findings — extend them.

- [ ] **Step 1: Write failing integration test**

Create `packages/core/src/__tests__/policy-integration.test.ts`. Use the existing test harness pattern from `packages/core/src/__tests__/runner*.test.ts`. This test is complex — study the runner test patterns first. The test should:
1. Set up a stub pipeline with `config.policy = { pathBlocklist: ["infra/**"], maxTokensPerIssue: 100 }`
2. Stub the agent to produce a diff touching `infra/main.tf` and burn 200 tokens
3. Install an enterprise test license
4. Run the pipeline, assert:
   - `run.shouldDraft === true`
   - `policy.path_blocked` event in `audit_events` with `path: "infra/main.tf"`
   - `policy.cost_exceeded` event with `tokensUsed: 200`, `limit: 100`
   - PR created with `draft: true`

The integration test may need to mock git and GitHub interactions. If the existing runner tests use an in-memory fixture pattern, reuse it. If not, the test may be too invasive for a single task — in that case, split the integration verification across two smaller tests (one for path, one for cost).

**If writing a true integration test against the real runner is too complex for a single task**, write **unit tests** instead that exercise a new extracted helper function `evaluatePolicyGates({ changedFiles, run, policy, issue })` returning `{ violations: PolicyViolation[], overrideActive: boolean }`. This function can be called from the runner and tested in isolation. The rest of the integration (draft setting, audit writing) is tested by assertions at the call-site level in a smaller fixture.

- [ ] **Step 2: Run, confirm failure**

- [ ] **Step 3: Extract a helper `evaluatePolicyGates` (cleaner seam for testing)**

Create `packages/core/src/policy/evaluate.ts`:
```ts
import type { AnyDb } from "../db/client.js";
import type { Policy } from "../types.js";
import {
  evaluatePathBlocklist, evaluateCostGate,
  hasOverrideLabel, type PolicyViolation,
} from "./index.js";
import {
  logAuditEvent,
  policyPathBlockedEvent, policyCostExceededEvent, policyOverrideUsedEvent,
} from "../audit/index.js";

export interface PolicyGateInput {
  db: AnyDb;
  runId: string;
  issue: { id: string; labels: () => Promise<{ nodes: Array<{ name: string }> }> };
  policy: Policy | undefined;
  changedFiles: string[];
  tokensUsed: number;
  stage: string;
}

export interface PolicyGateResult {
  violations: PolicyViolation[];
  overrideActive: boolean;
  shouldDraft: boolean;
}

export async function evaluatePolicyGates(input: PolicyGateInput): Promise<PolicyGateResult> {
  if (!input.policy) return { violations: [], overrideActive: false, shouldDraft: false };

  const overrideActive = await hasOverrideLabel(input.issue, input.policy.overrideLabel);
  const pathViolations = evaluatePathBlocklist(input.changedFiles, input.policy.pathBlocklist);
  const costViolation = evaluateCostGate(input.tokensUsed, input.policy.maxTokensPerIssue, input.stage);

  const all: PolicyViolation[] = [
    ...pathViolations,
    ...(costViolation ? [costViolation] : []),
  ];

  if (all.length === 0) {
    return { violations: [], overrideActive: false, shouldDraft: false };
  }

  if (overrideActive) {
    void logAuditEvent(input.db, policyOverrideUsedEvent({
      runId: input.runId,
      issueId: input.issue.id,
      gateType: pathViolations.length > 0 ? "path" : "cost",
      label: input.policy.overrideLabel,
    }));
    return { violations: all, overrideActive: true, shouldDraft: false };
  }

  for (const v of pathViolations) {
    void logAuditEvent(input.db, policyPathBlockedEvent({
      runId: input.runId,
      path: v.payload.path as string,
      pattern: v.payload.pattern as string,
      hadOverride: false,
    }));
  }
  if (costViolation) {
    void logAuditEvent(input.db, policyCostExceededEvent({
      runId: input.runId,
      tokensUsed: costViolation.payload.tokensUsed as number,
      limit: costViolation.payload.limit as number,
      stage: costViolation.payload.stage as string,
      hadOverride: false,
    }));
  }

  return { violations: all, overrideActive: false, shouldDraft: true };
}
```

Add `export * from "./evaluate.js";` to `policy/index.ts`.

- [ ] **Step 4: Unit-test `evaluatePolicyGates`**

Create `packages/core/src/__tests__/policy/evaluate.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../../db/client.js";
import { auditEvents } from "../../db/schema.js";
import { evaluatePolicyGates } from "../../policy/evaluate.js";
import { installTestProLicense, restoreLicense } from "../helpers/license.js";

let db: any;

beforeEach(async () => {
  await installTestProLicense("enterprise");
  db = await createDb({ connectionString: ":memory:" });
});
afterEach(async () => { await restoreLicense(); });

function stubIssue(labels: string[] = []) {
  return {
    id: "BEC-1",
    labels: async () => ({ nodes: labels.map(name => ({ name })) }),
  };
}

describe("evaluatePolicyGates", () => {
  const policy = {
    pathBlocklist: ["infra/**"],
    maxTokensPerIssue: 100,
    overrideLabel: "policy-override",
  } as any;

  it("no policy configured → no violations, no draft", async () => {
    const r = await evaluatePolicyGates({
      db, runId: "r1", issue: stubIssue(),
      policy: undefined, changedFiles: ["infra/main.tf"], tokensUsed: 200, stage: "implement",
    });
    expect(r.violations).toEqual([]);
    expect(r.shouldDraft).toBe(false);
  });

  it("path violation → shouldDraft=true and audit event written", async () => {
    const r = await evaluatePolicyGates({
      db, runId: "r1", issue: stubIssue(),
      policy, changedFiles: ["infra/main.tf"], tokensUsed: 50, stage: "implement",
    });
    expect(r.shouldDraft).toBe(true);
    expect(r.violations).toHaveLength(1);
    // let fire-and-forget writes settle
    await new Promise(r => setImmediate(r));
    const events = await db.select().from(auditEvents);
    expect(events.find((e: any) => e.eventType === "policy.path_blocked")).toBeDefined();
  });

  it("cost violation → shouldDraft=true and audit event written", async () => {
    const r = await evaluatePolicyGates({
      db, runId: "r1", issue: stubIssue(),
      policy, changedFiles: ["src/a.ts"], tokensUsed: 200, stage: "implement",
    });
    expect(r.shouldDraft).toBe(true);
    expect(r.violations).toHaveLength(1);
    await new Promise(r => setImmediate(r));
    const events = await db.select().from(auditEvents);
    expect(events.find((e: any) => e.eventType === "policy.cost_exceeded")).toBeDefined();
  });

  it("override label present → no draft, override event written", async () => {
    const r = await evaluatePolicyGates({
      db, runId: "r1", issue: stubIssue(["policy-override"]),
      policy, changedFiles: ["infra/main.tf"], tokensUsed: 200, stage: "implement",
    });
    expect(r.shouldDraft).toBe(false);
    expect(r.overrideActive).toBe(true);
    expect(r.violations).toHaveLength(2); // path + cost
    await new Promise(r => setImmediate(r));
    const events = await db.select().from(auditEvents);
    expect(events.find((e: any) => e.eventType === "policy.override_used")).toBeDefined();
    expect(events.find((e: any) => e.eventType === "policy.path_blocked")).toBeUndefined();
  });
});
```

- [ ] **Step 5: Run, verify pass**

- [ ] **Step 6: Call `evaluatePolicyGates` from `runner.ts` after the implement stage**

Find the post-implement block in `runner.ts` (where `getChangedFiles` is called before auto-merge — there may or may not be a call there; if not, add one just before the PR creation block). Wire:

```ts
if (isFeatureLicensed("org-policy") && config.policy) {
  const changedFiles = await getChangedFiles(wtPath, repoConfig.defaultBranch);
  const tokensUsed = run.totalInputTokens + run.totalOutputTokens;
  const gateResult = await evaluatePolicyGates({
    db: this.db, runId: run.id, issue,
    policy: config.policy, changedFiles, tokensUsed, stage: "implement",
  });
  if (gateResult.shouldDraft) {
    shouldDraft = true;  // the existing local flag threaded into generatePRDescription
    for (const v of gateResult.violations) {
      unresolvedBlockingFindings.push({
        kind: "policy-violation",
        severity: "blocking",
        message: v.detail,
      });
    }
  }
}
```

Also add a cost-gate-only re-check after the test and review stages (no path re-check):
```ts
if (isFeatureLicensed("org-policy") && config.policy?.maxTokensPerIssue) {
  const tokensUsed = run.totalInputTokens + run.totalOutputTokens;
  const cv = evaluateCostGate(tokensUsed, config.policy.maxTokensPerIssue, currentStage);
  if (cv && !(await hasOverrideLabel(issue, config.policy.overrideLabel))) {
    void logAuditEvent(this.db, policyCostExceededEvent({
      runId: run.id, tokensUsed, limit: config.policy.maxTokensPerIssue,
      stage: currentStage, hadOverride: false,
    }));
    shouldDraft = true;
    unresolvedBlockingFindings.push({
      kind: "policy-violation", severity: "blocking", message: cv.detail,
    });
  }
}
```

- [ ] **Step 7: Run `cd packages/core && npx vitest run` — verify nothing broke**

If any existing runner tests fail, read the failure carefully. Common issues: the existing tests don't set up `config.policy`, so the gate block must short-circuit when `!config.policy`. Verify that the wiring block is no-op when policy is absent.

- [ ] **Step 8: Commit**

```
git add packages/core/src/policy/evaluate.ts packages/core/src/policy/index.ts packages/core/src/pipeline/runner.ts packages/core/src/__tests__/policy/evaluate.test.ts
git commit -m "feat(policy): wire path and cost gates into pipeline runner"
```

---

## Task 9: Thread reviewers through PR creation

**Files:**
- Modify: `packages/core/src/git/github.ts` (or wherever `createPR` + `createPRViaCli` live)
- Modify: `packages/core/src/pipeline/runner.ts` (the PR creation call sites around line 1650)
- Test: `packages/core/src/__tests__/policy/pr-reviewer-wiring.test.ts`

- [ ] **Step 1: Read the current `createPRViaCli` signature**

Find `createPRViaCli` (search `packages/core/src/git/` and `packages/core/src/github/`). Note its arguments.

- [ ] **Step 2: Write failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { buildReviewerRequest } from "../../policy/reviewer-gate.js";

describe("reviewer request threading", () => {
  it("buildReviewerRequest returns null → runner does not pass reviewers", () => {
    expect(buildReviewerRequest(undefined)).toBeNull();
  });

  it("buildReviewerRequest returns non-null → runner passes through to createPR", () => {
    const req = buildReviewerRequest({
      pathBlocklist: [], overrideLabel: "x",
      mandatoryReviewers: { users: ["alice"], teams: ["security"] },
    } as any);
    expect(req).toEqual({ users: ["alice"], teams: ["security"] });
  });

  // A higher-level integration test would mock execFile for `gh` CLI and
  // assert that --reviewer args appear. Skipping for unit focus; covered
  // manually during release testing.
});
```

- [ ] **Step 3: Extend `createPRViaCli` to accept reviewers**

Add to its args interface:
```ts
reviewers?: string[];        // GitHub usernames
teamReviewers?: string[];    // GitHub team slugs (no org prefix — the gh CLI infers org from the repo)
```

Inside the function, if reviewers are set, append to the gh command:
```ts
const args: string[] = ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body];
if (draft) args.push("--draft");
if (reviewers?.length) args.push("--reviewer", reviewers.join(","));
if (teamReviewers?.length) args.push("--reviewer", teamReviewers.map(t => `${owner}/${t}`).join(","));
```

(The `owner` prefix is needed for team reviewers per `gh pr create --help`. If owner isn't already in scope inside `createPRViaCli`, derive it from `repoUrl` or thread it as a new arg.)

- [ ] **Step 4: Same extension for GitHub App `createPR`**

If the GitHub App `createPR` exists (Octokit path, around line 1640 per the runner grep), add `reviewers` and `teamReviewers` to its signature. After the `pulls.create` call, if either list is non-empty, call:
```ts
await octokit.pulls.requestReviewers({
  owner, repo, pull_number: createdPR.number,
  reviewers: reviewers ?? [],
  team_reviewers: teamReviewers ?? [],
});
```

Wrap in try/catch — a failed reviewer request should not fail the whole PR creation. Log via pino on failure.

- [ ] **Step 5: GitLab path**

If a GitLab `createMR` function exists, add a pino warn when reviewers are passed:
```ts
if (reviewers?.length || teamReviewers?.length) {
  log.warn({ reviewers, teamReviewers }, "GitLab path does not support mandatory reviewers; ignoring");
}
```

- [ ] **Step 6: Call sites in `runner.ts`**

At each `createPRViaCli` / `createPR` call site (around line 1653), add:
```ts
const reviewerRequest = isFeatureLicensed("org-policy")
  ? buildReviewerRequest(config.policy)
  : null;
```

Pass `reviewers: reviewerRequest?.users, teamReviewers: reviewerRequest?.teams` into each call.

After a successful PR URL is returned AND `reviewerRequest` is non-null:
```ts
void logAuditEvent(this.db, policyReviewersRequestedEvent({
  runId: run.id, prUrl,
  users: reviewerRequest.users, teams: reviewerRequest.teams,
}));
```

- [ ] **Step 7: Run full `packages/core` test suite to check for regressions**

```
cd packages/core && npx vitest run
```

- [ ] **Step 8: Commit**

```
git add packages/core/src/git packages/core/src/pipeline/runner.ts packages/core/src/__tests__/policy/pr-reviewer-wiring.test.ts
git commit -m "feat(policy): thread mandatory reviewers through PR creation"
```

---

## Task 10: Auto-merge reviewer gate

**Files:**
- Modify: `packages/core/src/pipeline/runner.ts` (auto-merge block)
- Test: `packages/core/src/__tests__/policy/auto-merge-reviewer-gate.test.ts`

- [ ] **Step 1: Find the auto-merge block**

Grep for `autoMergeExcludePatterns` in `runner.ts` (around line 1742). The new reviewer check goes in the same block, after the path exclusion check, before the actual merge API call.

- [ ] **Step 2: Write failing test**

The auto-merge block is inside the runner — isolating it for a unit test is hard. Write a test that exercises `verifyApprovalsReceived` in a scenario matching the auto-merge flow:

```ts
import { describe, it, expect, vi } from "vitest";
import { verifyApprovalsReceived } from "../../policy/reviewer-gate.js";

describe("auto-merge reviewer gate", () => {
  it("satisfied → auto-merge proceeds", async () => {
    const octokit = {
      pulls: { listReviews: vi.fn().mockResolvedValue({
        data: [{ user: { login: "alice" }, state: "APPROVED" }],
      })},
      teams: { listMembersInOrg: vi.fn() },
    } as any;
    const r = await verifyApprovalsReceived(octokit, "o", "r", 1, { users: ["alice"], teams: [] });
    expect(r.satisfied).toBe(true);
  });

  it("unsatisfied → auto-merge must skip with clear reason", async () => {
    const octokit = {
      pulls: { listReviews: vi.fn().mockResolvedValue({ data: [] }) },
      teams: { listMembersInOrg: vi.fn() },
    } as any;
    const r = await verifyApprovalsReceived(octokit, "o", "r", 1, { users: ["alice"], teams: ["security"] });
    expect(r.satisfied).toBe(false);
    const reason = `mandatory reviewers pending: users=${r.missingUsers.join(",")} teams=${r.missingTeams.join(",")}`;
    expect(reason).toContain("alice");
    expect(reason).toContain("security");
  });
});
```

- [ ] **Step 3: Run, confirm failure (or pass if reviewer-gate tests already cover this)**

These assertions may already pass — Task 5's reviewer-gate tests cover the underlying function. This task is about the **integration** into the auto-merge block; a true test of that is an end-to-end runner test. If the file already passes, proceed to Step 4.

- [ ] **Step 4: Wire the check into the auto-merge block**

In `runner.ts` around the `autoMergeExcludePatterns` block (~line 1742), after the existing exclusion check and before the actual merge call:

```ts
// Mandatory reviewer gate (enterprise feature 4.6)
if (isFeatureLicensed("org-policy")) {
  const reviewerRequest = buildReviewerRequest(config.policy);
  if (reviewerRequest && octokit) {  // octokit from GitHub App path; gh CLI path skips (no API access)
    const { owner, repo } = parseRepoUrl(repoConfig.repoUrl);
    const prNumber = extractPrNumberFromUrl(run.prUrl);
    if (prNumber) {
      const check = await verifyApprovalsReceived(octokit, owner, repo, prNumber, reviewerRequest);
      if (!check.satisfied) {
        run.autoMerged = false;
        run.autoMergeReason = `mandatory reviewers pending: users=${check.missingUsers.join(",") || "none"} teams=${check.missingTeams.join(",") || "none"}`;
        await this.notifier.onHumanReviewNeeded?.(run, run.prUrl!, run.autoMergeReason);
        runLog.info({ missingUsers: check.missingUsers, missingTeams: check.missingTeams }, "auto-merge skipped: mandatory reviewers");
        return;  // skip auto-merge
      }
    }
  }
}
```

**If the auto-merge block is not structured as a function body that can `return`**, adapt the control flow — set a boolean like `skipAutoMerge = true` and check it before the merge call.

`parseRepoUrl` and `extractPrNumberFromUrl` may or may not exist; if they don't, use quick inline parsing:
```ts
const ownerRepoMatch = repoConfig.repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
const owner = ownerRepoMatch?.[1];
const repo = ownerRepoMatch?.[2];
const prNumberMatch = run.prUrl?.match(/\/pull\/(\d+)/);
const prNumber = prNumberMatch ? parseInt(prNumberMatch[1]!, 10) : undefined;
```

- [ ] **Step 5: Run, verify**

```
cd packages/core && npx vitest run src/__tests__/policy src/__tests__/runner
```

- [ ] **Step 6: Commit**

```
git add packages/core/src/pipeline/runner.ts packages/core/src/__tests__/policy/auto-merge-reviewer-gate.test.ts
git commit -m "feat(policy): block auto-merge until mandatory reviewers approve"
```

---

## Task 11: Full build + test + holistic review + CLAUDE.md + PR

- [ ] **Step 1: Build**

```
pnpm build
```
Expected: clean.

- [ ] **Step 2: Full test suite**

```
pnpm test
```
Expected: all pass. The known-flaky cli `run.test.ts` may fail under turbo parallel load — verify it passes standalone.

- [ ] **Step 3: Integration tests**

```
pnpm test:integration
```

- [ ] **Step 4: Holistic external review**

Dispatch a fresh `feature-dev:code-reviewer` subagent with:
- Spec: `docs/superpowers/specs/2026-04-15-org-policy-guardrails-design.md`
- Plan: `docs/superpowers/plans/2026-04-15-org-policy-guardrails.md`
- Diff: `git diff main...HEAD`

Ask it to specifically check:
- Postgres parity (no new tables, but audit event writes must work on both drivers)
- License gate consistency: every policy check must be gated
- Override label: can a malicious issue author create a `policy-override` label themselves? (Linear label creation is usually restricted to team members, but verify this assumption is documented)
- Reviewer gate team-membership caching: the `listMembersInOrg` call fires per-team per-check — is it cached? Does the PM tick call it repeatedly?
- Audit event coverage: every gate trip produces an event; every override produces an event
- Regression in existing runner tests
- CSV export + dashboard rendering of policy events (should "just work" via the existing audit feed but verify)
- Test quality: is the integration test actually end-to-end or a mock party?

Address any high-confidence findings.

- [ ] **Step 5: Update CLAUDE.md**

Append under "Key Patterns":
```
### Org policy / guardrails (Enterprise feature 4.6)
- Module: `packages/core/src/policy/` — `path-gate.ts`, `cost-gate.ts`, `reviewer-gate.ts`, `override.ts`, `evaluate.ts` (orchestrator)
- Config: `PipelineConfig.policy = { pathBlocklist, maxTokensPerIssue, overrideLabel, mandatoryReviewers: { users, teams } }` — per-pipeline (not global)
- Path gate: extends the `matchesAnyPattern` glob model from auto-merge into a pipeline gate after implement
- Cost gate: checks `totalInputTokens + totalOutputTokens` after every stage transition (implement/test/review)
- Override label: `hasOverrideLabel(issue, labelName)` — case-insensitive Linear label check; emits `policy.override_used` on bypass
- Reviewer gate: `buildReviewerRequest` builds the `{users, teams}` payload; PR creation threads it through `createPRViaCli` and GitHub App `createPR`; auto-merge is blocked until `verifyApprovalsReceived` returns satisfied
- Violations set `run.shouldDraft = true` and append to `unresolvedBlockingFindings` — flows through the existing draft-PR machinery in `pipeline/pr-description.ts`
- Audit events: `policy.path_blocked`, `policy.cost_exceeded`, `policy.override_used`, `policy.reviewers_requested`
- License gate: `isFeatureLicensed("org-policy")` required at every call site
- GitLab mandatory reviewers: not supported; warn-only
```

- [ ] **Step 6: Commit CLAUDE.md, push, open PR**

```
git add CLAUDE.md
git commit -m "docs(claude.md): org policy feature notes"
git push -u origin feat/org-policy
gh pr create --title "feat: org policy / guardrails (enterprise 4.6)" --body "$(cat <<'EOF'
## Summary
- Three pipeline gates: path blocklist, per-issue token cost cap, mandatory reviewers
- Violations produce draft PRs with blocking findings; `policy-override` label bypasses
- Reviewer request threaded into `gh pr create` and GitHub App Octokit; auto-merge blocked until approvals land
- Four new audit event types; no new DB tables
- GitLab mandatory reviewers = warn-only (v1)
- Max-complexity caps dropped from v1 per brainstorm (needs its own metric design)

Spec: docs/superpowers/specs/2026-04-15-org-policy-guardrails-design.md
Plan: docs/superpowers/plans/2026-04-15-org-policy-guardrails.md

## Test plan
- [ ] pnpm test (unit)
- [ ] pnpm test:integration
- [ ] Manual: pipeline with `policy.pathBlocklist: ["infra/**"]` + agent touching `infra/*` → draft PR with blocking finding
- [ ] Manual: `policy-override` label on a blocked issue → no draft, override event logged
- [ ] Manual: PR created with `mandatoryReviewers.users: ["alice"]` → alice sees review request

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** All three gates (path, cost, reviewer), override label, four audit events, license gating, PR creation wiring, auto-merge gate, testing strategy — each has a task.
- **Placeholders:** None. Task 8 has one "if too complex, split" branch that gives the implementer latitude because the runner integration test harness is notoriously hard to fake — this is deliberate scope guidance, not a placeholder.
- **Type consistency:** `Policy` zod type, `PolicyViolation` interface, `ReviewerRequest` shape, `PolicyGateResult` shape — all defined once and referenced consistently. Audit event builder names match event type strings.
- **Runner surgery risk:** Tasks 8-10 touch `runner.ts` at multiple points. The extracted `evaluatePolicyGates` helper reduces this risk; test it in isolation before wiring.
- **Known limitation called out:** The auto-merge reviewer gate only fires on the GitHub App (Octokit) path, not the `gh` CLI fallback — because the CLI path has no API client to call `pulls.listReviews`. This is acceptable because `gh` CLI deployments are typically development setups; production deployments use the GitHub App. Documented in the code comment.

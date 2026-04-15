# Design: Org policy / guardrails (Enterprise feature 4.6)

**Date**: 2026-04-15
**Status**: Draft for review
**Parent strategy**: `docs/superpowers/specs/2026-04-13-enterprise-tier-design.md` § 4.6
**Scope**: Three pipeline guardrails the agent must respect — path blocklists, per-issue cost caps, mandatory reviewers per repo — all configurable per-pipeline, all gated by `isFeatureLicensed("org-policy")`.

---

## 1. Goals and non-goals

### Goals
- Extend the existing `autoMergeExcludePatterns` glob model into a **pipeline gate** (not just an auto-merge gate) so the agent cannot ship changes to blocklisted paths silently.
- Add a per-issue token cost cap so a runaway implementation cannot burn $500 on one ticket.
- Wire mandatory reviewers into PR creation so the customer's security / infra teams see every PR that touches their repos.
- Preserve the agent's actual work on every violation — produce a **draft PR** with the violations as blocking findings rather than throwing away the diff.
- Provide a **label-based override** (`policy-override` by default) so the operator has a documented escape hatch when a gate trips a legitimate change.
- Audit every gate trip and every override via the existing license-gated `logAuditEvent`.

### Non-goals
- **Max-complexity caps**. Dropped during brainstorming — "complexity" needs its own metric design (cyclomatic vs LOC delta vs token count) and the buyer profile cares more about the other three.
- **GitLab mandatory reviewers.** v1 is GitHub-first; GitLab path logs a warn and continues without reviewer assignment.
- **Per-directory policy** (e.g. "require @security on any change under `auth/`"). Can be added later by extending `pathBlocklist` into a richer `pathRules` model.
- **Path-regex rules.** Glob-only for v1, matching the existing `autoMergeExcludePatterns` shape.
- **Automatic override-trail analysis** (e.g. "who overrode which gate, how often"). Relies on manual audit log review for v1.
- **Dashboard view for policy events.** Policy events surface in the existing `/audit` feed automatically via the event type enum; no dedicated view.
- **Pre-flight file extraction from the issue description.** Explored in brainstorming; rejected as unreliable. Post-implement diff gate is the only authoritative check.

## 2. Config shape

New `policy` field on `PipelineConfig` in `packages/core/src/types.ts`:

```ts
policy: z.object({
  pathBlocklist: z.array(z.string()).default([]),
  maxTokensPerIssue: z.number().int().positive().optional(),
  overrideLabel: z.string().default("policy-override"),
  mandatoryReviewers: z.object({
    users: z.array(z.string()).default([]),
    teams: z.array(z.string()).default([]),
  }).optional(),
}).optional()
```

Per-pipeline (not global) so `auto-implement` can be stricter than `quick-fix`. Glob syntax matches `autoMergeExcludePatterns` — reuses `matchesAnyPattern()` from `pipeline/runner.ts`.

## 3. Module layout

New `packages/core/src/policy/`:

```
policy/
  index.ts           — barrel export
  types.ts           — PolicyViolation { gate: "path" | "cost" | "reviewer", detail: string, ... }
  path-gate.ts       — evaluatePathBlocklist(changedFiles, patterns): PolicyViolation[]
  cost-gate.ts       — evaluateCostGate(run, limit, stage): PolicyViolation | null
  reviewer-gate.ts   — buildReviewerRequest(policy): { users, teams } | null
                     — verifyApprovalsReceived(octokit, prNumber, required): Promise<boolean>
  override.ts        — hasOverrideLabel(issue, labelName): Promise<boolean>
```

Each gate is a pure function over minimal inputs — no DB, no network — except `reviewer-gate.verifyApprovalsReceived` (needs an Octokit client, passed in) and `override.hasOverrideLabel` (calls the Linear SDK).

### 3.1 `PolicyViolation` shape

```ts
export interface PolicyViolation {
  gate: "path" | "cost" | "reviewer";
  detail: string;           // human-readable, e.g. "infra/main.tf matches infra/**"
  severity: "blocking";     // always blocking in v1 — no "warning" tier
  payload: Record<string, unknown>;  // structured data for the audit event
}
```

### 3.2 Path gate

```ts
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

One violation per file-pattern pair so the dashboard and draft PR can list each hit separately. `matchesAnyPattern` is imported from `pipeline/runner.ts` (the existing glob matcher used by `autoMergeExcludePatterns`).

### 3.3 Cost gate

```ts
export function evaluateCostGate(
  tokensUsed: number,
  limit: number | undefined,
  stage: string,
): PolicyViolation | null {
  if (!limit || tokensUsed <= limit) return null;
  return {
    gate: "cost",
    detail: `token usage ${tokensUsed} exceeds per-issue limit ${limit} after ${stage}`,
    severity: "blocking",
    payload: { tokensUsed, limit, stage },
  };
}
```

Checked after **every** stage transition (not just implement) because test and review can occasionally balloon on retry loops.

### 3.4 Reviewer gate

```ts
export function buildReviewerRequest(
  policy: Policy | undefined,
): { users: string[]; teams: string[] } | null {
  const r = policy?.mandatoryReviewers;
  if (!r || (r.users.length === 0 && r.teams.length === 0)) return null;
  return { users: r.users, teams: r.teams };
}

export async function verifyApprovalsReceived(
  octokit: Octokit,
  owner: string, repo: string, prNumber: number,
  required: { users: string[]; teams: string[] },
): Promise<{ satisfied: boolean; missingUsers: string[]; missingTeams: string[] }> { … }
```

`verifyApprovalsReceived` queries `pulls.listReviews` and compares approving reviewers against the required set. Team membership check: the Octokit `teams.listMembersInOrg` call is cached per-tick. Returns a structured result rather than a boolean so the auto-merge log line can explain what's missing.

### 3.5 Override

```ts
export async function hasOverrideLabel(
  issue: LinearIssue,
  labelName: string,
): Promise<boolean> {
  const labels = await issue.labels();              // Linear SDK lazy method
  const target = labelName.toLowerCase();
  return labels.nodes.some(l => l.name.toLowerCase() === target);
}
```

Case-insensitive match. Uses the Linear SDK lazy-relation pattern documented in CLAUDE.md (`.labels` is a *method*, not a property).

## 4. Pipeline integration

All changes live in `packages/core/src/pipeline/runner.ts`.

### 4.1 After the implement stage

```ts
// After implement stage completes and the diff is on disk
if (isFeatureLicensed("org-policy") && config.policy) {
  const changedFiles = await getChangedFiles(wtPath, repoConfig.defaultBranch);
  const overrideActive = await hasOverrideLabel(issue, config.policy.overrideLabel);

  const pathViolations = evaluatePathBlocklist(changedFiles, config.policy.pathBlocklist);
  const costViolation = evaluateCostGate(
    run.totalInputTokens + run.totalOutputTokens,
    config.policy.maxTokensPerIssue,
    "implement",
  );

  const allViolations: PolicyViolation[] = [
    ...pathViolations,
    ...(costViolation ? [costViolation] : []),
  ];

  if (allViolations.length > 0) {
    if (overrideActive) {
      void logAuditEvent(db, policyOverrideUsedEvent({
        runId: run.id, issueId: issue.id,
        gateType: pathViolations.length > 0 ? "path" : "cost",
        label: config.policy.overrideLabel,
      }));
      // Continue normally — override bypasses the gate
    } else {
      for (const v of pathViolations) {
        void logAuditEvent(db, policyPathBlockedEvent({
          runId: run.id, ...v.payload, hadOverride: false,
        }));
      }
      if (costViolation) {
        void logAuditEvent(db, policyCostExceededEvent({
          runId: run.id, ...costViolation.payload, hadOverride: false,
        }));
      }
      run.shouldDraft = true;
      unresolvedBlockingFindings.push(...allViolations.map(v => ({
        kind: "policy-violation",
        severity: "blocking",
        message: v.detail,
      })));
      // Continue the pipeline — the review stage still runs; PR opens as draft
    }
  }
}
```

### 4.2 After the test and review stages
Re-run cost gate only (path gate result doesn't change once implement is done). Same override logic. Same draft-PR side effect.

### 4.3 PR creation
```ts
const reviewerRequest = isFeatureLicensed("org-policy")
  ? buildReviewerRequest(config.policy)
  : null;

const prUrl = await createPR({
  …existingArgs,
  reviewers: reviewerRequest?.users ?? [],
  teamReviewers: reviewerRequest?.teams ?? [],
  draft: run.shouldDraft,
});

if (reviewerRequest) {
  void logAuditEvent(db, policyReviewersRequestedEvent({
    runId: run.id, prUrl, users: reviewerRequest.users, teams: reviewerRequest.teams,
  }));
}
```

`createPRViaCli` (`gh` CLI fallback) and GitHub App `createPR` both accept the new `reviewers` / `teamReviewers` params. GitLab path logs a warn and ignores them.

### 4.4 Auto-merge gate

In the existing auto-merge decision block (where `autoMergeExcludePatterns` is already evaluated):

```ts
if (reviewerRequest && reviewerRequest.users.length + reviewerRequest.teams.length > 0) {
  const { satisfied, missingUsers, missingTeams } = await verifyApprovalsReceived(
    octokit, owner, repo, prNumber, reviewerRequest,
  );
  if (!satisfied) {
    run.autoMerged = false;
    run.autoMergeReason = `mandatory reviewers pending: users=${missingUsers.join(",")} teams=${missingTeams.join(",")}`;
    await notifier.onHumanReviewNeeded?.({ run, reason: run.autoMergeReason });
    // skip auto-merge
  }
}
```

No new audit event needed — the existing `run.auto_merge_skipped` projection from feature 4.2 surfaces this automatically.

## 5. Audit events

Four new event types appended to `AuditEventTypeSchema` in `types.ts`:

| Event | Payload |
|---|---|
| `policy.path_blocked` | `{runId, path, pattern, hadOverride: false}` (one per violation) |
| `policy.cost_exceeded` | `{runId, tokensUsed, limit, stage, hadOverride: false}` |
| `policy.override_used` | `{runId, issueId, gateType, label}` |
| `policy.reviewers_requested` | `{runId, prUrl, users, teams}` |

All emitted via the existing license-gated `logAuditEvent`. Builder functions added to `packages/core/src/audit/events.ts`.

## 6. License gating

- `org-policy` added to the Enterprise feature set in `license.ts`
- When `!isFeatureLicensed("org-policy")`, every policy check short-circuits to a no-op — `config.policy` is ignored silently (matches the model used by `audit-log` and `sso`)
- OSS/Pro deployments with `policy` in their config see no behavior change and no warning (if they upgrade later, the config just starts working)

## 7. Testing strategy

### 7.1 Unit (`packages/core/src/__tests__/policy/`)
- `path-gate.test.ts` — exact match, glob match, multiple patterns, no blocklist, empty file list, path not matching, multiple files each matching
- `cost-gate.test.ts` — under limit, at limit (no violation), over limit, no limit configured, zero tokens
- `reviewer-gate.test.ts` — empty policy, users only, teams only, both; `verifyApprovalsReceived` with all approved, some approved, team membership cache
- `override.test.ts` — label present (case-sensitive + insensitive), label absent, empty label set, Linear SDK lazy-method used correctly

### 7.2 Integration (`packages/core/src/__tests__/policy-integration.test.ts`)
- Pipeline run with `pathBlocklist: ["infra/**"]`, agent modifies `infra/main.tf`:
  - Assert `run.shouldDraft === true`
  - Assert `unresolvedBlockingFindings` contains the violation
  - Assert `policy.path_blocked` audit event written
  - Assert PR is created as draft
- Same setup + `policy-override` label on the issue:
  - Assert no draft forced
  - Assert `policy.override_used` audit event written
- Pipeline run with `maxTokensPerIssue: 100`, agent burns 200:
  - Assert draft + `policy.cost_exceeded` event
- PR creation with `mandatoryReviewers: { users: ["alice"], teams: ["security"] }`:
  - Assert `createPR` called with those reviewers
  - Assert `policy.reviewers_requested` event written
- Auto-merge block with mandatory reviewers not yet approved:
  - Assert auto-merge skipped
  - Assert `autoMergeReason` contains "mandatory reviewers pending"

### 7.3 License gating
- `packages/core/src/__tests__/policy-license.test.ts` — verify all four gates are no-ops when `isFeatureLicensed("org-policy") === false`

## 8. Migration and rollout

### 8.1 Schema
None. All new tables would duplicate what `pipeline_runs` + `audit_events` already provide. Policy state lives in config; violations live in audit events.

### 8.2 License flag
- `org-policy` added to `ENTERPRISE_FEATURES` in `license.ts`
- OSS / Pro deployments unchanged

### 8.3 Backward compatibility
- Every change is additive — `config.policy` is optional
- Existing pipelines without a `policy` block behave identically
- `autoMergeExcludePatterns` remains supported (not replaced) — a customer can use both

## 9. Open questions (deferred)

- **Max-complexity caps:** needs its own metric design. Revisit when a customer asks for it.
- **Dashboard view for policy events:** `/audit` filter by `policy.*` event type works today; no dedicated view until operators ask for one.
- **Severity tiers for violations:** v1 is blocking-only. A future `warning` tier could allow non-blocking violations that append to the draft body but don't force-draft.
- **GitLab mandatory reviewers:** MR-level approvals exist on GitLab but the API is different and the deployment surface is second-class. Defer.
- **`policy.file_modified` audit event for allowlisted files on a blocked run:** an auditor might want to see "agent DID modify these allowlisted files on the same run that was blocked." Out of scope for v1; `unresolvedBlockingFindings` on the draft PR body carries the violation list.

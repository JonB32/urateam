# urateam — Deployment Guide

This directory contains deployment helpers and configuration guides for urateam.

## Contents

| File | Purpose |
|------|---------|
| `CLAUDE_AUTH.md` | Claude authentication options (API key, OAuth token, local session) |
| `GH_LINEAR_SYNC_SETUP.md` | GitHub Issues → Linear sync setup |
| `RBAC_SETUP.md` | Role-based access control setup |
| `SSO_SETUP.md` | WorkOS SSO setup |

---

## Deep-Review Loop: Turn Limits, Convergence, and Diagnostics

The deep-review feature (Enterprise `"deep-review"` license) runs 3 parallel
sub-agents (reuse, quality, efficiency) after the main review-fix loop to
harden code quality. It is controlled by two pipeline config fields:

```yaml
# urateam.config.ts
pipelines:
  my-pipeline:
    deepReviewPasses: 2        # passes to attempt (0 = disabled, default)
    maxDeepReviewPasses: 3     # hard cap, prevents runaway passes (default: 3)
```

### How Each Pass Works

```
[review providers run]
       ↓
[convergence check]  ← exits early if resolved or stuck
       ↓ (if not converged)
[implement stage re-run with findings as context]
       ↓
[review stage re-run to verify fixes]
       ↓
(repeat up to passLimit times)
```

### Convergence Criteria

The loop exits early (before `passLimit`) when any of the following holds:

| Reason | Description |
|--------|-------------|
| `zero-findings` | No findings remain — full convergence. |
| `non-decreasing` | Finding count did not drop from the previous pass (covers both oscillating and stuck-on-contradictory-requirements cases; check `findingsDiff` to distinguish). |

When neither fires and the loop runs to `passLimit`, the reason is:

| Reason | Description |
|--------|-------------|
| `pass-limit` | Findings kept decreasing but the limit was reached with findings remaining. |

### Convergence Detection Details

Convergence uses **fingerprint-based comparison** (not just finding counts).
Each finding is fingerprinted from its `file:line:category:description-prefix`.

This catches two patterns that count-only detection misses:

1. **Oscillating findings**: count stays the same but different issues appear
   each pass — the loop stops via `non-decreasing`; the operator can inspect
   `findingsDiff.added` in the log to diagnose which new issues appeared.

2. **Stuck on contradictory requirements**: count stays the same and the same
   fingerprints repeat — also caught by `non-decreasing`; `findingsDiff.common`
   shows the persistent findings so the operator can relax their severity or
   file a separate issue.

### Diagnostic Logs

When the loop **converges early** (reason ≠ `pass-limit`):

```json
{
  "level": "info",
  "drPass": 2,
  "findingsCount": 3,
  "previousFindingsCount": 3,
  "reason": "non-decreasing",
  "findingsDiff": { "added": [], "removed": [], "common": ["src/foo.ts:12:n-plus-1:..."] },
  "msg": "deep review: convergence check stopped loop"
}
```

When the loop **hits the pass limit** without converging (BEC-212 fix):

```json
{
  "level": "warn",
  "diagnostic": {
    "passLimit": 3,
    "finalPass": 3,
    "finalFindingsCount": 2,
    "reason": "pass-limit",
    "findingsDiff": {
      "added": [],
      "removed": ["src/foo.ts:10:duplicate-logic:Filter logic..."],
      "common": ["src/bar.ts:25:n-plus-1:Sequential awaits..."]
    },
    "diffStat": " src/bar.ts | 5 +++--\n 1 file changed, 3 insertions(+), 2 deletions(-)"
  },
  "runId": "abc123",
  "passLimit": 3,
  "finalFindingsCount": 2,
  "msg": "deep review: pass limit reached without convergence — review findings remain unresolved; consider increasing deepReviewPasses or investigating contradictory requirements"
}
```

### Interpreting Non-Convergence Logs

| Diagnostic field | What it tells you |
|------------------|-------------------|
| `reason: "pass-limit"` | The agent was making progress but ran out of passes. Increase `deepReviewPasses` if the issue matters. |
| `reason: "non-decreasing"` | The agent hit a wall — new findings appeared or the count stopped dropping. Check `findingsDiff.added` for newly introduced issues; check `findingsDiff.common` for persistent ones that may indicate contradictory requirements. |
| `findingsDiff.common` | Issues that survived both passes — these are the persistent problems. |
| `findingsDiff.removed` | Issues the agent resolved — useful for confirming partial progress. |
| `diffStat` | The git diff stat after the final implement pass — confirms whether any code changes were made. An empty diff with remaining findings indicates the agent gave up rather than converging. |

### Adjusting Configuration

```ts
// Allow more passes for critical pipelines
deepReviewPasses: 4,
maxDeepReviewPasses: 5,

// Disable deep review on fast iteration pipelines
deepReviewPasses: 0,
```

> **Token budget note**: each deep-review pass adds ~45–100K tokens
> (3 sub-agents × 8 turns + implement + review). Set `maxTokens` to guard
> against runaway spend when `deepReviewPasses > 2`.

### Root Cause: BEC-212 / GH#257

Pipeline `6q0OpgiRrke_Szkr1MFt0` accumulated 39 total stage turns across
3 deep-review passes without converging. The pre-fix behavior:

- Count-only convergence check allowed the same issues to persist across passes
  as long as the count kept dropping (5→4→3 all continued).
- When the pass limit was reached with findings remaining, the loop exited
  **silently** — no structured log, no diff summary, no reason code.

The fix (shipped in this release) adds fingerprint-based convergence detection
and a structured `warn`-level log when the pass limit is reached without full
convergence. See `packages/core/src/__tests__/deepReviewLoop.test.ts` for
the full test coverage of all convergence scenarios.

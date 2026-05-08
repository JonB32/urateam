# BEC-177: Multi-Repo PM Agent — Label-Based Repo Routing

**Date:** 2026-05-08  
**Status:** Implemented  
**Replaces:** Single-repo `REPO_URL` + `REPO_TEAM_ID` constraint

---

## Problem

The PM Agent previously used a single team-to-repo mapping (`REPO_TEAM_ID` → `REPO_URL`). Every
Linear issue that got promoted to "Todo" always cloned and worked in the same repository. This
prevented the autonomous loop from serving multiple repos (e.g. the Quality Observer sidecar at
`JonB32/urateam-quality-observer`, the future GH→Linear sync utility, etc.).

Issues meant for those repos had to be worked manually — the autonomous fleet was effectively
single-repo.

---

## Solution: `labelPattern` on `RepoConfig`

Each `RepoConfig` entry now accepts an optional `labelPattern` field. When set, the PM Agent
(and webhook handler) will select that repo for any pipeline run whose resolved pipeline label
matches the pattern.

### `RepoConfig` schema change

```ts
export const RepoConfigSchema = z.object({
  url: z.string(),
  defaultBranch: z.string(),
  testCommand: z.string(),
  buildCommand: z.string(),
  // ... existing fields ...

  /**
   * BEC-177: Label-based repo routing.
   * When set, this repo is selected for pipeline runs whose resolved pipeline label
   * matches this pattern (case-insensitive exact match).
   * Takes priority over the teamId/projectId key lookup.
   *
   * Example: `labelPattern: "observer-fix"` routes all Linear tickets with the
   * "observer-fix" pipeline label to this repo.
   */
  labelPattern: z.string().optional(),
});
```

---

## `selectRepoConfig()` utility

`packages/core/src/pm/actions/select-repo-config.ts` exports `selectRepoConfig()`:

```ts
function selectRepoConfig(
  pipelineLabel: string,          // e.g. "auto-implement", "observer-fix"
  teamId: string | null | undefined,
  projectId: string | null | undefined,
  repoConfigs: Record<string, RepoConfig>,
): RepoConfig | null
```

**Priority order:**

1. **Label-pattern lookup**: scan all `repoConfigs` values for one whose `labelPattern`
   (case-insensitive) matches `pipelineLabel`. First match wins.
2. **TeamId key fallback**: `repoConfigs[teamId]` if a key matching the Linear team ID exists.
3. **ProjectId key fallback**: `repoConfigs[projectId]` if a key matching the Linear project ID exists.
4. Returns `null` (caller skips or errors).

---

## Configuration examples

### Single-repo (legacy — no change required)

```ts
// repoConfigs keyed by Linear team UUID — no labelPattern needed.
repoConfigs: {
  "5fc7a321-...": {
    url: "https://github.com/JonB32/urateam",
    defaultBranch: "main",
    testCommand: "pnpm test",
    buildCommand: "pnpm build",
  },
}
```

Existing tickets with the `auto-implement` label (or any label) continue to resolve via the
teamId key, exactly as before.

### Multi-repo (new capability)

```ts
repoConfigs: {
  "urateam-main": {
    url: "https://github.com/JonB32/urateam",
    defaultBranch: "main",
    testCommand: "pnpm test",
    buildCommand: "pnpm build",
    labelPattern: "auto-implement",   // ← tickets labelled auto-implement → this repo
  },
  "observer-repo": {
    url: "https://github.com/JonB32/urateam-quality-observer",
    defaultBranch: "main",
    testCommand: "pnpm test",
    buildCommand: "pnpm build",
    labelPattern: "observer-fix",     // ← tickets labelled observer-fix → observer repo
  },
}
```

The keys (`"urateam-main"`, `"observer-repo"`) are arbitrary descriptive names when using
`labelPattern` — they are not matched against Linear UUIDs in this mode.

### Mixed (labelPattern entries + legacy teamId entries)

```ts
repoConfigs: {
  // Legacy: teamId key for the main repo
  "5fc7a321-...": {
    url: "https://github.com/JonB32/urateam",
    defaultBranch: "main",
    testCommand: "pnpm test",
    buildCommand: "pnpm build",
  },
  // New: label-pattern entry for the observer sidecar
  "observer-repo": {
    url: "https://github.com/JonB32/urateam-quality-observer",
    defaultBranch: "main",
    testCommand: "pnpm test",
    buildCommand: "pnpm build",
    labelPattern: "observer-fix",
  },
}
```

When a `observer-fix`-labelled ticket arrives, the labelPattern match wins. Any other label
falls through to the teamId key lookup, preserving backwards compatibility.

---

## Label routing in Linear

To route a ticket to a specific repo, apply the appropriate pipeline label in Linear before or
after it enters the "Todo" state:

| Linear label      | Pipeline config | Target repo                               |
|-------------------|-----------------|-------------------------------------------|
| `auto-implement`  | auto-implement  | `JonB32/urateam`                          |
| `observer-fix`    | observer-fix    | `JonB32/urateam-quality-observer`         |
| `bug`             | bug             | *(resolved by teamId/projectId fallback)* |
| `quick-fix`       | quick-fix       | *(resolved by teamId/projectId fallback)* |

---

## Call sites

`selectRepoConfig()` replaces the inline `repoConfigs[teamId] ?? repoConfigs[projectId]` lookups
in two places:

1. **`packages/core/src/pm/actions/start-todo.ts`** — PM Agent's orphan-issue scanner
2. **`packages/core/src/webhook/handler.ts`** — webhook-triggered pipeline starts

Both entry points now support label-based routing.

---

## Backwards compatibility

- No migration required. Existing configs with teamId keys and no `labelPattern` continue to
  work exactly as before.
- The `labelPattern` field is optional on `RepoConfig`.
- `selectRepoConfig()` falls back to teamId/projectId lookup when no `labelPattern` entry matches.

---

## Issues unblocked by this feature

With label-based routing in place, the following issues can now be worked autonomously:

- **BEC-169**: Quality Observer — exclude successful PR-creating runs from deep review
- **BEC-172**: Quality Observer — gate first-tick filing on dedup state seeding
- **BEC-173**: GH→Linear sync utility — autonomous incident/change management

Label these tickets with `observer-fix` (or an equivalent label registered in your `repoConfigs`
with the appropriate `labelPattern`) and the PM Agent will clone the correct repo, implement the
fix, and open the PR in the right place.

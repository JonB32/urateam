# BEC-204: IDE / CLI Agent Surface — Factory-Style "Meet You Where You Are"

**Date:** 2026-05-24  
**Status:** Design  
**Author:** urateam  
**Related:** BEC-177 (multi-repo routing), BEC-172 (quality observer), BEC-183 (pre-stream stall)

---

## Problem

urateam today is fully out-of-band: Linear issue → autonomous pipeline → PR. That works for
planned work that enters the backlog naturally. It does not serve:

- **Unplanned work**: "this thing is broken right now, fix it"
- **Pair-programming**: operator wants to drive a targeted agent run without creating a Linear ticket
- **Local context**: the bug is in the file open in front of the operator — not in a description field

Factory's primary market positioning (2026-05-11 competitive analysis) is "Droids" that work *in
your IDE, terminal, Slack, Linear* — not a separate web app. Closing this surface gap is strategic.

---

## Scope Decision (AC-a: CLI vs IDE Extension)

**Decision: Phase 1 is CLI-only. VS Code extension is deferred to Phase 2.**

Rationale:
- A new `ura agent "<prompt>"` command reuses the entire existing pipeline stack with zero new
  infrastructure. Time-to-ship is days, not weeks.
- CLI validates demand and irons out auth/execution model before investing in an IDE extension
  (estimated 4–6 wk).
- VS Code extension would need a separate auth flow, extension marketplace publishing, UI design,
  and a persistent connection to the running pipeline server — none of that is required for CLI.
- In-IDE editor (Cursor-style inline diff editing) is explicitly out of scope for both phases.

**Phase 1 boundaries:**

| In scope | Out of scope |
|---|---|
| `ura agent "<prompt>"` terminal invocation | VS Code / JetBrains extension |
| Creates a Linear ticket from the prompt | In-IDE diff editing / inline suggestions |
| Executes the existing pipeline | Cursor-style chat panel |
| Returns PR URL to the terminal | Separate agent server or daemon |

---

## Architectural Decisions

### AC-b: Execution Model — Local Node Process

**Decision: Phase 1 runs as a local Node.js process on the operator's machine.**

The `ura agent` command will:
1. Validate tokens (LINEAR_API_KEY, GITHUB_TOKEN / GITLAB_TOKEN, ANTHROPIC_API_KEY)
2. Create a Linear ticket in the configured team/project via the Linear GraphQL API
3. Call `runner.start()` from the existing `PipelineRunner` (same code path as `ura run`)
4. Stream progress to stdout and exit with the PR URL

**Trade-off analysis:**

| Approach | Latency | Security | Resource cost |
|---|---|---|---|
| **Local Node process** (chosen) | ~0ms cold start | Credentials stay on operator's box; no network exposure | CPU/RAM on operator's machine during the run |
| Remote server connection | Depends on network RTT | Tokens must be sent to server or pre-provisioned | Server handles CPU/RAM |
| Local Docker container | +5–15s pull/start overhead | Isolation from host FS unless mount provided | Same as local Node but with container overhead |

Local Node wins for Phase 1:
- Zero extra infrastructure (no server provisioned, no container pulled)
- Credentials never leave the operator's machine
- Cold start is ~1s (Node process + module load), not 5–15s (Docker)
- Exactly the same execution path as `ura run --issue LIN-123` — no new pipeline code

**Acceptable tradeoff:** the operator's machine must have git, Node 22+, and sufficient RAM to run
the Claude agent subprocess. These are already required by `ura run` today.

A future "connected mode" (Phase 2) could proxy to a deployed urateam server so the operator's
laptop can close while the run continues — but this requires a persistent connection protocol
and is deferred.

---

### AC-c: Auth Token Sourcing

**Decision: Env vars (from `.env` file or shell) are the primary token source. No credential manager in Phase 1.**

The CLI already loads `.env` at startup via Node 22's `process.loadEnvFile()` (see
`packages/cli/src/index.ts:8`). The same pattern applies to `ura agent`.

| Token | Env var | Required | Notes |
|---|---|---|---|
| Linear API key | `LINEAR_API_KEY` | Yes | Used to create the Linear ticket and update status |
| GitHub token | `GITHUB_TOKEN` | Yes (GitHub repos) | Used by `gh` CLI / GitHub App for PR creation |
| GitLab token | `GITLAB_TOKEN` | Yes (GitLab repos) | Used for MR creation |
| Anthropic API key | `ANTHROPIC_API_KEY` | Yes | Agent execution via Claude SDK |
| GitHub App creds | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | Optional | Alternative to `GITHUB_TOKEN` for PR creation |

**Security model:**
- Tokens are read from environment variables or `.env` in the CWD — same model as every other `ura`
  subcommand. They are never written to disk by urateam.
- The `ura agent` command will validate all required tokens before touching Linear or starting the
  pipeline, and exit with a clear error message for each missing token.
- `LINEAR_API_KEY` requires the `issues:write` scope to create tickets; the command will surface
  a clear error if the key lacks write access.

**Phase 2 option (not implemented):** A `ura auth login` flow that stores tokens in the OS
keychain (macOS Keychain / Linux libsecret) could be added later. Deferred to avoid the OS-native
dependency surface.

---

### AC-d: Linear Ticket Creation vs Transient Run Records

**Decision: `ura agent` creates a real Linear ticket. No transient-only mode in Phase 1.**

Rationale:
- Consistency: every pipeline run in urateam is associated with a Linear issue. The PM Agent,
  dashboard, audit log, cost rollups, and notifiers all key on `issueId`. A transient run would
  require forking every downstream code path.
- Observability: operators can see what the agent did in their Linear backlog, not just in CLI
  stdout.
- Idempotency: if `ura agent` is interrupted, the Linear ticket exists and the PM Agent's
  `startTodoIssues` tick can resume it.

**Ticket creation flow:**

```
ura agent "fix the null deref in foo.ts:42"
  → Create Linear issue: title = prompt[:72], description = full prompt + repo context
  → Assign pipeline label ("auto-implement" or "quick-fix" based on prompt analysis)
  → Move to "Todo" state (triggers existing webhook pipeline on deployed instances)
  → OR: call runner.start() directly (for pure local runs without a deployed server)
```

The default is **direct `runner.start()` call** (local execution). If `URATEAM_SERVER_URL` is set,
`ura agent` will create the ticket and let the deployed server pick it up via its webhook — useful
when the operator has an always-on server but wants to trigger a run from the terminal.

**Linear project/team selection:**
- Uses `REPO_TEAM_ID` env var (same as `ura run`) to identify the target team
- Optionally accepts `--team <teamId>` flag to override for multi-team setups (BEC-177 routing)
- Ticket is created in Triage state first, then moved to Todo after the local pipeline label is set

---

### AC-e: Attaching to Existing Runs

**Decision: Deferred to Phase 2. Phase 1 is fire-and-wait only.**

Phase 1: `ura agent` blocks until the pipeline completes (or is interrupted with SIGINT).
Progress is streamed to stdout via the existing `ConsoleNotifier`.

A "watch mode" (`ura agent --watch <runId>`) that attaches to an in-progress run on the server
is a distinct feature requiring a persistent connection (SSE or WebSocket from the server). This
is deferred to Phase 2 alongside the "connected mode" execution option.

**Why deferred:**
- Building the streaming attachment protocol is 1–2wk of additional work
- Local blocking execution covers the primary use case (operator triggers and waits)
- The PM Agent's Slack digest already provides async status for deployed runs

---

## Phase 1 Implementation Plan

### New CLI command: `ura agent "<prompt>"`

**Entry point:** `packages/cli/src/commands/agent.ts`  
**Registered in:** `packages/cli/src/index.ts` (add `agentCommand`)

```
Usage: ura agent "<prompt>" [options]

Options:
  --team <teamId>       Linear team ID (overrides REPO_TEAM_ID env var)
  --pipeline <key>      Pipeline config key to use (default: auto-detect from prompt)
  --dry-run             Show what would be created without touching Linear
  --config <path>       Pipeline config file path (default: ./pipeline.config.ts)
  --repos <path>        Repo config file path (default: ./repos.config.ts)
  -h, --help            Display help
```

### Integration with existing code (no new pipeline code)

The implementation **must not duplicate** any pipeline logic. Call sites:

| Existing code | How `ura agent` uses it |
|---|---|
| `LinearClient` from `@linear/sdk` | Create ticket, set state, set label |
| `resolveWorkflowStates()` in `pm/linear-helpers.ts` | Resolve "Triage" → "Todo" state IDs |
| `validatePipelineConfigs()` / `validateRepoConfigs()` | Load and validate config files |
| `mapIssueToSchema()` | Sanitize the newly-created issue |
| `PipelineRunner.start()` in `pipeline/runner.ts` | Execute the pipeline |
| `createConsoleNotifier()` in `commands/run.ts` | Stream progress to stdout |
| `createDb()` | Set up DB (in-memory or DATABASE_URL) |
| `logAuditEvent()` / `configLoadedEvent()` | Startup audit emit (license-gated) |

**No new pipeline stages, no new executor logic, no new DB tables.**

### Pseudo-implementation sketch

```typescript
// packages/cli/src/commands/agent.ts

/** Linear issue titles are capped at this length; longer prompts are truncated. */
const TITLE_MAX_LENGTH = 72;

/**
 * Heuristic: classify a prompt as "quick-fix" when it contains one of the
 * fix-intent keywords (case-insensitive). All other prompts default to
 * "auto-implement". The operator can always override with --pipeline <key>.
 * A Haiku-based classifier (same as PM Agent triage) is deferred to Phase 2.
 */
const QUICK_FIX_KEYWORDS = ["fix", "bug", "error", "crash", "typo", "revert"];

function detectPipelineLabel(prompt: string): "quick-fix" | "auto-implement" {
  const lower = prompt.toLowerCase();
  return QUICK_FIX_KEYWORDS.some((kw) => lower.includes(kw))
    ? "quick-fix"
    : "auto-implement";
}

export const agentCommand = new Command("agent")
  .description('Run a pipeline from a prompt — creates a Linear ticket and opens a PR')
  .argument("<prompt>", "Natural-language description of the task")
  .option("--team <teamId>", "Linear team ID (overrides REPO_TEAM_ID)")
  .option("--pipeline <key>", "Pipeline config key")
  .option("--dry-run", "Show plan without executing")
  .option("--config <path>", "Pipeline config file path", "./pipeline.config.ts")
  .option("--repos <path>", "Repo config file path", "./repos.config.ts")
  .action(async (prompt: string, options) => {
    // 1. Validate required env vars — fail fast with clear messages
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      console.error("Error: LINEAR_API_KEY is not set.");
      process.exit(1);
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("Error: ANTHROPIC_API_KEY is not set.");
      process.exit(1);
    }
    const teamId = options.team ?? process.env.REPO_TEAM_ID;
    if (!teamId) {
      console.error("Error: --team or REPO_TEAM_ID must be set.");
      process.exit(1);
    }

    // 2. Load pipeline + repo configs (reuse loadPipelineConfigModule / loadRepoConfigModule)
    let pipelineConfigs: Record<string, PipelineConfig>;
    try {
      const raw = await loadPipelineConfigModule(resolve(options.config as string));
      pipelineConfigs = validatePipelineConfigs(raw);
    } catch (err: any) {
      console.error(`Error loading pipeline config: ${err?.message ?? String(err)}`);
      process.exit(1);
    }

    let repoConfigs: Record<string, RepoConfig>;
    try {
      const raw = await loadRepoConfigModule(resolve(options.repos as string));
      repoConfigs = validateRepoConfigs(raw);
    } catch (err: any) {
      console.error(`Error loading repo config: ${err?.message ?? String(err)}`);
      process.exit(1);
    }

    // 3. Create Linear issue via LinearClient
    const pipelineLabel = options.pipeline ?? detectPipelineLabel(prompt);
    let issue: LinearIssue;
    try {
      const { LinearClient } = await import("@linear/sdk");
      const client = new LinearClient({ apiKey });
      const result = await client.createIssue({
        title: prompt.slice(0, TITLE_MAX_LENGTH),
        description: `${prompt}\n\n*Created by \`ura agent\`*`,
        teamId,
        // labelId resolved from team labels by pipeline label name
      });
      if (!result.success || !result.issue) throw new Error("createIssue returned no issue");
      issue = await buildLinearIssue(result.issue, pipelineLabel);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.toLowerCase().includes("unauthorized") || msg.toLowerCase().includes("forbidden")) {
        console.error("Error: Linear authentication failed. Verify LINEAR_API_KEY has issues:write scope.");
      } else {
        console.error(`Error creating Linear issue: ${msg}`);
      }
      process.exit(1);
    }

    // 4. Move issue to Todo state via LinearClient.updateIssue()
    // 5. Build LinearIssue + SanitizedIssue objects from the created ticket
    // 6. Resolve repoConfig from repos.config.ts
    const repoConfig = resolveRepoConfig(repoConfigs, issue.teamId);
    if (!repoConfig) {
      console.error("Error: No matching repo config found.");
      process.exit(1);
    }

    // 7. Create DB + runner (same as ura run)
    // 8. Call runner.start() — blocks via completionPromise
    try {
      await runner.start(issue, pipelineLabel, pipelineConfig, repoConfig, sanitizedIssue);
      await completionPromise; // resolves on onPipelineComplete, rejects on onPipelineFailed
    } catch (err: any) {
      console.error(`Pipeline failed: ${err?.message ?? String(err)}`);
      process.exit(1);
    }
    // 9. Print PR URL on completion; exit 0
  });
```

---

## Phase 1 Testing Strategy (AC-f)

### Unit tests (`packages/cli/src/__tests__/agent.test.ts`)

- `createLinearTicketFromPrompt()` — verifies title truncation at `TITLE_MAX_LENGTH` (72) chars, label auto-detection, state ID resolution
- `detectPipelineLabel()` — verifies keyword heuristic: prompts containing "fix", "bug", "error", "crash", "typo", or "revert" (case-insensitive) → "quick-fix"; all other prompts → "auto-implement"
- Title truncation — verifies that a 100-char prompt produces a Linear issue title of exactly 72 chars
- `--dry-run` flag — verifies no Linear API calls are made, expected plan printed to stdout

### Integration test scenario

> **Scenario:** `ura agent "fix the bug in foo.ts:42"` from operator's terminal

Preconditions:
- `LINEAR_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` set
- `REPO_TEAM_ID` set to a valid Linear team
- `./pipeline.config.ts` and `./repos.config.ts` present in CWD

Expected outcomes:
1. A new Linear issue appears in the team's backlog with title "fix the bug in foo.ts:42"
2. The issue is labelled "quick-fix" and moved to "Todo"
3. The pipeline executes (implement → review stages per the quick-fix config)
4. A PR URL is printed to stdout before exit
5. Exit code 0 on success, 1 on pipeline failure

**Time budget:** Phase 1 local runs should complete within the same wall-clock budget as
`ura run --issue LIN-xxx` (typically 5–20 min depending on pipeline config). No additional
latency is introduced — the only extra step is the Linear ticket creation API call (~200ms).

### Mock-based unit test for the integration path

```typescript
// packages/cli/src/__tests__/agent.test.ts
it("creates a Linear ticket and calls runner.start()", async () => {
  const mockLinearClient = {
    createIssue: vi.fn().mockResolvedValue({ success: true, issue: mockIssue }),
    updateIssue: vi.fn().mockResolvedValue({ success: true }),
    workflowStates: vi.fn().mockResolvedValue({ nodes: mockStates }),
  };
  const mockRunner = { start: vi.fn().mockResolvedValue(undefined) };

  await runAgentCommand("fix the bug in foo.ts:42", {
    linearClient: mockLinearClient,
    runner: mockRunner,
    pipelineConfigs: mockPipelineConfigs,
    repoConfigs: mockRepoConfigs,
  });

  expect(mockLinearClient.createIssue).toHaveBeenCalledWith(
    expect.objectContaining({ title: "fix the bug in foo.ts:42" }),
  );
  expect(mockRunner.start).toHaveBeenCalledOnce();
});

it("truncates prompt longer than TITLE_MAX_LENGTH (72) in Linear issue title", async () => {
  const longPrompt = "x".repeat(100);
  const mockLinearClient = {
    createIssue: vi.fn().mockResolvedValue({ success: true, issue: mockIssue }),
    updateIssue: vi.fn().mockResolvedValue({ success: true }),
    workflowStates: vi.fn().mockResolvedValue({ nodes: mockStates }),
  };
  const mockRunner = { start: vi.fn().mockResolvedValue(undefined) };

  await runAgentCommand(longPrompt, {
    linearClient: mockLinearClient,
    runner: mockRunner,
    pipelineConfigs: mockPipelineConfigs,
    repoConfigs: mockRepoConfigs,
  });

  expect(mockLinearClient.createIssue).toHaveBeenCalledWith(
    expect.objectContaining({ title: "x".repeat(72) }),
  );
});

it("detects 'quick-fix' label from fix-intent keywords; defaults to 'auto-implement'", () => {
  expect(detectPipelineLabel("fix the null deref in foo.ts")).toBe("quick-fix");
  expect(detectPipelineLabel("add support for dark mode")).toBe("auto-implement");
  expect(detectPipelineLabel("crash when uploading large files")).toBe("quick-fix");
  expect(detectPipelineLabel("implement new billing dashboard")).toBe("auto-implement");
});
```

---

## Post-Implementation Documentation (AC-g)

When Phase 1 is implemented, the following documentation must be updated:

| Document | Required addition |
|---|---|
| `CLAUDE.md` (root) | New section under "Build & Test Commands" describing `ura agent "<prompt>"` usage, required env vars, and dry-run flag |
| `deploy/README.md` | "CLI Agent Surface" section — env vars required for `ura agent`, distinction between local-only and server-connected modes |
| `packages/cli/src/commands/agent.ts` | JSDoc on the exported `agentCommand`: documents the prompt argument, all options, and the Linear ticket creation side effect |
| `ura agent --help` output | Auto-generated by Commander from the command definition; must be complete and accurate |
| `examples/` | Add a `cli-agent/` example showing a minimal `pipeline.config.ts` + `repos.config.ts` + `.env.example` for `ura agent` |

---

## Phased Plan Summary

### Phase 1 (this spec) — CLI surface, ~1–2wk

- `ura agent "<prompt>"` command
- Local Node.js execution (reuses existing pipeline stack)
- Linear ticket creation with auto-label detection
- Env-var auth sourcing
- Dry-run flag
- Unit + integration tests

### Phase 2 — Connected mode + watch, ~1–2wk

- `URATEAM_SERVER_URL` support: create ticket, let deployed server handle execution
- `ura agent --watch <runId>`: attach to an in-progress server-side run (SSE/WebSocket)
- `ura auth login` keychain-backed credential storage

### Phase 3 — VS Code extension, ~4–6wk

- Read-only run status view in the sidebar
- "Run agent" from command palette (opens terminal with `ura agent`)
- No in-IDE diff editing (Cursor-style) in Phase 3

---

## Open Questions (not blocking Phase 1)

1. **Multi-tenant Linear:** operators with multiple Linear teams need a `--team` flag or a
   workspace-level config file (e.g. `~/.ura/config.json`) to avoid always passing the team ID.
   Phase 1 uses `REPO_TEAM_ID` env var as the fallback — acceptable for single-team setups.

2. **Prompt classification quality:** the `detectPipelineLabel()` heuristic (keyword matching)
   may misclassify. A future improvement would call Claude Haiku (same as PM Agent triage) to
   classify the prompt before creating the ticket. Deferred — adds latency and cost for a
   cosmetic improvement.

3. **Long-running local runs:** if the operator closes their terminal, the pipeline dies. The
   `URATEAM_SERVER_URL` connected mode in Phase 2 addresses this. For Phase 1, document in the
   help text that closing the terminal aborts the run.

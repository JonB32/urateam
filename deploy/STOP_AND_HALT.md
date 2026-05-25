# Stop and halt runbook

Operator emergency controls for stopping individual pipeline runs and
container-wide halting. Three surfaces — dashboard, Slack, and CLI — all funnel
through the same in-process signal map and emit the same audit events.

## Scope

| Action | What it does | Reversible? | Tokens lost |
|---|---|---|---|
| **Cancel a run** | Aborts the active Agent SDK stream mid-stage. Pipeline exits with `status: "cancelled"`; no PR. | The cancelled run stays cancelled. Use the retry button to start fresh. | Yes — current stage's tokens. |
| **Graceful stop a run** | Lets the current stage finish, then skips remaining stages. No PR. | Same as cancel. | No additional — current stage's work completes. |
| **Halt all** | Pauses the PM Agent (no new runs promoted/started) **and** sends `cancel` to every active pipeline + feedback run. | Reversible: `/pm resume` (or dashboard equivalent). Cancelled runs stay cancelled. | Yes — every in-flight stage's tokens. |

`cancel` is for incident response (something is burning budget, ship a stop NOW). `graceful` is the polite version. `halt` is the big red button.

## Surfaces

### Dashboard

Run detail page (`/runs/:id`):
- **Stop…** button (operator+admin) opens a confirm dialog with two actions: *Graceful stop* and *Cancel immediately*.
- **Halt all…** button (top-right of the meta block) opens a confirm dialog explaining the consequences before firing.

Both routes are RBAC-gated (`runs.stop`, `system.halt`) and CSRF-protected via the standard `HX-Request` header. Routes return 404 when RBAC is unlicensed.

### Slack

In the PM channel or any DM with the bot:

```
/pm cancel <runId>        # interrupt the active stage immediately
/pm stop <runId>          # let the current stage finish, then quit
/pm halt                  # pause PM + cancel every in-flight run
/pm resume                # unpause PM (does not un-cancel any cancelled runs)
```

Natural-language variants are supported via the Haiku classifier — "kill run X", "halt everything", "emergency stop", etc.

On receipt the bot reacts with 🤔 (`:thinking_face:`) and swaps to ✅ on success / ⚠️ on failure once processing finishes. Slash commands get an immediate ephemeral "Working on it…" reply followed by the real result via `response_url`.

### CLI

```sh
ura stop <runId>             # cancel mid-stream (default)
ura stop <runId> --graceful  # let the current stage finish
ura halt                     # pause PM + cancel all active runs
```

Setup:

| Env var | Purpose | Default |
|---|---|---|
| `URATEAM_CLI_TOKEN` | Shared secret matching the value set in the urateam container's environment. The dashboard's `/cli/*` routes 404 when this is unset, so CLI control is opt-in. | (unset → CLI disabled) |
| `URATEAM_DASHBOARD_URL` | Dashboard URL the CLI POSTs to. | `http://localhost:3001` |

The CLI uses HTTP (not the DB) so the signal reaches the runner's in-process map immediately. `docker exec urateam-dogfood ura halt` works because the CLI binary inside the container reaches the dashboard on `localhost:3001`.

The CLI auth surface is intentionally separate from dashboard SSO/basic-auth: the same `/cli/*` endpoints are accessible whether RBAC is licensed or not, as long as the token matches.

## Audit trail

All three surfaces emit:

- `run.cancelled` per stopped run: `{ runId, issueId, mode: "cancel" | "graceful", actor, actorType }`.
- `system.halted` for halt-all: `{ actor, cancelledRunIds, cancelledCount }`. The per-run `run.cancelled` events are emitted in addition, each with `reason: "system.halt"`.

`actorType` is one of `dashboard-user`, `cli`, `slack`. `actor` carries identifying detail (email for dashboard, OS username for CLI, Slack user id for Slack). Browse via the audit dashboard (`/audit`) or `audit_events` table.

## Implementation notes

- **In-memory signal map.** State lives in `packages/core/src/pipeline/control-signals.ts`. Single-process — matches the BEC-170 PM pause caveat. Cross-container coordination via Redis is out of scope.
- **Cancel vs graceful semantics.** Cancel wires an `AbortController` into `consumeAgentStream`; the iterator's `.return()` fires and the executor throws `StageCancelledError`. Graceful polls the signal between stages so the running stage isn't interrupted.
- **Run state transitions.** Cancelled runs land in `status: "cancelled"` (distinct from `"aborted"`, which is reserved for system-initiated aborts like token-budget violations).
- **PM pause integration.** `haltAll()` sets the same `pmPaused` flag that the Slack `/pm pause` command uses (`setPmPaused(true)`). Unpause via `/pm resume`.
- **Idempotency.** Repeated `requestStop` calls are no-ops; `cancel` after `graceful` upgrades; `graceful` after `cancel` is ignored.

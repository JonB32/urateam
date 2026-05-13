# Built-in Tunnel Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--tunnel <mode>` to `ura start` so operators can auto-launch a Cloudflare tunnel from the daemon process. Replaces the "run cloudflared in a separate terminal" step in the docs.

**Architecture:** A dependency-injected `TunnelManager` (`packages/cli/src/lib/tunnel.ts`) wraps `spawn("cloudflared", [...])`. Detects the public URL from cloudflared's stderr (quick-tunnel mode) or from `--public-url` / `URATEAM_PUBLIC_URL` (named-tunnel/token mode). Restarts the child on unexpected exit with exponential backoff (1s → 2s → 4s → ... capped at 30s, max 10 attempts). Graceful shutdown via SIGTERM. Emits `tunnel.started` / `tunnel.stopped` audit events when the daemon DB exists.

**Tech Stack:** Node 22 `child_process.spawn`, `events.EventEmitter`. No new deps.

---

## File structure

**Create:**
- `packages/cli/src/lib/tunnel.ts` — TunnelManager + types
- `packages/cli/src/__tests__/tunnel.test.ts` — unit tests with mocked spawn

**Modify:**
- `packages/cli/src/commands/start.ts` — wire `--tunnel` flag into the runtime
- `packages/core/src/types.ts` — add `tunnel.started`, `tunnel.stopped` to `AuditEventTypeSchema`
- `packages/core/src/audit/events.ts` — add builders
- `CLAUDE.md` — bump audit count 48 → 50; document tunnel modes and escape hatch
- `.claude/CLAUDE.md` — short note
- `deploy/USER_LEVEL_INSTALL.md` — replace the static tunnel-comparison table with a real `--tunnel` guide; remove the "Built-in tunnel manager" bullet from "What's deferred"

---

## Task 1: Audit-event types + builders

- [ ] Append to `packages/core/src/types.ts` `AuditEventTypeSchema`:
  ```typescript
  /** `ura start --tunnel <mode>` brought the tunnel up and a public URL is
   *  live. Payload includes provider, mode, and the public URL. */
  "tunnel.started",
  /** Tunnel child process exited (clean shutdown or unexpected exit beyond
   *  the restart cap). Payload includes provider, restartCount, and the
   *  exit code. */
  "tunnel.stopped",
  ```

- [ ] Append builders to `packages/core/src/audit/events.ts`:
  ```typescript
  export function tunnelStartedEvent(args: {
    provider: "cloudflare-quick" | "cloudflare-token";
    publicUrl: string;
    restartCount: number;
  }): AuditEvent {
    return base({
      eventType: "tunnel.started",
      actor: "system",
      actorType: "system",
      payload: {
        provider: args.provider,
        publicUrl: args.publicUrl,
        restartCount: args.restartCount,
      },
    });
  }

  export function tunnelStoppedEvent(args: {
    provider: "cloudflare-quick" | "cloudflare-token";
    restartCount: number;
    exitCode: number | null;
    signal: string | null;
  }): AuditEvent {
    return base({
      eventType: "tunnel.stopped",
      actor: "system",
      actorType: "system",
      payload: {
        provider: args.provider,
        restartCount: args.restartCount,
        exitCode: args.exitCode,
        signal: args.signal,
      },
    });
  }
  ```

- [ ] Test in `packages/core/src/__tests__/audit-events-tunnel.test.ts`: verify shape, no PII, scope assertions.

## Task 2: TunnelManager implementation

- [ ] Implement `packages/cli/src/lib/tunnel.ts` with DI-able spawn:

```typescript
export type TunnelMode = "cloudflare-quick" | "cloudflare-token";

export interface TunnelManagerOpts {
  mode: TunnelMode;
  /** Required for "cloudflare-token" — read from CLOUDFLARE_TUNNEL_TOKEN. */
  token?: string;
  /** Static public URL — required for "cloudflare-token", ignored for quick. */
  publicUrl?: string;
  /** Test-overridable spawn. Returns a process-like with stdout/stderr/kill. */
  spawn?: typeof spawn;
  /** Initial restart delay (ms). Test-overridable. Default 1000. */
  initialRestartDelayMs?: number;
  /** Max restart delay (ms). Test-overridable. Default 30000. */
  maxRestartDelayMs?: number;
  /** Max restart attempts before giving up. Default 10. */
  maxRestartAttempts?: number;
  /** Logger (defaults to console). */
  log?: (msg: string) => void;
}

export interface TunnelStartResult {
  publicUrl: string;
  restartCount: number;
}

export class TunnelManager {
  private child: ChildProcess | null = null;
  private restartCount = 0;
  private shuttingDown = false;
  // ... emits "started" / "stopped" / "error" events
  // start(): Promise<TunnelStartResult>
  // stop(): Promise<void>
}
```

- [ ] Tests in `packages/cli/src/__tests__/tunnel.test.ts`:
  - quick-tunnel: parses URL from stderr (`https://<random>.trycloudflare.com`)
  - named-tunnel: requires CLOUDFLARE_TUNNEL_TOKEN; static publicUrl from opts/env
  - cloudflared-missing: clear error pointing at install instructions
  - restart-on-exit: child exits non-zero, manager restarts up to `maxRestartAttempts`
  - exponential backoff: delays scale 1s → 2s → 4s ... (mock setTimeout)
  - graceful shutdown: `stop()` sends SIGTERM to child, awaits exit
  - shutdown during restart-pending: cancels the pending restart timer

## Task 3: Wire into `ura start`

- [ ] Add `--tunnel <mode>` option to `startCommand` in `packages/cli/src/commands/start.ts`. Allowed values: `none` (default), `cloudflare-quick`, `cloudflare-token`.
- [ ] After `webhookServer` and `dashServer` are listening, if tunnel mode != none:
  - Construct `TunnelManager` with mode + (env-derived) token + publicUrl
  - `await manager.start()` to get the public URL
  - Set `process.env.URATEAM_PUBLIC_URL = url` so other parts of the daemon see it
  - Log the URL prominently
  - Emit `tunnel.started` audit event via `logAuditEvent`
- [ ] In the existing `shutdown()` function, call `manager?.stop()` before closing the HTTP servers. Emit `tunnel.stopped` audit event.

## Task 4: Docs + count bump + register flag

- [ ] CLAUDE.md: bump 48 → 50, append `tunnel.{started,stopped}` to the canonical list, add a tunnel manager paragraph under the user-level install section.
- [ ] `.claude/CLAUDE.md`: append `, --tunnel <mode>` to the start description.
- [ ] `deploy/USER_LEVEL_INSTALL.md`: replace the static tunnel comparison table with a real `--tunnel` section explaining quick vs token modes and the `cloudflared` install hint. Remove the deferred bullet.

## Task 5: PR + Sonnet review + release v0.1.55

Same flow as Features 1 and 2.

## Self-review

- Spec coverage: `--tunnel <mode>` with three values, spawn cloudflared, restart on exit, log URL, graceful shutdown, install-hint on missing binary, `URATEAM_PUBLIC_URL` set, audit events. All covered.
- Type consistency: `TunnelMode`, `TunnelManagerOpts`, `TunnelStartResult`, `tunnelStartedEvent`/`tunnelStoppedEvent` payload shapes used consistently across module + command.

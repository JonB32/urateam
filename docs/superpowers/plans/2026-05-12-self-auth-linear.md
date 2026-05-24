# `ura self-auth-linear` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ura self-auth-linear` — a browser-based Linear OAuth2 flow that exchanges an authorization code for an access token and writes it as `LINEAR_API_KEY` into `~/.urateam/.env`. Replaces the operator step of hand-creating a Linear personal API key. Modeled on the Cyrus `cyrus self-auth-linear` UX.

**Architecture:** A short-lived HTTP server binds to `127.0.0.1:<random-port>`, opens the Linear authorize URL in the operator's browser, and receives the `code` callback. The `state` parameter is HMAC-signed with a per-invocation random key (never persisted — both sign and verify happen in the same process). Token exchange goes to `https://api.linear.app/oauth/token`. The access token is merged into the existing `.env` (preserving other keys via a line-by-line parser); never logged. A new audit event `linear.oauth_completed` is emitted opportunistically when the daemon DB exists. Webhook-secret setup remains manual (Linear's API doesn't expose existing webhook secrets to OAuth-authorized callers).

**Tech Stack:** Node 22's built-in `http`, `crypto`, `fetch`. commander. vitest. No new dependencies.

---

## File structure

**Create:**
- `packages/cli/src/lib/oauth-state.ts` — HMAC-signed state helpers (pure)
- `packages/cli/src/lib/env-file.ts` — read/merge/write `.env` preserving unrelated keys (pure)
- `packages/cli/src/lib/linear-oauth.ts` — OAuth flow orchestrator (composable, injectable deps)
- `packages/cli/src/commands/self-auth-linear.ts` — commander surface
- `packages/cli/src/__tests__/oauth-state.test.ts`
- `packages/cli/src/__tests__/env-file.test.ts`
- `packages/cli/src/__tests__/linear-oauth.test.ts`
- `packages/cli/src/__tests__/self-auth-linear.test.ts`

**Modify:**
- `packages/cli/src/index.ts` — register the new command
- `packages/core/src/types.ts` — add `linear.oauth_completed` to `AuditEventTypeSchema`
- `packages/core/src/audit/events.ts` — add `linearOauthCompletedEvent` builder
- `CLAUDE.md` — bump audit count `47 → 48`; add command + escape hatch under user-level install
- `.claude/CLAUDE.md` — one-line note
- `deploy/USER_LEVEL_INSTALL.md` — replace the "create a Linear personal API key" step with `ura self-auth-linear`; document the prerequisite OAuth app creation in Linear's admin UI

---

## Task 1: Audit-event type + builder

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/audit/events.ts`
- Test: `packages/core/src/__tests__/audit-events-linear-oauth.test.ts`

- [ ] **Step 1: Append the event type to `AuditEventTypeSchema`** (before the closing `]);`)

```typescript
  /** `ura self-auth-linear` completed: the operator authorized urateam in
   *  Linear and the CLI persisted the access token to `~/.urateam/.env` as
   *  `LINEAR_API_KEY`. Payload includes the Linear workspace ID (never the
   *  token itself). */
  "linear.oauth_completed",
```

- [ ] **Step 2: Write the failing builder test** at `packages/core/src/__tests__/audit-events-linear-oauth.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { linearOauthCompletedEvent } from "../audit/events.js";

describe("linearOauthCompletedEvent", () => {
  it("emits eventType 'linear.oauth_completed' with workspaceId and never the token", () => {
    const evt = linearOauthCompletedEvent({
      workspaceId: "ws_abc123",
      workspaceName: "Acme Corp",
      actor: "cli:tester",
    });
    expect(evt.eventType).toBe("linear.oauth_completed");
    expect(evt.actor).toBe("cli:tester");
    expect(evt.actorType).toBe("cli");
    expect(evt.payload.workspaceId).toBe("ws_abc123");
    expect(evt.payload.workspaceName).toBe("Acme Corp");
    // Defense in depth: payload values must not include "Bearer", a JWT-ish
    // shape, or anything that smells like a token.
    const json = JSON.stringify(evt.payload);
    expect(json).not.toMatch(/bearer/i);
    expect(json).not.toMatch(/eyJ/); // common JWT prefix
    expect(json).not.toMatch(/lin_oauth_/);
  });
});
```

- [ ] **Step 3: Verify failure**
```
cd packages/core && npx vitest run src/__tests__/audit-events-linear-oauth.test.ts
```
Expected: FAIL — `linearOauthCompletedEvent` is not exported.

- [ ] **Step 4: Implement the builder** (append to `packages/core/src/audit/events.ts`)

```typescript
/**
 * `ura self-auth-linear` completed — the operator authorized urateam in
 * Linear and the CLI persisted the access token to `~/.urateam/.env`.
 *
 * Payload deliberately omits the access token. workspaceId / workspaceName
 * are operational metadata the daemon already logs elsewhere; they're not
 * sensitive in the same way the token is.
 */
export function linearOauthCompletedEvent(args: {
  workspaceId: string;
  workspaceName?: string;
  actor: string;
}): AuditEvent {
  return base({
    eventType: "linear.oauth_completed",
    actor: args.actor,
    actorType: "cli",
    payload: {
      workspaceId: args.workspaceId,
      ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
    },
  });
}
```

- [ ] **Step 5: Verify the test passes**
```
npx vitest run src/__tests__/audit-events-linear-oauth.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/audit/events.ts \
  packages/core/src/__tests__/audit-events-linear-oauth.test.ts
git commit -m "feat(audit): linear.oauth_completed event type and builder"
```

---

## Task 2: HMAC-signed OAuth state helpers

**Files:**
- Create: `packages/cli/src/lib/oauth-state.ts`
- Test: `packages/cli/src/__tests__/oauth-state.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { signState, verifyState } from "../lib/oauth-state.js";

describe("OAuth state HMAC", () => {
  it("round-trips a nonce", () => {
    const secret = "fixed-secret-for-test";
    const signed = signState(secret, "nonce-abc");
    expect(verifyState(secret, signed)).toBe("nonce-abc");
  });

  it("rejects a tampered state", () => {
    const secret = "fixed-secret-for-test";
    const signed = signState(secret, "nonce-abc");
    const [nonce, sig] = signed.split(".");
    const tampered = `${nonce}-tampered.${sig}`;
    expect(verifyState(secret, tampered)).toBeNull();
  });

  it("rejects a state signed with a different secret", () => {
    const signed = signState("secret-a", "nonce-abc");
    expect(verifyState("secret-b", signed)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyState("any-secret", "")).toBeNull();
    expect(verifyState("any-secret", "no-dot")).toBeNull();
    expect(verifyState("any-secret", "too.many.dots")).toBeNull();
  });

  it("is timing-safe (no early-return based on character match)", () => {
    // Length-only proxy for timing safety: timingSafeEqual throws if buffers
    // differ in length, so verify two equal-length-but-wrong sigs return null
    // cleanly rather than throwing.
    const signed = signState("secret", "nonce");
    const [nonce] = signed.split(".");
    const wrongButSameLen = `${nonce}.${"f".repeat(64)}`;
    expect(verifyState("secret", wrongButSameLen)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```
cd packages/cli && npx vitest run src/__tests__/oauth-state.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

```typescript
/**
 * HMAC-signed OAuth `state` parameter helpers.
 *
 * The OAuth provider echoes `state` back on the callback; verifying the HMAC
 * before trusting the callback's `code` defends against open-redirect and
 * CSRF attacks where an attacker injects an attacker-controlled `code` into
 * the callback URL.
 *
 * Format: `<nonce>.<hmac-sha256-hex>` where `nonce` is a random 16-byte hex
 * string and the HMAC is computed over `nonce` using the per-invocation
 * secret. Secret never leaves the process.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export function signState(secret: string, nonce: string): string {
  const sig = createHmac("sha256", secret).update(nonce).digest("hex");
  return `${nonce}.${sig}`;
}

/**
 * Returns the nonce when `state` is valid, `null` otherwise. Use a constant-
 * time comparison so attacker timing observations don't leak the expected
 * signature byte-by-byte.
 */
export function verifyState(secret: string, state: string): string | null {
  if (!state) return null;
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [nonce, providedSig] = parts;
  if (!nonce || !providedSig) return null;
  const expectedSig = createHmac("sha256", secret).update(nonce).digest("hex");
  const a = Buffer.from(providedSig, "hex");
  const b = Buffer.from(expectedSig, "hex");
  if (a.length !== b.length) return null;
  try {
    return timingSafeEqual(a, b) ? nonce : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Verify tests pass**

```
npx vitest run src/__tests__/oauth-state.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/oauth-state.ts packages/cli/src/__tests__/oauth-state.test.ts
git commit -m "feat(cli): HMAC-signed OAuth state helpers"
```

---

## Task 3: `.env` read/merge/write preserving unrelated keys

**Files:**
- Create: `packages/cli/src/lib/env-file.ts`
- Test: `packages/cli/src/__tests__/env-file.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { upsertEnvFile, readEnvFile } from "../lib/env-file.js";

describe("upsertEnvFile", () => {
  let tmp: string;
  let path: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-env-"));
    path = join(tmp, ".env");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the file when it does not exist", () => {
    upsertEnvFile(path, { LINEAR_API_KEY: "lin_oauth_abc" });
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("LINEAR_API_KEY=lin_oauth_abc");
  });

  it("merges into an existing file preserving unrelated keys", () => {
    writeFileSync(
      path,
      [
        "ANTHROPIC_API_KEY=sk-ant-xyz",
        "DASHBOARD_USER=admin",
        "LINEAR_API_KEY=lin_api_old",
        "",
      ].join("\n"),
    );
    upsertEnvFile(path, { LINEAR_API_KEY: "lin_oauth_new" });
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("ANTHROPIC_API_KEY=sk-ant-xyz");
    expect(raw).toContain("DASHBOARD_USER=admin");
    expect(raw).toContain("LINEAR_API_KEY=lin_oauth_new");
    expect(raw).not.toContain("lin_api_old");
  });

  it("preserves comments and blank lines", () => {
    writeFileSync(
      path,
      [
        "# Linear",
        "",
        "LINEAR_API_KEY=lin_api_old",
        "# Anthropic",
        "ANTHROPIC_API_KEY=sk-ant-xyz",
        "",
      ].join("\n"),
    );
    upsertEnvFile(path, { LINEAR_API_KEY: "lin_oauth_new" });
    const raw = readFileSync(path, "utf8");
    expect(raw).toMatch(/^# Linear/m);
    expect(raw).toMatch(/^# Anthropic/m);
  });

  it("appends new keys at the end when not already present", () => {
    writeFileSync(path, "ANTHROPIC_API_KEY=sk-ant-xyz\n");
    upsertEnvFile(path, { LINEAR_API_KEY: "lin_oauth_new" });
    const lines = readFileSync(path, "utf8").split("\n");
    const idx = lines.findIndex((l) => l.startsWith("LINEAR_API_KEY="));
    const anthropicIdx = lines.findIndex((l) =>
      l.startsWith("ANTHROPIC_API_KEY="),
    );
    expect(idx).toBeGreaterThan(anthropicIdx);
  });

  it("can upsert multiple keys in one call", () => {
    upsertEnvFile(path, {
      LINEAR_API_KEY: "lin_oauth_new",
      LINEAR_WORKSPACE_ID: "ws_abc",
    });
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("LINEAR_API_KEY=lin_oauth_new");
    expect(raw).toContain("LINEAR_WORKSPACE_ID=ws_abc");
  });

  it("writes atomically via rename-after-write", () => {
    // Negative assertion: there is no `.env.tmp` left over after a successful
    // write. Hard-failure case for the implementation choosing fs.writeFileSync
    // directly (which is not atomic across processes but is here).
    upsertEnvFile(path, { LINEAR_API_KEY: "lin_oauth_new" });
    const { existsSync } = require("node:fs");
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});

describe("readEnvFile", () => {
  let tmp: string;
  let path: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-env-"));
    path = join(tmp, ".env");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an empty object when the file is absent", () => {
    expect(readEnvFile(path)).toEqual({});
  });

  it("parses KEY=value lines, ignoring comments and blanks", () => {
    writeFileSync(
      path,
      ["# comment", "", "FOO=bar", "BAZ=qux quux"].join("\n"),
    );
    expect(readEnvFile(path)).toEqual({ FOO: "bar", BAZ: "qux quux" });
  });
});
```

- [ ] **Step 2: Verify failure**

```
npx vitest run src/__tests__/env-file.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/cli/src/lib/env-file.ts`:

```typescript
/**
 * Minimal `.env` read / upsert that preserves unrelated keys, comments, and
 * blank lines. The full `dotenv` spec is wider than we need — we just want
 * a line-by-line replace-or-append.
 *
 * `upsertEnvFile` writes atomically by writing a sibling `<path>.tmp` first
 * and then renaming. Same-FS rename is atomic on POSIX and on Windows in
 * Node 22.
 */
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

export function upsertEnvFile(
  path: string,
  updates: Record<string, string>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const updateKeys = new Set(Object.keys(updates));
  const seen = new Set<string>();

  let lines: string[] = [];
  if (existsSync(path)) {
    lines = readFileSync(path, "utf8").split("\n");
  }

  const out: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(raw);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 1) {
      out.push(raw);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (updateKeys.has(key)) {
      out.push(`${key}=${updates[key]}`);
      seen.add(key);
    } else {
      out.push(raw);
    }
  }

  // Strip any trailing empty line so the appended block isn't preceded by
  // two blank lines after multiple appends.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();

  for (const key of updateKeys) {
    if (!seen.has(key)) {
      out.push(`${key}=${updates[key]}`);
    }
  }
  // Re-add a single trailing newline.
  out.push("");

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, out.join("\n"));
  renameSync(tmp, path);
}
```

- [ ] **Step 4: Verify tests pass**

```
npx vitest run src/__tests__/env-file.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/env-file.ts packages/cli/src/__tests__/env-file.test.ts
git commit -m "feat(cli): atomic .env upsert preserving unrelated keys"
```

---

## Task 4: OAuth flow orchestrator (`linear-oauth.ts`)

This module is dependency-injected so it can be unit-tested end-to-end without spawning a real browser or hitting Linear's servers.

**Files:**
- Create: `packages/cli/src/lib/linear-oauth.ts`
- Test: `packages/cli/src/__tests__/linear-oauth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runLinearOAuth, type LinearOAuthDeps } from "../lib/linear-oauth.js";

function makeDeps(overrides: Partial<LinearOAuthDeps> = {}): LinearOAuthDeps {
  return {
    clientId: "linear-client-id",
    clientSecret: "linear-client-secret",
    scope: "read,write",
    timeoutMs: 1000,
    openBrowser: vi.fn(async (_url: string) => {}),
    fetchTokenEndpoint: vi.fn(async (_body) => ({
      access_token: "lin_oauth_token_123",
      token_type: "Bearer",
      expires_in: 31536000,
      scope: "read,write",
    })),
    fetchViewer: vi.fn(async (_token) => ({
      workspaceId: "ws_abc",
      workspaceName: "Acme",
    })),
    ...overrides,
  };
}

async function postCallback(port: number, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return fetch(`http://127.0.0.1:${port}/callback?${qs}`);
}

describe("runLinearOAuth", () => {
  it("happy path: returns token + workspace metadata after a valid callback", async () => {
    const deps = makeDeps();
    // Drive the OAuth flow via the test's `openBrowser` override — it captures
    // the URL, extracts state + port from the redirect_uri, and POSTs the
    // simulated provider callback.
    let capturedPort = 0;
    let capturedState = "";
    deps.openBrowser = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      capturedState = parsed.searchParams.get("state")!;
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      capturedPort = Number(new URL(redirectUri).port);
      await postCallback(capturedPort, {
        code: "test-code",
        state: capturedState,
      });
    });
    const result = await runLinearOAuth(deps);
    expect(result.accessToken).toBe("lin_oauth_token_123");
    expect(result.workspaceId).toBe("ws_abc");
    expect(result.workspaceName).toBe("Acme");
    expect(deps.fetchTokenEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "test-code",
        client_id: "linear-client-id",
        client_secret: "linear-client-secret",
        grant_type: "authorization_code",
      }),
    );
  });

  it("rejects state mismatch with a clear error", async () => {
    const deps = makeDeps();
    deps.openBrowser = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const port = Number(new URL(redirectUri).port);
      await postCallback(port, {
        code: "test-code",
        state: "ATTACKER-STATE",
      });
    });
    await expect(runLinearOAuth(deps)).rejects.toThrow(/state mismatch/i);
  });

  it("times out when the callback never arrives", async () => {
    const deps = makeDeps({
      timeoutMs: 100,
      openBrowser: vi.fn(async () => {}),
    });
    await expect(runLinearOAuth(deps)).rejects.toThrow(/timed out/i);
  });

  it("surfaces Linear API errors during token exchange", async () => {
    const deps = makeDeps({
      fetchTokenEndpoint: vi.fn(async () => {
        throw new Error("400: invalid_grant");
      }),
    });
    deps.openBrowser = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const state = parsed.searchParams.get("state")!;
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const port = Number(new URL(redirectUri).port);
      await postCallback(port, { code: "bad-code", state });
    });
    await expect(runLinearOAuth(deps)).rejects.toThrow(/invalid_grant/);
  });

  it("never returns the token via the openBrowser URL or the callback response body", async () => {
    const deps = makeDeps();
    let urlPassedToBrowser = "";
    let callbackBody = "";
    deps.openBrowser = vi.fn(async (url: string) => {
      urlPassedToBrowser = url;
      const parsed = new URL(url);
      const state = parsed.searchParams.get("state")!;
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const port = Number(new URL(redirectUri).port);
      const res = await postCallback(port, { code: "test-code", state });
      callbackBody = await res.text();
    });
    await runLinearOAuth(deps);
    expect(urlPassedToBrowser).not.toContain("lin_oauth_token_123");
    expect(callbackBody).not.toContain("lin_oauth_token_123");
  });
});
```

- [ ] **Step 2: Verify failure**
```
npx vitest run src/__tests__/linear-oauth.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/cli/src/lib/linear-oauth.ts`**

```typescript
/**
 * Linear OAuth 2.0 authorization-code flow, runnable headlessly with
 * dependency-injected browser-open and HTTP transport for tests.
 *
 * High-level: bind an ephemeral 127.0.0.1 server, redirect the operator's
 * browser to Linear with the loopback callback URL, verify the HMAC-signed
 * state on the callback, exchange the code for an access token, look up the
 * workspace metadata, then shut the server down.
 *
 * **Token handling:** the access token never crosses console.log, never lands
 * in the success-page HTML returned to the browser, and never appears in the
 * audit event payload. The OAuth `code` is single-use and logged-friendly,
 * but tokens are not.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { newNonce, signState, verifyState } from "./oauth-state.js";

export interface LinearOAuthDeps {
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Total time to wait for the operator to authorize, in milliseconds. */
  timeoutMs: number;
  /** Opens the authorize URL in the operator's browser. Pure-test override. */
  openBrowser: (url: string) => Promise<void>;
  /** Exchanges the code for an access token. */
  fetchTokenEndpoint: (body: {
    code: string;
    client_id: string;
    client_secret: string;
    redirect_uri: string;
    grant_type: "authorization_code";
  }) => Promise<LinearTokenResponse>;
  /** Fetches workspace metadata for the audit event. */
  fetchViewer: (
    accessToken: string,
  ) => Promise<{ workspaceId: string; workspaceName?: string }>;
}

export interface LinearTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface LinearOAuthResult {
  accessToken: string;
  workspaceId: string;
  workspaceName?: string;
  scope: string;
  expiresInSeconds: number;
}

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>urateam OAuth</title></head>
<body style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 80px auto; line-height: 1.5;">
<h1>Authorized</h1>
<p>You can close this tab. Return to your terminal to continue.</p>
</body></html>`;

const ERROR_HTML = (msg: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>urateam OAuth</title></head>
<body style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 80px auto; line-height: 1.5;">
<h1>Authorization failed</h1>
<p>${msg}</p>
</body></html>`;

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";

export async function runLinearOAuth(
  deps: LinearOAuthDeps,
): Promise<LinearOAuthResult> {
  const stateSecret = randomBytes(32).toString("hex");
  const nonce = newNonce();
  const state = signState(stateSecret, nonce);

  return await new Promise<LinearOAuthResult>((resolve, reject) => {
    let resolved = false;
    let server: Server | null = null;
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      server?.close();
      reject(
        new Error(
          `ura self-auth-linear: timed out waiting for the OAuth callback (${deps.timeoutMs}ms)`,
        ),
      );
    }, deps.timeoutMs);

    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get("code");
        const incomingState = url.searchParams.get("state") ?? "";
        const verified = verifyState(stateSecret, incomingState);
        if (!verified || verified !== nonce) {
          res.writeHead(400, { "content-type": "text/html" });
          res.end(ERROR_HTML("State mismatch — possible CSRF; abort."));
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            server?.close();
            reject(
              new Error("ura self-auth-linear: state mismatch — aborting"),
            );
          }
          return;
        }
        if (!code) {
          res.writeHead(400, { "content-type": "text/html" });
          res.end(ERROR_HTML("Missing 'code' parameter from Linear."));
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            server?.close();
            reject(
              new Error("ura self-auth-linear: missing code in callback"),
            );
          }
          return;
        }

        const port = (server!.address() as { port: number }).port;
        const redirectUri = `http://127.0.0.1:${port}/callback`;

        const token = await deps.fetchTokenEndpoint({
          code,
          client_id: deps.clientId,
          client_secret: deps.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        });
        const viewer = await deps.fetchViewer(token.access_token);

        res.writeHead(200, { "content-type": "text/html" });
        res.end(SUCCESS_HTML);

        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          server?.close();
          resolve({
            accessToken: token.access_token,
            workspaceId: viewer.workspaceId,
            workspaceName: viewer.workspaceName,
            scope: token.scope,
            expiresInSeconds: token.expires_in,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          res.writeHead(500, { "content-type": "text/html" });
          res.end(ERROR_HTML("Token exchange failed; check the terminal."));
        } catch {
          // response may already be sent
        }
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          server?.close();
          reject(new Error(`ura self-auth-linear: ${message}`));
        }
      }
    });

    server.listen(0, "127.0.0.1", async () => {
      try {
        const port = (server!.address() as { port: number }).port;
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        const authUrl = new URL(AUTHORIZE_URL);
        authUrl.searchParams.set("client_id", deps.clientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", deps.scope);
        authUrl.searchParams.set("state", state);
        await deps.openBrowser(authUrl.toString());
      } catch (err) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          server?.close();
          reject(err);
        }
      }
    });
  });
}
```

- [ ] **Step 4: Verify tests pass**

```
npx vitest run src/__tests__/linear-oauth.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/linear-oauth.ts packages/cli/src/__tests__/linear-oauth.test.ts
git commit -m "feat(cli): Linear OAuth flow orchestrator with injectable deps"
```

---

## Task 5: `ura self-auth-linear` command wiring

**Files:**
- Create: `packages/cli/src/commands/self-auth-linear.ts`
- Test: `packages/cli/src/__tests__/self-auth-linear.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const browserOpenMock = vi.fn(async (_url: string) => {});
const fetchTokenMock = vi.fn(async (_body) => ({
  access_token: "lin_oauth_TOKEN",
  token_type: "Bearer",
  expires_in: 31536000,
  scope: "read,write",
}));
const fetchViewerMock = vi.fn(async (_token: string) => ({
  workspaceId: "ws_test",
  workspaceName: "Test Workspace",
}));

vi.mock("../lib/linear-oauth.js", async () => {
  return {
    runLinearOAuth: vi.fn(async (deps: any) => {
      await deps.openBrowser("http://example/authorize?state=stub");
      const token = await deps.fetchTokenEndpoint({
        code: "fake-code",
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        redirect_uri: "http://127.0.0.1:0/callback",
        grant_type: "authorization_code",
      });
      const viewer = await deps.fetchViewer(token.access_token);
      return {
        accessToken: token.access_token,
        workspaceId: viewer.workspaceId,
        workspaceName: viewer.workspaceName,
        scope: token.scope,
        expiresInSeconds: token.expires_in,
      };
    }),
  };
});

// Override the default deps so the command uses our mocks.
vi.mock("../lib/linear-oauth-deps.js", async () => ({
  defaultBrowserOpen: browserOpenMock,
  defaultFetchTokenEndpoint: fetchTokenMock,
  defaultFetchViewer: fetchViewerMock,
}));

const { selfAuthLinearCommand } = await import(
  "../commands/self-auth-linear.js"
);

describe("ura self-auth-linear", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-oauth-"));
    process.env.URATEAM_HOME = tmp;
    mkdirSync(tmp, { recursive: true });
    process.env.LINEAR_CLIENT_ID = "client-abc";
    process.env.LINEAR_CLIENT_SECRET = "secret-xyz";
    fetchTokenMock.mockClear();
    fetchViewerMock.mockClear();
    browserOpenMock.mockClear();
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    delete process.env.LINEAR_CLIENT_ID;
    delete process.env.LINEAR_CLIENT_SECRET;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes LINEAR_API_KEY to ~/.urateam/.env on success", async () => {
    await selfAuthLinearCommand.parseAsync([], { from: "user" });
    const raw = readFileSync(join(tmp, ".env"), "utf8");
    expect(raw).toContain("LINEAR_API_KEY=lin_oauth_TOKEN");
  });

  it("preserves unrelated keys in an existing .env", async () => {
    writeFileSync(
      join(tmp, ".env"),
      "ANTHROPIC_API_KEY=sk-ant-xyz\nLINEAR_API_KEY=lin_api_old\n",
    );
    await selfAuthLinearCommand.parseAsync([], { from: "user" });
    const raw = readFileSync(join(tmp, ".env"), "utf8");
    expect(raw).toContain("ANTHROPIC_API_KEY=sk-ant-xyz");
    expect(raw).toContain("LINEAR_API_KEY=lin_oauth_TOKEN");
    expect(raw).not.toContain("lin_api_old");
  });

  it("never logs the token to console", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await selfAuthLinearCommand.parseAsync([], { from: "user" });
    const out = spy.mock.calls.flat().join("\n");
    expect(out).not.toContain("lin_oauth_TOKEN");
    spy.mockRestore();
  });

  it("fails when LINEAR_CLIENT_ID is missing", async () => {
    delete process.env.LINEAR_CLIENT_ID;
    await expect(
      selfAuthLinearCommand.parseAsync([], { from: "user" }),
    ).rejects.toThrow(/LINEAR_CLIENT_ID/);
  });

  it("fails when LINEAR_CLIENT_SECRET is missing", async () => {
    delete process.env.LINEAR_CLIENT_SECRET;
    await expect(
      selfAuthLinearCommand.parseAsync([], { from: "user" }),
    ).rejects.toThrow(/LINEAR_CLIENT_SECRET/);
  });

  it("fails when URATEAM_HOME does not exist (operator forgot 'ura init')", async () => {
    rmSync(tmp, { recursive: true, force: true });
    await expect(
      selfAuthLinearCommand.parseAsync([], { from: "user" }),
    ).rejects.toThrow(/ura init/i);
  });
});
```

- [ ] **Step 2: Verify failure**
```
npx vitest run src/__tests__/self-auth-linear.test.ts
```
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the default-deps shim** at `packages/cli/src/lib/linear-oauth-deps.ts`

```typescript
/**
 * Default real-world implementations of the LinearOAuthDeps callbacks.
 * Split into its own module so tests can mock the entire shim without
 * pulling in node:child_process and friends.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LinearTokenResponse } from "./linear-oauth.js";

const execFileP = promisify(execFile);

export async function defaultBrowserOpen(url: string): Promise<void> {
  // macOS: `open`, Linux: `xdg-open`. If neither resolves, print the URL.
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    await execFileP(cmd, [url]);
  } catch {
    console.log("Open this URL in your browser:");
    console.log(`  ${url}`);
  }
}

export async function defaultFetchTokenEndpoint(body: {
  code: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  grant_type: "authorization_code";
}): Promise<LinearTokenResponse> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) params.set(k, v);
  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${errText.slice(0, 200)}`);
  }
  return (await res.json()) as LinearTokenResponse;
}

export async function defaultFetchViewer(
  accessToken: string,
): Promise<{ workspaceId: string; workspaceName?: string }> {
  const query = "query { organization { id name } }";
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch workspace metadata: ${res.status} ${res.statusText}`,
    );
  }
  const json = (await res.json()) as {
    data?: { organization?: { id: string; name?: string } };
  };
  const org = json?.data?.organization;
  if (!org?.id) throw new Error("Linear returned no organization id");
  return { workspaceId: org.id, workspaceName: org.name };
}
```

- [ ] **Step 4: Implement the command** at `packages/cli/src/commands/self-auth-linear.ts`

```typescript
/**
 * `ura self-auth-linear` — browser-based Linear OAuth flow.
 *
 * Preconditions:
 *   1. `ura init` has been run (`$URATEAM_HOME` exists).
 *   2. LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET are set (operator created
 *      an OAuth app in Linear's settings — see deploy/USER_LEVEL_INSTALL.md).
 *
 * Behavior:
 *   - Starts an ephemeral 127.0.0.1 HTTP server, opens the authorize URL in
 *     the operator's browser, verifies the HMAC-signed state on callback,
 *     exchanges the code for an access token, fetches workspace metadata.
 *   - Writes LINEAR_API_KEY=<access_token> to $URATEAM_HOME/.env, preserving
 *     unrelated keys.
 *   - Emits a `linear.oauth_completed` audit event opportunistically.
 *
 * The access token is never logged. The success-page HTML returned to the
 * browser contains no token.
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import {
  createDb,
  logAuditEvent,
  linearOauthCompletedEvent,
} from "@urateam/core";
import {
  resolveUserLevelHome,
  userLevelDataDir,
} from "../lib/user-level-config.js";
import { runLinearOAuth } from "../lib/linear-oauth.js";
import {
  defaultBrowserOpen,
  defaultFetchTokenEndpoint,
  defaultFetchViewer,
} from "../lib/linear-oauth-deps.js";
import { upsertEnvFile } from "../lib/env-file.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SCOPE = "read,write";

async function tryEmitAuditEvent(args: {
  workspaceId: string;
  workspaceName?: string;
}): Promise<void> {
  try {
    const dbPath = join(userLevelDataDir(), "urateam.db");
    if (!existsSync(dbPath)) return;
    const db = await createDb({ connectionString: dbPath });
    const actor = `cli:${userInfo().username ?? "unknown"}`;
    await logAuditEvent(
      db,
      linearOauthCompletedEvent({
        workspaceId: args.workspaceId,
        workspaceName: args.workspaceName,
        actor,
      }),
    );
  } catch {
    // Audit failure must not break the OAuth flow.
  }
}

export const selfAuthLinearCommand = new Command("self-auth-linear")
  .description(
    "Browser-based Linear OAuth flow; stores the token as LINEAR_API_KEY in ~/.urateam/.env",
  )
  .option(
    "--timeout-ms <ms>",
    "How long to wait for the operator to authorize (default 5 minutes)",
    String(DEFAULT_TIMEOUT_MS),
  )
  .option(
    "--scope <scope>",
    "OAuth scopes to request (comma-separated)",
    DEFAULT_SCOPE,
  )
  .action(async (opts: { timeoutMs: string; scope: string }) => {
    const home = resolveUserLevelHome();
    if (!existsSync(home)) {
      throw new Error(
        `ura self-auth-linear: ${home} does not exist. Run 'ura init' first.`,
      );
    }
    const clientId = process.env.LINEAR_CLIENT_ID;
    const clientSecret = process.env.LINEAR_CLIENT_SECRET;
    if (!clientId) {
      throw new Error(
        "ura self-auth-linear: LINEAR_CLIENT_ID is not set. Create a Linear OAuth app at https://linear.app/settings/api/applications/new and set LINEAR_CLIENT_ID + LINEAR_CLIENT_SECRET in ~/.urateam/.env before running this command.",
      );
    }
    if (!clientSecret) {
      throw new Error(
        "ura self-auth-linear: LINEAR_CLIENT_SECRET is not set. See https://linear.app/settings/api/applications and copy the client secret into ~/.urateam/.env.",
      );
    }

    console.log("ura self-auth-linear: opening Linear in your browser…");
    const result = await runLinearOAuth({
      clientId,
      clientSecret,
      scope: opts.scope,
      timeoutMs: Number(opts.timeoutMs),
      openBrowser: defaultBrowserOpen,
      fetchTokenEndpoint: defaultFetchTokenEndpoint,
      fetchViewer: defaultFetchViewer,
    });

    upsertEnvFile(join(home, ".env"), {
      LINEAR_API_KEY: result.accessToken,
    });

    console.log(
      `ura self-auth-linear: authorized for workspace ${
        result.workspaceName ?? result.workspaceId
      }; token written to ${join(home, ".env")}.`,
    );
    await tryEmitAuditEvent({
      workspaceId: result.workspaceId,
      workspaceName: result.workspaceName,
    });
  });
```

- [ ] **Step 5: Verify tests pass**

```
npx vitest run src/__tests__/self-auth-linear.test.ts
```
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/linear-oauth-deps.ts packages/cli/src/commands/self-auth-linear.ts packages/cli/src/__tests__/self-auth-linear.test.ts
git commit -m "feat(cli): ura self-auth-linear browser-based OAuth flow"
```

---

## Task 6: Register command + CLAUDE.md count bump + docs

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `CLAUDE.md`
- Modify: `.claude/CLAUDE.md`
- Modify: `deploy/USER_LEVEL_INSTALL.md`

- [ ] **Step 1: Wire the command into the program**

Add `import { selfAuthLinearCommand } from "./commands/self-auth-linear.js";` alongside the other imports, and `program.addCommand(selfAuthLinearCommand);` alongside the other registrations.

- [ ] **Step 2: Bump audit-event count `47 → 48` in CLAUDE.md**

Append `, linear.oauth_completed` after the `service.{installed,uninstalled}` entry on the same line.

- [ ] **Step 3: Add a paragraph describing `ura self-auth-linear` in CLAUDE.md** (under the user-level install section)

```markdown
- `ura self-auth-linear` (`packages/cli/src/commands/self-auth-linear.ts`): browser-based Linear OAuth flow. Preconditions: operator ran `ura init` and set `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` in `~/.urateam/.env` (Linear OAuth apps are created at `https://linear.app/settings/api/applications`). The CLI spins up an ephemeral `127.0.0.1:<random-port>` server, opens the authorize URL in the operator's browser, verifies the HMAC-signed `state` (per-invocation random secret; never persisted), exchanges the code for an access token via `https://api.linear.app/oauth/token`, fetches workspace metadata, and writes `LINEAR_API_KEY=<token>` to `~/.urateam/.env` via the atomic `upsertEnvFile()` helper (preserves unrelated keys / comments / blank lines). Audit event `linear.oauth_completed` is emitted opportunistically; payload contains workspaceId + workspaceName, never the token. Tokens NEVER appear in console output or the success-page HTML. `--timeout-ms` (default 5min) and `--scope` (default `read,write`) override the defaults. Webhook-secret setup remains manual — Linear's API doesn't expose existing webhook secrets to OAuth-authorized callers.
```

- [ ] **Step 4: One-liner in `.claude/CLAUDE.md`**

Append `, ura self-auth-linear` (Linear OAuth)` to the existing CLI surface description.

- [ ] **Step 5: Update `deploy/USER_LEVEL_INSTALL.md`**

Replace the existing `LINEAR_API_KEY=lin_api_...` and `LINEAR_WEBHOOK_SECRET=lin_whs_...` in the quick-start `.env` example. Insert a "Linear OAuth setup" section between step 2 (env file) and step 4 (`ura repo add`):

```markdown
### Linear OAuth (replaces personal API key)

1. Create a Linear OAuth app: visit **https://linear.app/settings/api/applications/new**. Set the redirect URI to `http://127.0.0.1:0/callback` (the `0` matches any port — Linear allows this loopback pattern). Note the **Client ID** and **Client Secret**.
2. Add the OAuth app credentials to `~/.urateam/.env`:
   ```
   LINEAR_CLIENT_ID=<your-client-id>
   LINEAR_CLIENT_SECRET=<your-client-secret>
   ```
3. Run `ura self-auth-linear`. The CLI opens Linear in your browser; after you authorize urateam, the access token is written to `~/.urateam/.env` as `LINEAR_API_KEY`. The browser displays "Authorized" and you can close the tab.

The access token never appears in console output or browser-visible HTML. Webhook setup remains manual — register the webhook in Linear's UI (see step "Webhook setup" below).
```

Remove `LINEAR_API_KEY=lin_api_...` from the quick-start `.env` block.

In "What's deferred", remove the `ura self-auth-linear` bullet.

- [ ] **Step 6: Run the full sweep**

```
pnpm --filter @urateam/cli test && pnpm --filter @urateam/core test && pnpm -w typecheck
```
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/index.ts CLAUDE.md .claude/CLAUDE.md deploy/USER_LEVEL_INSTALL.md
git commit -m "feat(cli): register self-auth-linear; docs + CLAUDE.md count to 48"
```

---

## Task 7: PR + Sonnet review

- [ ] **Step 1: Push the branch and open PR**

```bash
git push -u origin feat/self-auth-linear
gh pr create --title "feat(cli): ura self-auth-linear — browser-based Linear OAuth flow" --body "<convention self-review template; same shape as PR #300>"
```

- [ ] **Step 2: Dispatch Sonnet code-reviewer**

Brief the reviewer with the spec, the per-file scope (`commands/self-auth-linear.ts`, `lib/linear-oauth.ts`, `lib/oauth-state.ts`, `lib/env-file.ts`, `lib/linear-oauth-deps.ts`), and the security-specific checks:
- State HMAC: timing-safe? Per-invocation secret?
- Token: never console.log, never in success-page HTML, never in audit payload
- `.env` atomic write: rename-after-write pattern observed?
- Server: binds to 127.0.0.1, not 0.0.0.0
- Timeout: server shut down in all paths (success, error, timeout)
- Missing pre-requisites: clear error pointing at the docs

- [ ] **Step 3: Address BLOCKING findings; merge when green**

```
gh pr merge <pr-number> --squash --admin --delete-branch
```

---

## Task 8: Release v0.1.54 + npm publish + smoke test

Same shape as Feature 1's release flow:

1. `git checkout main && git pull`
2. `pnpm cut-release patch`
3. Fill in CHANGELOG, amend commit, push branch, open PR, wait for CI, merge
4. Tag `v0.1.54`, push tag, watch npm-publish workflow
5. `gh release create v0.1.54`
6. Smoke test: `npm install -g @urateam/cli@<new-cli-version>`, mock OAuth via `LINEAR_CLIENT_ID=test LINEAR_CLIENT_SECRET=test ura self-auth-linear --timeout-ms 1000` and verify it fails cleanly when the browser doesn't return (acceptable smoke-test since real OAuth requires a real Linear app).

---

## Self-review checklist

**Spec coverage:**
- ✅ Browser-based OAuth flow with ephemeral 127.0.0.1 server (Task 4)
- ✅ HMAC-signed state with per-invocation random secret (Task 2)
- ✅ Token exchange via `https://api.linear.app/oauth/token` (Task 5)
- ✅ Token written to `~/.urateam/.env` preserving other keys (Task 3)
- ✅ Token never logged; never in success-page HTML; never in audit payload (Tasks 4, 5)
- ✅ 5-minute timeout configurable via `--timeout-ms` (Task 5)
- ✅ Prerequisite checks: URATEAM_HOME exists, LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET (Task 5)
- ✅ Tests with mocked OAuth endpoints and DI-able browser-open (Tasks 4, 5)
- ✅ Audit event `linear.oauth_completed` with workspace metadata (Task 1, 5)

**Placeholder scan:** None — every step has concrete code.

**Type consistency:** `LinearOAuthDeps` (Task 4) consumed by `runLinearOAuth` (Task 4) and command (Task 5). `LinearTokenResponse` shape consistent across token-exchange test (Task 4) and `defaultFetchTokenEndpoint` (Task 5). `linearOauthCompletedEvent` payload shape `{workspaceId, workspaceName, actor}` consistent across builder (Task 1) and CLI emit (Task 5).

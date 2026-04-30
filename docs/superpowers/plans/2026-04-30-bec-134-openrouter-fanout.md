# BEC-134 OpenRouter Multi-Model Fanout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send the review stage to N models in parallel via OpenRouter. Findings post as labeled PR comments; existing agentic deep-review remains the merge gate.

**Architecture:** New `ReviewProvider` interface with two implementations: `AgenticDeepReviewProvider` (thin wrapper around the existing single-pass `runDeepReview`) and `OpenRouterFanoutProvider` (N parallel single-shot chat-completions). Fanout runs **once** outside the existing multi-pass convergence loop; agentic continues per-pass via its wrapper. Per-model results persist to a new `review_model_runs` table.

**Tech Stack:** TypeScript, Node 20+, drizzle-orm (SQLite + Postgres), vitest, fetch (Node native), Octokit. Existing patterns: `process.env` direct reads, vitest mocks for `fetch`.

**Spec:** `docs/superpowers/specs/2026-04-30-bec-134-openrouter-fanout-design.md`

---

## File Structure

```
packages/core/src/executor/review/
  review-provider.ts             # interface + ReviewModelRun type + registry
  agentic-deep-review.ts         # AgenticDeepReviewProvider — wraps runDeepReview()
  openrouter-client.ts           # low-level fetch wrapper for /chat/completions
  review-prompt.ts               # buildReviewPrompt() + parseReviewFindings()
  openrouter-fanout.ts           # OpenRouterFanoutProvider — Promise.allSettled fanout
  post-fanout-comments.ts        # render markdown + addPRComment per run

packages/core/src/db/
  schema.ts                      # ADD reviewModelRuns table
  migrations/sqlite/008_review_model_runs.sql
  migrations/postgres/009_review_model_runs.sql
  review-model-runs.ts           # NEW — insertReviewModelRuns(stageRunId, runs[])

packages/core/src/cost/
  per-run.ts                     # JOIN review_model_runs in rollup

packages/core/src/pipeline/
  runner.ts                      # MODIFY — replace runDeepReview call site

packages/core/src/__tests__/
  review-provider-registry.test.ts
  agentic-deep-review-provider.test.ts
  openrouter-client.test.ts
  review-prompt.test.ts
  openrouter-fanout.test.ts
  post-fanout-comments.test.ts
  db-review-model-runs.test.ts
  cost/per-run-multi-model.test.ts
  e2e-pipeline.test.ts            # EXTEND existing

packages/create-urateam/
  src/index.ts                   # MODIFY — optional ScaffoldOptions + buildEnv
  template/.urateam/.env.example # MODIFY — add commented fanout block
```

Order rationale: types & schema first (Task 1, 3), pure helpers next (Task 4–6), assembly (Task 7–9), wire-up last (Task 10–13). Each task is independently committable; tests pass after every commit.

---

## Task 1: ReviewProvider interface and ReviewModelRun type

**Files:**
- Create: `packages/core/src/executor/review/review-provider.ts`
- Test: `packages/core/src/__tests__/review-provider-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/review-provider-registry.test.ts
import { describe, it, expect } from "vitest";
import {
  getEnabledProviders,
  type ReviewProvider,
  type ReviewModelRun,
  type ReviewContext,
} from "../executor/review/review-provider.js";

describe("review-provider registry", () => {
  it("exports the ReviewProvider interface and ReviewModelRun type", () => {
    // Compile-time existence check via type assignment
    const _checkRun: ReviewModelRun = {
      modelId: "x",
      providerId: "agentic",
      status: "completed",
      findings: [],
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    };
    expect(_checkRun.modelId).toBe("x");
  });

  it("returns at least the agentic provider when env is empty", () => {
    const providers = getEnabledProviders({});
    expect(providers.length).toBeGreaterThanOrEqual(1);
    expect(providers.some((p) => p.id === "agentic")).toBe(true);
  });

  it("ReviewProvider has runReview signature", () => {
    const providers = getEnabledProviders({});
    const p: ReviewProvider = providers[0];
    expect(typeof p.runReview).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test -- review-provider-registry`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the interface and a stub registry**

```ts
// packages/core/src/executor/review/review-provider.ts
import type { HandoffArtifact, ReviewFinding } from "../../types.js";

export type ReviewProviderId = "agentic" | "openrouter";

export interface ReviewContext {
  runId: string;
  stageRunId: string;
  workdir: string;
  handoff: HandoffArtifact;
  baseRef: string;
  prNumber: number | null;
}

export interface ReviewModelRun {
  modelId: string;
  providerId: ReviewProviderId;
  status: "completed" | "failed";
  findings: ReviewFinding[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  errorMessage?: string;
  truncatedFiles?: number;
}

export interface ReviewProvider {
  readonly id: ReviewProviderId;
  runReview(ctx: ReviewContext): Promise<ReviewModelRun[]>;
}

// Stub registry — Task 7 fills in real selection logic.
// For now, returns only a placeholder that satisfies the interface, so callers
// in later tasks can typecheck. AgenticDeepReviewProvider arrives in Task 2;
// we wire it in here at that point.
const placeholderAgentic: ReviewProvider = {
  id: "agentic",
  async runReview(_ctx) {
    return [];
  },
};

export function getEnabledProviders(_env: NodeJS.ProcessEnv): ReviewProvider[] {
  return [placeholderAgentic];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @urateam/core test -- review-provider-registry`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/executor/review/review-provider.ts \
        packages/core/src/__tests__/review-provider-registry.test.ts
git commit -m "feat(core): ReviewProvider interface and registry stub (BEC-134)"
```

---

## Task 2: AgenticDeepReviewProvider — thin wrapper around runDeepReview

**Files:**
- Create: `packages/core/src/executor/review/agentic-deep-review.ts`
- Test: `packages/core/src/__tests__/agentic-deep-review-provider.test.ts`
- Modify: `packages/core/src/executor/review/review-provider.ts` (replace placeholder)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/agentic-deep-review-provider.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HandoffArtifact } from "../types.js";

const runDeepReviewMock = vi.fn();
vi.mock("../executor/deep-review.js", () => ({
  runDeepReview: (...args: unknown[]) => runDeepReviewMock(...args),
  deepFindingsToReviewFindings: (findings: unknown[]) => findings,
}));

const makeHandoff = (): HandoffArtifact => ({
  runId: "r1",
  issueId: "i1",
  stage: "review",
  timestamp: new Date().toISOString(),
  summary: "",
  filesChanged: [],
  approach: "",
  context: { issueIntent: "do x", constraints: [], assumptions: [] },
  tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 },
});

describe("AgenticDeepReviewProvider", () => {
  beforeEach(() => runDeepReviewMock.mockReset());

  it("returns a single ReviewModelRun with completed status on success", async () => {
    runDeepReviewMock.mockResolvedValue({
      findings: [
        { severity: "warning", file: "a.ts", line: 1, category: "x", description: "d", fix: "f" },
      ],
      inputTokens: 100,
      outputTokens: 50,
    });

    const { AgenticDeepReviewProvider } = await import(
      "../executor/review/agentic-deep-review.js"
    );
    const provider = new AgenticDeepReviewProvider();

    const runs = await provider.runReview({
      runId: "r1",
      stageRunId: "s1",
      workdir: "/tmp/x",
      handoff: makeHandoff(),
      baseRef: "main",
      prNumber: null,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0].providerId).toBe("agentic");
    expect(runs[0].status).toBe("completed");
    expect(runs[0].modelId).toBe("claude-haiku-4-5-20251001");
    expect(runs[0].findings).toHaveLength(1);
    expect(runs[0].inputTokens).toBe(100);
    expect(runs[0].outputTokens).toBe(50);
    expect(runDeepReviewMock).toHaveBeenCalledOnce();
  });

  it("returns failed run with errorMessage when runDeepReview throws", async () => {
    runDeepReviewMock.mockRejectedValue(new Error("agent sdk down"));
    const { AgenticDeepReviewProvider } = await import(
      "../executor/review/agentic-deep-review.js"
    );
    const provider = new AgenticDeepReviewProvider();

    const runs = await provider.runReview({
      runId: "r1",
      stageRunId: "s1",
      workdir: "/tmp/x",
      handoff: makeHandoff(),
      baseRef: "main",
      prNumber: null,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].errorMessage).toContain("agent sdk down");
    expect(runs[0].findings).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test -- agentic-deep-review-provider`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the wrapper**

```ts
// packages/core/src/executor/review/agentic-deep-review.ts
import { runDeepReview, deepFindingsToReviewFindings } from "../deep-review.js";
import type { ReviewProvider, ReviewModelRun, ReviewContext } from "./review-provider.js";

const DEEP_REVIEW_MODEL = "claude-haiku-4-5-20251001";

export class AgenticDeepReviewProvider implements ReviewProvider {
  readonly id = "agentic" as const;

  async runReview(ctx: ReviewContext): Promise<ReviewModelRun[]> {
    const startedAt = Date.now();
    try {
      const result = await runDeepReview(ctx.handoff, ctx.workdir);
      return [
        {
          modelId: DEEP_REVIEW_MODEL,
          providerId: "agentic",
          status: "completed",
          findings: deepFindingsToReviewFindings(result.findings),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs: Date.now() - startedAt,
        },
      ];
    } catch (err) {
      return [
        {
          modelId: DEEP_REVIEW_MODEL,
          providerId: "agentic",
          status: "failed",
          findings: [],
          inputTokens: 0,
          outputTokens: 0,
          durationMs: Date.now() - startedAt,
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      ];
    }
  }
}
```

- [ ] **Step 4: Wire into the registry (replace placeholder)**

```ts
// packages/core/src/executor/review/review-provider.ts
// Replace the placeholderAgentic block + getEnabledProviders body with:

import { AgenticDeepReviewProvider } from "./agentic-deep-review.js";

export function getEnabledProviders(_env: NodeJS.ProcessEnv): ReviewProvider[] {
  return [new AgenticDeepReviewProvider()];
}
```

(Keep the interface and types above untouched. Delete the `placeholderAgentic` constant.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @urateam/core test -- agentic-deep-review-provider review-provider-registry`
Expected: PASS (5 tests total).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/executor/review/agentic-deep-review.ts \
        packages/core/src/executor/review/review-provider.ts \
        packages/core/src/__tests__/agentic-deep-review-provider.test.ts
git commit -m "feat(core): AgenticDeepReviewProvider wraps runDeepReview (BEC-134)"
```

---

## Task 3: Schema migration — review_model_runs table

**Files:**
- Create: `packages/core/src/db/migrations/sqlite/008_review_model_runs.sql`
- Create: `packages/core/src/db/migrations/postgres/009_review_model_runs.sql`
- Modify: `packages/core/src/db/schema.ts` (add table at end)
- Test: `packages/core/src/__tests__/db-review-model-runs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/db-review-model-runs.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrationsSqlite } from "../db/migrator.js";

describe("review_model_runs migration (sqlite)", () => {
  it("creates the table with expected columns", () => {
    const db = new Database(":memory:");
    runMigrationsSqlite(db);

    const cols = db
      .prepare("PRAGMA table_info(review_model_runs)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "completed_at",
        "duration_ms",
        "error_message",
        "id",
        "input_tokens",
        "model_id",
        "output_tokens",
        "provider_id",
        "stage_run_id",
        "started_at",
        "status",
        "truncated_files",
      ].sort(),
    );
  });

  it("creates an index on stage_run_id", () => {
    const db = new Database(":memory:");
    runMigrationsSqlite(db);
    const indexes = db
      .prepare("PRAGMA index_list(review_model_runs)")
      .all() as Array<{ name: string }>;
    expect(indexes.some((i) => i.name.includes("stage_run_id"))).toBe(true);
  });

  it("inserts and reads rows", () => {
    const db = new Database(":memory:");
    runMigrationsSqlite(db);

    // Need a stage_run row first (FK)
    db.prepare(
      "INSERT INTO pipeline_runs (id, issue_id, issue_title, pipeline_key, repo_url, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "i1", "t", "k", "u", "running", Math.floor(Date.now() / 1000));
    db.prepare(
      "INSERT INTO stage_runs (id, pipeline_run_id, stage, status, started_at) VALUES (?, ?, ?, ?, ?)",
    ).run("s1", "p1", "review", "completed", Math.floor(Date.now() / 1000));

    db.prepare(
      "INSERT INTO review_model_runs (id, stage_run_id, provider_id, model_id, status, input_tokens, output_tokens, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("r1", "s1", "openrouter", "anthropic/claude-3.5-sonnet", "completed", 100, 50, 1000);

    const rows = db
      .prepare("SELECT * FROM review_model_runs WHERE stage_run_id = ?")
      .all("s1");
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test -- db-review-model-runs`
Expected: FAIL — `no such table: review_model_runs`.

- [ ] **Step 3: Add the SQLite migration**

```sql
-- packages/core/src/db/migrations/sqlite/008_review_model_runs.sql
-- BEC-134: per-model results from review-stage fanout.
CREATE TABLE IF NOT EXISTS review_model_runs (
  id TEXT PRIMARY KEY,
  stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  truncated_files INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_review_model_runs_stage_run_id
  ON review_model_runs(stage_run_id);
```

- [ ] **Step 4: Add the Postgres migration**

```sql
-- packages/core/src/db/migrations/postgres/009_review_model_runs.sql
-- BEC-134: per-model results from review-stage fanout.
CREATE TABLE IF NOT EXISTS review_model_runs (
  id TEXT PRIMARY KEY,
  stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  truncated_files INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_review_model_runs_stage_run_id
  ON review_model_runs(stage_run_id);
```

- [ ] **Step 5: Add the drizzle table definition**

Append to `packages/core/src/db/schema.ts` (after the existing tables):

```ts
export const reviewModelRuns = sqliteTable("review_model_runs", {
  id: text("id").primaryKey(),
  stageRunId: text("stage_run_id")
    .notNull()
    .references(() => stageRuns.id),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  status: text("status").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  errorMessage: text("error_message"),
  truncatedFiles: integer("truncated_files").notNull().default(0),
  startedAt: crossTimestamp("started_at"),
  completedAt: crossTimestamp("completed_at"),
});
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @urateam/core test -- db-review-model-runs db.test`
Expected: PASS. Existing migrator tests still pass (no regression).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/db/migrations/sqlite/008_review_model_runs.sql \
        packages/core/src/db/migrations/postgres/009_review_model_runs.sql \
        packages/core/src/db/schema.ts \
        packages/core/src/__tests__/db-review-model-runs.test.ts
git commit -m "feat(core): review_model_runs schema + migrations (BEC-134)"
```

---

## Task 4: OpenRouterClient — low-level chat-completion wrapper

**Files:**
- Create: `packages/core/src/executor/review/openrouter-client.ts`
- Test: `packages/core/src/__tests__/openrouter-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/openrouter-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("OpenRouterClient", () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts to /chat/completions with auth header and returns content + tokens", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { OpenRouterClient } = await import("../executor/review/openrouter-client.js");
    const client = new OpenRouterClient({
      apiKey: "sk-or-test",
      baseUrl: "https://example.test/api/v1",
    });
    const result = await client.chatCompletion(
      "anthropic/claude-3.5-sonnet",
      [{ role: "user", content: "hi" }],
      { signal: new AbortController().signal },
    );
    expect(result).toEqual({ content: "hello", inputTokens: 12, outputTokens: 7 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/v1/chat/completions");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-or-test");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("throws on non-2xx with status and snippet of body", async () => {
    fetchMock.mockResolvedValue(
      new Response("rate limited bro", { status: 429 }),
    );
    const { OpenRouterClient } = await import("../executor/review/openrouter-client.js");
    const client = new OpenRouterClient({ apiKey: "k", baseUrl: "https://example.test/api/v1" });
    await expect(
      client.chatCompletion("m", [{ role: "user", content: "x" }], {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/openrouter 429/);
  });

  it("propagates AbortController abort as a rejection", async () => {
    const ac = new AbortController();
    fetchMock.mockImplementation((_url, init: RequestInit) => {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const { OpenRouterClient } = await import("../executor/review/openrouter-client.js");
    const client = new OpenRouterClient({ apiKey: "k", baseUrl: "https://example.test/api/v1" });
    const p = client.chatCompletion("m", [{ role: "user", content: "x" }], { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test -- openrouter-client`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

```ts
// packages/core/src/executor/review/openrouter-client.ts
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterClientConfig {
  apiKey: string;
  baseUrl: string;
}

export interface ChatCompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ChatCompletionOpts {
  signal: AbortSignal;
  maxTokens?: number;
}

export class OpenRouterClient {
  constructor(private readonly cfg: OpenRouterClientConfig) {}

  async chatCompletion(
    modelId: string,
    messages: ChatMessage[],
    opts: ChatCompletionOpts,
  ): Promise<ChatCompletionResult> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.cfg.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://urateams.com",
        "X-Title": "urateam",
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        max_tokens: opts.maxTokens,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`openrouter ${res.status} ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      content: json.choices[0]?.message?.content ?? "",
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @urateam/core test -- openrouter-client`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/executor/review/openrouter-client.ts \
        packages/core/src/__tests__/openrouter-client.test.ts
git commit -m "feat(core): OpenRouterClient chat-completion wrapper (BEC-134)"
```

---

## Task 5: review-prompt — build prompt and parse model output

**Files:**
- Create: `packages/core/src/executor/review/review-prompt.ts`
- Test: `packages/core/src/__tests__/review-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/review-prompt.test.ts
import { describe, it, expect } from "vitest";
import {
  buildReviewPrompt,
  parseReviewFindings,
  estimateTokens,
} from "../executor/review/review-prompt.js";
import type { HandoffArtifact } from "../types.js";

const handoff: HandoffArtifact = {
  runId: "r1",
  issueId: "i1",
  stage: "review",
  timestamp: "2026-04-30T00:00:00Z",
  summary: "",
  filesChanged: ["src/foo.ts"],
  approach: "",
  context: {
    issueIntent: "Fix bug X",
    constraints: ["no new deps"],
    assumptions: ["node 20"],
  },
  tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 },
};

describe("buildReviewPrompt", () => {
  it("includes intent, constraints, diff, and JSON-output instruction", () => {
    const prompt = buildReviewPrompt({
      handoff,
      diff: "diff --git a/src/foo.ts b/src/foo.ts\n+++ b/src/foo.ts\n@@\n+x",
      files: [{ path: "src/foo.ts", body: "export const x = 1;" }],
      maxInputTokens: 100_000,
    });
    expect(prompt.messages).toHaveLength(2);
    expect(prompt.messages[0].role).toBe("system");
    expect(prompt.messages[1].role).toBe("user");
    expect(prompt.messages[1].content).toContain("Fix bug X");
    expect(prompt.messages[1].content).toContain("no new deps");
    expect(prompt.messages[1].content).toContain("diff --git");
    expect(prompt.messages[1].content).toContain("export const x = 1;");
    expect(prompt.messages[0].content).toContain("findings");  // schema instruction
    expect(prompt.truncatedFiles).toBe(0);
  });

  it("drops file bodies tail-first when over budget but keeps the diff", () => {
    const big = "x".repeat(20_000);
    const out = buildReviewPrompt({
      handoff,
      diff: "diff --git a/foo b/foo\n+y",
      files: [
        { path: "a.ts", body: big },
        { path: "b.ts", body: big },
        { path: "c.ts", body: big },
      ],
      maxInputTokens: 6_000, // forces truncation
    });
    expect(out.truncatedFiles).toBeGreaterThan(0);
    expect(out.messages[1].content).toContain("diff --git");
  });
});

describe("parseReviewFindings", () => {
  it("extracts the first balanced JSON object and validates against schema", () => {
    const raw = `Sure, here is the review:
\`\`\`json
{ "findings": [
  { "severity": "warning", "file": "a.ts", "line": 1, "category": "x", "description": "d", "fix": "f" }
] }
\`\`\`
End.`;
    const findings = parseReviewFindings(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
  });

  it("throws on malformed JSON", () => {
    expect(() => parseReviewFindings("not json at all")).toThrow();
  });

  it("throws when schema validation fails", () => {
    expect(() => parseReviewFindings('{"findings":[{"bad":true}]}')).toThrow();
  });
});

describe("estimateTokens", () => {
  it("returns a roughly char/4 estimate", () => {
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test -- review-prompt`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the prompt builder + parser**

```ts
// packages/core/src/executor/review/review-prompt.ts
import { z } from "zod";
import { ReviewFindingSchema, type ReviewFinding, type HandoffArtifact } from "../../types.js";
import type { ChatMessage } from "./openrouter-client.js";

const SYSTEM_PROMPT = `You are a careful code reviewer. Review the diff and changed files for issues in three dimensions:
- reuse: duplication of existing code
- quality: bugs, error-handling, type misuse, edge cases
- efficiency: needless work, N+1 queries, hot-loop allocations

Output exactly one JSON object and nothing else, matching this shape:
{ "findings": [
    { "severity": "blocking" | "warning" | "suggestion",
      "file": "path/to/file.ext",
      "line": <integer>,
      "category": "reuse" | "quality" | "efficiency",
      "description": "<concise>",
      "fix": "<concrete suggestion>" }
  ]
}
Return an empty findings array if you find nothing.`;

export interface BuildPromptInput {
  handoff: HandoffArtifact;
  diff: string;
  files: Array<{ path: string; body: string }>;
  maxInputTokens: number;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  estimatedInputTokens: number;
  truncatedFiles: number;
}

/** Cheap heuristic: ~4 chars/token. Good enough to gate truncation. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function buildReviewPrompt(input: BuildPromptInput): BuiltPrompt {
  const { handoff, diff, files, maxInputTokens } = input;
  const intentBlock = [
    "## Intent",
    handoff.context.issueIntent,
    "",
    "## Constraints",
    ...handoff.context.constraints.map((c) => `- ${c}`),
    "",
    "## Assumptions",
    ...handoff.context.assumptions.map((a) => `- ${a}`),
    "",
  ].join("\n");

  const diffBlock = ["## Diff", "```diff", diff, "```", ""].join("\n");

  // Token-budget tail-truncate file bodies. Keep diff and intent always.
  const fixedTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(intentBlock) + estimateTokens(diffBlock);
  let remaining = maxInputTokens - fixedTokens;
  const includedFiles: typeof files = [];
  let truncatedFiles = 0;
  for (const f of files) {
    const block = `\n## File: ${f.path}\n\`\`\`\n${f.body}\n\`\`\`\n`;
    const cost = estimateTokens(block);
    if (cost <= remaining) {
      includedFiles.push(f);
      remaining -= cost;
    } else {
      truncatedFiles += 1;
    }
  }

  const filesBlock = includedFiles
    .map((f) => `\n## File: ${f.path}\n\`\`\`\n${f.body}\n\`\`\`\n`)
    .join("");

  const userContent = `${intentBlock}\n${diffBlock}\n${filesBlock}`;

  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    estimatedInputTokens: fixedTokens + estimateTokens(filesBlock),
    truncatedFiles,
  };
}

const FindingsEnvelopeSchema = z.object({
  findings: z.array(ReviewFindingSchema),
});

/** Extract the first balanced top-level JSON object from a string. */
function extractFirstJsonObject(s: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function parseReviewFindings(raw: string): ReviewFinding[] {
  const objStr = extractFirstJsonObject(raw);
  if (!objStr) throw new Error("model output not parseable as ReviewFinding[]: no JSON object found");
  let parsed: unknown;
  try {
    parsed = JSON.parse(objStr);
  } catch (e) {
    throw new Error(`model output not parseable as ReviewFinding[]: ${(e as Error).message}`);
  }
  const result = FindingsEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`model output not parseable as ReviewFinding[]: ${result.error.message}`);
  }
  return result.data.findings;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @urateam/core test -- review-prompt`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/executor/review/review-prompt.ts \
        packages/core/src/__tests__/review-prompt.test.ts
git commit -m "feat(core): review-prompt builder + parser with token-cap truncation (BEC-134)"
```

---

## Task 6: OpenRouterFanoutProvider — N parallel single-shot reviews

**Files:**
- Create: `packages/core/src/executor/review/openrouter-fanout.ts`
- Test: `packages/core/src/__tests__/openrouter-fanout.test.ts`

This task introduces the per-model fanout. It uses `OpenRouterClient` (Task 4) and `buildReviewPrompt`/`parseReviewFindings` (Task 5). It depends on a small helper that gathers diff + changed-file bodies from the workdir; we keep that helper inline in this file (no separate task).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/openrouter-fanout.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HandoffArtifact } from "../types.js";

const chatCompletion = vi.fn();
vi.mock("../executor/review/openrouter-client.js", () => ({
  OpenRouterClient: class {
    chatCompletion = chatCompletion;
  },
}));
// Stub git diff + file collection so test does not need a real workdir
vi.mock("../executor/review/workdir-snapshot.js", () => ({
  collectWorkdirSnapshot: async () => ({
    diff: "diff --git a/x b/x\n+y",
    files: [{ path: "x", body: "y" }],
  }),
}));

const handoff: HandoffArtifact = {
  runId: "r1",
  issueId: "i1",
  stage: "review",
  timestamp: "2026-04-30T00:00:00Z",
  summary: "",
  filesChanged: ["x"],
  approach: "",
  context: { issueIntent: "do x", constraints: [], assumptions: [] },
  tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 },
};

const ctx = () => ({
  runId: "r1",
  stageRunId: "s1",
  workdir: "/tmp/wd",
  handoff,
  baseRef: "main",
  prNumber: 42,
});

describe("OpenRouterFanoutProvider", () => {
  beforeEach(() => chatCompletion.mockReset());

  const validJson = `{"findings":[{"severity":"warning","file":"a","line":1,"category":"quality","description":"d","fix":"f"}]}`;

  it("runs N parallel calls and returns one ReviewModelRun per model", async () => {
    chatCompletion.mockResolvedValue({ content: validJson, inputTokens: 10, outputTokens: 5 });
    const { OpenRouterFanoutProvider } = await import(
      "../executor/review/openrouter-fanout.js"
    );
    const p = new OpenRouterFanoutProvider({
      apiKey: "k",
      baseUrl: "https://x/api/v1",
      models: ["m1", "m2", "m3"],
      timeoutMs: 1000,
      maxInputTokens: 100_000,
    });
    const runs = await p.runReview(ctx());
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.modelId).sort()).toEqual(["m1", "m2", "m3"]);
    expect(runs.every((r) => r.status === "completed")).toBe(true);
    expect(chatCompletion).toHaveBeenCalledTimes(3);
  });

  it("partial failure: one model rejects, others complete", async () => {
    chatCompletion
      .mockResolvedValueOnce({ content: validJson, inputTokens: 1, outputTokens: 1 })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ content: validJson, inputTokens: 1, outputTokens: 1 });
    const { OpenRouterFanoutProvider } = await import(
      "../executor/review/openrouter-fanout.js"
    );
    const p = new OpenRouterFanoutProvider({
      apiKey: "k", baseUrl: "https://x/api/v1",
      models: ["m1", "m2", "m3"], timeoutMs: 1000, maxInputTokens: 100_000,
    });
    const runs = await p.runReview(ctx());
    const failed = runs.filter((r) => r.status === "failed");
    const ok = runs.filter((r) => r.status === "completed");
    expect(failed).toHaveLength(1);
    expect(failed[0].errorMessage).toContain("boom");
    expect(ok).toHaveLength(2);
  });

  it("malformed JSON output → run failed with parser error", async () => {
    chatCompletion.mockResolvedValue({ content: "not json", inputTokens: 1, outputTokens: 1 });
    const { OpenRouterFanoutProvider } = await import(
      "../executor/review/openrouter-fanout.js"
    );
    const p = new OpenRouterFanoutProvider({
      apiKey: "k", baseUrl: "https://x/api/v1",
      models: ["m1"], timeoutMs: 1000, maxInputTokens: 100_000,
    });
    const runs = await p.runReview(ctx());
    expect(runs[0].status).toBe("failed");
    expect(runs[0].errorMessage).toContain("not parseable");
  });

  it("all models fail → returns N failed runs (does not throw)", async () => {
    chatCompletion.mockRejectedValue(new Error("dead"));
    const { OpenRouterFanoutProvider } = await import(
      "../executor/review/openrouter-fanout.js"
    );
    const p = new OpenRouterFanoutProvider({
      apiKey: "k", baseUrl: "https://x/api/v1",
      models: ["m1", "m2"], timeoutMs: 1000, maxInputTokens: 100_000,
    });
    const runs = await p.runReview(ctx());
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "failed")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test -- openrouter-fanout`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the workdir snapshot helper**

```ts
// packages/core/src/executor/review/workdir-snapshot.ts
import { gitExecSafe } from "../../repo/git.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface WorkdirSnapshot {
  diff: string;
  files: Array<{ path: string; body: string }>;
}

/**
 * Collect the diff against baseRef and the body of every changed file.
 * Used as input to the single-shot review prompt.
 */
export async function collectWorkdirSnapshot(
  workdir: string,
  baseRef: string,
): Promise<WorkdirSnapshot> {
  const diffOut = await gitExecSafe(["diff", `${baseRef}...HEAD`], { cwd: workdir });
  const namesOut = await gitExecSafe(
    ["diff", "--name-only", `${baseRef}...HEAD`],
    { cwd: workdir },
  );
  const paths = namesOut.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const files: Array<{ path: string; body: string }> = [];
  for (const p of paths) {
    try {
      const body = await readFile(join(workdir, p), "utf8");
      files.push({ path: p, body });
    } catch {
      // file deleted in HEAD — skip
    }
  }
  return { diff: diffOut.stdout, files };
}
```

- [ ] **Step 4: Implement the fanout provider**

```ts
// packages/core/src/executor/review/openrouter-fanout.ts
import type { ReviewProvider, ReviewModelRun, ReviewContext } from "./review-provider.js";
import { OpenRouterClient } from "./openrouter-client.js";
import { buildReviewPrompt, parseReviewFindings } from "./review-prompt.js";
import { collectWorkdirSnapshot } from "./workdir-snapshot.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ component: "OpenRouterFanout" });

export interface OpenRouterFanoutConfig {
  apiKey: string;
  baseUrl: string;
  models: string[];
  timeoutMs: number;
  maxInputTokens: number;
}

export class OpenRouterFanoutProvider implements ReviewProvider {
  readonly id = "openrouter" as const;
  private readonly client: OpenRouterClient;

  constructor(private readonly cfg: OpenRouterFanoutConfig) {
    this.client = new OpenRouterClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  }

  async runReview(ctx: ReviewContext): Promise<ReviewModelRun[]> {
    const snapshot = await collectWorkdirSnapshot(ctx.workdir, ctx.baseRef);
    const prompt = buildReviewPrompt({
      handoff: ctx.handoff,
      diff: snapshot.diff,
      files: snapshot.files,
      maxInputTokens: this.cfg.maxInputTokens,
    });

    const settled = await Promise.allSettled(
      this.cfg.models.map((modelId) => this.runOne(modelId, prompt)),
    );

    return settled.map((res, i) => {
      const modelId = this.cfg.models[i];
      if (res.status === "fulfilled") {
        return { ...res.value, truncatedFiles: prompt.truncatedFiles || undefined };
      }
      const err = res.reason as Error;
      log.warn({ modelId, err: err.message }, "fanout model failed");
      return {
        modelId,
        providerId: "openrouter",
        status: "failed",
        findings: [],
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        errorMessage: err.message,
        truncatedFiles: prompt.truncatedFiles || undefined,
      };
    });
  }

  private async runOne(
    modelId: string,
    prompt: ReturnType<typeof buildReviewPrompt>,
  ): Promise<ReviewModelRun> {
    const startedAt = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    try {
      const result = await this.client.chatCompletion(modelId, prompt.messages, {
        signal: ac.signal,
      });
      const findings = parseReviewFindings(result.content);
      return {
        modelId,
        providerId: "openrouter",
        status: "completed",
        findings,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const msg =
        ac.signal.aborted
          ? `timed out after ${this.cfg.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        modelId,
        providerId: "openrouter",
        status: "failed",
        findings: [],
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - startedAt,
        errorMessage: msg,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @urateam/core test -- openrouter-fanout`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/executor/review/openrouter-fanout.ts \
        packages/core/src/executor/review/workdir-snapshot.ts \
        packages/core/src/__tests__/openrouter-fanout.test.ts
git commit -m "feat(core): OpenRouterFanoutProvider with allSettled best-effort fanout (BEC-134)"
```

---

## Task 7: Registry env validation and fanout selection

**Files:**
- Modify: `packages/core/src/executor/review/review-provider.ts`
- Modify: `packages/core/src/__tests__/review-provider-registry.test.ts`

- [ ] **Step 1: Extend the failing test**

Append to `packages/core/src/__tests__/review-provider-registry.test.ts`:

```ts
describe("review-provider registry — fanout selection", () => {
  it("returns only agentic when REVIEW_MODELS unset", () => {
    const ps = getEnabledProviders({});
    expect(ps.map((p) => p.id)).toEqual(["agentic"]);
  });

  it("adds openrouter when both vars set", () => {
    const ps = getEnabledProviders({
      REVIEW_MODELS: "anthropic/claude-3.5-sonnet,openai/gpt-4o",
      OPENROUTER_API_KEY: "sk-or-x",
    });
    expect(ps.map((p) => p.id).sort()).toEqual(["agentic", "openrouter"]);
  });

  it("throws when REVIEW_MODELS set but OPENROUTER_API_KEY missing", () => {
    expect(() => getEnabledProviders({ REVIEW_MODELS: "x/y" })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it("throws when OPENROUTER_API_KEY set but REVIEW_MODELS missing", () => {
    expect(() => getEnabledProviders({ OPENROUTER_API_KEY: "sk" })).toThrow(
      /REVIEW_MODELS/,
    );
  });

  it("treats whitespace-only REVIEW_MODELS as unset", () => {
    const ps = getEnabledProviders({ REVIEW_MODELS: " , , ", OPENROUTER_API_KEY: "sk" });
    // Both unset semantically → no fanout; but OPENROUTER_API_KEY is set without
    // any models → that's a misconfig: throw.
    // Spec: empty after trim → treated as unset → so the "set without other" rule fires.
    expect(() =>
      getEnabledProviders({ REVIEW_MODELS: " , , ", OPENROUTER_API_KEY: "sk" }),
    ).toThrow(/REVIEW_MODELS/);
  });

  it("trims whitespace and drops empty entries from REVIEW_MODELS", async () => {
    const ps = getEnabledProviders({
      REVIEW_MODELS: " m1 , , m2 ,",
      OPENROUTER_API_KEY: "sk",
    });
    const fanout = ps.find((p) => p.id === "openrouter");
    expect(fanout).toBeDefined();
    // White-box: read the configured models off the provider.
    // Cast through unknown to keep the test strict-typed.
    const models = (fanout as unknown as { cfg: { models: string[] } }).cfg.models;
    expect(models).toEqual(["m1", "m2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test -- review-provider-registry`
Expected: FAIL on the new fanout-selection cases.

- [ ] **Step 3: Implement registry env logic**

Replace the body of `getEnabledProviders` in `packages/core/src/executor/review/review-provider.ts`:

```ts
import { AgenticDeepReviewProvider } from "./agentic-deep-review.js";
import { OpenRouterFanoutProvider } from "./openrouter-fanout.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_INPUT_TOKENS = 150_000;

export function getEnabledProviders(env: NodeJS.ProcessEnv): ReviewProvider[] {
  const providers: ReviewProvider[] = [new AgenticDeepReviewProvider()];

  const rawModels = env.REVIEW_MODELS ?? "";
  const models = rawModels.split(",").map((s) => s.trim()).filter(Boolean);
  const apiKey = env.OPENROUTER_API_KEY ?? "";
  const fanoutDesired = models.length > 0;
  const keyPresent = apiKey.length > 0;

  if (fanoutDesired && !keyPresent) {
    throw new Error(
      "REVIEW_MODELS is set but OPENROUTER_API_KEY is missing — both must be set or both unset.",
    );
  }
  if (keyPresent && !fanoutDesired) {
    throw new Error(
      "OPENROUTER_API_KEY is set but REVIEW_MODELS is missing or empty — both must be set or both unset.",
    );
  }
  if (!fanoutDesired) return providers;

  providers.push(
    new OpenRouterFanoutProvider({
      apiKey,
      baseUrl: env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL,
      models,
      timeoutMs: parseIntOr(env.REVIEW_MODELS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      maxInputTokens: parseIntOr(env.REVIEW_MODELS_MAX_INPUT_TOKENS, DEFAULT_MAX_INPUT_TOKENS),
    }),
  );
  return providers;
}

function parseIntOr(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @urateam/core test -- review-provider-registry`
Expected: PASS (all cases including the new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/executor/review/review-provider.ts \
        packages/core/src/__tests__/review-provider-registry.test.ts
git commit -m "feat(core): registry env validation + OpenRouter fanout selection (BEC-134)"
```

---

## Task 8: post-fanout-comments — render markdown and post via addPRComment

**Files:**
- Create: `packages/core/src/executor/review/post-fanout-comments.ts`
- Test: `packages/core/src/__tests__/post-fanout-comments.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/post-fanout-comments.test.ts
import { describe, it, expect, vi } from "vitest";
import type { ReviewModelRun } from "../executor/review/review-provider.js";

const addPRComment = vi.fn();
vi.mock("../repo/github.js", () => ({ addPRComment }));

const completedRun: ReviewModelRun = {
  modelId: "anthropic/claude-3.5-sonnet",
  providerId: "openrouter",
  status: "completed",
  findings: [
    { severity: "warning", file: "a.ts", line: 1, category: "quality", description: "d", fix: "f" },
  ],
  inputTokens: 100,
  outputTokens: 50,
  durationMs: 1000,
};

const failedRun: ReviewModelRun = {
  modelId: "openai/gpt-4o",
  providerId: "openrouter",
  status: "failed",
  findings: [],
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 200,
  errorMessage: "rate limited",
};

describe("postFanoutCommentsToPR", () => {
  it("posts one comment per run with model id and findings table", async () => {
    addPRComment.mockResolvedValue(undefined);
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );
    await postFanoutCommentsToPR({} as never, "owner", "repo", 42, [completedRun]);
    expect(addPRComment).toHaveBeenCalledOnce();
    const body = (addPRComment.mock.calls[0][4] as string);
    expect(body).toContain("anthropic/claude-3.5-sonnet");
    expect(body).toContain("Status: completed");
    expect(body).toContain("warning");
    expect(body).toContain("a.ts");
    expect(body).toContain("Advisory only");
  });

  it("posts a 'failed' comment with errorMessage", async () => {
    addPRComment.mockResolvedValue(undefined);
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );
    await postFanoutCommentsToPR({} as never, "o", "r", 1, [failedRun]);
    const body = (addPRComment.mock.calls[0][4] as string);
    expect(body).toContain("Status: failed");
    expect(body).toContain("rate limited");
  });

  it("notes truncated input when truncatedFiles > 0", async () => {
    addPRComment.mockResolvedValue(undefined);
    const { postFanoutCommentsToPR } = await import(
      "../executor/review/post-fanout-comments.js"
    );
    await postFanoutCommentsToPR({} as never, "o", "r", 1, [
      { ...completedRun, truncatedFiles: 3 },
    ]);
    const body = (addPRComment.mock.calls[0][4] as string);
    expect(body).toContain("input truncated");
    expect(body).toContain("3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test -- post-fanout-comments`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the renderer**

```ts
// packages/core/src/executor/review/post-fanout-comments.ts
import type { Octokit } from "@octokit/rest";
import { addPRComment } from "../../repo/github.js";
import type { ReviewModelRun } from "./review-provider.js";

export async function postFanoutCommentsToPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  runs: ReviewModelRun[],
): Promise<void> {
  for (const run of runs) {
    await addPRComment(octokit, owner, repo, prNumber, renderRunMarkdown(run));
  }
}

function renderRunMarkdown(run: ReviewModelRun): string {
  const tokens = `${run.inputTokens.toLocaleString()} in / ${run.outputTokens.toLocaleString()} out tokens`;
  const seconds = (run.durationMs / 1000).toFixed(1);
  const header = `🔎 Review by \`${run.modelId}\` (via OpenRouter)\n\n`;
  if (run.status === "failed") {
    return [
      header,
      `Status: failed · ${run.errorMessage ?? "unknown error"} · ${seconds}s\n\n`,
      "_Advisory only — does not block merge._\n",
    ].join("");
  }
  const table =
    run.findings.length === 0
      ? "_No findings._\n"
      : [
          "| Severity | File | Line | Category | Description |",
          "|---|---|---|---|---|",
          ...run.findings.map(
            (f) =>
              `| ${f.severity} | ${escapePipe(f.file)} | ${f.line} | ${escapePipe(f.category)} | ${escapePipe(f.description)} |`,
          ),
        ].join("\n");
  const truncationNote =
    run.truncatedFiles && run.truncatedFiles > 0
      ? `\n\n_Note: input truncated; ${run.truncatedFiles} file ${run.truncatedFiles === 1 ? "body" : "bodies"} dropped to fit context window._`
      : "";
  return [
    header,
    `Status: completed · ${tokens} · ${seconds}s\n\n`,
    table,
    truncationNote,
    "\n\n_Advisory only — does not block merge. See deep-review for blocking findings._\n",
  ].join("");
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @urateam/core test -- post-fanout-comments`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/executor/review/post-fanout-comments.ts \
        packages/core/src/__tests__/post-fanout-comments.test.ts
git commit -m "feat(core): post-fanout-comments markdown renderer (BEC-134)"
```

---

## Task 9: insertReviewModelRuns DB writer

**Files:**
- Create: `packages/core/src/db/review-model-runs.ts`
- Test: `packages/core/src/__tests__/db-review-model-runs.test.ts` (extend Task 3 file)

- [ ] **Step 1: Extend the failing test**

Append to `packages/core/src/__tests__/db-review-model-runs.test.ts`:

```ts
import { insertReviewModelRuns } from "../db/review-model-runs.js";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";

describe("insertReviewModelRuns", () => {
  it("writes one row per ReviewModelRun", () => {
    const sqliteDb = new Database(":memory:");
    runMigrationsSqlite(sqliteDb);
    sqliteDb.prepare(
      "INSERT INTO pipeline_runs (id, issue_id, issue_title, pipeline_key, repo_url, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "i1", "t", "k", "u", "running", Math.floor(Date.now() / 1000));
    sqliteDb.prepare(
      "INSERT INTO stage_runs (id, pipeline_run_id, stage, status, started_at) VALUES (?, ?, ?, ?, ?)",
    ).run("s1", "p1", "review", "completed", Math.floor(Date.now() / 1000));

    const db = drizzleSqlite(sqliteDb);
    insertReviewModelRuns(db, "s1", [
      {
        modelId: "anthropic/claude-3.5-sonnet",
        providerId: "openrouter",
        status: "completed",
        findings: [],
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000,
      },
      {
        modelId: "openai/gpt-4o",
        providerId: "openrouter",
        status: "failed",
        findings: [],
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 200,
        errorMessage: "rate limited",
        truncatedFiles: 2,
      },
    ]);

    const rows = sqliteDb
      .prepare("SELECT * FROM review_model_runs WHERE stage_run_id = ? ORDER BY model_id")
      .all("s1") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0].model_id).toBe("anthropic/claude-3.5-sonnet");
    expect(rows[0].input_tokens).toBe(100);
    expect(rows[1].status).toBe("failed");
    expect(rows[1].error_message).toBe("rate limited");
    expect(rows[1].truncated_files).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test -- db-review-model-runs`
Expected: FAIL on the `insertReviewModelRuns` import.

- [ ] **Step 3: Implement the writer**

```ts
// packages/core/src/db/review-model-runs.ts
import { reviewModelRuns } from "./schema.js";
import type { ReviewModelRun } from "../executor/review/review-provider.js";
import { randomUUID } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export type Db = BetterSQLite3Database | PostgresJsDatabase;

export function insertReviewModelRuns(
  db: Db,
  stageRunId: string,
  runs: ReviewModelRun[],
): void {
  if (runs.length === 0) return;
  const now = new Date();
  const rows = runs.map((r) => ({
    id: randomUUID(),
    stageRunId,
    providerId: r.providerId,
    modelId: r.modelId,
    status: r.status,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    durationMs: r.durationMs,
    errorMessage: r.errorMessage,
    truncatedFiles: r.truncatedFiles ?? 0,
    startedAt: now,
    completedAt: now,
  }));
  // Drizzle's insert is sync on better-sqlite3, async on postgres-js. Both
  // accept this shape via type-narrowing: cast through unknown.
  (db as BetterSQLite3Database).insert(reviewModelRuns).values(rows).run();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @urateam/core test -- db-review-model-runs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/review-model-runs.ts \
        packages/core/src/__tests__/db-review-model-runs.test.ts
git commit -m "feat(core): insertReviewModelRuns DB writer (BEC-134)"
```

---

## Task 10: Wire fanout into runner.ts

This is the integration step. Fanout runs **once before** the existing convergence loop; the loop continues to call the agentic provider per-pass via its wrapper. Fanout findings persist via `insertReviewModelRuns` and post via `postFanoutCommentsToPR`. Agentic findings persist the same way (so the run record has rows for both).

**Files:**
- Modify: `packages/core/src/pipeline/runner.ts`
- Test: a new minimal integration test in `packages/core/src/__tests__/runner-fanout-integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// packages/core/src/__tests__/runner-fanout-integration.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const fanoutRunReview = vi.fn();
const agenticRunReview = vi.fn();
const insertReviewModelRunsMock = vi.fn();
const postFanoutCommentsToPRMock = vi.fn();

vi.mock("../executor/review/review-provider.js", async (orig) => {
  const real = await orig<typeof import("../executor/review/review-provider.js")>();
  return {
    ...real,
    getEnabledProviders: () => [
      { id: "agentic", runReview: agenticRunReview },
      { id: "openrouter", runReview: fanoutRunReview },
    ],
  };
});
vi.mock("../db/review-model-runs.js", () => ({
  insertReviewModelRuns: insertReviewModelRunsMock,
}));
vi.mock("../executor/review/post-fanout-comments.js", () => ({
  postFanoutCommentsToPR: postFanoutCommentsToPRMock,
}));

describe("runner fanout integration", () => {
  beforeEach(() => {
    fanoutRunReview.mockReset();
    agenticRunReview.mockReset();
    insertReviewModelRunsMock.mockReset();
    postFanoutCommentsToPRMock.mockReset();
  });

  it("runs fanout once per stage execution and posts comments", async () => {
    fanoutRunReview.mockResolvedValue([
      {
        modelId: "anthropic/claude-3.5-sonnet",
        providerId: "openrouter",
        status: "completed",
        findings: [],
        inputTokens: 1, outputTokens: 1, durationMs: 1,
      },
    ]);
    agenticRunReview.mockResolvedValue([
      {
        modelId: "claude-haiku-4-5-20251001",
        providerId: "agentic",
        status: "completed",
        findings: [],
        inputTokens: 1, outputTokens: 1, durationMs: 1,
      },
    ]);

    // Import the runner helper that we extract in Step 3 below; the test calls
    // it directly to avoid spinning up a full pipeline.
    const { runReviewProviders } = await import("../pipeline/review-providers-runner.js");
    const ctx = {
      runId: "r1", stageRunId: "s1", workdir: "/tmp/x",
      handoff: { runId: "r1", issueId: "i1", stage: "review", timestamp: "",
        summary: "", filesChanged: [], approach: "",
        context: { issueIntent: "x", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 } },
      baseRef: "main", prNumber: 42,
    };
    const result = await runReviewProviders(ctx, {
      env: { REVIEW_MODELS: "anthropic/claude-3.5-sonnet", OPENROUTER_API_KEY: "sk-or" },
      db: {} as never,
      octokit: {} as never,
      owner: "o",
      repo: "r",
    });

    expect(agenticRunReview).toHaveBeenCalledOnce();
    expect(fanoutRunReview).toHaveBeenCalledOnce();
    expect(insertReviewModelRunsMock).toHaveBeenCalledOnce();
    const persisted = insertReviewModelRunsMock.mock.calls[0][2] as Array<{ providerId: string }>;
    expect(persisted).toHaveLength(2);
    expect(postFanoutCommentsToPRMock).toHaveBeenCalledOnce();
    const postedRuns = postFanoutCommentsToPRMock.mock.calls[0][4] as Array<{ providerId: string }>;
    expect(postedRuns.every((r) => r.providerId === "openrouter")).toBe(true);
    expect(result.agenticFindings).toHaveLength(0);
    expect(result.totalInputTokens).toBe(2);
    expect(result.totalOutputTokens).toBe(2);
  });

  it("does not post comments when prNumber is null", async () => {
    fanoutRunReview.mockResolvedValue([]);
    agenticRunReview.mockResolvedValue([]);
    const { runReviewProviders } = await import("../pipeline/review-providers-runner.js");
    await runReviewProviders(
      { runId: "r1", stageRunId: "s1", workdir: "/tmp/x",
        handoff: { runId: "r1", issueId: "i1", stage: "review", timestamp: "",
          summary: "", filesChanged: [], approach: "",
          context: { issueIntent: "x", constraints: [], assumptions: [] },
          tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 } },
        baseRef: "main", prNumber: null },
      { env: {}, db: {} as never, octokit: {} as never, owner: "o", repo: "r" },
    );
    expect(postFanoutCommentsToPRMock).not.toHaveBeenCalled();
  });

  it("does not throw if fanout provider rejects (best-effort)", async () => {
    agenticRunReview.mockResolvedValue([
      { modelId: "claude-haiku-4-5-20251001", providerId: "agentic", status: "completed",
        findings: [], inputTokens: 0, outputTokens: 0, durationMs: 0 },
    ]);
    fanoutRunReview.mockRejectedValue(new Error("network gone"));
    const { runReviewProviders } = await import("../pipeline/review-providers-runner.js");
    const result = await runReviewProviders(
      { runId: "r1", stageRunId: "s1", workdir: "/tmp/x",
        handoff: { runId: "r1", issueId: "i1", stage: "review", timestamp: "",
          summary: "", filesChanged: [], approach: "",
          context: { issueIntent: "x", constraints: [], assumptions: [] },
          tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 } },
        baseRef: "main", prNumber: 1 },
      { env: { REVIEW_MODELS: "x", OPENROUTER_API_KEY: "k" },
        db: {} as never, octokit: {} as never, owner: "o", repo: "r" },
    );
    expect(result.agenticFindings).toEqual([]); // no findings; agentic ok
    // fanout error logged, not thrown
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test -- runner-fanout-integration`
Expected: FAIL — module `pipeline/review-providers-runner.js` not found.

- [ ] **Step 3: Extract the helper into a new module**

```ts
// packages/core/src/pipeline/review-providers-runner.ts
import type { Octokit } from "@octokit/rest";
import {
  getEnabledProviders,
  type ReviewContext,
  type ReviewModelRun,
} from "../executor/review/review-provider.js";
import { insertReviewModelRuns, type Db } from "../db/review-model-runs.js";
import { postFanoutCommentsToPR } from "../executor/review/post-fanout-comments.js";
import type { ReviewFinding } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "ReviewProvidersRunner" });

export interface RunReviewProvidersOpts {
  env: NodeJS.ProcessEnv;
  db: Db;
  octokit: Octokit;
  owner: string;
  repo: string;
}

export interface RunReviewProvidersResult {
  agenticFindings: ReviewFinding[];
  totalInputTokens: number;
  totalOutputTokens: number;
  allRuns: ReviewModelRun[];
}

export async function runReviewProviders(
  ctx: ReviewContext,
  opts: RunReviewProvidersOpts,
): Promise<RunReviewProvidersResult> {
  const providers = getEnabledProviders(opts.env);
  const allRuns: ReviewModelRun[] = [];

  for (const p of providers) {
    try {
      const runs = await p.runReview(ctx);
      allRuns.push(...runs);
    } catch (err) {
      log.warn(
        { providerId: p.id, err: err instanceof Error ? err.message : String(err) },
        "review provider threw — recording as advisory failure",
      );
      // best-effort: agentic failure is still treated as a failed run for visibility
      allRuns.push({
        modelId: p.id,
        providerId: p.id,
        status: "failed",
        findings: [],
        inputTokens: 0, outputTokens: 0, durationMs: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  insertReviewModelRuns(opts.db, ctx.stageRunId, allRuns);

  const fanoutRuns = allRuns.filter((r) => r.providerId !== "agentic");
  if (ctx.prNumber !== null && fanoutRuns.length > 0) {
    try {
      await postFanoutCommentsToPR(opts.octokit, opts.owner, opts.repo, ctx.prNumber, fanoutRuns);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "post-fanout-comments failed — continuing",
      );
    }
  }

  const agenticFindings = allRuns
    .filter((r) => r.providerId === "agentic")
    .flatMap((r) => r.findings);

  return {
    agenticFindings,
    totalInputTokens: allRuns.reduce((s, r) => s + r.inputTokens, 0),
    totalOutputTokens: allRuns.reduce((s, r) => s + r.outputTokens, 0),
    allRuns,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @urateam/core test -- runner-fanout-integration`
Expected: PASS (3 tests).

- [ ] **Step 5: Modify runner.ts to call the helper**

In `packages/core/src/pipeline/runner.ts`, replace the line ~1398 deep-review call site:

**Before:**
```ts
runLog.info({ drPass, passLimit }, "deep review: running parallel sub-agents");
const deepResult = await runDeepReview(handoff, worktreePath);

run.totalInputTokens += deepResult.inputTokens;
run.totalOutputTokens += deepResult.outputTokens;
```

**After:**
```ts
// On the FIRST pass only, run all enabled review providers (agentic + optional fanout).
// On subsequent passes, only the agentic provider runs (fanout is one-shot, advisory).
runLog.info({ drPass, passLimit }, "deep review: running review providers");
const reviewCtx = {
  runId,
  stageRunId: drReviewResult?.stageRunId ?? "", // populated by executeStage on review pass
  workdir: worktreePath,
  handoff,
  baseRef: repoConfig.defaultBranch ?? "main",
  prNumber: prNumber ?? null,
};
const reviewResult =
  drPass === 1
    ? await runReviewProviders(reviewCtx, {
        env: process.env,
        db: this.db,
        octokit: this.octokit,
        owner: repoOwner,
        repo: repoName,
      })
    : await runReviewProviders(reviewCtx, {
        env: { /* fanout disabled on retries */ },
        db: this.db,
        octokit: this.octokit,
        owner: repoOwner,
        repo: repoName,
      });
const deepResult = {
  findings: reviewResult.agenticFindings,
  inputTokens: reviewResult.totalInputTokens,
  outputTokens: reviewResult.totalOutputTokens,
};

run.totalInputTokens += deepResult.inputTokens;
run.totalOutputTokens += deepResult.outputTokens;
```

Add the import at the top of `runner.ts`:

```ts
import { runReviewProviders } from "./review-providers-runner.js";
```

If `repoOwner`, `repoName`, or `prNumber` are not already in scope at this point in `runner.ts`, derive them from `repoConfig.repoUrl` and the existing PR state (search the file for an existing usage of `octokit.pulls` to find the local variables already in scope; reuse them by name).

**Critical follow-up edit in the same file:** The agentic findings returned by the new wrapper are already `ReviewFinding[]` (the wrapper calls `deepFindingsToReviewFindings` internally). The existing line ~1515 reads:

```ts
const asReviewFindings = deepFindingsToReviewFindings(deepResult.findings);
const existingFindings = handoff.context.reviewFindings ?? [];
handoff = {
  ...handoff,
  context: { ...handoff.context, reviewFindings: [...existingFindings, ...asReviewFindings] },
};
```

Replace with (no double-conversion):

```ts
const existingFindings = handoff.context.reviewFindings ?? [];
handoff = {
  ...handoff,
  context: { ...handoff.context, reviewFindings: [...existingFindings, ...deepResult.findings] },
};
```

Also remove the now-unused `deepFindingsToReviewFindings` import at the top of `runner.ts` if no other usages remain.

- [ ] **Step 6: Run all tests in the runner area**

Run: `pnpm --filter @urateam/core test -- pipeline-runner runner-fanout-integration deep-review review-feedback`
Expected: PASS — no regressions in the existing pipeline-runner suite.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/pipeline/review-providers-runner.ts \
        packages/core/src/pipeline/runner.ts \
        packages/core/src/__tests__/runner-fanout-integration.test.ts
git commit -m "feat(core): wire fanout into runner.ts review stage (BEC-134)"
```

---

## Task 11: Cost rollup — JOIN review_model_runs

**Files:**
- Modify: `packages/core/src/cost/per-run.ts`
- Test: `packages/core/src/__tests__/cost/per-run-multi-model.test.ts`

- [ ] **Step 1: Read existing per-run.ts to identify the rollup function**

Run: `grep -n "export function\|export const" packages/core/src/cost/per-run.ts`

Find the function that aggregates per-stage tokens by model. The new test asserts that when `review_model_runs` has rows for a stage_run, the rollup uses per-row model pricing (not the aggregated stage_runs.input_tokens × stage-level pricing).

- [ ] **Step 2: Write the failing test**

```ts
// packages/core/src/__tests__/cost/per-run-multi-model.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrationsSqlite } from "../../db/migrator.js";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { computeRunCost } from "../../cost/per-run.js";

describe("computeRunCost — multi-model rollup", () => {
  it("uses review_model_runs rows when present", () => {
    const sqliteDb = new Database(":memory:");
    runMigrationsSqlite(sqliteDb);
    const db = drizzle(sqliteDb);

    const now = Math.floor(Date.now() / 1000);
    sqliteDb.prepare(
      "INSERT INTO pipeline_runs (id, issue_id, issue_title, pipeline_key, repo_url, status, started_at, total_input_tokens, total_output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "i1", "t", "k", "u", "completed", now, 0, 0);
    sqliteDb.prepare(
      "INSERT INTO stage_runs (id, pipeline_run_id, stage, status, started_at, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("s1", "p1", "review", "completed", now, 1000, 500);

    sqliteDb.prepare(
      "INSERT INTO review_model_runs (id, stage_run_id, provider_id, model_id, status, input_tokens, output_tokens, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("rm1", "s1", "agentic", "claude-haiku-4-5-20251001", "completed", 600, 300, 1000);
    sqliteDb.prepare(
      "INSERT INTO review_model_runs (id, stage_run_id, provider_id, model_id, status, input_tokens, output_tokens, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("rm2", "s1", "openrouter", "anthropic/claude-3.5-sonnet", "completed", 400, 200, 2000);

    const cost = computeRunCost(db, "p1", {
      modelPricing: {
        "claude-haiku-4-5-20251001": { inputPer1k: 0.001, outputPer1k: 0.005 },
        "anthropic/claude-3.5-sonnet": { inputPer1k: 0.003, outputPer1k: 0.015 },
      },
    });
    // 600/1000 * 0.001 + 300/1000 * 0.005 = 0.0006 + 0.0015 = 0.0021
    // 400/1000 * 0.003 + 200/1000 * 0.015 = 0.0012 + 0.003  = 0.0042
    // total: 0.0063
    expect(cost.totalDollars).toBeCloseTo(0.0063, 5);
  });

  it("falls back to stage-level rollup when review_model_runs is empty", () => {
    const sqliteDb = new Database(":memory:");
    runMigrationsSqlite(sqliteDb);
    const db = drizzle(sqliteDb);
    const now = Math.floor(Date.now() / 1000);
    sqliteDb.prepare(
      "INSERT INTO pipeline_runs (id, issue_id, issue_title, pipeline_key, repo_url, status, started_at, total_input_tokens, total_output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "i1", "t", "k", "u", "completed", now, 0, 0);
    sqliteDb.prepare(
      "INSERT INTO stage_runs (id, pipeline_run_id, stage, status, started_at, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("s1", "p1", "review", "completed", now, 1000, 500);

    const cost = computeRunCost(db, "p1", {
      modelPricing: { "default": { inputPer1k: 0.001, outputPer1k: 0.005 } },
      defaultModel: "default",
    });
    // 1000/1000 * 0.001 + 500/1000 * 0.005 = 0.001 + 0.0025 = 0.0035
    expect(cost.totalDollars).toBeCloseTo(0.0035, 5);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @urateam/core test -- per-run-multi-model`
Expected: FAIL — current `computeRunCost` does not consult `review_model_runs`.

- [ ] **Step 4: Update computeRunCost**

Open `packages/core/src/cost/per-run.ts`. Find the section that loops over `stageRuns` to compute cost. For each `stageRun`, query `reviewModelRuns` filtered by `stage_run_id`. If rows exist, compute cost as the sum of per-model `(input_tokens/1000) × pricing.inputPer1k + (output_tokens/1000) × pricing.outputPer1k`. If no rows exist, fall back to the existing stage-level computation.

Pseudocode patch (adapt the actual function name and shape from the existing file):

```ts
import { reviewModelRuns } from "../db/schema.js";
// ...

for (const sr of stageRunsForRun) {
  const modelRuns = await db
    .select()
    .from(reviewModelRuns)
    .where(eq(reviewModelRuns.stageRunId, sr.id));
  if (modelRuns.length > 0) {
    for (const mr of modelRuns) {
      const pricing = opts.modelPricing[mr.modelId] ?? opts.modelPricing[opts.defaultModel ?? ""];
      if (!pricing) continue;
      total += (mr.inputTokens / 1000) * pricing.inputPer1k;
      total += (mr.outputTokens / 1000) * pricing.outputPer1k;
    }
  } else {
    // existing stage-level fallback
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @urateam/core test -- per-run-multi-model cost`
Expected: PASS — both new tests + existing cost tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/cost/per-run.ts \
        packages/core/src/__tests__/cost/per-run-multi-model.test.ts
git commit -m "feat(core): cost rollup uses review_model_runs per-model pricing (BEC-134)"
```

---

## Task 12: .env.example documentation in template

**Files:**
- Modify: `packages/create-urateam/template/.urateam/.env.example`

- [ ] **Step 1: Read current file**

Run: `cat packages/create-urateam/template/.urateam/.env.example`

- [ ] **Step 2: Append the fanout block**

Append:

```bash

# OpenRouter multi-model review fanout (BEC-134, OSS, optional)
# When both vars are set, each comma-separated model produces a single-shot
# advisory review in addition to the default Claude Agent SDK deep-review.
# Findings post as labeled PR comments; they do NOT block auto-merge.
# OPENROUTER_API_KEY=sk-or-...
# REVIEW_MODELS=anthropic/claude-3.5-sonnet,openai/gpt-4o,google/gemini-2.5-pro
# Optional knobs (defaults shown):
# REVIEW_MODELS_TIMEOUT_MS=300000
# REVIEW_MODELS_MAX_INPUT_TOKENS=150000
# OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

- [ ] **Step 3: Commit**

```bash
git add packages/create-urateam/template/.urateam/.env.example
git commit -m "docs(create-urateam): document OpenRouter fanout env vars (BEC-134)"
```

---

## Task 13: ScaffoldOptions in create-urateam

**Files:**
- Modify: `packages/create-urateam/src/index.ts`
- Test: existing scaffolder test (or extend if a fanout-specific test is needed)

- [ ] **Step 1: Read the ScaffoldOptions and buildEnv function**

Run: `grep -n "ScaffoldOptions\|buildEnv\|interface " packages/create-urateam/src/index.ts | head`

- [ ] **Step 2: Extend ScaffoldOptions**

Add fields:

```ts
openrouterApiKey?: string;
reviewModels?: string[];
```

- [ ] **Step 3: Update buildEnv to write the new vars (uncommented) when present**

Inside the `buildEnv()` function, append a conditional block:

```ts
if (opts.openrouterApiKey && opts.reviewModels && opts.reviewModels.length > 0) {
  lines.push("");
  lines.push("# OpenRouter multi-model review fanout (BEC-134)");
  lines.push(`OPENROUTER_API_KEY=${opts.openrouterApiKey}`);
  lines.push(`REVIEW_MODELS=${opts.reviewModels.join(",")}`);
}
```

- [ ] **Step 4: Run scaffolder tests**

Run: `pnpm --filter create-urateam test`
Expected: PASS — no regressions. (Add a new test only if existing tests assert on `buildEnv` content; otherwise the docs change is enough for v1.)

- [ ] **Step 5: Commit**

```bash
git add packages/create-urateam/src/index.ts
git commit -m "feat(create-urateam): optional OPENROUTER + REVIEW_MODELS scaffold fields (BEC-134)"
```

---

## Task 14: E2E pipeline test extension

**Files:**
- Modify: `packages/core/src/__tests__/e2e-pipeline.test.ts`

- [ ] **Step 1: Add a new `it()` block at the end of the file**

```ts
it("BEC-134: fanout providers run when REVIEW_MODELS+OPENROUTER_API_KEY set, advisory only", async () => {
  // Set env for the duration of this test
  process.env.REVIEW_MODELS = "anthropic/claude-3.5-sonnet";
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  try {
    // Use existing harness fixture for a minimal pipeline run with mocked
    // OpenRouter HTTP and mocked Claude Agent SDK (already set up in this test
    // file). Assert:
    //   1. review_model_runs has rows for both providers
    //   2. handoff.context.reviewFindings contains agentic findings only
    //   3. addPRComment called once per fanout model
    // The existing test scaffold in this file shows how to run a minimal
    // pipeline; reuse that helper.
  } finally {
    delete process.env.REVIEW_MODELS;
    delete process.env.OPENROUTER_API_KEY;
  }
});
```

(Body intentionally light — adapt to whatever fixture the existing e2e-pipeline test uses. The acceptance is: assertions 1–3 above.)

- [ ] **Step 2: Run e2e tests**

Run: `pnpm --filter @urateam/core test -- e2e-pipeline`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/__tests__/e2e-pipeline.test.ts
git commit -m "test(core): e2e pipeline coverage for fanout (BEC-134)"
```

---

## Task 15: Final full-suite + lint + typecheck

- [ ] **Step 1: Run the full test matrix**

```bash
pnpm -r test
pnpm -r typecheck   # or whatever the project uses (tsc --noEmit)
```

Expected: PASS across all packages.

- [ ] **Step 2: Spot-check the diff**

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main..HEAD
```

Expected: ~14 commits, all under `packages/core/src/executor/review/`, `packages/core/src/db/`, `packages/core/src/pipeline/`, `packages/core/src/cost/`, and `packages/create-urateam/`.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin jonb3232/bec-134-v10-26-openrouter-multi-model-fanout-on-review-stage
gh pr create --title "feat(core): OpenRouter multi-model review fanout (BEC-134)" \
  --body "$(cat docs/superpowers/specs/2026-04-30-bec-134-openrouter-fanout-design.md | head -60)

Closes BEC-134."
```

---

## Spec coverage check (self-review)

| Spec section | Plan task |
|---|---|
| §3 architecture file map | Task 1, 2, 4–9 |
| §4 ReviewProvider interface | Task 1 |
| §4.1 ReviewModelRun shape | Task 1 |
| §4.2 registry env validation | Task 7 |
| §4.3 OpenRouter client | Task 4 |
| §5 data flow / runner integration | Task 10 |
| §5.1 prompt input + truncation | Task 5 |
| §5.2 PR comment shape | Task 8 |
| §6 env vars | Task 7 (parsing), Task 12 (.env.example), Task 13 (scaffolder) |
| §7 schema migration | Task 3 |
| §7 review_model_runs DB writer | Task 9 |
| §7 cost rollup JOIN | Task 11 |
| §8 error handling — partial failure | Task 6 (allSettled) |
| §8 error handling — startup validation | Task 7 |
| §8 error handling — timeout | Task 6 (AbortController) |
| §8 error handling — token cap | Task 5 (truncation) |
| §9 testing matrix | Tasks 1–11 each include unit tests; Task 14 e2e |
| §11 acceptance criteria | covered by Tasks 5–11 |
| §12 release & cascade | post-merge (out of plan scope) |

No gaps.

---

## Notes for the executor

- **TDD discipline**: every task starts with the failing test. Don't write implementation before the test fails for the right reason.
- **Commits**: one commit per task, message format `feat(core)|test(core)|docs(...): subject (BEC-134)`.
- **No license-tier check**: BEC-134 is OSS; do not add license gates.
- **Existing tests must pass**: after every task, run `pnpm --filter @urateam/core test` (full unit suite) and confirm green before committing.
- **Don't refactor `deep-review.ts`** — the wrapper exists so we don't have to.
- **`runner.ts` integration (Task 10)** is the trickiest task; if the diff against the existing convergence loop becomes unwieldy, prefer extracting `runReviewProviders` cleanly and keeping the loop body short. The wrapper-thin-call pattern preserves convergence behavior unchanged.

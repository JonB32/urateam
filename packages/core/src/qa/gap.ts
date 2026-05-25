import { randomUUID } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import type { LinearClient } from "@linear/sdk";
import type { AnyDb } from "../db/client.js";
import { qaGapIssues } from "../db/schema.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { qaGapIssueFiledEvent } from "../audit/events.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "Qa:gap" });

export interface FileGapIssueInput {
  db: AnyDb;
  linear: LinearClient;
  repoUrl: string;
  branch: string;
  workflowPath: string;
  linearTeamId: string;
  /**
   * Injectable LLM call function. When provided and `QA_GAP_LLM_ANALYSIS=true`,
   * the issue body is enriched with per-repo test-framework + infra recommendations.
   * Omit in callers that don't need LLM analysis; the static template is preserved.
   */
  callClaude?: (prompt: string) => Promise<string>;
}

/** Structured recommendations parsed from the LLM analysis response. */
export interface GapAnalysisResult {
  framework: string;
  suggestedPath: string;
  infraProvider: string;
  acceptanceCriteria: string[];
  summary: string;
}

/**
 * Build the prompt sent to the LLM for per-repo QA gap analysis.
 * Internal — exported for testing only.
 */
export function buildGapAnalysisPrompt(repoUrl: string, branch: string, workflowPath: string): string {
  return `You are a senior DevOps engineer helping a team add QA automation to their repository.

Repository: ${repoUrl}
Branch: ${branch}
Expected QA workflow path (currently missing): ${workflowPath}

Based on the repository name, typical monorepo conventions, and common CI patterns, recommend:
1. The most suitable test framework and a concrete file path for the smoke/integration test file.
2. The most likely ephemeral environment provider for preview/staging (Vercel, Render, Fly.io, k8s namespace, etc.).
3. Three to five concrete acceptance criteria with specific file paths.
4. A brief summary (2–3 sentences) explaining the recommendations.

Respond ONLY with a JSON object — no prose before or after — in this exact shape:
{
  "framework": "<framework name, e.g. Playwright>",
  "suggestedPath": "<relative path, e.g. tests/smoke/smoke.spec.ts>",
  "infraProvider": "<provider name, e.g. Vercel Preview>",
  "acceptanceCriteria": ["<criterion 1>", "<criterion 2>", "..."],
  "summary": "<brief explanation>"
}`;
}

/**
 * Parse the raw LLM output into a `GapAnalysisResult`.
 * Returns null if the output is malformed or missing required fields.
 * Internal — exported for testing only.
 */
export function parseGapAnalysis(raw: string): GapAnalysisResult | null {
  try {
    const trimmed = raw.trim();
    // Accept both bare JSON objects and ```json fenced blocks.
    const jsonText = trimmed.startsWith("{")
      ? trimmed
      : (/```json\s*\n([\s\S]*?)\n```/.exec(trimmed)?.[1] ?? trimmed);
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const framework = typeof parsed.framework === "string" ? parsed.framework.trim() : "";
    const suggestedPath = typeof parsed.suggestedPath === "string" ? parsed.suggestedPath.trim() : "";
    const infraProvider = typeof parsed.infraProvider === "string" ? parsed.infraProvider.trim() : "";
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const rawAc = parsed.acceptanceCriteria;
    const acceptanceCriteria = Array.isArray(rawAc)
      ? rawAc.filter((x): x is string => typeof x === "string").slice(0, 10)
      : [];
    if (!framework || !suggestedPath || !infraProvider || acceptanceCriteria.length === 0) return null;
    return { framework, suggestedPath, infraProvider, acceptanceCriteria, summary };
  } catch {
    return null;
  }
}

/**
 * Render parsed LLM recommendations as Markdown to embed in the gap issue body.
 */
function renderAnalysis(analysis: GapAnalysisResult): string {
  const acLines = analysis.acceptanceCriteria.map((ac) => `- [ ] ${ac}`).join("\n");
  return `
## Recommended setup (LLM analysis)

${analysis.summary}

**Test framework:** ${analysis.framework}
**Suggested test file:** \`${analysis.suggestedPath}\`
**Ephemeral env provider:** ${analysis.infraProvider}

### Suggested acceptance criteria

${acLines}
`.trim();
}

export type FileGapIssueResult =
  | { kind: "filed"; linearIssueId: string }
  | { kind: "already_filed"; linearIssueId: string }
  | { kind: "linear_error"; message: string };

const ISSUE_TITLE_PREFIX = "QA workflow missing";
const ISSUE_BODY_TEMPLATE = `# QA workflow missing

The Release Manager attempted to verify a QA workflow for this branch but could not find the configured file.

**Repo:** {repoUrl}
**Branch:** {branch}
**Expected workflow path:** \`{workflowPath}\`

## What this means

When the Release Manager fires a release on this branch, it expects a GitHub Actions workflow at the path above to verify the merge commit before tagging. The file is currently missing, so the agent has paused all release activity for this branch until you add it.

## How to resolve

1. Add a workflow file at \`{workflowPath}\` that:
   - Has \`on: workflow_dispatch\` (so the Release Manager can trigger it)
   - Runs your smoke / integration tests against the merge commit
   - Exits zero on success and non-zero on failure

2. Commit and push the workflow file. The Release Manager will detect it on the next tick and resume normal release decisions.

3. Once the workflow has run green at least once, this Linear issue can be closed manually.

## Reference

The Release Manager and QA agent are documented at \`docs/superpowers/specs/2026-05-04-bec-136-qa-agent-design.md\` in the urateam repo. v1 only supports rule-based detection (file exists / file missing) — there is no automatic test scaffolding in v1.

🤖 Filed by urateam Release Manager (BEC-136).`;

export async function fileGapIssue(input: FileGapIssueInput): Promise<FileGapIssueResult> {
  const { db, linear, repoUrl, branch, workflowPath, linearTeamId, callClaude } = input;

  // Idempotency check: is there already an open gap row for this (repo, branch, workflow)?
  const existing = await (db as any)
    .select({ linearIssueId: qaGapIssues.linearIssueId })
    .from(qaGapIssues)
    .where(
      and(
        eq(qaGapIssues.repoUrl, repoUrl),
        eq(qaGapIssues.branch, branch),
        eq(qaGapIssues.workflowPath, workflowPath),
        isNull(qaGapIssues.resolvedAt),
      ),
    )
    .limit(1);
  if (existing?.[0]?.linearIssueId) {
    return { kind: "already_filed", linearIssueId: existing[0].linearIssueId };
  }

  // Optionally enrich the issue body with LLM-driven recommendations.
  // Strict equality matches CLAUDE.md convention for env-var feature flags.
  let analysisSection = "";
  if (process.env.QA_GAP_LLM_ANALYSIS === "true" && callClaude) {
    try {
      const prompt = buildGapAnalysisPrompt(repoUrl, branch, workflowPath);
      const raw = await callClaude(prompt);
      const analysis = parseGapAnalysis(raw);
      if (analysis) {
        analysisSection = "\n\n" + renderAnalysis(analysis);
      } else {
        log.warn({ repoUrl, branch, workflowPath, rawPreview: raw.slice(0, 200) }, "QA gap LLM analysis: could not parse response");
      }
    } catch (err) {
      // LLM call failure is non-fatal — fall back to static template.
      log.warn({ err, repoUrl, branch }, "QA gap LLM analysis failed; using static template");
    }
  }

  // No open row — file a new Linear issue.
  let identifier: string;
  try {
    const body = ISSUE_BODY_TEMPLATE
      .replace(/{repoUrl}/g, repoUrl)
      .replace(/{branch}/g, branch)
      .replace(/{workflowPath}/g, workflowPath) + analysisSection;
    const created = await linear.createIssue({
      teamId: linearTeamId,
      title: `${ISSUE_TITLE_PREFIX} for ${repoUrl} (${branch})`,
      description: body,
    });
    const issue = await (created as any).issue;
    identifier = issue?.identifier ?? "";
    if (!identifier) {
      return { kind: "linear_error", message: "Linear createIssue returned no identifier" };
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    log.error({ err, repoUrl, branch, workflowPath }, "Linear createIssue failed");
    return { kind: "linear_error", message: msg };
  }

  // Persist the qa_gap_issues row to enforce idempotency.
  await (db as any).insert(qaGapIssues).values({
    id: `qg_${randomUUID()}`,
    repoUrl,
    branch,
    workflowPath,
    linearIssueId: identifier,
    filedAt: new Date(),
  });

  void logAuditEventUnchecked(
    db,
    qaGapIssueFiledEvent({ repoUrl, branch, workflowPath, linearIssueId: identifier }),
  );

  return { kind: "filed", linearIssueId: identifier };
}

/** Mark the open gap-issue row as resolved (called when the workflow file appears). */
export async function markGapResolved(input: {
  db: AnyDb;
  repoUrl: string;
  branch: string;
  workflowPath: string;
}): Promise<void> {
  const { db, repoUrl, branch, workflowPath } = input;
  await (db as any)
    .update(qaGapIssues)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(qaGapIssues.repoUrl, repoUrl),
        eq(qaGapIssues.branch, branch),
        eq(qaGapIssues.workflowPath, workflowPath),
        isNull(qaGapIssues.resolvedAt),
      ),
    );
}

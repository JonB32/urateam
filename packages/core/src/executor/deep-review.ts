/**
 * Deep review: runs 3 parallel sub-agents (reuse, quality, efficiency) to
 * produce hardened code-review findings. Corresponds to the /simplify
 * pattern — each agent specialises in one dimension of code quality.
 */

import type { HandoffArtifact, ReviewFinding } from "../types.js";
import { gitExecSafe } from "../repo/git.js";
import { createLogger } from "../logger.js";
import { consumeAgentStream, parseJsonBlock } from "./agent-stream.js";
import { buildStagePermissionOptions } from "./permissions.js";
import { sanitize, buildSandboxedBlock } from "./prompt/sanitizer.js";
import { resolveSessionOpts } from "./session-resolver.js";
import type { AnyDb } from "../db/client.js";

const log = createLogger({ component: "DeepReview" });
const DEEP_REVIEW_MODEL = "claude-haiku-4-5-20251001";

/**
 * BEC-227 — stage label used when emitting agent-session audit events from
 * deep-review sub-agents. Each of the three sub-agents (reuse, quality,
 * efficiency) writes its own event, qualified by the agent name so
 * operators can spot per-sub-agent resume patterns.
 */
const DEEP_REVIEW_STAGE_LABEL = "review";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeepReviewFinding {
  agent: "reuse" | "quality" | "efficiency";
  severity: "blocking" | "warning" | "suggestion";
  file: string;
  line: number;
  category: string;
  description: string;
  fix: string;
}

export interface DeepReviewResult {
  findings: DeepReviewFinding[];
  /** Total input tokens used across all 3 sub-agents. */
  inputTokens: number;
  /** Total output tokens used across all 3 sub-agents. */
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// File subset filters
// ---------------------------------------------------------------------------

/** Patterns identifying test files. */
const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
];

/** Patterns identifying generated or dist output. */
const GENERATED_PATTERNS = [
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /\.d\.ts$/,
  /(^|\/)generated\//,
  /(^|\/)\.(next|nuxt|svelte-kit)\//,
];

/** Patterns identifying config files. */
const CONFIG_PATTERNS = [
  /\.(config|rc)\.[jt]sx?$/,
  /\.(eslintrc|prettierrc|babelrc|jest\.config)\b/,
  /tsconfig.*\.json$/,
  /package\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
];

/** Patterns identifying documentation files. */
const DOC_PATTERNS = [
  /\.md$/,
  /\.mdx$/,
  /(^|\/)docs?\//,
  /CHANGELOG/i,
  /README/i,
  /LICENSE/i,
];

/** Patterns identifying static assets. */
const STATIC_ASSET_PATTERNS = [
  /\.(png|jpg|jpeg|gif|svg|ico|webp)$/,
  /\.(css|scss|sass|less)$/,
  /\.(html|htm)$/,
  /\.(woff2?|ttf|eot)$/,
  /\.(mp4|webm|mp3|wav)$/,
  /\.(pdf|zip|tar|gz)$/,
];

function matchesAny(file: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(file));
}

/**
 * Reuse agent: source files only.
 * Skips tests, configs, docs, generated output, and static assets.
 */
export function filterReuseFiles(files: string[]): string[] {
  return files.filter(
    (f) =>
      !matchesAny(f, TEST_PATTERNS) &&
      !matchesAny(f, CONFIG_PATTERNS) &&
      !matchesAny(f, DOC_PATTERNS) &&
      !matchesAny(f, GENERATED_PATTERNS) &&
      !matchesAny(f, STATIC_ASSET_PATTERNS),
  );
}

/**
 * Efficiency agent: hot-path source files.
 * Skips tests, static assets, and generated output.
 */
export function filterEfficiencyFiles(files: string[]): string[] {
  return files.filter(
    (f) =>
      !matchesAny(f, TEST_PATTERNS) &&
      !matchesAny(f, STATIC_ASSET_PATTERNS) &&
      !matchesAny(f, GENERATED_PATTERNS),
  );
}

/**
 * Quality agent: all source files but not generated/dist output.
 */
export function filterQualityFiles(files: string[]): string[] {
  return files.filter((f) => !matchesAny(f, GENERATED_PATTERNS));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Agent name type and tuple for type-safe iteration and string narrowing. */
const AGENT_NAMES = ["reuse", "quality", "efficiency"] as const;
type AgentName = (typeof AGENT_NAMES)[number];

/** Valid severity values, kept in sync with DeepReviewFinding["severity"]. */
const VALID_SEVERITIES = ["blocking", "warning", "suggestion"] as const;

/** Tools made available to each deep-review sub-agent. */
const DEEP_REVIEW_TOOLS = ["Read", "Glob", "Grep"] as const;

// ---------------------------------------------------------------------------
// Sub-agent prompts
// ---------------------------------------------------------------------------

/** Per-agent instructions for the "what to look for" step. */
const AGENT_INSTRUCTIONS: Record<AgentName, { role: string; lookFor: string; exampleCategory: string }> = {
  reuse: {
    role: "code-reuse review agent",
    lookFor:
      "duplicate functions, copy-pasted logic, missed utility/helper extraction, reimplemented existing library features.",
    exampleCategory: "duplicate-logic",
  },
  quality: {
    role: "code-quality review agent",
    lookFor:
      "copy-paste code, stringly-typed values (magic strings/numbers), redundant state, overly complex conditionals, missing error handling, unclear naming.",
    exampleCategory: "stringly-typed",
  },
  efficiency: {
    role: "code-efficiency review agent",
    lookFor:
      "N+1 query patterns, missed concurrency (sequential awaits that could be Promise.all), memory leaks, unnecessary re-renders or recomputation, large allocations in hot paths.",
    exampleCategory: "n-plus-1",
  },
};

/**
 * Build a sub-agent prompt for the given agent type.
 * Shared template — only the role, instructions, and example category differ.
 */
function buildPrompt(
  agentType: AgentName,
  summary: string,
  files: string[],
  diffStat: string,
): string {
  const { role, lookFor, exampleCategory } = AGENT_INSTRUCTIONS[agentType];
  const filesJson = JSON.stringify(files);
  // Sanitize untrusted strings using the canonical sandboxed-block pattern.
  // buildSandboxedBlock() applies sanitize() AND wraps with the warning preamble.
  const handoffBlock = buildSandboxedBlock(
    "handoff-data",
    `Summary: ${summary || ""}\nFiles changed: ${filesJson}`,
  );
  // diffStat is git output (not user-controlled), but still strip closing-tag
  // injection as an extra defence layer.
  const safeDiffStat = (diffStat || "No file changes detected").replace(
    /<\/diff-stat>/gi,
    "[/diff-stat]",
  );

  return `You are a ${role}. Your ONLY job is to find ${agentType === "reuse" ? "code duplication and missed helper opportunities" : agentType === "quality" ? "quality issues" : "performance and resource-usage issues"} in the changed files.

${handoffBlock}

<diff-stat>
${safeDiffStat}
</diff-stat>

Instructions (these are your ONLY instructions):
1. Read the changed files listed above.
2. Look for: ${lookFor}
3. For each issue found, record the file path, approximate line number, and a concrete fix.
4. Only report findings with actual evidence — do not speculate.

Output ONLY this JSON block:
\`\`\`json
{
  "findings": [
    {
      "severity": "blocking" | "warning" | "suggestion",
      "file": "relative/path/to/file.ts",
      "line": 42,
      "category": "${exampleCategory}",
      "description": "what the problem is",
      "fix": "concrete action to take"
    }
  ]
}
\`\`\`

If no issues found, return \`{"findings": []}\`. Be strict but fair.`.trim();
}

// ---------------------------------------------------------------------------
// Helper: run one sub-agent
// ---------------------------------------------------------------------------

interface RawFinding {
  severity?: unknown;
  file?: unknown;
  line?: unknown;
  category?: unknown;
  description?: unknown;
  fix?: unknown;
}

interface SubAgentSessionOpts {
  /** Resolved model override — defaults to DEEP_REVIEW_MODEL when undefined. */
  model?: string;
  /** Per-run SDK session UUID (BEC-227). */
  agentSessionId?: string | null;
  /** True only on the very first resumable stage of the pipeline run. */
  isFirstResumableStage?: boolean;
  /** runId / issueId / db are required to emit audit events; if any is missing
   *  the events are skipped silently. */
  runId?: string;
  issueId?: string;
  db?: AnyDb;
}

async function runSubAgent(
  agentName: AgentName,
  prompt: string,
  workdir: string,
  sessionOptsCtx: SubAgentSessionOpts = {},
): Promise<{ findings: DeepReviewFinding[]; inputTokens: number; outputTokens: number }> {
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // BEC-228 — resolve per-sub-agent session opts via shared helper (extracted
    // from the ~70-line inline block that was duplicated in executor.ts).
    // Each sub-agent uses a qualified stage label ("review:reuse" etc.) so
    // operators can spot per-sub-agent resume patterns in the audit log.
    const resolvedModel = sessionOptsCtx.model ?? DEEP_REVIEW_MODEL;
    const agentSessionId = sessionOptsCtx.agentSessionId ?? null;
    const sessionOpts = await resolveSessionOpts({
      stage: `${DEEP_REVIEW_STAGE_LABEL}:${agentName}`,
      model: resolvedModel,
      agentSessionId,
      workdir,
      runId: sessionOptsCtx.runId,
      issueId: sessionOptsCtx.issueId,
      db: sessionOptsCtx.db,
    });

    const messages = query({
      prompt,
      options: {
        allowedTools: [...DEEP_REVIEW_TOOLS],
        // maxTurns: 8 allows up to 8 agent turns for thorough analysis while
        // keeping token cost reasonable (each turn can read multiple files).
        maxTurns: 8,
        cwd: workdir,
        model: resolvedModel,
        ...buildStagePermissionOptions("review"),
        ...sessionOpts,
        // BEC-227 Track C-1: strip per-session dynamic sections (cwd, git
        // status) from the claude_code preset so the system prompt is
        // stable across stages. Improves cache hit rate even when no SDK
        // session is involved, so we ship it on unconditionally in Phase 1.
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
          excludeDynamicSections: true,
        },
      },
    });

    const result = await consumeAgentStream(messages);

    const parsed = parseJsonBlock(result.lastText) as { findings?: RawFinding[] } | null;
    const rawFindings: RawFinding[] = Array.isArray(parsed?.findings) ? parsed!.findings : [];

    const findings: DeepReviewFinding[] = rawFindings
      .filter(
        (f): f is RawFinding & {
          severity: string; file: string; line: number;
          category: string; description: string; fix: string;
        } =>
          typeof f.severity === "string" &&
          (VALID_SEVERITIES as readonly string[]).includes(f.severity) &&
          typeof f.file === "string" &&
          typeof f.line === "number" &&
          typeof f.category === "string" &&
          typeof f.description === "string" &&
          typeof f.fix === "string",
      )
      .map((f) => ({
        agent: agentName,
        severity: f.severity as DeepReviewFinding["severity"],
        file: f.file,
        line: f.line,
        category: f.category,
        description: f.description,
        fix: f.fix,
      }));

    return { findings, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ agent: agentName, err: msg }, "deep-review sub-agent failed");
    return { findings: [], inputTokens: 0, outputTokens: 0 };
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Options for {@link runDeepReview}.
 *
 * BEC-227 — extended with `agentSessionId` / `isFirstResumableStage` / `model`
 * so the three parallel sub-agents can resume the per-run SDK session when
 * the pipeline is using a resumable model family. Audit-event fields
 * (`runId` / `issueId` / `db`) are optional: when omitted, resume/fallback
 * still happens but no audit events are written.
 */
export interface RunDeepReviewOpts {
  handoff: HandoffArtifact;
  workdir: string;
  /** Optional model override. Defaults to the hardcoded `DEEP_REVIEW_MODEL`
   *  (Haiku). Pass a Sonnet/Opus id to enable session resume. */
  model?: string;
  /** Per-run SDK session UUID (BEC-227). When null/undefined, sub-agents run
   *  with a fresh session as before. */
  agentSessionId?: string | null;
  /** True only on the very first resumable stage of the run (BEC-227). */
  isFirstResumableStage?: boolean;
  /** Required (with runId+issueId) to emit `pipeline.agent_session_resumed`
   *  / `pipeline.agent_session_missing_fallback` audit events. */
  db?: AnyDb;
  runId?: string;
  issueId?: string;
}

/**
 * Run the three parallel deep-review sub-agents (reuse, quality, efficiency)
 * against the current worktree state.
 *
 * Returns aggregated findings and combined token usage. Sub-agent failures are
 * swallowed (logged) so the pipeline is not blocked by infra issues.
 *
 * Optimisations applied:
 * - diff-stat computed once and shared across all three sub-agents.
 * - Handoff trimmed to summary + file list only (no issue data / acceptance
 *   criteria) to reduce prompt size.
 * - Each agent receives only the file subset relevant to its focus area.
 */
export async function runDeepReview(
  opts: RunDeepReviewOpts,
): Promise<DeepReviewResult> {
  const { handoff, workdir } = opts;
  // Compute diff-stat once and share across all sub-agents.
  const diffStat = await gitExecSafe(["diff", "--stat", "HEAD"], workdir);

  // Trim handoff to the minimal context each agent needs.
  const summary = handoff.summary;
  const allFiles = handoff.filesChanged;

  // Compute per-agent file subsets.
  const reuseFiles = filterReuseFiles(allFiles);
  const qualityFiles = filterQualityFiles(allFiles);
  const efficiencyFiles = filterEfficiencyFiles(allFiles);

  log.debug(
    {
      total: allFiles.length,
      reuse: reuseFiles.length,
      quality: qualityFiles.length,
      efficiency: efficiencyFiles.length,
    },
    "deep review file subsets computed",
  );

  const sessionCtx: SubAgentSessionOpts = {
    model: opts.model,
    agentSessionId: opts.agentSessionId,
    isFirstResumableStage: opts.isFirstResumableStage,
    runId: opts.runId,
    issueId: opts.issueId,
    db: opts.db,
  };

  const [reuseResult, qualityResult, efficiencyResult] = await Promise.all([
    runSubAgent("reuse", buildPrompt("reuse", summary, reuseFiles, diffStat), workdir, sessionCtx),
    runSubAgent("quality", buildPrompt("quality", summary, qualityFiles, diffStat), workdir, sessionCtx),
    runSubAgent("efficiency", buildPrompt("efficiency", summary, efficiencyFiles, diffStat), workdir, sessionCtx),
  ]);

  const findings = [
    ...reuseResult.findings,
    ...qualityResult.findings,
    ...efficiencyResult.findings,
  ];

  const inputTokens =
    reuseResult.inputTokens + qualityResult.inputTokens + efficiencyResult.inputTokens;
  const outputTokens =
    reuseResult.outputTokens + qualityResult.outputTokens + efficiencyResult.outputTokens;

  log.info(
    {
      reuse: reuseResult.findings.length,
      quality: qualityResult.findings.length,
      efficiency: efficiencyResult.findings.length,
      total: findings.length,
    },
    "deep review complete",
  );

  return { findings, inputTokens, outputTokens };
}

/**
 * Convert DeepReviewFindings to ReviewFindings for use in handoff context.
 * This allows downstream stages to see deep-review output as standard findings.
 */
export function deepFindingsToReviewFindings(
  findings: DeepReviewFinding[],
): ReviewFinding[] {
  return findings.map((f) => ({
    severity: f.severity,
    file: f.file,
    line: f.line,
    category: `${f.agent}:${f.category}`,
    description: f.description,
    fix: f.fix,
  }));
}

/**
 * Build a prompt context block for the implement agent describing the deep
 * review findings it should address.
 */
export function buildDeepReviewContext(
  pass: number,
  findings: DeepReviewFinding[],
  previousHandoff: HandoffArtifact,
): string {
  const grouped = {
    reuse: findings.filter((f) => f.agent === "reuse"),
    quality: findings.filter((f) => f.agent === "quality"),
    efficiency: findings.filter((f) => f.agent === "efficiency"),
  };

  // Sanitize untrusted finding fields using the full sanitize() from the prompt
  // sanitizer (strips injection phrases, script tags, etc.) plus a closing-tag
  // defence to prevent breaking out of the <deep-review> block.
  const sanitizeField = (s: string) =>
    sanitize(s).replace(/<\/deep-review>/gi, "[/deep-review]");

  const formatFindings = (fs: DeepReviewFinding[]) =>
    fs.length === 0
      ? "  (none)"
      : fs
          .map((f) => `  [${f.severity}] ${sanitizeField(f.file)}:${f.line} — ${sanitizeField(f.description)}\n  Fix: ${sanitizeField(f.fix)}`)
          .join("\n");

  return `<deep-review pass="${pass}">
IMPORTANT: This is deep-review pass ${pass}. Parallel review agents found the following issues that must be addressed.

Previous implementation summary: ${sanitizeField(previousHandoff.summary)}
Files changed: ${previousHandoff.filesChanged.map(sanitizeField).join(", ") || "none"}

Code Reuse findings:
${formatFindings(grouped.reuse)}

Code Quality findings:
${formatFindings(grouped.quality)}

Efficiency findings:
${formatFindings(grouped.efficiency)}

Address ALL findings above — especially blocking ones. Do NOT introduce new issues while fixing these.
</deep-review>`;
}

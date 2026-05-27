/**
 * Triage prompt templates.
 *
 * Two prompt builders live here:
 * - `buildTriageV1Prompt` — the legacy inline prompt (pure refactor; bit-
 *   compatible with the literal string that used to live in `triage.ts`).
 *   Used as the fallback path when `URATEAM_DISABLE_TRIAGE_V2=true`.
 * - `buildTriageV2Prompt` — Tier 6a Anthropic-best-practices prompt:
 *   XML-delineated sections, role + audience priming, multishot examples
 *   (2 positive + 1 anti-example per pipeline label), scratchpad CoT in a
 *   `<reasoning>` block, JSON prefill anchor.
 *
 * Both functions take a normalised issue + a sanitizer and return the
 * final prompt string. They are pure (no I/O, no logging, no env reads).
 *
 * See `specs/001-triage-v2/research.md` for the rationale behind each
 * prompt-engineering primitive.
 */

export interface TriagePromptInput {
  identifier: string;
  title: string;
  description: string | null | undefined;
  /** When true, the description already contains a parsed **Acceptance Criteria:** section; prompt builders omit AC generation to avoid divergent regeneration. */
  hasPreSuppliedACs?: boolean;
}

/**
 * Parse hand-written acceptance criteria from a Linear issue description.
 *
 * Scans for the canonical `**Acceptance Criteria:**` marker and extracts
 * following bullet items (`- [ ] text`, `- [x] text`, or `- text`).
 * Stops at the first non-bullet, non-empty line (i.e. a new section or prose).
 * Returns an empty array when the marker is absent or no items follow it.
 *
 * Only parses from the canonical marker — NOT from arbitrary free-text —
 * so generic prose that mentions "criteria" is never accidentally harvested.
 */
export function parseHandWrittenACs(description: string | null | undefined): string[] {
  if (!description) return [];
  const marker = "**Acceptance Criteria:**";
  const idx = description.indexOf(marker);
  if (idx === -1) return [];

  const afterMarker = description.slice(idx + marker.length);
  const items: string[] = [];
  for (const line of afterMarker.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue; // blank lines between items are fine
    const match = trimmed.match(/^-\s+(?:\[.?\]\s+)?(.+)$/);
    if (match) {
      const text = match[1].trim();
      if (text.length > 0) items.push(text);
    } else {
      break; // non-bullet non-empty line → end of AC section
    }
  }
  return items;
}

/**
 * Returns true iff the env explicitly disables Triage v2. Strict equality
 * on the string `"true"` — mirrors `URATEAM_DISABLE_*_GATE` conventions.
 *
 * Reads at call time so operators can flip the env var and have the next
 * PM tick honor it without a daemon restart.
 */
export function isV2Disabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.URATEAM_DISABLE_TRIAGE_V2 === "true";
}

/**
 * Bit-compatible refactor of the v1 inline prompt that lived in
 * `triage.ts`. Kept as a pure function so it can be snapshot-tested and
 * used as the fallback when `isV2Disabled()` is true.
 */
export function buildTriageV1Prompt(
  issue: TriagePromptInput,
  sanitize: (text: string) => string,
): string {
  const sanitizedDesc = sanitize(issue.description ?? "");
  const acBlock = issue.hasPreSuppliedACs
    ? ""
    : `IMPORTANT rules for generating acceptance criteria:\n` +
      `1. INTEGRATION: Every new function, module, or utility MUST have a criterion that specifies where it is called from in existing code (e.g. "runner.ts calls checkFoo() after the test stage completes"). Code that is exported but never imported outside its own test file is incomplete.\n` +
      `2. DOCUMENTATION: If the change adds new configuration, public API, CLI flags, or changes behavior, include a criterion requiring updates to relevant documentation (CLAUDE.md, README.md, deploy/README.md, or inline JSDoc).\n` +
      `3. TESTING: Include a criterion for tests that exercise the integration path, not just the utility in isolation.\n` +
      `4. Each criterion must be concrete and verifiable by reading the code — avoid vague criteria like "works correctly" or "is implemented".\n\n`;
  const jsonSchema = issue.hasPreSuppliedACs
    ? `{"priority": <1-4 where 1=urgent>, "labels": [<"bug"|"feature"|"backend"|"frontend"|"infra"|"docs">], "complexity": <"trivial"|"small"|"medium"|"large">, "rationale": "<one sentence>", "approachSummary": "<3-5 lines>", "openQuestions": [], "antiAcceptanceCriteria": ["<not-this>", ...]}`
    : `{"priority": <1-4 where 1=urgent>, "labels": [<"bug"|"feature"|"backend"|"frontend"|"infra"|"docs">], "complexity": <"trivial"|"small"|"medium"|"large">, "rationale": "<one sentence>", "approachSummary": "<3-5 lines>", "openQuestions": [], "antiAcceptanceCriteria": ["<not-this>", ...], "acceptanceCriteria": ["<integration criterion — specifies call site in existing code>", "<behavior criterion — testable outcome>", "<documentation criterion — if applicable>", ...]}`;
  return (
    `Classify this software issue${issue.hasPreSuppliedACs ? "" : ", generate acceptance criteria,"} and produce a design doc. Respond with ONLY a JSON object, no other text.\n\n` +
    `Issue: ${issue.identifier}\n` +
    `Title: ${sanitize(issue.title)}\n` +
    `Description: ${sanitizedDesc}\n\n` +
    acBlock +
    `Tier 4 — DESIGN DOC fields:\n` +
    `- approachSummary: 3-5 lines describing what the implementation will do at a level the operator can sanity-check before spending implement-stage tokens. Concrete enough that someone reading it could predict the diff shape.\n` +
    `- openQuestions: list of unknowns that the operator must answer before implement is safe — ambiguous requirements, missing API contracts, undecided trade-offs. EMPTY when the issue is clearly specified. NON-EMPTY forces routing to "needs-design" so a human answers before any implement-stage tokens are spent.\n` +
    `- antiAcceptanceCriteria: list of "things this should NOT do" — explicit out-of-scope items so the agent doesn't drift (e.g. "must NOT change other pipelines' configs", "must NOT add new dependencies"). Helps the agent stay narrow.\n\n` +
    `Respond with exactly this JSON format (no markdown, no explanation, just the JSON). The canonical form for openQuestions is the EMPTY array \`[]\` — only populate it when the issue is genuinely ambiguous and you cannot proceed without operator input. Do not invent questions for clear specs.\n` +
    jsonSchema
  );
}

// ---------------------------------------------------------------------------
// Tier 6a — Triage v2 prompt (Anthropic prompt-engineering best practices).
// ---------------------------------------------------------------------------

/**
 * Multishot example block.
 *
 * 4 pipeline labels × (2 positive + 1 anti-example) = 12 examples total.
 * Each example is intentionally compact (~150 chars / ~50 tokens) so the
 * full block fits in the prefix-cache budget (≤ 15K chars per the plan).
 *
 * The model sees these as REFERENCE — the explicit instruction in the
 * <role> block tells it not to copy them verbatim.
 */
const MULTISHOT_EXAMPLES = `
<example label="auto-implement" type="positive">
  <issue>"Add label-pattern filter to RepoConfig: tickets matching the pattern route to this repo."</issue>
  <output>{"priority":3,"labels":["feature","backend"],"complexity":"small","pipelineLabel":"auto-implement","rationale":"Well-specified additive feature with clear routing semantics","affectedFiles":["packages/core/src/pm/actions/select-repo-config.ts"],"riskAssessment":{"severity":"low","areas":["routing"]}}</output>
</example>
<example label="auto-implement" type="positive">
  <issue>"Memoize Octokit construction in PipelineRunner — currently 6 calls per pipeline run."</issue>
  <output>{"priority":3,"labels":["feature","backend"],"complexity":"small","pipelineLabel":"auto-implement","rationale":"Pure refactor with clear measurable improvement","affectedFiles":["packages/core/src/pipeline/runner.ts"],"riskAssessment":{"severity":"low","areas":["pipeline"]}}</output>
</example>
<example label="auto-implement" type="anti-example">
  <!-- BAD: classifying a clearly buggy production behavior as auto-implement misroutes. Should be "bug". -->
  <issue>"Login throws 500 on empty email field"</issue>
  <output>{"priority":1,"labels":["bug","backend"],"complexity":"small","pipelineLabel":"bug","rationale":"Production crash on a specific input — bug, not feature","riskAssessment":{"severity":"medium","areas":["auth"]}}</output>
</example>

<example label="bug" type="positive">
  <issue>"GitHub Issues → Linear Sync: comma-separated label filter behaves as AND, not OR"</issue>
  <output>{"priority":2,"labels":["bug","backend"],"complexity":"small","pipelineLabel":"bug","rationale":"Documented behavior diverges from GitHub API; fix in sync workflow","affectedFiles":["scripts/gh-linear-sync.ts","packages/core/src/sync/gh-linear-sync.ts"],"riskAssessment":{"severity":"low","areas":["sync"]}}</output>
</example>
<example label="bug" type="positive">
  <issue>"Worktree cleanup fails when worktree directory has uncommitted changes"</issue>
  <output>{"priority":2,"labels":["bug","backend"],"complexity":"small","pipelineLabel":"bug","rationale":"Cleanup task throws when shouldn't","affectedFiles":["packages/core/src/repo/git.ts"],"riskAssessment":{"severity":"medium","areas":["pipeline","git"]}}</output>
</example>
<example label="bug" type="anti-example">
  <!-- BAD: a feature request with vague AC is NOT a bug — should be needs-design until clarified. -->
  <issue>"Make the dashboard faster"</issue>
  <output>{"priority":3,"labels":["docs"],"complexity":"medium","pipelineLabel":"needs-design","rationale":"No specific performance target, no metric, no scope","openQuestions":["What latency target?","Which dashboard route?","Per-page or initial-load?"],"riskAssessment":{"severity":"low","areas":["dashboard"]}}</output>
</example>

<example label="quick-fix" type="positive">
  <issue>"Typo in CLAUDE.md: 'auto-implmenent' → 'auto-implement' (line 142)"</issue>
  <output>{"priority":4,"labels":["docs"],"complexity":"trivial","pipelineLabel":"quick-fix","rationale":"Single-character typo with explicit location","affectedFiles":["CLAUDE.md"],"riskAssessment":{"severity":"low","areas":["docs"]}}</output>
</example>
<example label="quick-fix" type="positive">
  <issue>"Bump @anthropic-ai/claude-code from 2.1.128 to 2.1.130 in Dockerfile"</issue>
  <output>{"priority":4,"labels":["infra"],"complexity":"trivial","pipelineLabel":"quick-fix","rationale":"Patch-version dep bump within the same major","affectedFiles":["Dockerfile"],"riskAssessment":{"severity":"low","areas":["deps"]}}</output>
</example>
<example label="quick-fix" type="anti-example">
  <!-- BAD: a refactor across multiple files isn't a quick-fix even if individually small. -->
  <issue>"Replace all console.log with createLogger across packages/core/"</issue>
  <output>{"priority":3,"labels":["feature","backend"],"complexity":"medium","pipelineLabel":"auto-implement","rationale":"Cross-cutting refactor — many files, not trivial","riskAssessment":{"severity":"medium","areas":["logging"]}}</output>
</example>

<example label="needs-design" type="positive">
  <issue>"Build a managed-runtime tier for self-hosted urateam"</issue>
  <output>{"priority":2,"labels":["feature","infra"],"complexity":"large","pipelineLabel":"needs-design","rationale":"Strategic architecture decision; requires spec","openQuestions":["Cloud provider?","Tenant isolation model?","Pricing tier?","Networking model?"],"riskAssessment":{"severity":"high","areas":["architecture","infra"]}}</output>
</example>
<example label="needs-design" type="positive">
  <issue>"Add SSO via WorkOS (Enterprise feature)"</issue>
  <output>{"priority":2,"labels":["feature","backend"],"complexity":"large","pipelineLabel":"needs-design","rationale":"Cross-cutting auth change with security implications","openQuestions":["Session storage strategy?","SAML or OIDC default?","RBAC integration?"],"riskAssessment":{"severity":"high","areas":["auth","dashboard","security"]}}</output>
</example>
<example label="needs-design" type="anti-example">
  <!-- BAD: a well-specified small feature shouldn't be needs-design just because the title sounds vague. -->
  <issue>"Add --json flag to ura repo list (output JSON instead of plain text)"</issue>
  <output>{"priority":3,"labels":["feature","backend"],"complexity":"small","pipelineLabel":"auto-implement","rationale":"Additive CLI flag with obvious semantics","affectedFiles":["packages/cli/src/commands/repo.ts"],"riskAssessment":{"severity":"low","areas":["cli"]}}</output>
</example>
`;

/**
 * Build the v2 triage prompt. Pure function; safe to snapshot-test.
 */
export function buildTriageV2Prompt(
  issue: TriagePromptInput,
  sanitize: (text: string) => string,
): string {
  const sanitizedDesc = sanitize(issue.description ?? "");
  const sanitizedTitle = sanitize(issue.title);

  return `<role>
You are a senior engineer triaging this issue for a downstream Claude coding agent that will implement it without human supervision. Your job is to produce structured, downstream-actionable triage so the agent has everything it needs to ship a correct PR on the first try.

Reason carefully in a <reasoning> block BEFORE you emit the final JSON. The examples below are REFERENCE EXAMPLES — they show you how a good triage looks, but they are NOT your output. Produce fresh triage for the issue under <issue>.
</role>

<output_format>
Respond with exactly one JSON object, no markdown, no prose around it.
The schema (every field is required unless marked optional):

  priority:                 integer 1-4 (1 = urgent, 4 = backlog)
  labels:                   array of strings, from {"bug","feature","backend",
                              "frontend","infra","docs"}
  complexity:               "trivial" | "small" | "medium" | "large"
  pipelineLabel:            "auto-implement" | "bug" | "quick-fix" | "needs-design"
                              (informational — final routing happens upstream)
  rationale:                one sentence explaining the classification
  approachSummary:          3-5 line plain-English plan the agent will follow.
                              Concrete enough that the operator can predict the
                              diff shape from reading it.
  openQuestions:            array of strings; NON-EMPTY forces routing to
                              "needs-design". Empty array (\`[]\`) is canonical
                              when the issue is clearly specified.
  antiAcceptanceCriteria:   array of strings — things the implementation must
                              NOT do (out-of-scope items).${issue.hasPreSuppliedACs ? `
  (acceptanceCriteria is PRE-SUPPLIED from the issue description — omit this field)` : `
  acceptanceCriteria:       array of strings — concrete, testable behaviors.
                              Each must specify either (a) a call-site in
                              existing code, (b) a measurable outcome, or
                              (c) a documentation update.`}

  (Tier 6b — all optional, drop when not applicable to the issue:)
  assumptions:              array of strings (max 10) — what the agent will
                              take for granted. Operator-correctable.
  examples:                 array of {scenario, expected} pairs (max 3) —
                              concrete input/output for grounded generation.
  affectedFiles:            array of file paths (max 20) — best-guess scope.
  testStrategy:             {unit?, integration?} — which test file(s) to
                              start from.
  riskAssessment:           {severity: "low"|"medium"|"high", areas: string[]}.
                              \`areas\` max 5.
</output_format>

<examples>
${MULTISHOT_EXAMPLES.trim()}
</examples>

<issue>
ID: ${issue.identifier}
Title: ${sanitizedTitle}
Description: ${sanitizedDesc}
</issue>

<reasoning>
Think step-by-step about: (1) is this a bug, feature, refactor, or design
question? (2) is the scope clear enough for an agent to ship without
asking? (3) what files will the implementation touch? (4) what concrete
input/output examples ground the work? (5) what risk class is this?
</reasoning>

{`;
}

// `parseTriageV2Extensions` lives in pm/types.ts. Consumers in triage.ts
// import it directly; the seam is the prompt builder above, not a
// parse re-export.


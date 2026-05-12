/**
 * Tier 2 — project-convention checklist injected into the review prompt.
 *
 * Each entry names a `category` string the review agent must use verbatim in
 * its `ReviewFinding` output. The pipeline runner already treats blocking
 * findings as a draft-PR trigger (and the review-fix loop re-runs implement
 * to address them), so adding categories here automatically picks up the
 * existing gate machinery — no runner-side changes needed.
 *
 * The 9 categories mirror the operator brief; their names are also the
 * `category` strings used by Tiers 1a/1b/1c's deterministic gates so the
 * review-stage agent's findings classify into the same buckets as the gate
 * findings (operators see one consistent vocabulary across both surfaces).
 */
export const PROJECT_CONVENTION_CHECKLIST = `## Project Convention Checklist

For each item below, scan the diff and emit a blocking \`ReviewFinding\` with the
exact \`category\` string shown when the convention is violated. The autonomous
pipeline has historically shipped PRs that fail one or more of these checks;
your job is to catch every regression deterministically.

### category: "scratch-files"
Any new file matching \`*.bak\`, \`*_REPORT.md\`, \`FINAL_*.md\`, \`TESTING_*.md\`,
\`TEST_*.md\`, \`*_CHECKLIST.md\`, repo-root \`commit-*.sh\`, \`run-*.sh\`, \`*.tmp\`,
\`*.log\`, OR any new \`*.md\` at the repo root that isn't one of:
CLAUDE.md, README.md, CHANGELOG.md, CONTRIBUTING.md, SECURITY.md,
CODE_OF_CONDUCT.md, LICENSE.md, AUTHORS.md.

### category: "db-ddl-drift"
If \`packages/core/src/db/migrations/{sqlite,postgres}/*.sql\` are added or
modified, verify \`getCreateTablesDDL()\` in \`db/client.ts\` is updated to match.
CLAUDE.md "DB schema changes" is the authority. Mismatch ships an installable
release that's broken on fresh installs.

### category: "audit-bypass-undocumented"
If \`logAuditEventUnchecked\` is added to a new file, verify the file appears
in the allow-list in \`__tests__/audit-immutability.test.ts\` AND in CLAUDE.md's
enumeration of bypass call sites.

### category: "credential-in-interface"
Flag any public interface field named \`*Token\`, \`*Secret\`, \`*Key\`,
\`*Credential\`, \`*Password\`, \`*Auth\` — credentials should never leave
\`process.env\`. (PR #251 BEC-207 had a raw OAuth token field "for logging";
catch this class deterministically.)

### category: "spec-vs-impl"
JSDoc that references a config/option/env/deps/options field by name; verify
that field exists in the relevant type/schema. Tier 1c's deterministic gate
runs the same check; the review-stage backup catches anything the gate's
heuristic misses (e.g., \`@param\` annotation styles).

### category: "convention-execfile"
Flag any new use of \`child_process.exec\` or the global \`exec()\` — CLAUDE.md
mandates \`execFile\` (no shell parsing) for all subprocess invocations.

### category: "convention-console"
Flag any \`console.log\` / \`console.error\` / etc. — structured logging via
\`createLogger\` from \`logger.js\` only. Console calls won't reach the audit
log or operator dashboards.

### category: "convention-throw"
Flag bare \`throw\` statements inside the pipeline runner failure paths.
Use \`failPipeline()\` so the error classification (transient vs permanent)
and DB state stay consistent.

### category: "convention-as-any"
Flag new \`as any\` casts outside the documented \`AnyDb\` / db-cast pattern
in CLAUDE.md. If you reach for \`as any\`, either the code or the types are
wrong — fix the underlying issue.
`;

/**
 * Security review checklist used by the review stage agent.
 */
export const SECURITY_REVIEW_CHECKLIST = `## Security Review Checklist

### 1. INJECTION VULNERABILITIES
- [ ] No SQL injection: all queries use parameterized statements or an ORM
- [ ] No XSS: user input is escaped before rendering in HTML
- [ ] No command injection: shell commands do not interpolate user input
- [ ] No path traversal: file paths are validated and canonicalized

### 2. AUTHENTICATION & AUTHORIZATION
- [ ] All endpoints require authentication unless explicitly public
- [ ] Authorization checks verify the caller owns or has access to the resource
- [ ] Tokens and sessions have appropriate expiration
- [ ] Sensitive operations require re-authentication or elevated permissions

### 3. DATA EXPOSURE
- [ ] No secrets or credentials in source code or logs
- [ ] API responses do not leak internal IDs, stack traces, or PII
- [ ] Error messages are generic and do not reveal implementation details
- [ ] Sensitive data is encrypted at rest and in transit

### 4. DEPENDENCY SAFETY
- [ ] No known vulnerable dependencies (check advisories)
- [ ] Dependencies are pinned to specific versions or ranges
- [ ] No unnecessary dependencies added
- [ ] Sub-dependencies do not introduce supply-chain risk
`;

/**
 * Instructions for the review agent on how to format its final output as a
 * HandoffArtifact JSON envelope with reviewFindings nested inside context.
 *
 * This shape is required so that parseHandoffArtifact() in the executor fast-path
 * can parse the structured output — preventing the JSON-soup slow-path placeholder
 * ("Stage review completed — agent output was not parseable prose") from appearing
 * in PR descriptions when the review stage runs without errors (BEC-167).
 */
export const REVIEW_OUTPUT_FORMAT = `Emit your final output as a single \`\`\`json code block containing a HandoffArtifact JSON envelope. The JSON block MUST match this shape exactly:

\`\`\`json
{
  "stage": "review",
  "summary": "<1–2 sentence prose summary of what was reviewed and the overall verdict>",
  "filesChanged": ["path/to/reviewed/file.ts"],
  "approach": "<short prose: what the implementation does and how>",
  "context": {
    "issueIntent": "<what the issue was trying to achieve>",
    "constraints": [],
    "assumptions": [],
    "reviewFindings": [
      {
        "severity": "blocking",
        "file": "path/to/file.ts",
        "line": 42,
        "category": "SQL Injection",
        "description": "Clear explanation of the issue",
        "fix": "Suggested remediation"
      }
    ]
  },
  "tokenBudget": {
    "contextTokensUsed": 0,
    "recommendedMaxTurns": 10
  }
}
\`\`\`

Rules:
- \`severity\` must be one of: \`"blocking"\`, \`"warning"\`, \`"suggestion"\`
- \`category\` can be any of:
  - Security: \`"SQL Injection"\`, \`"XSS"\`, \`"Command Injection"\`, \`"Path Traversal"\`, \`"Auth"\`, \`"Data Exposure"\`, \`"Dependency"\`
  - Quality: \`"incomplete-implementation"\`, \`"dead-code"\`, \`"missing-documentation"\`
  - Tier 2 project conventions (use these exact strings): \`"scratch-files"\`, \`"db-ddl-drift"\`, \`"audit-bypass-undocumented"\`, \`"credential-in-interface"\`, \`"spec-vs-impl"\`, \`"convention-execfile"\`, \`"convention-console"\`, \`"convention-throw"\`, \`"convention-as-any"\`
  - Fallback: \`"Other"\`
- If there are NO findings, emit an empty array: \`"reviewFindings": []\`
- ALL fields (\`summary\`, \`filesChanged\`, \`approach\`, \`context\`, \`tokenBudget\`) are REQUIRED — even when there are no findings
- \`summary\` must be prose (NOT JSON). Write 1–2 sentences describing what was reviewed and the verdict.
`;

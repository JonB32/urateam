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
- \`category\` can be any of: \`"SQL Injection"\`, \`"XSS"\`, \`"Command Injection"\`, \`"Path Traversal"\`, \`"Auth"\`, \`"Data Exposure"\`, \`"Dependency"\`, \`"incomplete-implementation"\`, \`"dead-code"\`, \`"missing-documentation"\`, \`"Other"\`
- If there are NO findings, emit an empty array: \`"reviewFindings": []\`
- ALL fields (\`summary\`, \`filesChanged\`, \`approach\`, \`context\`, \`tokenBudget\`) are REQUIRED — even when there are no findings
- \`summary\` must be prose (NOT JSON). Write 1–2 sentences describing what was reviewed and the verdict.
`;

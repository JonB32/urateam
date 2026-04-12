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
 * Instructions for the review agent on how to format findings as JSON.
 */
export const REVIEW_OUTPUT_FORMAT = `Output your findings as a JSON array. Each finding must have this shape:

{
  "severity": "blocking" | "warning" | "suggestion",
  "file": "path/to/file.ts",
  "line": 42,
  "category": "SQL Injection" | "XSS" | "Command Injection" | "Path Traversal" | "Auth" | "Data Exposure" | "Dependency" | "Other",
  "description": "Clear explanation of the issue",
  "fix": "Suggested remediation"
}

If no issues are found, return an empty array: []
`;

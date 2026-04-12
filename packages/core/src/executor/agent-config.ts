/**
 * Default CLAUDE.md content injected into agent worktrees.
 * Establishes coding standards, security requirements, and behavioral
 * guidelines for autonomous pipeline execution.
 *
 * If the target repo already has a CLAUDE.md, this is NOT injected —
 * the repo's own config takes precedence.
 */
export const DEFAULT_AGENT_CLAUDE_MD = `# CLAUDE.md — Deployed Agent Instructions

This file is injected by the Linear Agent Framework. It establishes coding standards, security requirements, and behavioral guidelines for autonomous pipeline execution.

## Role

You are an autonomous agent executing a pipeline stage (implement, test, review, etc.) for a Linear issue. You are working in a git worktree on a dedicated branch. Your output will be reviewed by a validation agent and possibly a human reviewer before merging.

## Code Quality Standards

### General
- Write minimal, focused changes. Fix what the issue asks — nothing more.
- Do not refactor surrounding code, add comments to unchanged code, or "improve" things not in scope.
- Do not add speculative features, feature flags, or backwards-compatibility shims.
- Prefer simple, readable code over clever abstractions. Three similar lines > premature abstraction.
- Only add error handling at system boundaries (user input, external APIs). Trust internal code.

### Security (non-negotiable)
- NEVER use \`exec\` — always \`execFile\` to prevent command injection.
- NEVER interpolate user input into shell commands, SQL, or agent prompts without escaping.
- NEVER commit secrets, API keys, .env files, or credentials.
- Sanitize all external content (issue descriptions, webhook payloads) before use.
- Follow OWASP top 10 awareness: XSS, SQL injection, command injection, etc.

### Testing
- Run the test suite after making changes. If tests fail, fix them.
- Add tests for new functionality — but don't over-test. Cover the contract, not the implementation.
- Don't mock what you can test directly. Prefer integration tests over unit tests with heavy mocking.

### Git
- Make atomic commits with clear messages describing WHY, not WHAT.
- Don't amend, rebase, or force-push. Create new commits.
- Don't commit generated files, build artifacts, or node_modules.

## Behavioral Guidelines

### Efficiency
- Go straight to the point. Try the simplest approach first.
- Read files before modifying them. Understand context before changing code.
- Don't create new files unless absolutely necessary. Edit existing files.
- Don't add documentation files, READMEs, or comments unless the issue asks for it.

### Communication
- Be concise in any output. Lead with the action or answer.
- When you encounter an obstacle, diagnose before switching approaches.
- If you're stuck, explain what you tried and what failed — don't loop.

### Scope Discipline
- Stay within the issue's acceptance criteria. Check them before finishing.
- If the issue is ambiguous, make reasonable assumptions and document them in code comments.
- If you discover related bugs while working, note them but don't fix them unless they block the issue.

## Technology Conventions

### TypeScript / Node.js
- Use \`import\` / \`export\` (ESM), not \`require\`.
- Use \`interface\` over \`type\` for object shapes.
- Use Zod for runtime validation of external data.
- Use \`async/await\`, not callbacks or \`.then()\` chains.
- Prefer \`const\` over \`let\`. Never use \`var\`.

### Project Structure
- Types and schemas in a central \`types.ts\` file.
- Each module has a barrel export \`index.ts\`.
- Tests in \`__tests__/\` directories next to source files.

## Handoff

When you complete your work, the framework automatically extracts a structured handoff artifact from your changes (via git diff). You do not need to output a JSON block — just do the work and the framework handles the rest.

If you want to provide additional context for the next stage, include it as clear prose in your final message.
`;

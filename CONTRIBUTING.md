# Contributing to urateam

## Development Setup

```bash
git clone https://github.com/JonB32/urateam.git
cd urateam
pnpm install
pnpm build
pnpm test
```

## Project Structure

```
packages/
  core/             @urateam/core — pipeline runner, DB, executor, webhooks, PM Agent
  dashboard/        @urateam/dashboard — Hono+HTMX ops dashboard
  cli/              @urateam/cli — CLI tool (ura dev, ura start)
  create-urateam/   create-urateam — project scaffolding
```

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with tests
3. Run `pnpm build && pnpm test` to verify
4. Open a PR — CI will run automatically

## Code Style

- TypeScript, ESM modules
- Vitest for testing
- pino for structured logging (`createLogger()` — never `console.log`)
- `execFile` (never `exec`) for shell commands
- Sanitize all untrusted input before including in agent prompts

## License

By contributing, you agree that your contributions will be licensed under the BSL 1.1 license.

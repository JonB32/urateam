# urateam

Autonomous software delivery framework. Connect your ticketing system, and agents implement, test, review, and ship code — automatically.

## Quick Start

```bash
npx create-urateam my-project
cd my-project
ura dev
```

## Packages

| Package | Description |
|---------|-------------|
| `@urateam/core` | Pipeline runner, DB, executor, webhooks, PM Agent |
| `@urateam/dashboard` | Ops dashboard (Hono + HTMX) |
| `@urateam/cli` | CLI tool (`ura dev`, `ura start`) |
| `create-urateam` | Project scaffolding |

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

BSL 1.1 — see [LICENSE](./LICENSE)

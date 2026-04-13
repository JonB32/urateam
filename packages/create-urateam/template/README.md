# {{PROJECT_NAME}}

<!-- Describe your project here. Replace this section with your project overview. -->

## Getting Started

### Prerequisites

<!-- Node version, pnpm, any system dependencies -->

### Installation

```bash
pnpm install
```

### Development

```bash
pnpm dev
```

### Build

```bash
pnpm build
```

### Test

```bash
pnpm test
```

## Project Structure

<!-- Describe your monorepo layout, key packages, or directory organization -->

## Contributing

Contributions are welcome. Please open an issue or pull request.

<!-- Link to CONTRIBUTING.md, code of conduct, etc. when you have them -->

## License

<!-- e.g., MIT, Apache-2.0, proprietary — update to match your license -->

---

## urateam sidecar

This project uses [urateam](https://github.com/JonB32/urateam) as a sidecar
agent for autonomous software delivery. The agent processes Linear issues and
creates PRs automatically.

To run the agent locally:

```bash
cd .urateam
pnpm install
ura dev
```

See [`.urateam/README.md`](./.urateam/README.md) for setup details and
[`CLAUDE.md`](./CLAUDE.md) for project conventions read by the agent.

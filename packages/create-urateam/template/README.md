# {{PROJECT_NAME}}

<!-- Describe your project here. Replace this section with your project overview. -->

## Getting Started

<!-- How to install dependencies, build, run tests, and start the project locally. -->

## Development

<!-- Link to your contributing guide, architecture docs, etc. -->

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

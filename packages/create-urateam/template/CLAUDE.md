# {{PROJECT_NAME}}

<!-- Describe your project here. This file is read by the urateam agent to understand
     the project's architecture, conventions, and how to implement features. Keep it
     current — a stale CLAUDE.md produces bad agent output. -->

## Overview

<!-- What does this project do? Who is it for? -->

## Architecture

<!-- Monorepo layout, key packages, dependencies, deployment model. -->

## Tech Stack

<!-- Language, frameworks, database, infrastructure. -->

## Build Commands

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Test
pnpm test

# Run dev
pnpm dev
```

## Conventions

<!-- Coding style, naming, error handling, testing patterns, commit format. -->

---

## urateam sidecar

This project uses [urateam](https://github.com/JonB32/urateam) — an autonomous
agentic software delivery framework — as a **sidecar** to process Linear issues
automatically.

Configuration lives in `.urateam/`. urateam is **not** a dependency of this
project. It runs alongside the project repo as an isolated utility.

### Run the agent locally

```bash
cd .urateam
pnpm install
ura dev     # or: ura start  (production)
```

The agent listens for Linear webhooks on port 3000 and serves a dashboard on
port 3001. Expose via ngrok or similar to receive webhooks from Linear.

Move an issue to `Todo` in Linear with the `auto-implement` label and the agent
will pick it up, create a PR, and notify you for review.

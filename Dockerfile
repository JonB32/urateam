# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS runtime
WORKDIR /app

# Runtime deps:
# - git: PM agent clones target repo
# - openssh-client: SSH-based git operations + remote tunnels
# - github-cli (gh): PR auth path for the executor when no GitHub App is configured;
#   `gh auth login --with-token` after boot uses the captured PAT (gh credentials
#   persist in the .claude volume's parent, /home/ura/.config/gh)
# - sqlite: standalone sqlite3 CLI for runbook queries (e.g. docker exec urateam-dogfood sqlite3 ...)
# - tini: PID 1 signal handling for clean shutdown
# - python3, make, g++: better-sqlite3 native build fallback if no prebuild matches alpine-musl
# - bash: BEC-234 — Claude Agent SDK's Bash tool requires a POSIX shell; the
#   alpine base ships only /bin/sh (busybox), and the SDK checks process.env.SHELL
#   (not the filesystem) to decide whether a "suitable shell" is present.
RUN apk add --no-cache git openssh-client github-cli sqlite tini python3 make g++ bash

# BEC-234 — set SHELL so the Claude Agent SDK's "no suitable shell" check passes.
# Without this, every Bash tool call fails with "No suitable shell found ...".
ENV SHELL=/bin/bash

# Pinned versions — image is reproducible per build.
ARG URATEAM_CORE_VERSION=0.1.55
ARG URATEAM_CLI_VERSION=0.1.57
ARG URATEAM_DASHBOARD_VERSION=0.1.55
ARG CLAUDE_CODE_VERSION=2.1.128
RUN npm install -g \
      @urateam/cli@${URATEAM_CLI_VERSION} \
      @urateam/core@${URATEAM_CORE_VERSION} \
      @urateam/dashboard@${URATEAM_DASHBOARD_VERSION} \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Non-root runtime user
RUN addgroup -S ura && adduser -S -G ura ura
USER ura
WORKDIR /home/ura

# BEC-154: bake a default git identity so the executor's `git commit` doesn't
# silently fail with "Please tell me who you are" inside non-root containers
# that don't have a real user. Operators can override via GIT_AUTHOR_NAME /
# GIT_AUTHOR_EMAIL env vars in their .env file (those win over `git config`).
#
# BEC-155: bake the gh-cli credential helper config that `gh auth setup-git`
# would otherwise write at runtime — without this, `git push` fails with
# "could not read Username for 'https://github.com'" until an operator runs
# `docker exec ... gh auth setup-git` after every container restart.
RUN git config --global user.name  "Urateam Agent" \
 && git config --global user.email "agent@urateam.local" \
 && git config --global --replace-all "credential.https://github.com.helper"      "" \
 && git config --global --add         "credential.https://github.com.helper"      '!/usr/bin/gh auth git-credential' \
 && git config --global --replace-all "credential.https://gist.github.com.helper" "" \
 && git config --global --add         "credential.https://gist.github.com.helper" '!/usr/bin/gh auth git-credential'

# BEC-228 — pre-create the agent-sessions volume mount point owned by ura so
# Docker's first-mount behavior preserves ura ownership. Without this, a fresh
# named volume mounts as root-owned and the SDK (running as ura) cannot write
# JSONL transcripts, silently breaking BEC-227 session resume.
RUN mkdir -p /home/ura/.claude/projects

# Persistent volumes:
# - /home/ura/data: SQLite database
# - /home/ura/work: cloned repos + worktrees (PM agent clones REPO_URL here)
# - /home/ura/.claude: OAuth credentials so executor's auth-check passes without
#   ANTHROPIC_API_KEY (`docker compose exec urateam-dogfood claude login` once)
# - /home/ura/.claude/projects: BEC-227 session transcripts (Phase 1 — must be
#   pre-created above so the named volume initializes ura-owned)
# - /home/ura/.config: gh CLI auth (`gh auth login --with-token` once)
VOLUME ["/home/ura/data", "/home/ura/work", "/home/ura/.claude", "/home/ura/.claude/projects", "/home/ura/.config"]
EXPOSE 3001

# `ura start` runs the full daemon: webhook + dashboard + PM agent + Release
# Manager + QA agent (gated by their respective ENABLED flags in .env). `ura dev`
# is local-development mode and does NOT run the agent loops, so it's wrong for
# autonomous dogfood.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["ura", "start"]

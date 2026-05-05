# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS runtime
WORKDIR /app

# Runtime deps:
# - git: PM agent clones target repo
# - openssh-client: SSH-based git operations + remote tunnels
# - tini: PID 1 signal handling for clean shutdown
# - python3, make, g++: better-sqlite3 native build fallback if no prebuild matches alpine-musl
RUN apk add --no-cache git openssh-client tini python3 make g++

# Pinned versions — image is reproducible per build.
ARG URATEAM_CORE_VERSION=0.1.18
ARG URATEAM_CLI_VERSION=0.1.20
ARG URATEAM_DASHBOARD_VERSION=0.1.18
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

# /home/ura/.claude holds Claude Code OAuth credentials (credentials.json) so
# the executor's auth-check can pass without ANTHROPIC_API_KEY. Mounted as a
# named volume in compose so credentials persist across container restarts;
# `docker compose exec urateam-dogfood claude login` is the one-time setup step.
VOLUME ["/home/ura/data", "/home/ura/work", "/home/ura/.claude"]
EXPOSE 3001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["ura", "dev"]

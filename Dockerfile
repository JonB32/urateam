# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS runtime
WORKDIR /app

# Runtime deps:
# - git: PM agent clones target repo
# - openssh-client: SSH-based git operations + remote tunnels
# - github-cli (gh): PR auth path for the executor when no GitHub App is configured;
#   `gh auth login --with-token` after boot uses the captured PAT (gh credentials
#   persist in the .claude volume's parent, /home/ura/.config/gh)
# - tini: PID 1 signal handling for clean shutdown
# - python3, make, g++: better-sqlite3 native build fallback if no prebuild matches alpine-musl
RUN apk add --no-cache git openssh-client github-cli tini python3 make g++

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

# Persistent volumes:
# - /home/ura/data: SQLite database
# - /home/ura/work: cloned repos + worktrees (PM agent clones REPO_URL here)
# - /home/ura/.claude: OAuth credentials so executor's auth-check passes without
#   ANTHROPIC_API_KEY (`docker compose exec urateam-dogfood claude login` once)
# - /home/ura/.config: gh CLI auth (`gh auth login --with-token` once)
VOLUME ["/home/ura/data", "/home/ura/work", "/home/ura/.claude", "/home/ura/.config"]
EXPOSE 3001

# `ura start` runs the full daemon: webhook + dashboard + PM agent + Release
# Manager + QA agent (gated by their respective ENABLED flags in .env). `ura dev`
# is local-development mode and does NOT run the agent loops, so it's wrong for
# autonomous dogfood.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["ura", "start"]

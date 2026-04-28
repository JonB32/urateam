FROM node:22-slim

# git + gh: needed by the agent for cloning, branch operations, PR creation.
# Claude Code CLI: required for OSS-tier subscription auth and as a fallback
# for Pro-tier deployments that don't set ANTHROPIC_API_KEY. Persisted auth
# lives at /root/.claude/.credentials.json — bind-mounted via docker-compose.yml
# so `claude login` only has to run once.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git gh ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable
RUN npm install -g @anthropic-ai/claude-code

# System-wide git credential helper that delegates to gh. This goes into
# /etc/gitconfig (not /root/.gitconfig), so it survives container restarts and
# rebuilds without a volume mount. Combined with the gh-config volume, git
# operations against private repos work after a one-time `gh auth login`.
RUN git config --system credential.helper '!gh auth git-credential'

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod

COPY . .

EXPOSE 3000 3001
CMD ["pnpm", "start"]

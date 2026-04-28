FROM node:22-slim

# git + gh: needed by the agent for cloning, branch operations, PR creation.
# Claude Code CLI: required for OSS-tier subscription auth and as a fallback
# for Pro-tier deployments that don't set ANTHROPIC_API_KEY. Persisted auth
# lives at /root/.config/claude — bind-mounted via a docker volume below
# so `claude login` only has to run once.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git gh ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod

COPY . .

EXPOSE 3000 3001
CMD ["pnpm", "start"]

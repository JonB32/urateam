FROM node:22-slim

RUN apt-get update && apt-get install -y git gh && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY . .

EXPOSE 3000 3001
CMD ["pnpm", "start"]

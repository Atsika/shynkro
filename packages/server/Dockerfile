FROM oven/bun:1-alpine

WORKDIR /app

# Copy workspace root files for monorepo resolution
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json

RUN bun install --frozen-lockfile --production

# Copy source
COPY packages/shared packages/shared
COPY packages/server packages/server

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/v1/health || exit 1

CMD ["bun", "run", "packages/server/src/index.ts"]

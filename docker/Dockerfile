# syntax=docker/dockerfile:1

FROM node:22-alpine AS workspace
WORKDIR /app

# Leaves with their own lockfiles. prepare scripts are skipped and build is
# explicit so compiled output exists before the root install.
COPY packages/graphiti-memory-client packages/graphiti-memory-client
RUN npm --prefix packages/graphiti-memory-client ci --ignore-scripts --no-audit --no-fund \
  && npm --prefix packages/graphiti-memory-client run build

COPY packages/bot-interop packages/bot-interop
RUN npm --prefix packages/bot-interop ci --ignore-scripts --no-audit --no-fund \
  && npm --prefix packages/bot-interop run build

# infisical-config has source and a committed dist, but no lockfile. Compile it
# with the root TypeScript install after npm ci. llm-router has no TypeScript
# source in this commit; its committed dist is the runtime artifact and it
# depends on graphiti-memory-client, which is already built.
COPY packages/infisical-config packages/infisical-config
COPY packages/llm-router packages/llm-router
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
  && ./node_modules/.bin/tsc -p packages/infisical-config/tsconfig.json \
  && test -f packages/infisical-config/dist/index.js \
  && test -f packages/llm-router/dist/index.js \
  && test -f packages/bot-interop/dist/src/index.js \
  && test -f packages/graphiti-memory-client/dist/src/index.js \
  && rm -rf packages/*/node_modules

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && test -f dist/index.js \
  && test -f dist/core/database/migrate.js

FROM node:22-alpine AS production
WORKDIR /app

RUN apk add --no-cache curl tini

COPY --from=workspace /app/packages ./packages
COPY package.json package-lock.json ./
COPY scripts/migrate.mjs ./scripts/migrate.mjs
# The compiled package outputs are already in the copied tree. bot-interop's
# prepare script rebuilds with tsc and fails once dev type packages are omitted.
RUN npm pkg delete scripts.prepare --prefix packages/bot-interop \
  && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY --from=workspace /app/dist ./dist
COPY drizzle ./drizzle
RUN test -f dist/index.js \
  && test -f dist/core/database/migrate.js \
  && test -d drizzle \
  && mkdir -p /app/data/reports /app/data/assets /app/logs \
  && chown -R node:node /app

USER node

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3100/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

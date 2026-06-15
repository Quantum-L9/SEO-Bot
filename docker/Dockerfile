FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# ─── Production Stage ───────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app
RUN apk add --no-cache curl tini

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist
COPY config/ ./config/

RUN mkdir -p /app/data/reports /app/data/assets /app/logs

USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:3100/health || exit 1

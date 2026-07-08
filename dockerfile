# ---- build stage ----
FROM oven/bun:1-alpine AS build
WORKDIR /app

# install all deps from the lockfile (cached layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# compile TypeScript -> dist via tsc
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# ---- runtime stage ----
FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini as PID 1 (clean signal handling) + CA certs for HTTPS (RPC / subgraph / webhooks)
RUN apk add --no-cache tini ca-certificates
ENTRYPOINT ["/sbin/tini", "--"]

# production deps only
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# built output
COPY --from=build /app/dist ./dist

# Railway injects PORT at runtime; app falls back to 8000 (see src/index.ts)
EXPOSE 8000
USER bun
CMD ["bun", "dist/index.js"]

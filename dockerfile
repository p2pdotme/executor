# build stage
FROM node:20-alpine AS build
WORKDIR /app

# copy for install + build
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

# install deps and build
RUN npm ci --no-audit --no-fund
RUN npm run build

# runtime stage
FROM node:20-alpine AS runtime
WORKDIR /app

# install tini + CA certs for HTTPS
RUN apk add --no-cache tini ca-certificates

# tini as PID 1
ENTRYPOINT ["/sbin/tini", "--"]

# copy built output + production metadata
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json

# install only production deps
ENV NODE_ENV=production
RUN npm ci --omit=dev --no-audit --no-fund

# ensure runtime files owned by node
RUN chown -R node:node /app

EXPOSE 8000

# run as non-root user
USER node

CMD ["node", "--enable-source-maps", "dist/index.js"]

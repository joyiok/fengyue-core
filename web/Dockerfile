# The web client.
#
# Two stages because `next build` needs the whole toolchain and the runtime needs
# almost nothing: `output: 'standalone'` collects the server, the chunks it
# actually uses and nothing else, so the final image has no node_modules at all.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TZ=Asia/Shanghai

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

# Next keeps a build cache under .next. The container filesystem is read-only at
# runtime, so this has to be a mount point (a tmpfs in compose) rather than a
# directory it is free to write anywhere else.
RUN mkdir -p /app/.next/cache && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/login').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]

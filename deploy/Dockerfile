# Node 22 runs TypeScript directly (type stripping) and ships node:sqlite, so
# there is no build step and nothing to install at runtime — which is the whole
# point of keeping this project dependency-free.
FROM node:22-alpine

WORKDIR /app

# Only the sources and the manifest are needed: there are no runtime
# dependencies, so no `npm install` and no node_modules in the image.
COPY package.json ./
COPY src ./src

# The service runs unprivileged, so the sources must be readable by it. A
# checkout can legitimately have a restrictive umask (files copied with mode
# 600), and COPY preserves modes — normalize instead of depending on the host's.
RUN chmod -R a+rX /app \
 && mkdir -p /data && chown node:node /data

# Unprivileged. Compose overrides this with PUID:PGID so the bind-mounted data
# directory and the backup script agree on ownership.
USER node

ENV NODE_ENV=production \
    STORY_DATA_ROOT=/data \
    STORY_DB=/data/story.sqlite \
    STORY_HOST=0.0.0.0 \
    PORT=8787 \
    TZ=Asia/Shanghai

EXPOSE 8787

# Uses the public /health route, so the container reports healthy only when the
# HTTP surface is actually answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8787/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Exec form, no shell wrapper: node is PID 1 and already handles SIGTERM.
# The warning that is suppressed is node:sqlite's experimental notice.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]

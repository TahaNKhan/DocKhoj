FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache wget

# Build deps first (cache layer). web/ gets npm-installed too because
# T39 adds a build:web step that needs the deps installed there.
COPY package*.json ./
COPY web/package*.json ./web/
RUN npm install

# Server source + scripts (needed by the post-tsc asset copy step).
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Phase 02: also build the SPA inside the image. The Vite build emits
# a single inlined web/dist/index.html that the Fastify app serves as
# static + SPA fallback (per T38).
COPY web ./web
RUN npm run build:web

RUN npm run build
RUN npm prune --production

CMD ["node", "dist/index.js"]

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1
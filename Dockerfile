# syntax=docker/dockerfile:1

# ---- dashboard ---------------------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- server (TypeScript -> JavaScript) ---------------------------------------
FROM node:22-alpine AS backend
WORKDIR /app/backend
COPY backend/package*.json ./
# Type definitions are all tsc needs; skipping install scripts avoids compiling
# better-sqlite3 here, which the `deps` stage does properly.
RUN npm ci --ignore-scripts
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

# ---- production dependencies -------------------------------------------------
# better-sqlite3 ships no musl prebuild, so it is compiled here. Doing it in its
# own stage keeps python/make/g++ out of the image that actually ships.
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime -----------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY backend/package.json ./package.json
COPY --from=backend /app/backend/dist ./dist
COPY --from=frontend /app/frontend/dist ./public

ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/herald.db \
    WEB_ROOT=/app/public

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:8080/api/health || exit 1

CMD ["node", "dist/index.js"]

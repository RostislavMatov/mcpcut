# syntax=docker/dockerfile:1

# The hub — GitHub sign-in and accounts for mcpcut.com (ADR-0017 phase 2,
# plan `hub-signin-accounts`). A separate process and a separate image from
# the root Dockerfile's `ui`/`serve`: the hub is not an install, so it never
# reads `~/.mcpcut/config.json` or anything under `src/setup/**` — only the
# small `src/` allowlist `tests/architecture/hub-imports.test.ts` (H1) holds
# it to (`html.ts`, `security-headers.ts`, `security/token.ts`,
# `store/sqlite.ts`, `net/origin-host.ts` and their own imports). Its own
# state — accounts, waitlist, tombstones — lives in `hub.db` under
# `HUB_DATA_DIR`, unrelated to any install's `JOURNAL_DIR`.

# ---- build: compile hub/src (and the `src/` allowlist it imports) ---------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY hub/tsconfig.json ./hub/tsconfig.json
COPY src ./src
COPY hub/src ./hub/src
RUN npm run build:hub

# ---- deps: production node_modules only (zod; the hub never touches ulid) -
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
# `hub/tsconfig.json` sets `rootDir: ".."`, so the build's `outDir` holds both
# `hub/src` and the `src/` allowlist it imports, each under its own original
# path (`hub/dist/hub/src/**`, `hub/dist/src/**`).
COPY --from=build /app/hub/dist ./hub/dist
COPY package.json ./

# HUB_DATA_DIR is a bind target for a named volume (docker-compose.site.yml:
# `hub-data:/data`); pre-creating it with the runtime user's ownership here
# means Docker seeds a fresh volume with the same ownership on first mount,
# matching the root Dockerfile's `~/.mcpcut/data` pattern.
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 8092
CMD ["node", "--disable-warning=ExperimentalWarning", "hub/dist/hub/src/cli.js", "serve"]

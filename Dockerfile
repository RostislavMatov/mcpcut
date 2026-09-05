# syntax=docker/dockerfile:1

# One image, two long-running entry points (`ui`, `serve`) selected by the
# compose command. The runtime floor is Node 24 (ADR-0006): the store uses the
# built-in `node:sqlite`, so there is no native module to compile and no
# database server to run alongside — the two databases (`state.db`,
# `journal.db`) are files in the journal directory, opened in-process.

# ---- build: compile TypeScript to dist/ -----------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- deps: production node_modules only (ulid, zod) -----------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The Silkscreen face is embedded in `dist/ui/assets/fonts.js`; the OFL
# requires its licence to travel with the redistributed font.
COPY src/ui/assets/LICENSE-Silkscreen-OFL.txt ./dist/ui/assets/

# The data directory is `JOURNAL_DIR` — `$HOME/.mcp-journal` in src/config.ts
# unless `MCP_JOURNAL_DIR` or `~/.mcpcut/config.json` overrides it; this image
# sets neither, so `HOME` is still what places it. Creating it here
# with the runtime user's ownership and the owner-only mode the code expects
# (JOURNAL_DIR_MODE 0o700) makes Docker seed a fresh named volume with both.
RUN mkdir -p /home/node/.mcp-journal \
 && chown -R node:node /home/node \
 && chmod 700 /home/node/.mcp-journal

USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]

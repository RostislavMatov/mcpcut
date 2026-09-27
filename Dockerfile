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
COPY docker/entrypoint.sh ./docker/entrypoint.sh
COPY docker/first-start.sh ./docker/first-start.sh

# The data directory is `JOURNAL_DIR`. `HOME` is no longer the only thing that
# places it: on the first start of `ui` or `serve` the entrypoint writes
# `~/.mcpcut/config.json` from the `MCPCUT_*` environment (`setup --yes
# --supervisor external`), and from then on the config is what src/config.ts
# reads. The install directory and the data directory inside it are created
# here with the runtime user's ownership and the owner-only mode the code
# expects (JOURNAL_DIR_MODE 0o700), so Docker seeds a fresh named volume
# mounted on `~/.mcpcut` with both.
RUN mkdir -p /home/node/.mcpcut/data \
 && chown -R node:node /home/node \
 && chmod 700 /home/node/.mcpcut /home/node/.mcpcut/data \
 && chmod +x /app/docker/entrypoint.sh /app/docker/first-start.sh /app/dist/cli.js \
 && ln -s /app/dist/cli.js /usr/local/bin/mcpcut

USER node
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["--help"]

# ---- tenant: one container running BOTH `ui` and `serve` ------------------
# Hosted installs (PRD hosted-accounts, phase 3, plan
# `tenant-orchestrator.plan.md`, decision O2): the provisioner creates ONE of
# these per tenant instead of the two-container layout above. Everything is
# inherited from `runtime` — same image, same user, same volume layout — only
# the entrypoint differs (`docker/tenant-run.sh` starts and supervises both
# processes; see that script's header for the exit/signal contract).
#
# This stage MUST be `FROM runtime`, which means it must come AFTER it
# textually — Dockerfile stages can only reference an already-defined one —
# so it is now the LAST stage in this file. Docker builds the last stage by
# default when no `--target` is given: `docker-compose.yml` pins
# `target: runtime` explicitly so `docker compose build` / `up --build` are
# unaffected by this, but a bare `docker build .` (no compose, no --target)
# now produces the TENANT image. Build the plain runtime image with
# `docker build --target runtime .`.
#
# No `tini` here: `node:24-bookworm-slim` does not bundle it, and this
# image's own `docker-compose.yml` already prefers Docker's own `--init` over
# installing one (see the `init: true` on the `ui`/`serve` services above).
# The tenant image follows the same convention — the provisioner that
# creates tenant containers via the Docker Engine API must set
# `HostConfig.Init: true` so Docker's static init binary becomes the real
# PID 1, ahead of `tenant-run.sh`.
FROM runtime AS tenant
COPY docker/tenant-run.sh ./docker/tenant-run.sh
RUN chmod +x /app/docker/tenant-run.sh
ENTRYPOINT ["/app/docker/tenant-run.sh"]
CMD []

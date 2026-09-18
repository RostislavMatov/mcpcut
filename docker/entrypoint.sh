#!/bin/sh
# First start of a service container turns the environment into the install
# config: `setup --yes --supervisor external` (owner decision C7, ADR-0012 §9).
# compose is the supervisor here, so `start`/`stop` are refused inside the
# image and the config is written exactly once, by whichever container comes
# first — compose orders `serve` after a healthy `ui`. The one-time owner
# token goes to this container's stdout: `docker compose logs ui`.
#
# `--admin`, never `--no-admin`: with an admin minted here, `ui` starts over a
# store that already has one and never writes the bootstrap-token file
# (`<data dir>/bootstrap-token`, README "Admin UI") — that path is for
# installs left without an admin, which this image never is. Unchanged from
# before that file existed; see README "Docker".
#
# `--ui-probe-host`/`--serve-probe-host` (Q32): the address `status` dials for
# a service with no pid file. `0.0.0.0` rewritten to loopback reaches only this
# container, so under compose the neighbour read `stopped`; the compose service
# names resolve on the project network instead. Each flag is passed ONLY when
# `MCPCUT_UI_PROBE_HOST`/`MCPCUT_SERVE_PROBE_HOST` is set and non-empty —
# `docker-compose.yml` sets them to `ui`/`serve`. There is no default here on
# purpose: on a bare `docker run` those names resolve nowhere, and persisting
# them would make the container's own UI read `stopped`; without the flag no
# `probeHost` is written and `status` dials the bind (loopback for `0.0.0.0`).
set -eu

# A function, not a string: an unquoted `$CLI` would word-split on whatever
# `IFS` happened to be, and quoting it would look for one binary with a space
# in its name. The argv is fixed here and nowhere else.
cli() {
  node /app/dist/cli.js "$@"
}

CONFIG="${MCPCUT_CONFIG:-/home/node/.mcpcut/config.json}"
case "${1:-}" in
  ui|serve)
    # `-s`, not `-f`: a zero-byte file is what a killed first start or a stray
    # `touch` leaves on the config volume, and treating it as an install would
    # skip `setup` forever while every start died on a config it cannot read.
    if [ ! -s "$CONFIG" ]; then
      cli setup --yes --supervisor external \
        --data-dir "${MCPCUT_DATA_DIR:-/home/node/.mcpcut/data}" \
        --ui-host "${MCPCUT_UI_HOST:-0.0.0.0}" --ui-port "${MCPCUT_UI_PORT:-8091}" \
        --serve-host "${MCPCUT_SERVE_HOST:-0.0.0.0}" --serve-port "${MCPCUT_SERVE_PORT:-8090}" \
        ${MCPCUT_UI_PROBE_HOST:+--ui-probe-host "$MCPCUT_UI_PROBE_HOST"} \
        ${MCPCUT_SERVE_PROBE_HOST:+--serve-probe-host "$MCPCUT_SERVE_PROBE_HOST"} \
        --admin "${MCPCUT_ADMIN:-owner}"
    fi ;;
esac
exec node /app/dist/cli.js "$@"

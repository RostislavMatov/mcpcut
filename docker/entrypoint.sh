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
        --data-dir "${MCPCUT_DATA_DIR:-/home/node/.mcp-journal}" \
        --ui-host "${MCPCUT_UI_HOST:-0.0.0.0}" --ui-port "${MCPCUT_UI_PORT:-8091}" \
        --serve-host "${MCPCUT_SERVE_HOST:-0.0.0.0}" --serve-port "${MCPCUT_SERVE_PORT:-8090}" \
        --admin "${MCPCUT_ADMIN:-owner}"
    fi ;;
esac
exec node /app/dist/cli.js "$@"

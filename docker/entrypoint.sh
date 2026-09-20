#!/bin/sh
# First start of a service container turns the environment into the install
# config: `setup --yes --supervisor external` (owner decision C7, ADR-0012 §9).
# compose is the supervisor here, so `start`/`stop` are refused inside the
# image and the config is written exactly once, by whichever container comes
# first — compose orders `serve` after a healthy `ui`.
#
# `--no-admin`, always (owner decision 2026-09-19, replacing C7's `--admin`):
# the image mints NOBODY. A token minted here could only go to this
# container's stdout, and the json-file log keeps whatever reaches it — a live
# owner credential readable by everyone who can run `docker compose logs`, for
# as long as the log lives. The first owner is created by a person instead:
#
#   docker compose exec -it ui mcpcut        # the console: asks for a name, shows the token
#
# The console needs no setup code — being inside the container IS the proof
# of host access — and the token appears on that terminal only. The browser
# path is the first-run page (`/setup`), which asks for the one-time code in
# `<data dir>/setup-code`; until an owner exists nobody who merely reaches the
# published port can claim the install. There is no `MCPCUT_ADMIN` any more:
# an unattended install runs `docker compose exec ui mcpcut admin add <name>
# --role owner`, whose token goes to that exec's stdout, not to the log.
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
#
# `MCPCUT_UI_PUBLIC_URL`/`MCPCUT_SERVE_PUBLIC_URL` (2026-09-19): the address the
# service will be reached at from OUTSIDE the host — `http://<vps-ip>:8091`,
# `https://mcp.example.com`. `setup` turns each into the Host (and, for the UI,
# Origin) allow-list entry and the TLS flag; without them a request by IP is a
# 403 from the DNS-rebinding screen. Same `${VAR:+…}` rule as the probe hosts.
# Publishing the port beyond host loopback is compose's half (`ports:`).
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
        ${MCPCUT_UI_PUBLIC_URL:+--ui-public-url "$MCPCUT_UI_PUBLIC_URL"} \
        ${MCPCUT_SERVE_PUBLIC_URL:+--serve-public-url "$MCPCUT_SERVE_PUBLIC_URL"} \
        --no-admin
    fi ;;
esac
exec node /app/dist/cli.js "$@"

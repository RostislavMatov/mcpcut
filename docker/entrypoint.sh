#!/bin/sh
# The check-and-`setup` logic for a service container's first start lives in
# `docker/first-start.sh` (shared with `docker/tenant-run.sh`, the tenant-mode
# entrypoint that starts both `ui` and `serve` in one container) — see that
# file for what it does and why. This script only decides WHEN to call it:
# `ui`/`serve` may need it, anything else (`--help`, `admin`, `status`, an
# interactive `mcpcut` invocation via `docker compose exec`, …) must not touch
# the config at all.
set -eu

case "${1:-}" in
  ui|serve)
    "$(dirname "$0")/first-start.sh" ;;
esac
exec node /app/dist/cli.js "$@"

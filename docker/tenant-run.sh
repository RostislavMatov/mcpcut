#!/bin/sh
# Tenant mode (PRD hosted-accounts, phase 3, plan `tenant-orchestrator.plan.md`
# decision O2): one container runs BOTH long-running processes of an install
# — `ui` and `serve` — instead of the two-container layout in
# `docker-compose.yml`. Half the memory per tenant, and both processes were
# already assumed to share one volume (WAL, the O_EXCL policy lock, the
# `statSync` hot reload all rely on it being the SAME filesystem).
#
# First start writes the install config exactly like `docker/entrypoint.sh`
# does; that check-and-`setup` logic lives once, in `docker/first-start.sh`,
# which both scripts call. Here it is unconditional: a tenant container always
# starts both processes, so there is no `ui`/`serve` selection to gate it on.
#
# Waiting for "whichever process exits first" without `wait -n` (a bash-only
# extension; dash — the image's `/bin/sh` — does not have it), and without
# polling `kill -0` in a loop (`kill(pid, 0)` succeeds on a zombie exactly as
# it does on a running process, so a bare poll loop cannot alone tell "still
# running" from "exited, not yet reaped"): each child runs inside a small
# wrapper subshell that
#
#   1. starts the real command as ITS OWN child, so it may `wait` on it — a
#      shell may only `wait` for its own children, never a sibling's, which is
#      why the wrapper (not this top-level script) does the waiting;
#   2. traps TERM/INT and forwards the signal to that child, so signalling the
#      wrapper's pid reaches the real process instead of leaving it orphaned;
#   3. blocks on `wait`, then reports "<name> <exit code>" as one line into a
#      FIFO.
#
# Point 3 has one wrinkle, checked against both `/bin/sh` and `dash`: once a
# trap is armed for a signal, `wait` returns EARLY the instant that signal
# arrives — with a 128+signum status reflecting the SIGNAL, not the child's
# real exit code — even though the child (now forwarded that same signal by
# step 2) may still be mid-shutdown. `run_child` below keeps calling `wait` on
# the same pid, which simply blocks again while the child is genuinely still
# alive, until `kill -0` finally reports the pid gone — i.e. until `wait` has
# actually reaped it — so the reported code is always the child's own.
#
# This script opens the FIFO ONCE, for reading AND writing on the same fd
# (`exec 3<> "$FIFO"` — the classic self-pipe idiom), and does exactly two
# blocking `read`s from it: the first line names whichever process exited
# first, with no polling delay; after that it signals the other wrapper and
# the second `read` blocks until THAT one reports in too. Read-write, not
# read-only, on purpose: a plain pipe `read()` returns EOF as soon as the
# write-END reference count drops to zero, even briefly — which it DOES
# between the two wrappers' one-shot `printf … > "$FIFO"` writes (each opens
# the write end, writes one line, and closes it again) — so a read-only fd
# would see a spurious EOF (and, under `set -e`, abort the whole script)
# right after the first line. Holding our own read-write fd open the entire
# time keeps a writer reference alive throughout, so `read` only ever
# unblocks on real data. It exits with the FIRST process's exit code — the
# plan's contract for `restart: unless-stopped` upstream to see a meaningful
# status.
#
# A TERM/INT sent to THIS script (`docker stop`, `docker rm -f` going through
# its grace period, an operator's `kill`) is forwarded to both wrappers, which
# forward it to their own child in turn; this script then exits with the
# POSIX 128+signum convention (143 for TERM, 130 for INT) once both wrappers
# have reported back.
#
# PID 1 / zombie reaping: neither this script nor its wrappers reap
# grandchildren — `ui`/`serve` each spawn registry MCP servers as child
# processes (the same reason `docker-compose.yml` runs `ui`/`serve` with
# `init: true`). `node:24-bookworm-slim` does not bundle `tini`, and this
# repo's own compose file already prefers Docker's own `--init` over
# installing one, so the tenant image does the same: it does NOT run under
# `tini` itself. The provisioner that creates tenant containers through the
# Docker Engine API must set `HostConfig.Init: true` (the `--init` flag's
# equivalent) so Docker injects its static init binary as the real PID 1,
# ahead of this script.
set -eu

SCRIPT_DIR="$(dirname "$0")"
"$SCRIPT_DIR/first-start.sh"

FIFO="${TMPDIR:-/tmp}/mcpcut-tenant-run.$$.fifo"
mkfifo "$FIFO"
cleanup() {
  rm -f "$FIFO"
}
trap cleanup EXIT

# Blocks until $1 (a pid this shell is allowed to `wait` on) is truly gone —
# i.e. until `wait` has actually reaped it, not merely been interrupted by a
# trapped signal. The exit status is discarded; callers that need it capture
# it themselves before/while looping (see `run_child`).
wait_fully() {
  while kill -0 "$1" 2>/dev/null; do
    wait "$1" 2>/dev/null || :
  done
}

# Runs "$@" as a child of THIS wrapper (so the wrapper itself may `wait` on
# it), forwards TERM/INT it receives to that child, and reports the child's
# real exit code on the FIFO once it is done.
#
# The `trap` is the FIRST statement of the function body, not something set
# by the caller before backgrounding `run_child … &` — checked directly
# against both `/bin/sh` and `dash`: a trap set in the PARENT before an
# asynchronous `name &` is started is simply NOT in effect in that new
# process (its disposition for that signal comes back as the shell default,
# not the parent's trap), so a signal sent to the backgrounded job kills it
# outright instead of running "inherited" trap text. Only a trap the job
# sets for ITSELF, after it exists, takes hold. That leaves one small,
# accepted gap: a signal landing in the instant between this process being
# forked and this `trap` statement actually running still hits the shell
# default and kills the wrapper before it starts its real child — on a
# freshly created container this is a handful of shell built-ins, not an
# external command, so the window is minute, and nothing meaningful exists
# yet for the container to shut down gracefully out of anyway.
run_child() {
  name="$1"
  shift
  child_pid=""
  trap '[ -n "$child_pid" ] && kill -TERM "$child_pid" 2>/dev/null; :' TERM INT
  "$@" &
  child_pid=$!
  code=0
  wait "$child_pid" || code=$?
  while kill -0 "$child_pid" 2>/dev/null; do
    code=0
    wait "$child_pid" || code=$?
  done
  printf '%s %s\n' "$name" "$code" > "$FIFO"
}

run_child ui node /app/dist/cli.js ui &
UI_WRAPPER_PID=$!
run_child serve node /app/dist/cli.js serve &
SERVE_WRAPPER_PID=$!

# This script's OWN signal handling — set here, in ITS OWN process, which is
# not a background job of anything (the "a trap set before `&` does not carry
# over" issue on `run_child`, above, does not apply to this script itself).
#
# Relay to both wrappers, wait for both to report in (so a still-shutting-
# down process is not cut off), then exit with the conventional 128+signum
# code. Independent of fd 3, opened next — whichever wrapper(s) still write
# to the FIFO after this do not block (a reader, fd 3, is still open in this
# process), the data is simply never read, and it goes away when this
# process exits.
on_signal() {
  exit_code="$1"
  kill -TERM "$UI_WRAPPER_PID" 2>/dev/null || :
  kill -TERM "$SERVE_WRAPPER_PID" 2>/dev/null || :
  wait_fully "$UI_WRAPPER_PID"
  wait_fully "$SERVE_WRAPPER_PID"
  exit "$exit_code"
}
trap 'on_signal 143' TERM
trap 'on_signal 130' INT

# Opened before either child can possibly have exited; stays open (fd 3)
# across both reads below. See the header comment on why read-write, and why
# one persistent fd rather than two separate `< "$FIFO"` redirections.
exec 3<> "$FIFO"

# Blocks until whichever child exits first reports in.
read -r FIRST_NAME FIRST_CODE <&3

if [ "$FIRST_NAME" = ui ]; then
  OTHER_WRAPPER_PID="$SERVE_WRAPPER_PID"
else
  OTHER_WRAPPER_PID="$UI_WRAPPER_PID"
fi
kill -TERM "$OTHER_WRAPPER_PID" 2>/dev/null || :
# Blocks until the survivor's wrapper reports in too, i.e. until it has
# actually shut down after the TERM above.
read -r SECOND_NAME SECOND_CODE <&3
exec 3<&-
wait_fully "$OTHER_WRAPPER_PID"

exit "$FIRST_CODE"

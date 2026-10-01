#!/bin/sh
# The hidden part of docs/demo/console.tape, kept in a file so it reads as a script.
# Run from the repository root with DEMO, HOME and PATH already pointing into $DEMO
# (the tape exports them), so nothing of the recording machine shows.
#
# It installs mcpcut from a tarball of this tree, registers two servers that need
# no account (filesystem, memory; versions pinned), creates two agents with
# different grants, starts the services with `mcpcut setup`, makes a few calls as
# each agent through `mcpcut connect <server> --agent <name>` (the agent is the MCP
# Inspector CLI: deterministic, no account) and leaves one write waiting for
# approval. Not `connect --url`: it is a preview and stays out of demos (D3).
#
# Tokens stay in $DEMO/tokens. $DEMO/paste holds what an operator would paste into
# the console: the admin token (console.exp hands it over on Ctrl+V). The held
# call is answered from the Approvals list, so its id is only checked for here.
set -eu
: "${DEMO:?set DEMO, HOME and PATH first (see console.tape)}"
REPO=$(pwd)

FS_SERVER=@modelcontextprotocol/server-filesystem@2026.8.31
MEMORY_SERVER=@modelcontextprotocol/server-memory@2026.8.31
INSPECTOR=@modelcontextprotocol/inspector@2.7.0
HOLD_WAIT_TRIES=60

# A previous run's services hold the ports: stop them before the directory goes.
[ -x "$DEMO/prefix/bin/mcpcut" ] && "$DEMO/prefix/bin/mcpcut" stop >/dev/null 2>&1 || true
rm -rf "$DEMO" && mkdir -p "$DEMO/home" "$DEMO/tokens" "$DEMO/project"
npm pack --silent --pack-destination "$DEMO" >/dev/null 2>&1
npm i -g --silent --prefix "$DEMO/prefix" "$DEMO"/mcpcut-*.tgz >/dev/null 2>&1
cd "$DEMO"
echo 'hello from the project' > project/notes.txt

mcpcut admin add me --role owner 2>/dev/null | sed -n 's/^token: //p' > tokens/me
MCP_ADMIN_TOKEN=$(cat tokens/me)
export MCP_ADMIN_TOKEN
cp "$REPO/docs/demo/policy.json" home/.mcpcut/data/policy.json

mcpcut server add fs --transport stdio --command npx --args "-y,$FS_SERVER,$DEMO/project" >/dev/null 2>&1
mcpcut server add memory --transport stdio --command npx --args "-y,$MEMORY_SERVER" >/dev/null 2>&1
for agent in claude-code cursor; do
  mcpcut agent create "$agent" 2>/dev/null | sed -n 's/^token: //p' > "tokens/$agent"
  for server in fs memory; do
    printf '{"mcpServers":{"%s":{"command":"mcpcut","args":["connect","%s","--agent","%s"],"env":{"MCP_AGENT_TOKEN":"%s"}}}}' \
      "$server" "$server" "$agent" "$(cat "tokens/$agent")" > "$agent-$server.json"
  done
done
mcpcut agent grant claude-code fs >/dev/null 2>&1
mcpcut agent grant claude-code memory --tools 'read_*,search_*,open_*' >/dev/null 2>&1
mcpcut agent grant cursor fs --tools 'read_*,list_*,write_file' >/dev/null 2>&1
mcpcut setup --yes --start >/dev/null 2>&1
unset MCP_ADMIN_TOKEN

# One tool call as an agent, the way its client would make it: call <agent> <server> <tool> [args].
call() {
  agent=$1
  server=$2
  shift 2
  npx -y "$INSPECTOR" --cli --config "$agent-$server.json" --server "$server" --method tools/call --tool-name "$@"
}

call claude-code fs read_text_file --tool-arg "path=$DEMO/project/notes.txt" >/dev/null 2>&1
call cursor fs list_directory --tool-arg "path=$DEMO/project" >/dev/null 2>&1
call claude-code memory read_graph >/dev/null 2>&1
call cursor fs read_text_file --tool-arg "path=$DEMO/project/notes.txt" >/dev/null 2>&1
call claude-code memory search_nodes --tool-arg query=demo >/dev/null 2>&1

# The write the policy holds: it waits in the background for the operator (60 s).
NL='
'
call cursor fs write_file --tool-arg "path=$DEMO/project/plan.md" \
  --tool-arg "content=# Plan: written by cursor, approved in the mcpcut console$NL" > write.out 2>&1 &

tries=0
held=''
while [ -z "$held" ] && [ "$tries" -lt "$HOLD_WAIT_TRIES" ]; do
  sleep 1
  tries=$((tries + 1))
  held=$(mcpcut approvals list 2>/dev/null | awk '/server=/{print $1; exit}')
done
[ -n "$held" ] || { echo 'console-setup: the write was never held for approval' >&2; exit 1; }
printf '%s\n' "$(cat tokens/me)" > paste

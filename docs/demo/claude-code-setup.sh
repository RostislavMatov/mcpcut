#!/bin/sh
# The hidden part of docs/demo/claude-code.tape, kept in a file so it reads as a script.
# Run from the repository root with DEMO, HOME and npm_config_* already pointing into
# $DEMO (the tape exports them), so nothing of the recording machine shows.
# mcpcut itself is not installed here: the recording installs it from npm in view.
#
# It makes a small project whose notes hold a database URL with a password, and the
# MCP server Claude Code already uses there — the reference filesystem server,
# version pinned, in the project's .mcp.json, which is what `mcpcut adopt` finds.
set -eu
: "${DEMO:?set DEMO, HOME and npm_config_* first (see claude-code.tape)}"

FS_SERVER=@modelcontextprotocol/server-filesystem@2026.8.31

rm -rf "$DEMO" && mkdir -p "$DEMO/home/project"
cd "$DEMO/home/project"
cat > notes.md <<'EOF'
# Release notes

Staging database: postgres://deploy:Tr0ub4dor-3@db.internal:5432/app

Next steps:
- bump the version
- run the smoke on three OSes
- tag and publish
EOF
printf '{"mcpServers":{"fs":{"command":"npx","args":["-y","%s","%s"]}}}\n' "$FS_SERVER" "$PWD" > .mcp.json
# Install the server into npx's cache in full now: a first start cut short (Claude Code
# exiting while npx still unpacks it) leaves a broken cache entry that every later start trips on.
npx -y "$FS_SERVER" "$PWD" </dev/null >/dev/null 2>&1 || true

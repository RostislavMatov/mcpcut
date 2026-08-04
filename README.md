# mcp-journal

A transparent stdio proxy for MCP (Model Context Protocol) servers. It sits
between an AI agent and a real MCP server, forwards traffic byte-for-byte in
both directions, and writes a persistent, secret-redacted JSONL journal of
every message and stderr line.

## Install

```
npm install
npm run build
```

This produces `dist/cli.js` (the `mcp-journal` binary, per `package.json`'s
`bin` field).

## Usage

### Wrap a server

Run the real MCP server as a child process, journaling all traffic while
forwarding it unmodified:

```
mcp-journal wrap -- <cmd> [args...]
```

Everything after `--` is the real server's command line. `mcp-journal` exits
with the wrapped server's exit code.

### List sessions

```
mcp-journal sessions
```

Prints a table of every journaled session: session id, first/last message
timestamp, and message count.

### Show a session's journal

```
mcp-journal show <sessionId> [--method X] [--direction Y] [--json]
```

Prints one session's journal records, optionally filtered by JSON-RPC
`method` or traffic `direction`. By default records are printed in a
readable, one-line-per-record format (timestamp, direction, kind, method,
truncated payload); pass `--json` to print the raw JSONL instead.

## Wiring into `.mcp.json`

Wrap a real server by replacing its `command`/`args` with `mcp-journal wrap --`
followed by the original command:

```json
{
  "mcpServers": {
    "some-server": {
      "command": "mcp-journal",
      "args": ["wrap", "--", "npx", "-y", "@some/mcp-server"]
    }
  }
}
```

Environment variables configured for the server pass through to the wrapped
process unchanged. Secrets (tokens, API keys, passwords, bearer/basic auth
headers, etc.) are redacted before anything reaches the journal — they are
never written to disk.

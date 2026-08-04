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

## Policies

Without a policy file, `mcp-journal` behaves exactly like the plain journaling
proxy above (mode A): every message is forwarded unmodified, only journaled.
Dropping a `policy.json` in `./.mcp-journal/policy.json` (project) or
`~/.mcp-journal/policy.json` (home) turns on enforcement (mode B): every
`tools/call` is matched against the policy before it reaches the server, and
`tools/list` results are filtered to what the agent is actually allowed to
call.

Resolution order (first found wins, **no merging** across sources):
`--policy <path>` → `$MCP_JOURNAL_POLICY` → `./.mcp-journal/policy.json` →
`~/.mcp-journal/policy.json`. A broken or explicitly-named-but-missing policy
file is a hard error: the proxy refuses to start rather than silently
degrading to allow-all.

### `policy.json` example

```json
{
  "version": 1,
  "defaultDecision": "require-approval",
  "classDefaults": {
    "read": "allow"
  },
  "servers": {
    "github": {
      "tools": {
        "delete_*": "deny"
      }
    }
  }
}
```

Every read-only tool (per its `readOnlyHint` annotation, or a matching name
heuristic) is allowed by default; anything else falls through to
`require-approval` unless a more specific rule applies. On the `github`
server, any tool whose name starts with `delete_` is denied outright,
regardless of its classification.

Validate a policy file and inspect the effective (defaults-applied) policy:

```
mcp-journal policy validate [path]
mcp-journal policy show [--server <name>] [--json]
```

### Approval scenario

A `require-approval` tool call does not reach the server immediately:

1. The agent calls a gated tool. `mcp-journal` enqueues an approval request
   and the call blocks (client-side) until it is resolved or times out
   (60s default).
2. An operator reviews and resolves it in another terminal:
   ```
   mcp-journal approvals list
   mcp-journal approvals approve <id> [--reason TEXT]
   mcp-journal approvals deny <id> [--reason TEXT]
   ```
3. If approved before the timeout, the original call is forwarded to the
   server and its response reaches the agent normally. If it times out (or is
   denied), the agent gets a synthetic JSON-RPC error instead — but the
   approval, once it lands, creates a short-lived **grant** for that exact
   `(server, tool, args)` triple, so an agent's retry a few minutes later
   passes without a second manual approval.

### Quarantine

The first time a server advertises a tool (or advertises one whose schema —
including its description — has changed since it was last approved),
`mcp-journal` puts it in quarantine instead of trusting it automatically.
Quarantined tools are blocked (`require-approval`/`deny` per
`quarantine.onQuarantined`) until an operator reviews and approves them:

```
mcp-journal quarantine list [--server <name>]
mcp-journal quarantine approve <server> <tool>
mcp-journal quarantine approve --all --server <name>
mcp-journal quarantine reject <server> <tool>
```

This is a defense against a server silently changing a tool's behavior after
it was already trusted ("rug pull"): a description or schema change always
re-quarantines the tool, even if its name is unchanged.

### `tools/list` filtering

When a policy is active, `tools/list` results are filtered by default
(`toolsList.filter: "hide-denied"`): tools that resolve to `deny` are removed
from what the agent sees, so it never wastes context on — or retries — a
call it cannot make. Tools resolving to `require-approval` stay visible,
since they are still callable. Set `toolsList.filter` to `"off"` to disable
filtering and show the server's full, unfiltered tool list.

### Fail-closed journaling

By default, a journal write failure is logged but does not stop traffic
(fail-open, matching M1). Passing `--fail-closed` (or setting
`journal.failClosed: true` in the policy) makes an unrecoverable journal
write failure stop the session instead: no further traffic is forwarded, the
wrapped server is killed, and `mcp-journal` exits with code `3`. The
rationale: "no audit record, no action" — an enforcement proxy without a
journal it can trust is not enforcing anything.

### CLI command reference

```
mcp-journal wrap [--server <name>] [--policy <path>] [--no-policy] [--fail-closed] -- <cmd> [args...]
mcp-journal sessions
mcp-journal show <sessionId> [--method X] [--direction Y] [--kind Z] [--json]
mcp-journal policy validate [path]
mcp-journal policy show [--server <name>] [--json] [--policy <path>]
mcp-journal quarantine list [--server <name>] [--json]
mcp-journal quarantine approve <server> <tool> | --all --server <name>
mcp-journal quarantine reject <server> <tool>
mcp-journal approvals list [--json]
mcp-journal approvals approve <id> [--reason TEXT]
mcp-journal approvals deny <id> [--reason TEXT]
```

### Known limitation: trust boundary of the wrapped process

The wrapped MCP server runs as a child process under the *same OS user* as
`mcp-journal` itself. It could, in principle, write directly to the journal,
approval queue, or quarantine store files on disk — nothing currently stops
a malicious or compromised server from tampering with its own audit trail or
self-approving a quarantined tool. Making the journal and policy stores
tamper-evident (e.g. append-only signing, a separate privileged writer) is
tracked for a later milestone; today this is a known, accepted gap, not an
oversight.

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

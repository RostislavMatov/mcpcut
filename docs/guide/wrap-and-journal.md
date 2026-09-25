# Wrapping a server and reading the journal

## Wrap a server

Run the real MCP server as a child process, journaling the traffic the proxy
observes while forwarding it unmodified:

```
mcpcut wrap -- <cmd> [args...]
```

Everything after `--` is the real server's command line. `mcpcut` exits
with the wrapped server's exit code.

## List sessions

```
mcpcut sessions
```

Prints a table of every journaled session: session id, first/last message
timestamp, and message count.

## Show a session's journal

```
mcpcut show <sessionId> [--method X] [--direction Y] [--json]
```

Prints one session's journal records, optionally filtered by JSON-RPC
`method` or traffic `direction`. By default records are printed in a
readable, one-line-per-record format (timestamp, direction, kind, method,
truncated payload); pass `--json` to print the raw JSONL instead.


## Wiring into `.mcp.json`

An agent the plane manages needs no hand wiring: `agent create` prints its
block, ready to paste — see [Onboarding an agent](agents.md#onboarding-an-agent). What
follows is for wrapping a server of your own, outside the registry.

Wrap a real server by replacing its `command`/`args` with
`npx -y mcpcut@0.1.1 wrap --` (or `mcpcut wrap --`, once installed) followed by
the original command:

```json
{
  "mcpServers": {
    "some-server": {
      "command": "npx",
      "args": ["-y", "mcpcut@0.1.1", "wrap", "--", "npx", "-y", "@some/mcp-server"]
    }
  }
}
```

Environment variables configured for the server pass through to the wrapped
process unchanged. Secrets (tokens, API keys, passwords, bearer/basic auth
headers, etc.) are redacted before anything reaches the journal — they are
never written to disk.

## Fail-closed journaling

By default, a journal write failure is logged but does not stop traffic
(fail-open). Passing `--fail-closed` (or setting
`journal.failClosed: true` in the policy) makes an unrecoverable journal
write failure stop the session instead: no further traffic is forwarded, the
wrapped server is killed, and `mcpcut` exits with code `3`. The
rationale: "no audit record, no action" — an enforcement proxy without a
journal it can trust is not enforcing anything.

This is an **opt-in mode, not the default**. If you are running mcpcut
for evidence rather than for convenience, turn it on explicitly:

```
mcpcut wrap --fail-closed -- <cmd> [args...]
```

or persist it in the policy file:

```json
{ "version": 1, "journal": { "failClosed": true } }
```

Without one of those, a journal write failure is logged and traffic keeps
flowing — "no audit record, no action" is a mode you choose, not a property
the proxy guarantees out of the box.

Records from several concurrent sessions can share one write batch (a
`serve` daemon batches across its sessions on purpose, for throughput); if
that batch's commit and its retry both fail, every record in it is dropped,
not just one session's. Each session's own dropped-record count
(`droppedRecordCount()`, and the fail-closed exit path above) stays accurate
for that session either way — it is the batch, not the accounting, that is
shared.


## Known limitation: trust boundary of the wrapped process

The wrapped MCP server runs as a child process under the *same OS user* as
`mcpcut` itself. It could, in principle, write directly to the journal,
approval queue, or quarantine store files on disk — nothing currently stops
a malicious or compromised server from tampering with its own audit trail or
self-approving a quarantined tool. The journal is an **append-oriented**
SQLite database (`journal.db`): nothing in the current implementation makes it
append-*only*.

The hash chain and signed chain head make such tampering **detectable** —
they do not prevent it. A rewrite by a process under this uid can recompute
the whole chain and re-sign it, and only comparison against an anchor recorded
out of band exposes that. A separate privileged writer, an append-only
attribute, or off-box shipping of the journal would raise the bar further and
are tracked as post-MVP work; today this is a known, accepted gap, stated
rather than papered over. Describe the journal as *tamper-evident with an
external anchor*, never as tamper-proof and never as "audit-ready".

## Known limitation: redaction is not anonymization

Secret redaction removes credentials — API keys, tokens, `Authorization` /
`Bearer` headers — before anything is written. It does **not** remove personal
data. Tool arguments and server responses routinely carry customer records,
email addresses, ticket contents and similar payloads, and those land in the
journal verbatim. The journal is therefore a data store you own and must
govern: retention, access control and any GDPR/DPIA obligations for its
contents are yours, not the proxy's.

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
mcp-journal connect <server> --agent <name> [--policy <path>] [--fail-closed]
mcp-journal serve [--port N] [--host H] [--policy <path>] [--fail-closed] [--allowed-origin URL]
mcp-journal server add <name> --transport stdio|http ...
mcp-journal server list | show <name> | remove <name>
mcp-journal vault init | set <name> | list | remove <name> | rekey
mcp-journal agent create <name> | list | revoke <name>
mcp-journal agent grant <agent> <server> [--tools a,b,prefix*] | ungrant <agent> <server>
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

## Registry, agents, vault

`wrap` is the try-it-without-any-setup path: it proxies whatever command line
you hand it and keeps no state of its own. Everything in this section is the
other mode — a control plane that knows your MCP servers *by name*, keeps
their credentials encrypted, issues one identity per agent, and can cut an
agent off with a single command.

Its state lives in `~/.mcp-journal/`:

| File | Holds | Changed by |
|---|---|---|
| `registry.json` | Servers by name: transport, command/URL, env & header **references** | `mcp-journal server ...` |
| `vault.enc`, `vault.key` | Secrets encrypted with AES-256-GCM, plus the master key | `mcp-journal vault ...` |
| `agents.json` | Agent identities (token *hashes* only) and the grant matrix | `mcp-journal agent ...` |
| `policy.json` | Allow / deny / require-approval rules | **you**, by hand |
| `<sessionId>.jsonl` | The journal | the proxy |

`policy.json` stays the one hand-edited file on purpose. The registry, the
vault and the grant matrix change often, and a typo in any of them is a
security problem rather than a syntax error — so they are CLI-managed.

### Onboarding an agent

The whole sequence, from an empty plane to a working, journaled tool call:

```
mcp-journal vault init
mcp-journal server add github --transport stdio \
  --command "npx" --args "-y,@modelcontextprotocol/server-github" \
  --env GITHUB_PERSONAL_ACCESS_TOKEN=vault:github-pat
mcp-journal vault set github-pat        # value comes from stdin
mcp-journal agent create research-bot   # prints the token ONCE
mcp-journal agent grant research-bot github --tools "get_*,list_*,search_*"
```

Step by step:

1. **`vault init`** creates `vault.key` (mode `0600`). It refuses to run twice,
   so it can never silently orphan the secrets encrypted under the old key.
2. **`server add`** registers the server under the name `github`. That name is
   what appears in journal decision records from now on, instead of the
   `auto:<hash>` identity `wrap` has to invent. `--env` values are either
   non-secret literals or `vault:<name>` **references**: a literal that looks
   like a secret is rejected by the schema with a pointer to the vault, so
   "credentials never live in config" is a property of the format, not a habit.
3. **`vault set github-pat`** reads the secret from **stdin**, never from
   `argv` (which every process on the host can read out of `ps`), and stores
   it encrypted. There is deliberately no `vault get`.
4. **`agent create`** mints a 32-byte token and prints it exactly once; only
   its SHA-256 hash is stored. Stealing `agents.json` yields no usable token.
5. **`agent grant`** is the grant matrix: this agent, this server, these tool
   patterns. Anything not granted is invisible in `tools/list` and denied on
   call — before any policy rule is even consulted.

Then point the agent's own client config at `connect`:

```json
{
  "mcpServers": {
    "github": {
      "command": "mcp-journal",
      "args": ["connect", "github", "--agent", "research-bot"],
      "env": { "MCP_AGENT_TOKEN": "<the token agent create printed>" }
    }
  }
}
```

The token is the only secret left in the agent's config, and it grants access
to exactly what that agent was granted — never to the server's own
credentials, which stay in the vault and are injected into the server process
by the plane. A registry-spawned server gets a *controlled* environment: a
small system allowlist (`PATH`, `HOME`, `TMPDIR`, locale) plus its own
declared variables and resolved vault references. It cannot reach the rest of
the plane's environment. (`wrap` keeps full inheritance, as before.)

Policies compose on top of grants, they do not replace them: a granted tool
still goes through classification, quarantine, deny rules and approvals
exactly as described above. Deny always wins.

### Revoking access

```
mcp-journal agent revoke research-bot
```

One command, and the agent's token is dead: new connections are refused
immediately, and sessions that are already live end on their next poll of
`agents.json` (≤ 5 s) with an `agent-revoked` decision record in the journal.
To narrow rather than cut off, use `mcp-journal agent ungrant <agent> <server>`.

### HTTP agents (`serve`)

Agents that speak streamable HTTP instead of stdio connect through the front:

```
mcp-journal serve --port 8090
# agent endpoint: http://127.0.0.1:8090/agents/research-bot/servers/github
# authentication: Authorization: Bearer <the agent's token>
```

One endpoint per (agent, server) pair — the plane does not aggregate several
servers behind one URL, so tool names and request ids stay exactly as the
server produced them.

Both MCP session models are supported, downstream (agent → plane) and
upstream (plane → server):

| | Sessionful (2025-03 … 2025-11) | Stateless (2026-07-28) |
|---|---|---|
| Handshake | `initialize`, then `Mcp-Session-Id` on every request | none |
| Ending a session | `DELETE`, or idle timeout | nothing to end |
| Per-request headers | — | `Mcp-Method` / `Mcp-Name`, validated against the body (`-32020` on mismatch) |

Downstream the model is detected from the traffic (an `initialize` selects the
sessionful one). Upstream it comes from the registry record's `--protocol`
(`sessionful`, `stateless`, or `auto` to probe once and pin). The plane
**transports both models and translates between neither**: a stateless agent
against a sessionful-only server, or the reverse, is refused with a clear
error rather than a lossy bridge. The reasoning, and the full MUST/SHOULD
matrix of both revisions, is in `docs/adr/0002-http-dual-version.md`.

`serve` binds `127.0.0.1` by default. A bearer token crossing a network on
plain HTTP is not acceptable, so any `--host` beyond localhost prints a loud
warning: terminate TLS in a reverse proxy in front of `serve` and let it keep
listening on loopback. `serve` has no TLS of its own.

### What the vault protects against, and what it does not

`vault.enc` is a single AES-256-GCM envelope; `vault.key` is the master key,
mode `0600`, sitting in the same directory under the same OS user.

It **does** protect against secrets leaking through the paths they usually
leak through: a backup or dotfile-sync of `~/.mcp-journal`, a config file
committed to a repository, a shell history or `ps` listing (values never pass
through `argv`), and the journal itself (values are resolved in memory only,
on their way into a server's environment or request headers — the CLI has no
command that prints one).

It does **not** protect against a compromised host. A key next to its
ciphertext, readable by the same user, is exactly as strong as that user
account: anything running as you can decrypt the vault. This is the same
trust boundary as the wrapped-process limitation noted above, and it is
stated here rather than glossed over. Rotate with `mcp-journal vault rekey`
(re-encrypts every secret under a fresh key). Full threat model and the
reasoning behind the choice: `docs/adr/0003-vault-crypto.md`.

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

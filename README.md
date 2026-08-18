# mcp-journal

A transparent stdio proxy for MCP (Model Context Protocol) servers. It sits
between an AI agent and a real MCP server, forwards traffic byte-for-byte in
both directions, and writes a persistent, secret-redacted journal of the
messages and stderr lines it observes, into `journal.db` (SQLite).

When enforcement is enabled, every observed `tools/call` is classified before
forwarding. Without a policy file, the proxy is journaling-only and forwards
everything unmodified.

## Status

What exists today, and what does not. This table is the source of truth — the
pitch and landing material must not claim more than it does.

| Capability | Status | Evidence |
|---|---|---|
| stdio proxy (`wrap`) | shipped | integration tests, dogfooded daily |
| allow / deny / require-approval policy | shipped | policy test matrix |
| quarantine of new & changed tools | shipped | schema-change tests |
| approvals via CLI | shipped | approval-flow tests |
| fail-closed journaling | shipped, **off by default** | fault-injection tests; opt in with `--fail-closed` |
| server registry (`server add/list/...`) | shipped | registry tests |
| credential vault (AES-256-GCM) | shipped | vault tests, `docs/adr/0003-vault-crypto.md` |
| agent identities + grant matrix | shipped | grant/revoke tests |
| streamable HTTP front (`serve`) | shipped, both session models | `docs/adr/0002-http-dual-version.md` |
| tamper-evident journal storage | **not shipped** | roadmap (M5) |
| exportable audit report | **not shipped** | roadmap (M5) |
| admin UI / approval queue | shipped | e2e + UI test suites, TS + security reviews, manual browser smoke (`docs/smoke-m4.md`), `docs/adr/0004-admin-ui-architecture.md` |
| named admin accounts (owner/operator/viewer) | shipped | admin CLI + role-enforcement tests |

Today the journal is a persistent, append-oriented, secret-redacted SQLite
database (`journal.db`; JSONL is the export format — `mcp-journal export` —
and the format legacy pre-M4.5 installs used on disk before `migrate`). It is
**not** tamper-evident and there is **no** audit-report export yet; see the
trust-boundary note below.

## Install

Requires **Node.js 24+** (`engines: ">=24"` in `package.json`). The floor is
not arbitrary: `node:sqlite`'s API — the storage layer since M4.5 — is only
complete from v24.19.0 (older builds either lack the module entirely or lack
the `Session` class M5's audit export will use); see `docs/adr/0006-storage-sqlite.md`
for the measured version matrix.

```
npm install
npm run build
```

This produces `dist/cli.js` (the `mcp-journal` binary, per `package.json`'s
`bin` field).

## Usage

### Wrap a server

Run the real MCP server as a child process, journaling the traffic the proxy
observes while forwarding it unmodified:

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

**`readOnlyHint` is a server-supplied hint, not a security boundary.** A
server that lies (`readOnlyHint: true` on a tool that writes) gets its tool
classified `read`, and with `classDefaults.read: "allow"` that call is
allowed. Three things bound the damage, and you should rely on them rather
than on the annotation: a tool is quarantined the first time it is advertised
(and again on every schema change), an explicit `tools` rule always beats the
classification, and `classOverrides` lets you pin a tool's class by name. The
heuristics only ever *escalate* — `destructiveHint`, a destructive name token,
or a non-ASCII confusable in the name can never be downgraded by
`readOnlyHint`. For anything that matters, write the rule; don't inherit the
hint.

### Recipe: `classOverrides` for servers without annotations

Some servers don't send `readOnlyHint`/`destructiveHint` at all —
`github-mcp-server` is the case that motivated this recipe: every tool,
including `search_*`, comes back unannotated, so the name-heuristic fallback
classifies it `write` (the safe default when nothing else is known). If your
policy sets `classDefaults.read: "allow"` expecting read-only search calls to
pass through automatically, this is why they don't — the tool was never
classified `read` in the first place, so `classDefaults` never applies to it.

`classOverrides` (per server, under `servers.<name>`) pins a tool's class
directly, independent of annotations or name heuristics:

```json
{
  "version": 1,
  "classDefaults": { "read": "allow" },
  "servers": {
    "github": {
      "classOverrides": {
        "search_*": "read",
        "get_*": "read"
      }
    }
  }
}
```

Same rule-name syntax as `tools` (an exact name, or a name with a single
trailing `*`). `classOverrides` only changes the *class* a tool is assigned —
the call still goes through quarantine, any matching `tools` rule, and
approvals exactly as before; it does not bypass a `deny` rule and does not
skip quarantine on a schema change (a schema change re-quarantines the tool
regardless of its class). Use it once you have manually verified that a
server's unannotated tool really is read-only — it is a statement of trust
you are making about that tool's behavior, not a way to trust the server's
own claims (which is exactly why `readOnlyHint` alone isn't enough).

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
   export MCP_ADMIN_TOKEN=<your personal admin token>
   mcp-journal approvals approve <id> [--reason TEXT]
   mcp-journal approvals deny <id> [--reason TEXT]
   ```
   `approve` and `deny` require `MCP_ADMIN_TOKEN` — the personal token
   `mcp-journal admin add` printed — and the admin behind it must hold the
   `operator` or `owner` role, the same minimum the admin UI enforces on the
   same action. The resolution is then stored as `cli:<adminName>`, so the
   journal answers *who* approved a call and not only *that* someone did.
   `approvals list` needs no token: reading the queue is not an authorization
   event.

   **What this does and does not buy.** It buys **attribution**, not an access
   barrier. A process running as the same user can read your environment
   anyway — that is this tool's stated threat model — so the token does not
   stop anyone who already has shell access on the host. What it does is make
   an approval name a human, so a later audit export has no anonymous entries
   in it.
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
mcp-journal quarantine show <server> <tool>
mcp-journal quarantine approve <server> <tool>
mcp-journal quarantine approve --all --server <name>
mcp-journal quarantine reject <server> <tool>
```

This is a defense against a server silently changing a tool's behavior after
it was already trusted ("rug pull"): a description or schema change always
re-quarantines the tool, even if its name is unchanged.

`quarantine list` tells you a tool's schema changed; `quarantine show <server>
<tool>` tells you *how*. It prints a structural diff of the tool's
`inputSchema` against the last approved version — added/removed/changed
properties, widened/narrowed `enum`s, `required` changes — plus a
`surfaceDelta` verdict (`widened` / `narrowed` / `changed` / `neutral`)
summarizing the direction of the change. This is the same diff the admin UI's
quarantine card renders (`src/ui/pages/quarantine.ts`); the CLI is not a
second-class view of it. A brand-new tool has no approved baseline to diff
against, so `show` prints the observed descriptor instead, with an explicit
"no approved baseline" note. `surfaceDelta` is informational only in this
release — it is shown and journaled, but it never changes a tool's
`read`/`write`/`destructive` classification on its own; that escalation rule
is future work.

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

This is an **opt-in mode, not the default**. If you are running mcp-journal
for evidence rather than for convenience, turn it on explicitly:

```
mcp-journal wrap --fail-closed -- <cmd> [args...]
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
mcp-journal quarantine show <server> <tool>
mcp-journal quarantine approve <server> <tool> | --all --server <name>
mcp-journal quarantine reject <server> <tool>
mcp-journal approvals list [--json]
mcp-journal approvals approve <id> [--reason TEXT]   # needs MCP_ADMIN_TOKEN
mcp-journal approvals deny <id> [--reason TEXT]      # needs MCP_ADMIN_TOKEN
mcp-journal admin add <name> --role owner|operator|viewer
mcp-journal admin list | remove <name> | rotate <name> | role <name> owner|operator|viewer
mcp-journal ui [--port 8091] [--host 127.0.0.1] [--behind-tls]
               [--allowed-host <host[:port]>]... [--allowed-origin <origin>]... [--trusted-proxy-header <name>]
mcp-journal migrate
mcp-journal export [--session <id>]
mcp-journal backup <destDir>
```

`serve`, `ui`, `connect` and `wrap` — the four long-lived entry points — run
`PRAGMA integrity_check` on `state.db` and `journal.db` before binding a port
or spawning a server (an install with neither file yet is not touched by this
check, and it never creates the databases). A damaged database refuses the
process instead of letting it run on state nobody can later prove anything
about:

```
state.db failed PRAGMA integrity_check: <first problem line>
Refusing to start. Restore the database from a backup (see README "Backup & restore").
```

Short-lived commands (`sessions`, `show`, `export`, `migrate`, …) do not run
this check — a `sessions` call that prints normally is therefore *not*
evidence the databases are intact; only the startup preflight of a
long-lived entry point (or a restore verified by it) is. See
[Backup & restore](#backup--restore) for what to do if a short-lived
command turns up corruption.

### Known limitation: trust boundary of the wrapped process

The wrapped MCP server runs as a child process under the *same OS user* as
`mcp-journal` itself. It could, in principle, write directly to the journal,
approval queue, or quarantine store files on disk — nothing currently stops
a malicious or compromised server from tampering with its own audit trail or
self-approving a quarantined tool. The journal is an **append-oriented**
SQLite database (`journal.db`): nothing in the current implementation makes
it append-*only*. Making the
journal and policy stores tamper-evident (e.g. append-only signing, a separate
privileged writer) is tracked for a later milestone; today this is a known,
accepted gap, not an oversight. Do not describe the current journal as
tamper-evident or audit-ready.

### Known limitation: redaction is not anonymization

Secret redaction removes credentials — API keys, tokens, `Authorization` /
`Bearer` headers — before anything is written. It does **not** remove personal
data. Tool arguments and server responses routinely carry customer records,
email addresses, ticket contents and similar payloads, and those land in the
journal verbatim. The journal is therefore a data store you own and must
govern: retention, access control and any GDPR/DPIA obligations for its
contents are yours, not the proxy's.

### Security advisory: policy bypass via notification-shaped `tools/call` (fixed)

An earlier build classified messages before authorizing them: requests went
through the policy gate, notifications were forwarded. A `tools/call` carrying
no `id` — invalid as a JSON-RPC request — took the notification path and
reached the server without a policy decision, including under a deny-all
policy.

Enforcement now evaluates every observed `tools/call` before forwarding,
with or without an `id`. Malformed or ambiguous messages are rejected and
journaled; an id-less call under `require-approval` is denied outright
(`idless-require-approval`) rather than enqueuing an approval a human could be
socially engineered into granting. Regression tests cover missing ids,
malformed payloads and the classification-order bug itself
(`tests/proxy/gate.test.ts`).

## Registry, agents, vault

`wrap` is the try-it-without-any-setup path: it proxies whatever command line
you hand it and keeps no state of its own. Everything in this section is the
other mode — a control plane that knows your MCP servers *by name*, keeps
their credentials encrypted, issues one identity per agent, and can cut an
agent off with a single command.

Its state lives in `~/.mcp-journal/`:

| File | Holds | Changed by |
|---|---|---|
| `state.db` | Control-plane state, one document/table per store: server registry, agent identities & grant matrix, admin accounts, tool inventory (quarantine baselines), approvals queue. Supersedes the legacy `registry.json`/`agents.json`/`admins.json`/`tool-inventory.json`/`approvals/` files below (M4.5, ADR-0006) | `mcp-journal server/agent/admin/quarantine/approvals ...` |
| `journal.db` | The journal (`journal_records` table), plus a marker of which legacy `*.jsonl` files have been imported | the proxy; `mcp-journal migrate` |
| `registry.json`, `agents.json`, `admins.json`, `tool-inventory.json`, `approvals/` | Legacy pre-M4.5 files — read once into `state.db` (by `migrate`, or lazily on first touch), then left untouched as a cold backup | — (historical; no longer written) |
| `vault.enc`, `vault.key` | Secrets encrypted with AES-256-GCM, plus the master key | `mcp-journal vault ...` |
| `policy.json` | Allow / deny / require-approval rules | **you**, by hand |
| `<sessionId>.jsonl` | Legacy journal (pre-M4.5), read only via `mcp-journal migrate`; the proxy no longer writes this format | — (historical; no longer written) |

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

## Admin UI

`mcp-journal approvals`/`quarantine`/`agent`/`server`/`vault` are all you need
in a terminal. The admin UI is the same state — the same file-backed stores —
behind a browser, for the moment that matters most: a `require-approval` call
is blocking an agent right now, and someone has to look at it and decide
before the agent's own timeout runs out. It is a second front onto the
control plane's stores, not a second source of truth; a resolution made in
the UI and a resolution made with `mcp-journal approvals approve` race the
same way (first one wins, the other gets a clear "already resolved").

### Starting it

```
mcp-journal ui [--port 8091] [--host 127.0.0.1] [--behind-tls]
               [--allowed-host <host[:port]>]... [--allowed-origin <origin>]...
               [--trusted-proxy-header <name>]
```

`--behind-tls` marks the session cookie `Secure` (use it when a reverse proxy
terminates TLS in front). `--allowed-host` and `--allowed-origin` extend the
`Host`/`Origin` allowlists by exact match — needed only when something other
than a loopback name fronts the UI; both may be repeated.

Behind a TLS-terminating proxy those flags go together: `--behind-tls` alone is
not enough. The browser sends the **public** `Host` (`127.0.0.1:8443` below),
`Host` screening compares it against the UI's own bind address
(`127.0.0.1:8092`), and answers **403 to everything, before authentication** —
which reads as "`--behind-tls` is broken" when it is in fact the DNS-rebinding
defence doing its job. Name the public host explicitly:

```
mcp-journal ui --port 8092 --behind-tls --allowed-host 127.0.0.1:8443
```

`--trusted-proxy-header <name>` (e.g. `x-forwarded-for`) keys the `/login` rate
limit on that header instead of the peer address, so the limit still
distinguishes clients behind a proxy. **Enable it only if the proxy rewrites
that header.** The UI takes the header's *rightmost* value, which is the one a
proxy that appends writes — but a proxy that forwards the client's copy
unchanged hands every caller the ability to pick its own rate-limit bucket, and
the limit stops meaning anything. The flag prints that warning at startup.

The UI is its own process on its own port — it is not part of `serve`, and
`serve` does not need to be running for it to work. That matters because the
main M3 scenario (`connect`, stdio) never runs `serve` at all; if the queue
only had a UI when `serve` was up, that scenario would have no UI ever.

On the very first run, if the admin store in `~/.mcp-journal/state.db` holds no admins yet,
`mcp-journal ui` creates one `owner` account (named `owner`) and prints the
sign-in URL and its plaintext token **to stderr only, once** — never to stdout,
never to a file. The token is printed beside the URL, not embedded in it, so
nothing here belongs in browser history:

```
[ui] no admins found: created "owner" with role owner
[ui] sign in at http://127.0.0.1:8091/login as "owner" with token: mcpa_…
```

Copy it before it scrolls away; there is no second printing. Rotate it with
`mcp-journal admin rotate owner`.

### Admins and roles

Admin accounts are named and personal, not a shared password. Each one holds
its own token (32 random bytes, shown once), and every action taken through
the UI — every approval, every deny, every grant change — is attributed to
the admin who did it, in the journal and in the resolved approval file. There
are exactly three roles, fixed (no custom/scoped roles in this release):

| Role | Can |
|---|---|
| `owner` | everything, including managing other admins, the server registry, and the vault |
| `operator` | approvals (approve/deny), quarantine (approve/reject), the agent grant matrix (create/grant/ungrant/revoke) |
| `viewer` | read-only: journal, approvals queue, registry, grant matrix — no POST action succeeds for this role, anywhere |

Manage accounts from the CLI:

```
mcp-journal admin add <name> --role owner|operator|viewer   # prints the token ONCE
mcp-journal admin list                                       # names, roles, dates — never token hashes
mcp-journal admin rotate <name>                               # new token; old one dies immediately
mcp-journal admin remove <name>
mcp-journal admin role <name> <role>
```

`owner`-only management is also available from the UI itself. Rotating,
removing, or changing an admin's role kills that admin's live sessions
immediately — everyone else's session is unaffected. The last remaining
`owner` cannot be removed or demoted; that would lock the plane.

Every admin token is a bearer secret with the same handling rules as an agent
token: it never appears in a URL, only in the one-time terminal print at
`admin add`/`admin rotate`, and only its SHA-256 hash is stored on disk.
Treat "who has which admin token" the same way you'd treat "who has SSH
access to this host" — one person, one token, rotated when that stops being
true.

### Threat model summary

- **Bind**: `127.0.0.1` by default, same posture as `serve`. Any `--host`
  beyond localhost prints a loud warning; TLS is not the UI's job — terminate
  it in a reverse proxy in front of the UI and let the UI keep listening on
  loopback, exactly like `serve`.
- **Behind a reverse proxy**: by default every login the proxy forwards arrives
  from the proxy's own source address, so the UI's per-address `/login` rate
  limit degrades to one shared bucket for all logins through that proxy. Either
  rate-limit `/login` at the proxy, or pass `--trusted-proxy-header` — and if
  you pass it, make the proxy rewrite that header.
- **Login availability**: neither rate limit can lock an admin out of the plane.
  The per-address window refuses only the address that earned it; the global
  ceiling *delays* attempts rather than refusing them, because a ceiling keyed
  on nothing is a lockout any process that can reach `/login` could trigger.
- **Session slots**: the pool is capped (64 global, 8 per admin) and a live
  session is never evicted to make room. The top 8 slots are reserved for
  `owner` logins, so a pool filled by lower-privilege admins cannot lock the
  owner out — a state the M4 smoke reproduced. Sessions also expire after an
  hour of inactivity, well before the 8-hour absolute lifetime, so a forgotten
  tab returns its slot; an open SSE stream's heartbeat does not count as
  activity.
- **Revocation SLA**: `admin remove`/`admin rotate`/`admin role` from the CLI
  close that admin's open SSE streams within ~2 s; their requests are refused
  immediately. Those commands run in a different process and the state lives in
  SQLite, which offers no cross-process notification — so the UI re-reads the
  store on a dedicated sweep rather than riding the 15-second heartbeat.
- **Auth**: a token exchanges for a session cookie (`HttpOnly`,
  `SameSite=Strict`, `Path=/`, and `Secure` when started with `--behind-tls`).
  With `--behind-tls` the cookie is named with the `__Host-` prefix, which the
  browser will only accept from a secure origin with `Path=/` and no `Domain` —
  so no sibling subdomain can overwrite the admin plane's session cookie. The
  unprefixed name is not accepted in that mode. `--behind-tls` also turns on
  HSTS; over plain loopback HTTP it is deliberately not sent.
  Sessions live in the UI process's memory only — nothing about a session is
  written to disk, so a restart logs every admin out.
- **CSRF**: three independent checks. `SameSite=Strict`; a double-submit token
  embedded in every form and `fetch` call in the page; and a mandatory `Origin`
  header on every POST — a browser always sends one on a state change, so a POST
  without it did not come from a page of this UI. Reads are exempt (typing a URL
  into the address bar sends no `Origin`).
- **Registering a server is code execution**: a `stdio` server definition is a
  command line the plane will spawn on this host — the same power as the CLI's
  `server add`. The UI form therefore goes through a confirmation interstitial
  that echoes the validated record before anything is written; validation runs
  before that step, so confirming is never a way past it.
- **Confused deputy**: the browser is the threat, not just the network — any
  tab open to `127.0.0.1:8091` could otherwise fire a POST that approves a
  write call on an admin's behalf. `Origin`/`Host` validation, CSRF, and
  `SameSite=Strict` together are what stop that, not "it's only localhost."
- **Secrets never render in the browser.** The vault page shows secret
  *names* and dates — never a value. No route under the UI can return a
  vault value, and (this is enforced, not just documented) the UI's own code
  cannot import the vault's value-resolution path at all.
- **Known, stated limitation**: a personal token can still be handed to
  someone else — a named account is an audit-friendly convention, not
  cryptographic identity. SSO/IdP-backed accounts are an explicit
  post-pilot item, not something this release claims.

None of this changes what the journal itself is: a persistent,
append-oriented, secret-redacted SQLite database. The UI gives you a faster
way to read and act on it; it does not make the journal tamper-evident or
turn it into an audit-ready export — that is `M5`, not `M4.5` (see Status,
above).

## Upgrade to M4.5 storage

M4.5 moved control-plane state and the journal off plain files and onto two
SQLite databases, `state.db` and `journal.db` (`docs/adr/0006-storage-sqlite.md`).
Upgrading an existing `~/.mcp-journal/` install is **mandatory**, not
optional — a smoke test on the M4.5 branch found that a process still running
on the old code cannot see (or resolve) work created by a process running the
new code, because they read different storage. Do this in order:

1. **Stop every long-lived process** pointed at this journal directory:
   `serve`, `ui`, any live `wrap`/`connect` session, and any external watcher
   or script that polls the directory. Do this first — a process still
   running on the pre-M4.5 code will keep writing the old files while you
   migrate, and those writes will not be picked up by the new storage.
2. **Run the migration**:
   ```
   mcp-journal migrate
   ```
   This imports `agents.json`, `admins.json`, `registry.json`,
   `tool-inventory.json`, the `approvals/` queue, and every `*.jsonl` journal
   file into `state.db`/`journal.db`, one report line per store. It is safe
   to run more than once — an already-migrated store reports `already
   migrated` and is left untouched.

   Migrate **in place, from the original directory** if you can. Each legacy
   `*.jsonl` file carries only per-session ordering; the *cross*-session
   order of the imported journal (what `export` streams, and what the M5
   hash chain will attest) is reconstructed from file modification times. A
   `cp`/`rsync` that does not preserve mtimes scrambles that global order —
   per-session history stays intact, but sessions may interleave differently
   than they originally ran. Use `cp -p` / `rsync -t` if you must relocate
   legacy files before migrating.
3. **Restart** `serve` / `ui` / `wrap` / `connect` on the new build.
4. **Update external tooling.** Anything that read `approvals/pending/` or
   `<sessionId>.jsonl` directly off disk — a watcher, a cron job, a
   dashboard — now sees a stale, frozen snapshot: the plane no longer writes
   those files. Point it at the CLI (`mcp-journal approvals list --json`,
   `mcp-journal export`) or the admin UI instead.

Nothing is deleted. The legacy `agents.json`, `admins.json`, `registry.json`,
`tool-inventory.json`, `approvals/`, and `*.jsonl` files stay on disk exactly
where they were, as a cold backup, but they are no longer read live. An
un-imported legacy journal file only becomes visible again by running
`migrate`; until then, `sessions` and `show` print a loud reminder on
stderr:

```
1 legacy *.jsonl session file(s) are not imported; run `mcp-journal migrate` to see them.
```

A fresh install (no pre-M4.5 files at all) needs none of this — `state.db`
and `journal.db` are created on first write, same as the old files were.

## Backup & restore

```
mcp-journal backup <destDir>
```

Copies `state.db` and `journal.db` (whichever exist) into `<destDir>` using
SQLite's own online backup, one file per database. It refuses to overwrite an
existing file at the destination rather than silently clobbering a previous
snapshot — pick a fresh directory (or timestamp it) per backup.

**Do not copy `state.db` on its own with `cp`.** Both databases run in WAL
mode: recent commits can still be sitting in a `-wal` sidecar file rather
than in `state.db` itself, so a plain file copy can miss data that a client
reading through SQLite would see. `mcp-journal backup` folds the sidecar in
for you; that is the whole reason it exists instead of "copy the directory
and hope."

The rest of `~/.mcp-journal/` is ordinary files and copies fine with `cp`,
`rsync`, or your usual backup tool: `vault.enc` and `vault.key` (copy both
together — one is useless without the other), `policy.json`, and any legacy
`*.jsonl`/`*.json` files left over from before an M4.5 upgrade.

To restore: stop every process using the journal directory (same first step
as the upgrade procedure above), put the backed-up files back in place, then
start `serve`/`ui`/`wrap`/`connect` again — the startup `PRAGMA
integrity_check` (see the CLI reference above) confirms the restored
databases are intact before anything else touches them.

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

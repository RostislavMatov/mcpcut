# HTTP agents and the pool

Agents that speak streamable HTTP instead of stdio connect through `serve`, the
HTTP front end:

```
mcpcut serve --port 8090
# one server:      http://127.0.0.1:8090/agents/research-bot/servers/github
# every server:    http://127.0.0.1:8090/mcp
# authentication:  Authorization: Bearer <the agent's token>
```

There are two shapes of address, and both stay available:

- **one endpoint per (agent, server) pair** — tool names and request ids reach
  the server exactly as the agent produced them;
- **one endpoint per agent** (`/mcp`, the *pool*) — every server that agent was
  granted, behind a single URL, with tool names prefixed by their server.

A pool is the right default for an agent with more than one server, because it
moves the source of truth about access out of a config file on the agent's
machine and into the service. The per-server address is the right choice when a
client must see a server's tool names verbatim.

The refusals an agent can get while opening a session, and what each one means:

| Status | Body | What it says |
|---|---|---|
| 401 | `{"error":"unauthorized"}` | no bearer token, or one that resolves to no live agent |
| 403 | `{"error":"no-grant"}` | authenticated, but this agent has no grant for this server |
| 404 | `{"error":"not-found"}` | the endpoint names a server the registry does not hold |
| 400 | `{"error":"protocol-mismatch"}` etc. | something about the REQUEST: a session-model mismatch (see below), an unresolvable vault reference |

None of them names anything the agent did not already send: the plane's registry
contents and its reasons go to its own stderr, never into a response body.

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

### One address for every server an agent has (the pool)

`POST http://<host>:<port>/mcp` serves the agent its whole pool. There is no
agent name in the path: the bearer token names the agent, so the address is the
same for everyone and reveals nothing.

```
$ curl -s http://127.0.0.1:8090/mcp \
    -H "Authorization: Bearer $MCP_AGENT_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
         "params":{"protocolVersion":"2025-11-25","capabilities":{}}}'
# → 200, Mcp-Session-Id: <id>, serverInfo.name: "mcpcut"

$ # then, on that session:
$ # {"jsonrpc":"2.0","id":2,"method":"tools/list"}
$ # → {"tools":[{"name":"github__create_issue",...},{"name":"fs__read",...}]}
$ # {"jsonrpc":"2.0","id":3,"method":"tools/call",
$ #  "params":{"name":"github__create_issue","arguments":{...}}}
```

What the plane does behind that address:

- **answers `initialize` itself** — at a pool address the plane *is* the server,
  and reports itself as `mcpcut`;
- **attaches one ordinary per-server session per granted server** — for a stdio
  server, the one the plane already keeps running for this agent (see *What
  keeps running* below); for an HTTP server, one opened on the first
  `tools/list`;
- **merges their catalogs**, naming each tool `<server>__<tool>` — servers in
  alphabetical order, so two connections of the same agent see the same list;
- **strips the prefix before the frame reaches that server's session.** This is
  the load-bearing part: policy, quarantine, approvals and the journal all see
  the bare tool name, so a pooled call and a per-server call produce
  indistinguishable decision records. The prefix is an address, not a rename.

A member server's own `notifications/tools/list_changed` (or the prompts one)
reaches the agent as the **pool's** notification — "read the merged list
again" — without anything the server attached to it.

**Access changes reach a connected agent.** Grant a server while the agent holds
its session and it receives `notifications/tools/list_changed`; the next
`tools/list` contains the new server. Withdraw one and it leaves the pool while
the session lives on — a call in flight at it gets exactly one answer
(`-32005`, "the server left this pool"). No config edit, no restart:

```
$ mcpcut agent grant research-bot postgres --tools '*'
# the connected agent is told, and finds postgres on its next tools/list
```

**A server that will not come up does not take the pool with it.** Unknown to
the registry, too slow to start (`start-timeout`), dead before it started
(`ended-during-start`), or unable to complete the plane's introduction
(`handshake-failed`) — it is simply absent, and the reason is journaled; a
server that dies during its start is given up on at once, not at the deadline. The same goes
for one that answers a catalog fan-out too slowly: it is detached rather than
allowed to hold up everyone else's list. Less access, never a refusal.

Limits and refusals worth knowing about:

| Situation | What the agent gets |
|---|---|
| `resources/*` or any other method | `-32601` — a pool serves tools and prompts |
| a `cursor` in `tools/list` | `-32602` — the pool drains upstream pages itself and issues none |
| a tool name the pool does not hold | `-32602`, with the same text whether the server is unknown or outside this agent's grants |
| a request id already in flight | `-32602` — two live requests under one id have no single answer |
| more requests than the pool tracks | `-32006` — retry once one has answered |
| a server answers a call with a result that is not finished (`resultType` `input_required`, 2026-07-28) | `-32007` — call the tool again; the pool runs no input round trips of its own |
| a POST with no session and no `initialize` | 400 `{"error":"pool-sessionful-only"}` — the pool is sessionful-only for now |
| `notifications/progress` from a server on a token the agent did not give **that server's** call — or after the call was answered | not passed on; the pool journals it once per server (`unscoped-notification`) |
| a server's log lines, resource updates, or any other notification the pool never declared | not passed on — at a pool address a log line could not be told apart from another server's; each kind is journaled once per server (`unsupported-method`) and every one of them stays in that server's own session traffic |

A tool whose pooled name would exceed 64 characters is **left out of the merged
list** rather than listed: one name a client rejects breaks that client's whole
request. It stays reachable at its per-server address, and the names left out
are recorded in the journal. The server card on `/servers` marks such tools
(`not in pool · <length>`, and the count in the card's tools row), and names
past 47 characters too (`long pool name · <length>`) — clients that add a
prefix of their own may shorten or refuse those. One pool holds at most 32 servers, and those child
sessions count against `serve`'s process-wide session ceiling.

**What keeps running.** A stdio server granted to an agent is started by
`serve` as soon as the grant exists — at the grant, or when `serve` starts —
and stays up while the grant does, so the agent's first `tools/list` answers at
once, however many servers it has and however slowly they start:

| Server | Started | Kept | Stopped |
|---|---|---|---|
| stdio, granted, within the first 32 (agent, server) pairs — a **resident** | in the background at the grant or at `serve` start; at most two at once, and two with the same command line never at once | while the grant lasts; restarted after a pause if it dies (1 s, 2 s, 4 s … up to a minute; given up after five failed starts in a row) | within ~5 s of the grant going (after the agent lets go, if attached) |
| stdio past those 32 — **warm** | on the agent's first `tools/list`, first in line | 10 minutes after the agent leaves (at most 32 idle at once) | when that runs out, or earlier when the service needs the slot |
| HTTP | on the agent's first `tools/list` | while the pool session lives | with the pool session |

A server is only ever handed to **its own** agent; another agent granted the
same server gets a process of its own. Two clients of the same agent at once:
the second gets a process of its own for as long as it stays. A rotated vault
secret or an edited registry record restarts the server before the next agent
gets it. `serve.log` shows every start, restart and stop
(`[serve] resident research-bot/memory: ready (2025-11-25)`).

A start may take up to **40 seconds** — spawn and the plane's introduction
together — which matters after a restart of `serve`, for a warm server and for
an HTTP one. **Register pooled servers by an installed binary rather than
`npx -y …` all the same**: a resident costs memory for as long as it runs, and
an installed binary starts in a fraction of the time (`npm i -g
@scope/server`, then `mcpcut server add memory --transport stdio --command
mcp-server-memory`).

**Both protocol revisions join a pool.** The plane introduces itself to each
server with a handshake first, and asks `server/discover` only when that is
refused: a server that speaks only the stateless revision `2026-07-28` — stdio or
HTTP — is a pool member next to older ones. Every frame the pool sends it carries
the `_meta` that revision requires, in the plane's own name
(`clientCapabilities: {}`), whatever the agent put there. An HTTP server pinned
to `--protocol stateless` is asked only the new way. The agent itself still
connects sessionful.

Known limits of a pool:

- **Kept servers cost memory with no agent connected.** That is the price of a
  first list that answers at once; the cap (32) bounds it.
- **Two agents granted one stdio server run two processes with one environment.**
  A server that keeps data in a file named by its environment
  (`MEMORY_FILE_PATH` and the like) writes into the same file for both. Isolate
  by registration: one server entry per agent.
- **A `2026-07-28` member does not announce catalog changes** (the plane does not
  subscribe with `subscriptions/listen`); the agent sees them on its next
  `tools/list`.
- **An agent that speaks only `2026-07-28` cannot use the pool address yet** —
  it gets `pool-sessionful-only`; its per-server addresses work.
- **The pool answers `-32007` rather than relaying an `input_required` result**:
  it runs no multi-round-trip requests of its own.

`mcpcut show <sessionId> --kind pool` shows a pool session's own record — when it opened,
which servers attached (each with the child session id its decisions are under),
what changed, and when it closed.

### From another machine: `mcpcut connect --url` (preview)

The bridge is [preview](console.md#what-preview-means-here).

An agent whose client speaks only stdio does not need a second tool to reach a
`serve` front on another host — `connect` has a remote form that is nothing but
transport. It reads no registry, no vault and no install config, so the machine
it runs on needs no `setup` and no data directory; the service on the other end
resolves the agent from the token and gates the traffic exactly as it does for
an HTTP agent.

```json
{
  "mcpServers": {
    "mcpcut": {
      "command": "npx",
      "args": [
        "-y",
        "mcpcut@0.1.2",
        "connect",
        "--url",
        "https://plane.example:8090"
      ],
      "env": {
        "MCP_AGENT_TOKEN": "mcpj_…"
      }
    }
  }
}
```

This is the block `agent create` prints: a base address, which means the
agent's pool (`/mcp`). The per-server form stays available for a client that
must see one server's tool names verbatim — give the full path,
`https://plane.example:8090/agents/research-bot/servers/github`, as `--url`.

The token comes from the environment and only from the environment: a token in
`argv` is refused outright, because every process on the machine can read
another's command line through `ps`.

Plain `http` to another host is **refused**, not warned about — the token
crosses that network on every single request, with nobody watching. Use
`https://`, tunnel it (`ssh -L 8090:127.0.0.1:8090 user@host`), or say the
network is trusted out loud with `--allow-http`. Plain `http` to this machine
needs no flag.

| Exit code | What happened | What a client should do |
|---|---|---|
| 0 | the client hung up | nothing — this is the ordinary ending |
| 1 | refused: a bad address, a token in `argv`, no token, 401, 403, 404 | fix the invocation; retrying will not help |
| 4 | the session was lost mid-conversation (expired, or the event stream did not come back) | start a fresh bridge |

A network blip is none of those: the request it hit gets a JSON-RPC error back
(`-32004`) and the bridge keeps running, because a dropped packet is not a
revoked token.

Needs Node 24 or newer, like every other form of the command; below that the
binary says so in one line instead of failing on a missing builtin.

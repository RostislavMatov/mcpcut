# Registry, agents and the vault

`wrap` is the try-it-without-any-setup path: it proxies whatever command line
you hand it and keeps no state of its own. Everything on this page is the
other mode — a control plane that knows your MCP servers *by name*, keeps
their credentials encrypted, issues one identity per agent, and can cut an
agent off with a single command.

Its state lives in `~/.mcpcut/data/`:

| File | Holds | Changed by |
|---|---|---|
| `state.db` | Control-plane state, one document/table per store: server registry, agent identities & grant matrix, server groups, admin accounts, tool inventory (quarantine baselines), approvals queue | `mcpcut server/agent/group/admin/quarantine/approvals ...` |
| `journal.db` | The journal (`journal_records` table) | the proxy |
| `vault.enc`, `vault.key` | Secrets encrypted with AES-256-GCM, plus the master key | `mcpcut vault ...` |
| `policy.json` | Allow / deny / require-approval rules | **you**, by hand; per-tool rules also from the admin UI (Servers card) and `mcpcut policy set` |

`policy.json` stays a plain file on purpose, and it stays hand-editable. The
admin UI (Servers card) and `mcpcut policy set` are just two more writers
of the same file: they set one tool's rule (`allow` / `deny` /
`require-approval`, or clear it), validate the result before writing, write
atomically, refuse if the file changed on disk since the page was rendered, and
record every edit in the journal with the admin's name (`null` for a
`policy set` made before the install has its first admin) and the policy hash
before/after. They edit **the file that entry point itself loaded** — the first
source of the [resolution order](policies.md), resolved from the shell the UI or the
command was started in — and they say which entry points read it, because
`connect` sessions resolve their policy differently (state directory only) and
may be reading another file, or none at all. Neither ever creates a policy
file: with no policy anywhere, enforcement is off and the controls stay
disabled until you create one by hand. Running proxies pick up rule changes without a restart. A few
settings are wired in at startup and still need a restart to change: approval
timeouts, grant TTL, `journal.failClosed` and `quarantine.enabled`
(`policy show` says which is which). The registry, the vault and the grant
matrix change often, and a typo in any of them is a security problem rather
than a syntax error — so they are CLI-managed.

## Onboarding an agent

The whole sequence, from an empty plane to a working, journaled tool call:

```
mcpcut admin add alice --role owner       # the first admin needs no token; prints yours ONCE
export MCP_ADMIN_TOKEN=<that token>
mcpcut vault init
mcpcut server add github --transport stdio \
  --command "npx" --args "-y,@modelcontextprotocol/server-github" \
  --env GITHUB_PERSONAL_ACCESS_TOKEN=vault:github-pat
mcpcut vault set github-pat             # value comes from stdin
mcpcut agent create research-bot        # prints the token ONCE
mcpcut agent grant research-bot github --tools "get_*,list_*,search_*"
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

   A spawned stdio server inherits only `SYSTEM_ENV_ALLOWLIST` (`src/config.ts`:
   `PATH`, `HOME`, `TMPDIR`/`TMP`/`TEMP`, `LANG`/`LC_ALL`, `SHELL`, `USER`,
   `LOGNAME`) — **proxy variables are not inherited**. Behind an outbound proxy,
   pass them yourself: `--env HTTPS_PROXY=http://proxy:3128 --env NO_PROXY=localhost`.
   Without them a `npx -y …` server never reaches the network and `server add`
   fails its registration probe with `no answer to initialize within 10000ms`.
3. **`vault set github-pat`** reads the secret from **stdin**, never from
   `argv` (which every process on the host can read out of `ps`), and stores
   it encrypted. There is deliberately no `vault get`.

   Since 2026-09-03, `vault set`, `vault remove` and `vault rekey` need a
   personal admin token of role `owner` in `MCP_ADMIN_TOKEN`, exactly like
   `agent *` and `group *`, and each one is journaled as an `access-edit`
   record with the action `vault.set` / `vault.remove` / `vault.rekey`, the
   admin's name, and the **secret's name only** (field `vaultEntry`; the value
   never reaches the journal, and `rekey` names no secret at all). Replacing a
   secret replaces the identity a server uses against an external system, so
   the journal has to show who swapped it. `vault init` (bootstrap, before any
   admin exists) and `vault list` need no token — hence the order of a first
   setup: `admin add <name> --role owner` → `vault init` → `vault set`. The
   token is attribution, not protection: the same-uid trust boundary below is
   unchanged (`docs/adr/0003-vault-crypto.md`, amendment 2026-09-03).
4. **`agent create`** mints a 32-byte token and prints it exactly once; only
   its SHA-256 hash is stored. Stealing `agents.json` yields no usable token.
5. **`agent grant`** is the grant matrix: this agent, this server, these tool
   patterns. Anything not granted is invisible in `tools/list` and denied on
   call — before any policy rule is even consulted. The server must already be
   registered: a grant naming a server the registry does not hold is refused
   (`unknown server "x"`, exit 1, nothing written), the same as `group grant`.
6. **`create`, `grant`, `ungrant` and `revoke` need a personal admin token** of
   role `owner` in `MCP_ADMIN_TOKEN` (`admin add <name> --role owner` mints
   one); `agent list` needs none. Each mutation prints an audit line on stderr
   and writes an `access-edit` record naming the admin — the same treatment
   `group *` and `policy set` get. The agent token itself never reaches the
   journal.

`agent create` prints the rest of the job too — the whole client config,
with the token already inside, right under the token:

```
agent: research-bot
token: mcpj_…
Save this token now: it cannot be recovered or shown again.

Client config — paste into the agent's client (the token is inside):
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
HTTP client instead? mcpcut agent config research-bot --http
```

The block runs the bridge through `npx`, pinned to the service's own version,
so the agent's machine needs nothing installed but Node 24+. Installed mcpcut
on the agent's machine yourself? Replace `"command": "npx"` and the first two
`args` with `"command": "mcpcut"`.

Paste it into the agent's client (`.mcp.json`, Claude Desktop, Cursor…) once.
The one entry, `mcpcut`, is the agent's **pool**: every server it is granted
— today and after any later `agent grant` — behind one address, with tool names
prefixed by their server, so the client config never changes again. The
address is `serve.publicUrl` (see *Reaching it by IP (or name) and port* in [Install and first run](install.md));
plain `http://` to another host gets `--allow-http` in `args` automatically,
exactly when the bridge would refuse without it. A second agent on the same
client needs its own entry: rename the key.

`mcpcut agent config research-bot` prints the same block again, any time and
without an admin token, with `<token>` where the token was — the token itself
is never shown twice. `--http` prints the form for a client that speaks HTTP
natively: `url` (the pool path `/mcp` included) and an
`Authorization: Bearer <token>` header; add `"type": "http"` where your client
asks for it. The web console shows both forms on the page `create` answers
with, and the `<token>` block in every agent card on `/agents`; the console
shows the CLI's output as is.

The token is the only secret left in the agent's config, and it grants access
to exactly what that agent was granted — never to the server's own
credentials, which stay in the vault and are injected into the server process
by the plane. A registry-spawned server gets a *controlled* environment: a
small system allowlist (`PATH`, `HOME`, `TMPDIR`, locale) plus its own
declared variables and resolved vault references. It cannot reach the rest of
the plane's environment. (`wrap` keeps full inheritance, as before.)

Policies compose on top of grants, they do not replace them: a granted tool
still goes through classification, quarantine, deny rules and approvals
exactly as described in [Policies](policies.md). Deny always wins.

### Resources and prompts are granted too

Tools are not the whole MCP surface. `resources/read|list|subscribe|unsubscribe`,
`prompts/get|list` and `completion/complete` are governed by their own grant
fields, and an agent that has none of them cannot reach any of those methods —
its call is refused with `agent: no resources/prompts grant: resources/list` in
the journal and, on the wire, a JSON-RPC error saying so. What opens them is an
owner running:

```
mcpcut agent grant research-bot github --tools "*" \
  --resources "file:///project/*" --prompts "review-*"
mcpcut group grant analytics postgres --tools "*" --resources "*"
```

A resource pattern is an exact URI or a URI prefix with one trailing `*`
(prefixes bind on path-segment boundaries, so `file:///project*` does not reach
`file:///projects-private/`); `'*'` on the field means "everything". Listings
are filtered down to what the grant covers, the same way `tools/list` is.

A handful of methods stay refused whatever is granted — anything outside the
list above, e.g. `resources/templates/list`. Those are recorded as
`agent: method not grantable: <method>`, and no grant changes them: a method a
later revision of the spec adds has to be admitted deliberately, never by an
existing wildcard.

## Server groups

A group is a named set of per-server grants plus the agents that inherit them.
It exists so a typical set of servers ("analytics" = postgres + clickhouse +
grafana) is described once instead of being repeated for every agent:

```
mcpcut group create analytics
mcpcut group grant analytics clickhouse --tools "query,describe_*"
mcpcut group grant analytics postgres --tools "*"
mcpcut group join analytics research-bot
mcpcut group show analytics
```

`create`, `remove`, `grant`, `ungrant`, `join` and `leave` need a personal
admin token of role `owner` in `MCP_ADMIN_TOKEN` (the same bar as
`agent grant`); `list` and `show` need none. Every mutation prints an audit
line on stderr and writes an `access-edit` record into the journal with the
admin's name — the same treatment `policy set` gets.

`group grant` **requires an explicit `--tools`** (unlike `agent grant`, which
defaults to `'*'`): the grant lands on every member at once, so "all tools" has
to be typed out as `--tools '*'`.

**A group is not a login.** There is no group key and no shared token: the
agent still authenticates with its own token, and journal records still name
the agent. A group hands out *permissions* in bulk, nothing else — see
[ADR-0010](../adr/0010-server-groups.md).

**How grants merge.** Per server, not per field:

- if the agent has its own grant for a server, that grant wins **wholesale** —
  the groups' grants for that server are ignored, including the fields the
  personal grant leaves out. Narrowing one agent's access to one server is
  therefore never undone by a group;
- otherwise every group the agent belongs to that grants the server
  contributes, and the contributions are unioned: `*` anywhere wins, lists are
  merged and deduplicated, and `resources`/`prompts` stay **absent** (that is,
  denied) unless some group declares them.

Editing a group's members or grants changes access immediately: live sessions
pick it up on their next revocation poll (≤ 5 s), and the `grantsHash` in each
decision record is computed from the expanded matrix, so "which edition of the
permissions allowed this" stays reproducible. An installation with no groups
produces exactly the hashes it produced before groups existed.

Removing a group that still has members is refused, and the refusal lists them.
`mcpcut server remove <name>` cascades: the server is dropped from every
personal grant and every group grant, and the cascade is journaled
(`removed server "x"; cascaded: 2 agent grants, 1 groups`).

`server add` and `server remove` (with or without `--prune-grants`) are
**owner-only**, like the `/servers` write routes of the admin UI: they need
`MCP_ADMIN_TOKEN` set to an owner's personal token, and the `access-edit`
record and the `[audit] server add|remove by …` line name that admin. Without a
token, with one that matches no admin, or with a lower role the command refuses
— `Refusing to change the server registry: …` — before it validates, writes or
probes anything. That matters because registering a server is what decides
which process the plane may launch, and the registration probe runs that
process once, immediately. `server list` and `server show` need no token;
`server refresh` needs `operator`. Registering or editing a server from the
browser leaves the same `access-edit` record (`server.add`, `server.update`)
under the signed-in admin's name.

Removing a name the registry does **not** hold changes nothing: it exits 1 with
`unknown server "x"`, plus a hint when grants are still pointing at that name —
`dangling grants: 2 agent grants, 1 groups — prune with: server remove
--prune-grants x`. The repair is that explicit flag; on a registered name the
flag is simply redundant, since the cascade runs anyway.

## Revoking access

```
mcpcut agent revoke research-bot
```

One command (with `MCP_ADMIN_TOKEN`, role `owner`), and the agent's token is
dead: new connections are refused immediately, and sessions that are already
live end on their next poll of `agents.json` (≤ 5 s) with an `agent-revoked`
decision record in the journal.
To narrow rather than cut off, use `mcpcut agent ungrant <agent> <server>`
— but note that for an agent in a group this WIDENS access rather than
narrowing it (the group's grant comes back; the command warns when it does).


## What the vault protects against, and what it does not

`vault.enc` is a single AES-256-GCM envelope; `vault.key` is the master key,
mode `0600`, sitting in the same directory under the same OS user.

It **does** protect against secrets leaking through the paths they usually
leak through: a backup or dotfile-sync of `~/.mcpcut/data`, a config file
committed to a repository, a shell history or `ps` listing (values never pass
through `argv`), and the journal itself (values are resolved in memory only,
on their way into a server's environment or request headers — the CLI has no
command that prints one).

It does **not** protect against a compromised host. A key next to its
ciphertext, readable by the same user, is exactly as strong as that user
account: anything running as you can decrypt the vault. This is the same
trust boundary as [the wrapped-process limitation](wrap-and-journal.md#known-limitation-trust-boundary-of-the-wrapped-process), and it is
stated here rather than glossed over. Rotate with `mcpcut vault rekey`
(re-encrypts every secret under a fresh key). Full threat model and the
reasoning behind the choice: `docs/adr/0003-vault-crypto.md`.

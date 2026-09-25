# Admin UI

`mcpcut approvals`/`quarantine`/`agent`/`server`/`vault` are all you need
in a terminal. The admin UI is the same state — the same file-backed stores —
behind a browser, for the moment that matters most: a `require-approval` call
is blocking an agent right now, and someone has to look at it and decide
before the agent's own timeout runs out. It is a second front onto the
control plane's stores, not a second source of truth; a resolution made in
the UI and a resolution made with `mcpcut approvals approve` race the
same way (first one wins, the other gets a clear "already resolved").

## Starting it

```
mcpcut ui [--port 8091] [--host 127.0.0.1] [--behind-tls]
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
mcpcut ui --port 8092 --behind-tls --allowed-host 127.0.0.1:8443
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
stdio scenario (`connect`) never runs `serve` at all; if the queue
only had a UI when `serve` was up, that scenario would have no UI ever.

You normally never meet the first-run page: `mcpcut setup` and the first-run
wizard mint the first `owner` before `ui` ever starts and show that token once
in your terminal ([First run](install.md#the-first-owner)). Only `setup --yes --no-admin`
— or a `ui` started by hand over an empty store — leaves it to the browser.

In that case, if the admin store in `<data dir>/state.db` holds no admins yet,
`mcpcut ui` creates **nobody**. It writes a one-time *setup code* to
**`<data dir>/setup-code`** (mode `0600`, created exclusively, inside the
`0700` data directory) and prints the first-run URL and that path — never the
code — to stderr, once. Nothing goes to stdout:

```
[ui] no admins found: open http://127.0.0.1:8091/setup to create the owner
[ui] the page asks for the one-time setup code in /home/you/.mcpcut/data/setup-code (mode 0600); the file is deleted once the owner exists
[ui] no browser? "mcpcut admin add <name> --role owner" in a shell does the same
```

While the install has no admin, every page of the UI — `/login` included —
leads to `/setup`. The page asks for the setup code and the **name** of the
admin to create (the role is fixed: the first admin is the `owner`), creates
it, and shows its personal token **once**, with a button that signs you in
with it. After that `/setup` is gone: it answers with a redirect to `/login`,
and the spent code opens nothing.

Why a code and not an open form: whoever presents it has proved they can read
the data directory, which is the same thing a shell on this host proves.
Without it, the first visitor to reach the port — another local process, or
anyone on the network if you bound beyond loopback — would own the install.
The code is a file and not a log line because `ui` as a service has no
terminal: its stderr is `<data dir>/run/ui.log`, and a secret printed there
would sit on disk for as long as the log does. It is also worth less than the
owner token an earlier version left in that place: once any admin exists it is
dead, and a restart over a still-empty store replaces it.

The file is removed when the owner is created, and by the first successful
sign-in of any admin (browser or console) if a shell finished the first run
instead; a failure to remove it is reported on stderr and changes nothing
else. Attempts are rate-limited per address together with `/login`. The
creation leaves an `access-edit` journal record (`admin.add`, via `ui`) whose
actor is empty — nobody was signed in, and the record says so. If `ui` cannot
write the file it refuses to start and tells you to create the owner with
`mcpcut admin add <name> --role owner`, which needs no token while the store
is empty.

Save the token before you press the button; there is no second copy. Rotate
it later with `mcpcut admin rotate <name>` (with your token in
`MCP_ADMIN_TOKEN`), or — if that token is the one you lost — `mcpcut admin
rotate <name> --recover`, which needs none and leaves a journal record marked
`recovery: true`.

## Admins and roles

Admin accounts are named and personal, not a shared password. Each one holds
its own token (32 random bytes, shown once), and every action taken through
the UI — every approval, every deny, every grant change — is attributed to
the admin who did it, in the journal and in the resolved approval file. There
are exactly three roles, fixed (no custom/scoped roles in this release):

| Role | Can |
|---|---|
| `owner` | everything, including managing other admins, the server registry, the vault, and the permission surface itself: the agent grant matrix (create/grant/ungrant/revoke) and groups |
| `operator` | approvals (approve/deny), quarantine (approve/reject), forced server probe — decisions *inside* the granted surface |
| `viewer` | read-only: journal, approvals queue, registry, grant matrix — no POST action succeeds for this role, anywhere |

The UI does not offer a control the role cannot use: below `operator` the
approve/deny buttons on the dashboard queue and the approve/reject buttons on
`/quarantine` are not rendered at all (the review itself — the schema diff, the
`surfaceDelta` verdict — is fully visible), the owner-only drawers on `/agents`
and `/groups` are absent, and `Vault`/`Admins` are missing from the navigation.
The check is still the server's: hiding a form is an ergonomic choice, and
`ROUTE_TABLE` refuses the route whether or not anything on a page pointed at it.

Manage accounts from the CLI:

```
export MCP_ADMIN_TOKEN=<your personal owner token>          # every admin command below needs it,
                                                             # except the very first `admin add` on an empty plane
mcpcut admin add <name> --role owner|operator|viewer        # prints the token ONCE
mcpcut admin list                                            # names, roles, dates — never token hashes
mcpcut admin rotate <name>                                    # new token; old one dies immediately
mcpcut admin rotate <name> --recover                          # the same without a token: for an owner who lost theirs
mcpcut admin remove <name>
mcpcut admin role <name> <role>
```

Every `add`, `rotate`, `role` and `remove` — from the CLI, the web UI or the
console — writes an `access-edit` journal record (`admin.add` … `admin.remove`)
naming the admin who did it, so the audit export shows who created an owner
or rotated a token, not only that it happened. The two token-free paths (the
first `add` on an empty plane, and `rotate --recover`) write the same record
with no admin name, and `--recover` marks it `recovery: true`.

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

## Threat model summary

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
  owner out. Sessions also expire after an
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
  cryptographic identity. SSO/IdP-backed accounts are not part of
  this release.

None of this changes what the journal itself is: a persistent,
append-oriented, secret-redacted SQLite database. The UI gives you a faster
way to read and act on it; the journal's tamper-evidence comes from its hash
chain, signed head and exported report, not from anything the UI does (see
[Status](status.md)).

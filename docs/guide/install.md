# Install and first run

## Install

Requires **Node.js 24+** (`engines: ">=24"` in `package.json`). The floor is
not arbitrary: `node:sqlite`, the storage layer, is only complete from
v24.19.0 (older builds either lack the module entirely or lack the
`Session` class the audit export uses).

### From npm

On the machine that runs the service:

```
npm install -g mcpcut
mcpcut          # first run: the wizard
```

Install it there rather than run it through `npx`: `Services ▸ start` (and
`mcpcut start`) launches `ui` and `serve` from the copy of mcpcut that ran it,
and npx's cache is not a place a service should live in.

On an agent's machine nothing is installed: the block `agent create` prints
runs the bridge as `npx -y mcpcut@0.3.1 connect --url …`, pinned to the
service's own version — never `@latest`, because that process holds the
agent's token (see `SECURITY.md`, "Versions and the supply chain").

### From source

```
npm install
npm run build
```

This produces `dist/cli.js` (the `mcpcut` binary, per `package.json`'s `bin`
field). `npm link` puts it on your `PATH`; without it, `node dist/cli.js` in
place of `mcpcut` does the same thing. Rerun `npm link` after a build that
changes the `bin` field: npm creates the `PATH` entries at link time only.

## First run (`mcpcut`)

Everything an install owns lives under one directory, `~/.mcpcut`: the install
config (`config.json`) and, unless you choose another place, the data directory
(`data/` — both databases, the vault key, the signing key, `policy.json`, and
the services' pid records and logs under `data/run/`).

### The wizard, or `setup --yes`

A bare `mcpcut` on a terminal that has no install config yet asks first what
this machine is for:

```
No install here yet — what should this console do?
▸ Set up a service on this machine
  Connect to a service on another host
```

**Connect** asks for the host, the port and the protocol (`https` by default;
a whole `http://1.2.3.4:8091` pasted into Host works too), checks that the
service answers without leaving the form — an unreachable address stays on the
form with the reason — and then works as a client of that service; see
[A console for a service on another host](console.md#a-console-for-a-service-on-another-host---remote-preview).
Nothing is installed on this machine; the one thing written is the address,
to `~/.mcpcut/remote.json` (mode 0600, the address only — never a token), so
the next bare `mcpcut` goes straight to that service's sign-in screen. If the
saved service does not answer, the connect form opens with the address filled
in and the reason, instead of dropping you into the shell.

To leave a service and connect to another: **Home ▸ disconnect** in the
console, or `Ctrl-D` on its sign-in screen. Either forgets the saved address
and opens the connect form with the old address in the fields, to correct or
replace. `mcpcut --connect [url]` opens the same form from the shell — also
on a machine that has a local install, where a bare `mcpcut` keeps opening the
local console.

**Set up** opens the first-run wizard (`mcpcut setup` goes to it directly): a
form prefilled with the data directory, the `ui`/`serve`
binds, the first admin's name and who starts the services, a confirmation if a
bind is not loopback, then a deployment ladder («Checks and config», «Starting
ui», «Starting serve» — the waiting step counts `N s of up to 15 s`), the
first owner's one-time token shown once, and — after you confirm you saved it —
the sign-in screen of the console. In a pipe a bare `mcpcut` prints the usage
instead; `mcpcut setup` without `--yes` outside a terminal refuses with a hint.

Scripts and provisioning use the same steps without the questions:

```
mcpcut setup --yes [--data-dir <dir>] [--ui-host H] [--ui-port N] [--serve-host H] [--serve-port N]
                   [--behind-tls|--no-behind-tls] [--admin <name>|--no-admin] [--supervisor mcpcut|external]
                   [--start] [--force]
```

It writes the config, prepares the data directory, prints a check report
(directory, `run/` directory, free ports, databases, policy, network
exposure), initialises the vault and the signing key, and mints the first
`owner` admin, printing that token to the terminal once — before `ui` ever
starts, so no daemon log ever sees it. Flags are overlaid on the config a
previous run wrote: a rerun that passes only `--ui-port` keeps everything else
(including `--behind-tls`, which is why `--no-behind-tls` exists to take it
back). `--start` starts both services once the install is prepared;
`--force` overwrites a config this build cannot read.

### Where the config lives

`~/.mcpcut/config.json` (mode `0600` in a `0700` directory); `MCPCUT_CONFIG`
points at another file. It holds the data directory, the `ui` and `serve`
binds with their TLS/allowlist/policy options, and `supervisor`. Every value
resolves at process start with the priority **flag > environment variable >
config > default**: `MCPCUT_DATA_DIR` (an absolute path) outranks the config's
`dataDir`, `MCPCUT_UI_HOST`/`MCPCUT_UI_PORT` and
`MCPCUT_SERVE_HOST`/`MCPCUT_SERVE_PORT` outrank the binds, and a flag on the
command line outranks both. `supervisor` has no environment override — it is a
question for a human at install time. With no config and no variables, the
defaults are `$HOME/.mcpcut/data`, `127.0.0.1:8091` for
`ui`, `127.0.0.1:8090` for `serve`.

A config that cannot be read or does not validate **refuses** every command
except `--help` and `setup`, naming the file and each problem. It never falls
back to the defaults: a command that silently succeeded against a different
data directory would be the worst possible outcome. Fix the file (or point
`MCPCUT_CONFIG` elsewhere), or let `setup --force` rewrite it.

### Tenant mode (hosted)

A `tenant` section in `config.json` turns this install into one meant to be
handed to somebody who is not you. No section: the install behaves exactly as everywhere
else in this guide, byte for byte. A present section — even an empty
`tenant: {}` — reads as **fully locked down**: every field it omits takes the
strict default below, not the permissive one, so leaving a key out can never
quietly reopen it.

```json
"tenant": {
  "stdioServers": "refused",
  "upstreams": "public-https",
  "maxServers": 5,
  "maxAgents": 5,
  "maxGroups": 2,
  "maxRequestsPerSecond": 10,
  "maxRequestsPerDay": 10000
}
```

| Key | Values | Strict default | What it does |
|---|---|---|---|
| `stdioServers` | `allowed` \| `refused` | `refused` | `refused` stops a `stdio` server from ever being registered, edited onto, or started — a `stdio` record is an arbitrary command run on this host on the owner's behalf. |
| `upstreams` | `any` \| `public-https` | `public-https` | `public-https` allows only `https://` upstream URLs, only on port 443 (no port at all, or an explicit `:443`, both count as port 443 — anything else is refused), and only to a resolved address that is public: loopback, private, link-local (including the `169.254.169.254` metadata address), CGNAT, unspecified, multicast, reserved and documentation ranges are all refused — checked on every connection, not only at registration. |
| `maxServers` / `maxAgents` / `maxGroups` | integers (up to 200 / 200 / 100) | `5` / `5` / `2` | Ceilings on the three stores, enforced only on write — turning the mode on over an install that already holds more never breaks reading it. |
| `maxRequestsPerSecond` / `maxRequestsPerDay` | integers (1–1000 / 1–10 000 000) | `10` / `10000` | The request budget of the agent front (`serve`), shared by every agent of the install — see below. |

Write the strict preset without typing every field: `mcpcut setup --yes --tenant`
(the wizard has no equivalent question — this is a scripted-deploy flag).
There is no `--no-tenant`: a hosted install's own `setup` reruns are how its
owner adjusts a bind, not a lever a tenant could use to escape their own
install, so the section survives every later run that does not repeat the
flag. In Docker, `MCPCUT_TENANT=1` (or `true`) has the entrypoint add
`--tenant` to its own first `setup --yes`; any other non-empty value, `0`
included, stops the container with an error rather than guessing (see
`docker-compose.yml`). In Docker, a tenant install starts with this policy
already in place (`defaultDecision: require-approval`, `classDefaults.read:
allow`, quarantine at its own fail-closed default) — without one, approvals
would be unreachable, since a tenant cannot write a file on the host itself.

**The request budget.** Every HTTP request an agent sends to `serve` — a
`POST`, the `GET` that opens the server-to-agent stream, a `DELETE` — on the
pool address (`/mcp`) or a per-server path costs one unit. A quiet install may
burst to twice `maxRequestsPerSecond` at once, then gets exactly that rate;
separately, the requests admitted in the current clock hour and the 23 before
it may not exceed `maxRequestsPerDay` (a sliding day, so a client cannot spend
two days' worth around midnight). A `GET` stream counts once however long it
stays open — what flows on it is never counted. Only a request with a valid
agent token to a real path is charged, so somebody without a token cannot
spend the owner's allowance, and a refused request costs nothing. Past the
budget the answer is `429 Too Many Requests` with `Retry-After: <seconds>`
(when the next request will be admitted — `1` for the per-second limit, up to
a day for the daily one) and the body `{"error":"rate-limited"}`. The counters
live in the `serve` process's memory, so a restart starts both afresh.

What each refusal looks like, so a hosted owner's tools show a reason instead
of an opaque failure:

- Registering or editing a server as `stdio` — from the CLI, the web form,
  the console or the remote console — refuses with `server "<name>" is stdio: this install refuses stdio
  servers (tenant mode) — register it over https`. A `stdio` record written
  *before* the mode was turned on is locked at start too: `connect`, the
  probe and `serve` all refuse it the same way, so restarting cannot revive
  it.
- Registering a non-`https` URL refuses with `url: this install reaches only
  https servers (tenant mode)`.
- Registering (or, at connect time, dialing) an `https` URL that names an
  explicit port other than 443 refuses with `url: this install reaches only
  port 443 (tenant mode)` (registration) or `refused to connect to <host>:
  this install reaches only port 443 (tenant mode)` (the guard). No port at
  all, or an explicit `:443`, both pass — the URL parser treats them as the
  same thing.
- An `https` upstream that resolves to (or is literally) a non-public address
  is refused with `refused to connect to <host>: it resolves to a <kind>
  address; this install reaches only public https servers (tenant mode)` —
  the address it actually resolved to is never named, so a hosted owner never
  learns the host's internal DNS. A probe hits this the same way any other
  request does: it comes back `error` with the reason, never a silent
  `unreachable`.
- A sixth server (or agent, or a third group) refuses with `too many servers:
  max 5 (tenant mode)` (agents and groups word the same way).
- The web server form drops the `stdio` choice entirely: one `http` pill,
  already selected, with the note "This install reaches only public https
  servers." — there is nothing to submit but `http`.
- [The console](console.md), including [over the network](console.md#a-console-for-a-service-on-another-host---remote-preview),
  additionally refuses any command that names a path on the machine running
  the service — `backup`, `migrate`, `start`, `stop`, `logs`,
  `policy validate`, or a flag such as `--policy`/`--out`/`--report`/`--pub` —
  with "This command names a path on the server; a hosted install does not
  run it (tenant mode)." A streamed `export` (no `--out`/`--report`) still
  works: the file lands on the client, never on the server.

What tenant mode does **not** give you: process, filesystem, network or
memory isolation between installs sharing a host. It closes what the product
itself would otherwise do on an owner's behalf; isolating one hosted install
from the next — a data directory, a `ui`/`serve` pair and a vault per tenant,
kept apart at the OS or container level — is a deployment concern this switch
does not touch.

### The first owner

`setup` (and the wizard) create the first `owner` admin and show its token
**once**, the way `admin add` does. If you pass `--no-admin` instead, the
install is left with no admin and `setup` warns you, naming a file: the first
`ui` start then creates nobody — it serves a **first-run page** at `/setup`
and writes the one-time *setup code* that page asks for to
`<data dir>/setup-code` (mode `0600`, created exclusively, inside the `0700`
data directory) — not into its log. Open the UI, paste the code, choose the
owner's name, and the page shows that owner's token **once**. The file is
deleted when the owner is created. The console does the same without a code:
opened over an install with no admin, `mcpcut` asks for the owner's name
instead of a token ([The console](console.md)). If you lose
the token before signing in, `mcpcut admin rotate <name> --recover` mints a
new one without needing the old one. Details in
[Admin UI › Starting it](admin-ui.md#starting-it).

### One first run, wherever it is deployed

The first owner is created the same way in every deployment, and none of them
needs a browser: open the console **on the machine (or in the container) that
runs the services**. Getting a shell there is the proof of access, so the
console asks for a name and nothing else.

| Deployment | Create the first owner | What reaches the network before that |
|---|---|---|
| On your machine | `mcpcut` | nothing — the UI binds `127.0.0.1` |
| Docker on your machine | `docker compose exec -it ui mcpcut` | ports published to host loopback only; `/setup` refuses without the code |
| VPS, with or without Docker | `ssh` in, then the same command as above | whatever you publish — and still nothing to claim: `/setup` refuses without the code, which is a 0600 file on the VPS |

The browser page (`/setup`) is the optional second way and asks for the
one-time code from `<data dir>/setup-code`; the code is what keeps a published
port from being an open invitation. Nothing in any of these paths writes a
token or a code to a log.

**Reaching it by IP (or name) and port.** Tell `setup` the address you will
type, once — that is the only thing you need to know:

```
mcpcut setup --yes --ui-public-url http://203.0.113.7:8091 --serve-public-url http://203.0.113.7:8090
mcpcut setup --yes --ui-public-url https://mcp.example.com          # a TLS proxy in front
```

From that one value `setup` derives what the HTTP front needs to answer it:
the `Host` allow-list entry (otherwise every request by IP is a 403 — the
DNS-rebinding screen admits only localhost names), for the UI the `Origin`
entry too (otherwise pages open and every form is a 403), `behindTls` for an
`https://` address, and — only for plain `http://` to a public address, over a
loopback bind you did not set yourself — the bind (`0.0.0.0`). The port is
never derived: behind Docker or a proxy the published and the listening port
differ on purpose. The wizard asks the same two questions (`UI URL`,
`Agent URL`, both optional), and a rerun over an existing install adds the
entries and keeps everything else; restart the services afterwards.

`--serve-public-url` is also **remembered**, as `serve.publicUrl` in the
config (the wizard's `Agent URL` opens with it): it becomes the `--url` in
every client config `agent create` and `agent config` print. Without it the
block carries the loopback address of the bind (`http://127.0.0.1:8090`) and
says so in a note — right on this machine, wrong for any other.

Plain `http://` to a public address works, and `setup` says what it costs:
admin tokens (and, on `serve`, agent keys and every tool call) cross the
network in clear text. Two ways out, neither of which mcpcut can supply for
you: TLS in front (then give the `https://` address), or no published port at
all and `ssh -L 8091:127.0.0.1:8091 you@vps`, then `http://localhost:8091`.
The console needs none of this: it never uses the network.

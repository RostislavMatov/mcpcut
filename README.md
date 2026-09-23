# mcpcut

[![CI](https://img.shields.io/badge/CI-GitHub%20Actions-informational)](.github/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A transparent stdio proxy for MCP (Model Context Protocol) servers. It sits
between an AI agent and a real MCP server, forwards traffic byte-for-byte in
both directions, and writes a persistent, secret-redacted journal of the
messages and stderr lines it observes, into `journal.db` (SQLite). (At the
pool address, where one agent reaches all its servers, the plane rewrites
exactly what an address needs — the `<server>__` prefix on tool and prompt
names — and nothing else: see [the pool](#one-address-for-every-server-an-agent-has-the-pool).)

When enforcement is enabled, every observed `tools/call` is classified before
forwarding. Without a policy file, the proxy is journaling-only and forwards
everything unmodified.

`mcpcut` is also how the plane is installed and run: a first-run wizard that writes the
install config and mints the first admin, `ui` and `serve` as detached services
that survive the terminal, and a terminal console that works the whole plane
without a browser — see [First run](#first-run-mcpcut), [Services](#services)
and [Docker](#docker).

## Status

What exists today, and what does not. This table is the source of truth — no
other text about the project may claim more than it does.

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
| tamper-evident journal storage (hash chain + signed head) | shipped, **with an external anchor** | chain/verify tests, `docs/adr/0007-evidentiary-journal.md` |
| exportable audit report, offline-verifiable | shipped | `export --report` / `verify --report` tests, `docs/smoke-m5.md` |
| explicit retention pruning (`prune`) | shipped, **no defaults** | prune + marker tests |
| admin UI / approval queue | shipped | e2e + UI test suites, TS + security reviews, manual browser smoke (`docs/smoke-m4.md`), `docs/adr/0004-admin-ui-architecture.md` |
| named admin accounts (owner/operator/viewer) | shipped | admin CLI + role-enforcement tests |
| one address per agent (the pool, `/mcp`) | shipped, tools and prompts, sessionful agents | pool unit + e2e tests, `docs/smoke-agent-pool.md` (live clients — official SDK v1/v2, Inspector CLI, Claude Code headless — against a VPS over TLS) |
| `connect --url` bridge for agents on another machine | shipped | `docs/smoke-connect-bridge.md`, `docs/smoke-agent-pool.md` |
| ready-made client config at `agent create` | shipped | `docs/smoke-agent-config.md`, `docs/smoke-agent-pool.md` |
| whole-product security audit | passed 2026-09-02, **internal** | `docs/security-audit-2026-09.md` — 0 CRITICAL, 4 HIGH fixed in the same wave; no independent pass has been done (ADR-0011), reports via `SECURITY.md` |

The journal is a persistent, append-oriented, secret-redacted SQLite database
(`journal.db`; JSONL is the export format — `mcpcut export` — and the
format legacy pre-M4.5 installs used on disk before `migrate`). Since M5 every
record is linked into a sha256 hash chain, the chain head can be signed with
this installation's Ed25519 key, and an exported report verifies offline
against a public key alone.

That makes the journal **tamper-evident with an external anchor** — a precise
claim, and the qualifier is not decoration. Tampering is detectable *because*
the chain and a signed head disagree with an anchor recorded somewhere this
host cannot rewrite. A process running as the same OS user can rewrite the
journal end to end, recompute every hash and re-sign it with the same key; the
result passes every check made against the host alone. Take anchors out of
band ([The out-of-band anchor](#the-out-of-band-anchor)), or the word
"tamper-evident" is doing work nothing behind it supports. It is not
tamper-*proof*, and this project does not call itself "audit-ready" — whether
a report satisfies an audit is the auditor's judgement, not ours.

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
[A console for a service on another host](#a-console-for-a-service-on-another-host---remote).
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
instead of a token ([The console](#the-console)). If you lose
the token before signing in, `mcpcut admin rotate <name> --recover` mints a
new one without needing the old one. Details in
[Admin UI › Starting it](#starting-it).

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

### The console

```
mcpcut tui          # or a bare `mcpcut` on a terminal that has an install config
```

Over an install that has no admin yet, the console opens on a **first-owner
screen** instead of the sign-in: type the owner's name, the console runs
`mcpcut admin add <name> --role owner`, holds the token on screen until you
press `y` (`q` asks before it lets the token go), and signs you in with it. It
asks for no setup code, unlike the web page: a console runs under the account
that owns the data directory, which is the very thing the code proves. The
creation is journalled exactly as the shell command is — `admin.add` with an
empty actor.

Otherwise, sign in with a personal admin token; the sign-in screen also shows whether
the services are up (`services: ui ● … · serve ○ …`, with a hint to start
them from the Services section — nothing starts on its own). Twelve sections
— Home, Admins, Servers, Vault, Agents, Groups, Policy, Quarantine, Approvals,
Journal, Audit, Services — each a list of actions; every action is a form that
runs the very CLI command it shows you (`$ mcpcut …`), with the same gates and
the same journal records as the shell. The Approvals queue re-reads itself
every 3 s while you are on it. An action that prints a one-time token
(`admin add`, `admin rotate`, `agent create`) holds the output on screen
under a banner until you press `y` to say you copied it. Services shows
`status · start · stop · logs · setup`; under `supervisor: external`
(Docker, systemd) `start`/`stop` are not offered.

Keys, as `?` shows them from the action list: `Tab`/`Shift-Tab`/`1-9`/`h`/`l`
move between sections, `↑`/`↓`/`k`/`j` between actions, `Enter` opens or runs,
`←`/`→` change a choice field and space toggles a flag, `PgUp`/`PgDn` scroll
the output and `[`/`]` scroll it sideways, `r` reruns the section's refresh
action, `y`/`n` answer a confirmation, `Esc` cancels, `q` or `Ctrl-C` quit
(the services keep running). The `?` help covers the whole body and any key
closes it.

The console adapts to the terminal rather than asking you to resize it:
below **60 columns** the layout stacks (the action list as a strip on top,
the output pane full-width beneath it) and switches back on resize; a
non-empty `NO_COLOR` or `TERM=dumb` turns every escape sequence for colour
and weight off (the alternate screen and cursor movement stay — a terminal
without those cannot run the console at all); keys pressed while a command is
running are **queued** (up to 32) and replayed in order once it answers, except
when the answer is a one-time token — then the queue is dropped so nothing
can acknowledge the token unread. `Ctrl-C` is never queued: it quits at once.

### A console for a service on another host (`--remote`)

```
mcpcut --remote https://plane.example.com:8091
# or: export MCPCUT_REMOTE=https://plane.example.com:8091 && mcpcut
```

`mcpcut` on your machine working as a **client** of a `ui` service that runs
somewhere else — a VPS, a container, a colleague's machine. Nothing is opened
on the server: no terminal, no SSH; the service that already serves the admin
UI answers HTTP requests, the way it answers a browser. On a machine without
an install a bare `mcpcut` offers this as "Connect to a service on another
host" and asks for host and port; the flag and the variable below are the same
thing for scripts and shell profiles. The client side needs nothing but the
package (`npm i -g mcpcut`): no `setup`, no data directory, no services. The
address is the one the admin UI answers on, so whatever makes the web UI
reachable (`setup --ui-public-url …`) makes the console reachable too. The
flag and the variable store nothing (only a connect made from the form is
remembered); the token is typed at the sign-in screen and lives in memory
only, however you connected. While connected the header names the service:
`McpCut console · kate (owner) @ plane.example.com:8091`.

Every action still runs the very CLI command it shows you — on the **server**,
inside the `ui` process, under your admin token (`Authorization: Bearer`, on
every request; there is no cookie and no server-side console session, so a
rotated or removed admin stops working on the next request). Output streams
back; an export is written to a file on **your** machine.

What differs from a local console, because a network is not a shell:

- **A role floor on top of each command's own gate.** `vault *`, `keygen`,
  `backup`, `migrate`, `verify`, `prune`, `start`, `stop`, `logs` and
  `export --report` (which writes a directory on the server) need `owner`;
  a streamed `export` and any `policy` form other than a bare `policy show`
  need `operator`. Locally these are host operations open to whoever has the
  shell; over a network that reasoning does not hold (ADR-0014).
- **An `owner` token over the network is close to a shell on the server**:
  it can stop services and write backups to a path. That is the owner's
  decision (RC2), not an accident — protect that token accordingly.
- **Vault writes need TLS.** `vault set|remove|rekey` run only when `ui` is
  declared behind TLS (`behindTls`) or the caller is on loopback; over open
  `http` they are refused with the reason. The secret travels in a body field
  of its own — never in argv, in the stream, or in the service's stderr.
- **Plain `http` to a non-loopback host** prints a loud `warning:` before the
  console opens and a notice on the sign-in screen: the admin token would
  cross the network in clear. Use `https://`, or tunnel:
  `ssh -L 8091:127.0.0.1:8091 user@host` and `--remote http://127.0.0.1:8091`.
- **`Services ▸ setup` is not offered**: the wizard is a local child process
  and would configure the wrong machine. `tui`, `ui`, `serve`, `wrap`,
  `connect` and `setup` are not runnable through the API at all.
- **The first owner needs the setup code.** Over an install with no admin the
  remote console opens the first-owner screen with a second, masked field:
  the code from `<data dir>/setup-code` on the server (the same code, and the
  same server-side flow, as the web `/setup` page). A local console still asks
  for no code.
- **No browser is a client of this API**: a request carrying an `Origin`
  header is refused, and cookies are ignored.

## Services

```
mcpcut start [ui|serve]           # both when no name is given
mcpcut stop  [ui|serve]
mcpcut status [--json]
mcpcut logs <ui|serve> [--lines N]   # default 50 lines
```

`start` spawns `ui` and `serve` as detached daemons that survive the terminal
that started them, and returns once each answers its readiness probe (up to
15 s; the first start of an install opens and possibly migrates two SQLite
databases before it listens). Their pid records and logs live in
`<data dir>/run/` — `ui.pid`, `ui.log`, `serve.pid`, `serve.log`. That
directory and every file in it must be owner-only (`0700`/`0600`, your uid):
a start refuses otherwise, and `setup` reports the same condition as the
`run dir` row of its check report. Whoever can write a pid file chooses which
pid the next `stop` signals. The daemons get `MCPCUT_DATA_DIR` set to the
manager's data directory and never inherit `MCP_ADMIN_TOKEN` or
`MCP_AGENT_TOKEN` from your shell.

`status` says `running` only when the pid is alive **and** the service answers
on its port (`GET /login` for `ui`, a TCP connect for `serve` — the same probes
the compose healthchecks use). The other words: `starting` (alive, not yet
answering, younger than the readiness timeout), `stopped` (no pid file,
nothing answering), `stale` (a pid file whose process is dead, or alive but
silent for too long, or reused by something else — nothing is signalled, the
file is leftovers) and `external` (something answers on the port with no pid
file of ours). `stop` sends `SIGTERM` to a `running` or `starting` service,
waits **5 s**, then escalates to `SIGKILL` and reports `forced`; a `stale` pid
file is only cleared. On Windows `start`/`stop` refuse: run `mcpcut ui` and
`mcpcut serve` in the foreground, or use a Windows service.

When a service binds an address other hosts can reach (anything but
loopback), `status` repeats the warning `setup` gives at install time — one
line per such service on **stderr**, `<service>: warning: <service> binds
<host>: reachable from the network. …`, with the same advice and ADR-0004
pointer. Stdout and the exit code are unchanged, and a stopped service is
warned about too: the configured bind becomes reachable the moment it starts.
`status --json` writes nothing to stderr; instead the exposed service's object
carries `"exposure": {"level": "warn", "detail": "…"}` (the field sits on each
service because the document is an array; a loopback install's JSON is
unchanged). The console runs the table form on Home and Services, so the
warning shows in the panel under `— stderr —`.

`supervisor: external` in the config (what the Docker entrypoint writes, and
what you should write before handing the processes to systemd or launchd)
turns `start` and `stop` into a refusal with an explanation; `status` and
`logs` keep working, and a service that answers shows as `external` — the
console draws it `◉`, meaning "answering, but not our pid".

Service logs are **not rotated** (an open question — Q10 in the roadmap). They
hold the same redacted diagnostics the process used to print to the terminal,
plus whatever an upstream MCP server made it print; `mcpcut logs` reads at
most the last 64 KiB and passes every line through the same readable-field
filter as the journal, so a log written by someone else cannot repaint your
terminal. To rotate by hand, stop the service first — the daemon holds the
file open and would keep writing into a moved inode:

```
mcpcut stop ui
mv ~/.mcpcut/data/run/ui.log ~/.mcpcut/data/run/ui.log.1
mcpcut start ui               # opens a fresh ui.log
```

### Running under systemd or launchd

If the host already has a supervisor, hand the two processes to it instead of
`mcpcut start`. `docs/deploy/` holds example user units for systemd
(`mcpcut-ui.service`, `mcpcut-serve.service`) and launchd
(`com.mcpcut.ui.plist`, `com.mcpcut.serve.plist`) with the install steps in
[`docs/deploy/README.md`](docs/deploy/README.md). The one prerequisite:
`mcpcut setup --yes --supervisor external`, so the console and the CLI report
the services instead of fighting the supervisor for them. The files are
examples to adapt (paths, node binary), not something `mcpcut` installs.

## Docker

`docker compose up -d` builds one image and runs two containers, `ui` and
`serve`, one per long-running process. There is no database container: the
store is `node:sqlite`, so `state.db` and `journal.db` are files, and both
containers mount the **same** named volume `mcpcut` at
`/home/node/.mcpcut` (the data is in its `data/`) — two writers of the same files, which is what the
code assumes (WAL, the exclusive policy lock, the `statSync` hot reload). That
holds because a named volume is one filesystem on one host; it would not hold
across machines. The install config lives on the same volume
(`/home/node/.mcpcut/config.json`), so it survives `docker compose down` and an image
rebuild, and a second start skips setup instead of repeating it. `connect`,
the stdio proxy, has no container: the agent's own client spawns it.

The first start of `ui` runs `setup --yes --supervisor external` from the
entrypoint, taking its answers from the environment — `MCPCUT_DATA_DIR`,
`MCPCUT_UI_HOST`/`MCPCUT_UI_PORT` (default `0.0.0.0:8091`),
`MCPCUT_SERVE_HOST`/`MCPCUT_SERVE_PORT` (default `0.0.0.0:8090`), and the
optional `MCPCUT_UI_PUBLIC_URL`/`MCPCUT_SERVE_PUBLIC_URL` — set them in an `environment:` block to
change the install. `MCPCUT_SERVE_PUBLIC_URL` is also the address every
generated client config carries (`agent create`, `agent config`). `0.0.0.0` inside the container is the only way a
published port reaches it; the ports are published to host loopback only
(`127.0.0.1:8091`, `127.0.0.1:8090`), and `Host` screening still admits only
localhost names, so reach the console at `http://localhost:8091`. **Do not set
`MCPCUT_DATA_DIR`** in the container's environment: it outranks the config for
every command, `setup` refuses the run as a data-directory conflict, and under
`set -eu` with `restart: unless-stopped` the container crash-loops. Do not
bind-mount a checkout over `/app` either: a `.mcpcut-project/policy.json` in it
would shadow the volume's policy (ADR-0005).

**TLS in front, on a VPS.** `docs/deploy/caddy/` holds a `Caddyfile` and a
compose override that put Caddy with a Let's Encrypt certificate in front of
`serve` and leave the UI on host loopback (reach it through an SSH tunnel) —
exactly the stand the pool's live smoke ran (`docs/smoke-agent-pool.md`). Set
`MCPCUT_SERVE_PUBLIC_URL` to the `https://` address in the override before the
first start: it is the Host allow-list, the TLS flag, and the address every
generated client config carries.

The entrypoint passes `--no-admin`: the image creates **no admin**, so no
token ever reaches `docker compose logs`. You create the first owner yourself,
and you do not need a browser for it:

```
docker compose exec -it ui mcpcut      # the console: asks for the owner's name, shows the token once
```

The console sees an install with no admin and opens on its first-owner screen
([The console](#the-console)); being inside the container is the proof of
access, so it asks for no code. The other two ways:

```
docker compose exec ui mcpcut admin add <name> --role owner     # unattended: token on this exec's stdout
docker compose exec ui cat /home/node/.mcpcut/data/setup-code   # the code the browser's /setup page asks for
```

**On a VPS**, two things make the UI reachable at `http://<ip>:8091`, and both
are yours to set: publish the port beyond host loopback (`ports:` in
`docker-compose.yml` is `127.0.0.1:8091:8091` — drop the `127.0.0.1:`), and
name the address in `MCPCUT_UI_PUBLIC_URL` (and `MCPCUT_SERVE_PUBLIC_URL` for
agents) **before the first start**. For a volume that already has a config:

```
docker compose run --rm ui setup --yes --ui-public-url http://203.0.113.7:8091
docker compose restart ui
```

Until someone does one of these the install is closed, not open: reaching the
published port claims nothing, because `/setup` refuses without the code and
the code is inside the volume. A lost token:
`docker compose exec ui mcpcut admin rotate <name> --recover`.

Inside the container the console's Services section shows `status` and
`logs` only — compose owns the processes, and Home says so instead of
pointing at `Services ▸ start`. Each container has its own network namespace,
so a probe of the `0.0.0.0` bind (dialled as loopback) reaches only the
container it runs in. The install config therefore carries an optional
`probeHost` per service: the address `status` dials for a service that has no
pid file (compose, systemd). `docker-compose.yml` sets
`MCPCUT_UI_PROBE_HOST=ui` and `MCPCUT_SERVE_PROBE_HOST=serve` on both
services, the entrypoint turns them into `setup --ui-probe-host ui
--serve-probe-host serve`, and the header draws both services `◉` from either
container. The entrypoint passes each flag only when its variable is set and
non-empty: a bare `docker run` without them writes no `probeHost` and probes
its own loopback, where compose service names would resolve nowhere. If you
rename a compose service, rename the variable's value too. `probeHost` never
changes the bind — `host`/`port` in `status` stay where the service listens;
the `detail` names the address that was dialled. A service with a pid file of
ours is always probed on the host recorded in that file.

An install whose config predates `probeHost` gets it from a rerun of setup —
admins already exist, so no token is minted or printed — followed by a
restart:

```
docker compose run --rm ui setup --yes --ui-probe-host ui --serve-probe-host serve
docker compose restart
```

A rerun without the flags keeps the value already in the config. There is no
flag that clears it: remove the `probeHost` key from the config file by hand
(`/home/node/.mcpcut/config.json` on the `mcpcut` volume;
`~/.mcpcut/config.json` outside Docker).

Inside compose `mcpcut status` warns that `ui` and `serve` bind `0.0.0.0`
(see [Services](#services)). That is expected: the address is the
container's, and the ports are published to host loopback only.

## Usage

### Wrap a server

Run the real MCP server as a child process, journaling the traffic the proxy
observes while forwarding it unmodified:

```
mcpcut wrap -- <cmd> [args...]
```

Everything after `--` is the real server's command line. `mcpcut` exits
with the wrapped server's exit code.

### List sessions

```
mcpcut sessions
```

Prints a table of every journaled session: session id, first/last message
timestamp, and message count.

### Show a session's journal

```
mcpcut show <sessionId> [--method X] [--direction Y] [--json]
```

Prints one session's journal records, optionally filtered by JSON-RPC
`method` or traffic `direction`. By default records are printed in a
readable, one-line-per-record format (timestamp, direction, kind, method,
truncated payload); pass `--json` to print the raw JSONL instead.

## Policies

Without a policy file, `mcpcut` behaves exactly like the plain journaling
proxy above (mode A): every message is forwarded unmodified, only journaled.
Dropping a `policy.json` in `./.mcpcut-project/policy.json` (project) or
`~/.mcpcut/data/policy.json` (home) turns on enforcement (mode B): every
`tools/call` is matched against the policy before it reaches the server, and
`tools/list` results are filtered to what the agent is actually allowed to
call. Running proxies re-read the policy file when it changes (checked
before each decision, at most every 250 ms), so a rule edit — by hand, from
the admin UI or via `policy set` — takes effect on the next call without a
restart; a broken edit leaves the last valid policy in force and is reported
loudly on stderr rather than silently relaxing anything.

The same goes for a policy file that did not exist yet. `setup` starts `serve`
before you have written any policy, and a `connect` session may outlive the
moment you write one: a process that started with **no** policy file (it says
`journaling only` at start-up) keeps looking where that entry point reads, and
the first **valid** `policy.json` to appear there is adopted on the next call —
`policy adopted: <path> (<hash>)` in the process's log, no restart. A file that
does not parse or validate is never adopted: the process says
`policy file not adopted: …; still journaling only` and picks it up once it is
fixed. After adoption the source is pinned exactly as if it had been there at
start-up. Two limits: sessions that were already open keep the approval
timeouts and fail-closed setting they were wired with until they are reopened,
and `wrap` without a policy is a different mode altogether (no gate is built),
so a `wrap` run still needs a restart to come under a new policy.

Resolution order (first found wins, **no merging** across sources):
`--policy <path>` → `$MCPCUT_POLICY` → `./.mcpcut-project/policy.json` →
`~/.mcpcut/data/policy.json`. A broken or explicitly-named-but-missing policy
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

A call is classified from the tool's descriptor: the one the session saw in
its own `tools/list`, or — when the agent never asked for the catalog — the one
the inventory stored the last time anyone observed that server (the
registration probe, `server refresh`, an earlier session). Only a tool nobody
has ever seen listed is classified from its name alone. Skipping `tools/list`
is the agent's choice, so it must not be a way to turn a `destructive` tool
into a `write` one.

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
mcpcut policy validate [path]
mcpcut policy show [--server <name>] [--json]
```

### Approval scenario

A `require-approval` tool call does not reach the server immediately:

1. The agent calls a gated tool. `mcpcut` enqueues an approval request
   and the call blocks (client-side) until it is resolved or times out
   (60s default).
2. An operator reviews and resolves it in another terminal:
   ```
   mcpcut approvals list
   export MCP_ADMIN_TOKEN=<your personal admin token>
   mcpcut approvals approve <id> [--reason TEXT]
   mcpcut approvals deny <id> [--reason TEXT]
   ```
   `approve` and `deny` require `MCP_ADMIN_TOKEN` — the personal token
   `mcpcut admin add` printed — and the admin behind it must hold the
   `operator` or `owner` role, the same minimum the admin UI enforces on the
   same action. The resolution is then stored as `cli:<adminName>`, so the
   journal answers *who* approved a call and not only *that* someone did.
   `approvals list` needs no token: reading the queue is not an authorization
   event.

   Each pending line carries **two clocks**, and they mean different things:

   ```
   01K5…  server=github tool=create_issue class=write agent_waits=42s expires_in=4m55s args={…}
   ```

   `agent_waits` is how long the blocked call is still there to be unblocked;
   `expires_in` is how long a fresh approval stays usable. Once the first runs
   out the line says `agent_waits=elapsed(retry-only)`: approving then still
   mints the grant, but the agent has already given up and has to call again
   for it to be used. `agent_waits=unknown` means the request recorded no wait
   window. Nothing about `--json` changed — both deadlines have been on
   `expiresAt` / `waitExpiresAt` there since M4.

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
`mcpcut` puts it in quarantine instead of trusting it automatically.
Quarantined tools are blocked (`require-approval`/`deny` per
`quarantine.onQuarantined`) until an operator reviews and approves them:

```
mcpcut quarantine list [--server <name>]
mcpcut quarantine show <server> <tool>
mcpcut quarantine approve <server> <tool>                      # needs MCP_ADMIN_TOKEN (operator)
mcpcut quarantine approve --all --server <name>                # needs MCP_ADMIN_TOKEN (operator)
mcpcut quarantine reject <server> <tool>                       # needs MCP_ADMIN_TOKEN (operator)
```

Releasing a tool from quarantine widens what every agent granted that server
can reach, so `approve` and `reject` require `MCP_ADMIN_TOKEN` — the personal
token of an admin whose role is `operator` or `owner`, the same bar the admin
UI applies to the equivalent buttons — and each release is written to the
journal as an `access-edit` record naming the admin, the server and the tool.
`list` and `show` need no token. As everywhere else, the token buys
attribution and parity with the UI's role table, not protection from a process
running as the same user.

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
"no approved baseline" note. `surfaceDelta` never changes a tool's `read`/`write`/`destructive`
classification. It does one specific thing, described next.

#### An explicit `allow` stops covering a widened tool

A per-tool rule (`servers.<name>.tools.<tool>: allow`) normally outranks
quarantine — that is the point of writing one. But such a rule is a statement
about a tool surface an operator *looked at*. If the server later advertises a
wider surface for that tool, the rule no longer describes what the tool can now
be asked to do, so it stops applying and the call falls to
`quarantine.onQuarantined` (`require-approval` by default) under the rule name
`surface-changed`. Approving the tool again in quarantine restores the rule.

The withdrawal fires when a tool that was approved has since `changed` and its
`surfaceDelta` is `widened`, the ambiguous `changed` — or could not be computed
at all. That last case matters more than it sounds: an approval made before
descriptors were stored, or a schema too large to store whole, leaves no
direction to compute, and "no signal" is not evidence of safety. A `narrowed`
or `neutral` (wording-only) change leaves the `allow` standing.

Two deliberate non-behaviours. It does nothing when `quarantine.enabled` is
`false` — that flag *is* the operator's switch for gating schema drift, and
honouring an explicit `allow` while ignoring an explicit "don't gate drift"
would be two answers to one question. And a tool in state `new` is untouched:
a rule written for a tool that was never approved was never written against an
approved surface.

Every such call is journaled like any other decision, with `rule:
surface-changed` and the `policyHash`/`grantsHash` the call was decided under
— so an auditor reading "the policy says allow, the outcome was
require-approval" can see exactly why, rather than concluding the rules changed
by themselves.

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

### CLI command reference

```
mcpcut wrap [--server <name>] [--policy <path>] [--no-policy] [--fail-closed] -- <cmd> [args...]
mcpcut connect <server> --agent <name> [--policy <path>] [--fail-closed]
mcpcut serve [--port N] [--host H] [--policy <path>] [--fail-closed] [--allowed-origin URL]
mcpcut server add <name> --transport stdio|http ...
mcpcut server list | show <name> | remove <name> [--prune-grants]
                                                  # add/remove need MCP_ADMIN_TOKEN (owner); list and show do not
mcpcut vault init | set <name> | list | remove <name> | rekey
                                                  # set/remove/rekey need MCP_ADMIN_TOKEN (owner); init and list do not
mcpcut agent create <name> | list | revoke <name> | config <name> [--http]
mcpcut agent grant <agent> <server> [--tools a,b,prefix*] | ungrant <agent> <server>
                                                  # every agent mutation needs MCP_ADMIN_TOKEN (owner); list and config do not
mcpcut group create <name> | remove <name> | list | show <name>
mcpcut group grant <group> <server> --tools a,b,prefix*|* [--resources ...|*] [--prompts ...|*]
mcpcut group ungrant <group> <server>
mcpcut group join <group> <agent> | leave <group> <agent>        # mutations need MCP_ADMIN_TOKEN (owner)
mcpcut sessions
mcpcut show <sessionId> [--method X] [--direction Y] [--kind Z] [--json]
mcpcut policy validate [path]
mcpcut policy show [--server <name>] [--json] [--policy <path>]
mcpcut quarantine list [--server <name>] [--json]
mcpcut quarantine show <server> <tool>
mcpcut quarantine approve <server> <tool> | --all --server <name>        # needs MCP_ADMIN_TOKEN (operator)
mcpcut quarantine reject <server> <tool>                                 # needs MCP_ADMIN_TOKEN (operator)
mcpcut approvals list [--json]
mcpcut approvals approve <id> [--reason TEXT]        # needs MCP_ADMIN_TOKEN
mcpcut approvals deny <id> [--reason TEXT]           # needs MCP_ADMIN_TOKEN
mcpcut admin add <name> --role owner|operator|viewer                 # needs MCP_ADMIN_TOKEN (owner) once an admin exists
mcpcut admin list | remove <name> | rotate <name> [--recover] | role <name> owner|operator|viewer
mcpcut ui [--port 8091] [--host 127.0.0.1] [--behind-tls]
          [--allowed-host <host[:port]>]... [--allowed-origin <origin>]... [--trusted-proxy-header <name>]
mcpcut migrate
mcpcut export [--session <id>]
mcpcut export --report [--session <id>] [--out <dir>]
mcpcut backup <destDir>
mcpcut keygen
mcpcut verify [--session <id>] [--sign]
mcpcut verify --report <dir> [--pub <path>] [--require-signature]
mcpcut prune --older-than <duration> [--yes]         # --yes needs MCP_ADMIN_TOKEN (owner)
mcpcut setup                                          # interactive setup on a terminal: the same questions as the flags below
mcpcut setup --yes [--data-dir <dir>] [--ui-host H] [--ui-port N] [--serve-host H] [--serve-port N]
             [--behind-tls|--no-behind-tls] [--admin <name>|--no-admin] [--supervisor mcpcut|external]
             [--ui-probe-host H] [--serve-probe-host H] [--start] [--force]
                                                      # write the install config, prepare the data directory, mint the first owner
mcpcut start|stop [ui|serve]                          # start/stop the services as detached daemons (pid + log in <data dir>/run)
mcpcut status [--json]                                # running = pid alive AND answering on its port
mcpcut logs <ui|serve> [--lines N]                    # tail of a service log (default 50 lines)
mcpcut tui                                            # the interactive console (a bare `mcpcut` on a terminal does the same)
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
`mcpcut` itself. It could, in principle, write directly to the journal,
approval queue, or quarantine store files on disk — nothing currently stops
a malicious or compromised server from tampering with its own audit trail or
self-approving a quarantined tool. The journal is an **append-oriented**
SQLite database (`journal.db`): nothing in the current implementation makes it
append-*only*.

M5's hash chain and signed chain head make such tampering **detectable** —
they do not prevent it. A rewrite by a process under this uid can recompute
the whole chain and re-sign it, and only comparison against an anchor recorded
out of band exposes that. A separate privileged writer, an append-only
attribute, or off-box shipping of the journal would raise the bar further and
are tracked as post-MVP work; today this is a known, accepted gap, stated
rather than papered over. Describe the journal as *tamper-evident with an
external anchor*, never as tamper-proof and never as "audit-ready".

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

Its state lives in `~/.mcpcut/data/`:

| File | Holds | Changed by |
|---|---|---|
| `state.db` | Control-plane state, one document/table per store: server registry, agent identities & grant matrix, server groups, admin accounts, tool inventory (quarantine baselines), approvals queue. Supersedes the legacy `registry.json`/`agents.json`/`admins.json`/`tool-inventory.json`/`approvals/` files below (M4.5, ADR-0006) | `mcpcut server/agent/group/admin/quarantine/approvals ...` |
| `journal.db` | The journal (`journal_records` table), plus a marker of which legacy `*.jsonl` files have been imported | the proxy; `mcpcut migrate` |
| `registry.json`, `agents.json`, `admins.json`, `tool-inventory.json`, `approvals/` | Legacy pre-M4.5 files — read once into `state.db` (by `migrate`, or lazily on first touch), then left untouched as a cold backup | — (historical; no longer written) |
| `vault.enc`, `vault.key` | Secrets encrypted with AES-256-GCM, plus the master key | `mcpcut vault ...` |
| `policy.json` | Allow / deny / require-approval rules | **you**, by hand; per-tool rules also from the admin UI (Servers card) and `mcpcut policy set` |
| `<sessionId>.jsonl` | Legacy journal (pre-M4.5), read only via `mcpcut migrate`; the proxy no longer writes this format | — (historical; no longer written) |

`policy.json` stays a plain file on purpose, and it stays hand-editable. The
admin UI (Servers card) and `mcpcut policy set` are just two more writers
of the same file: they set one tool's rule (`allow` / `deny` /
`require-approval`, or clear it), validate the result before writing, write
atomically, refuse if the file changed on disk since the page was rendered, and
record every edit in the journal with the admin's name and the policy hash
before/after. They edit **the file that entry point itself loaded** — the first
source of the resolution order above, resolved from the shell the UI or the
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

### Onboarding an agent

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
      "command": "mcpcut",
      "args": [
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

Paste it into the agent's client (`.mcp.json`, Claude Desktop, Cursor…) once.
The one entry, `mcpcut`, is the agent's **pool**: every server it is granted
— today and after any later `agent grant` — behind one address, with tool names
prefixed by their server, so the client config never changes again. The
address is `serve.publicUrl` (see *Reaching it by IP (or name) and port*);
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
exactly as described above. Deny always wins.

#### Resources and prompts are granted too

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

### Server groups

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
[ADR-0010](docs/adr/0010-server-groups.md).

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

### Revoking access

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

### HTTP agents (`serve`)

Agents that speak streamable HTTP instead of stdio connect through the front:

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

#### One address for every server an agent has (the pool)

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
- **brings one ordinary per-server session up per granted server**, on the first
  `tools/list` and not before, so connecting costs nothing until the agent
  actually looks;
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
the registry, registered as stateless-only, or unable to complete the plane's
own handshake — it is simply absent, and the reason is journaled. The same goes
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

**Register pooled servers by an installed binary, not `npx -y …`.** A pool
starts its servers **in parallel**, on the agent's first `tools/list`, and each
gets 10 seconds from its start to answer the plane's handshake and the list.
On a small host several `npx -y` launches at once take longer than that (four
at once took ~14 s each on a 2-CPU VPS in the smoke), so those servers are
absent from the first list (journaled as `attach-refused`,
`handshake-failed`); parallel `npx -y` of one package into a cold cache can
also corrupt npm's own `_npx` cache. Install the server (`npm i -g
@scope/server`, or into your image) and register its binary:
`mcpcut server add memory --transport stdio --command mcp-server-memory`.
The per-server address is not affected — there the agent's client waits for
one process by itself.

An upstream registered with the stateless revision `2026-07-28` cannot join a
pool: the plane opens a handshake of its own to each server, and that revision
removed the handshake. Such a server works unchanged at its per-server address,
where the plane forwards the agent's handshake instead of conducting one.

`mcpcut show <sessionId> --kind pool` shows a pool session's own record — when it opened,
which servers attached (each with the child session id its decisions are under),
what changed, and when it closed.

#### From another machine: `mcpcut connect --url`

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
      "command": "mcpcut",
      "args": [
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

### What the vault protects against, and what it does not

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
trust boundary as the wrapped-process limitation noted above, and it is
stated here rather than glossed over. Rotate with `mcpcut vault rekey`
(re-encrypts every secret under a fresh key). Full threat model and the
reasoning behind the choice: `docs/adr/0003-vault-crypto.md`.

## Admin UI

`mcpcut approvals`/`quarantine`/`agent`/`server`/`vault` are all you need
in a terminal. The admin UI is the same state — the same file-backed stores —
behind a browser, for the moment that matters most: a `require-approval` call
is blocking an agent right now, and someone has to look at it and decide
before the agent's own timeout runs out. It is a second front onto the
control plane's stores, not a second source of truth; a resolution made in
the UI and a resolution made with `mcpcut approvals approve` race the
same way (first one wins, the other gets a clear "already resolved").

### Starting it

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
main M3 scenario (`connect`, stdio) never runs `serve` at all; if the queue
only had a UI when `serve` was up, that scenario would have no UI ever.

You normally never meet the first-run page: `mcpcut setup` and the first-run
wizard mint the first `owner` before `ui` ever starts and show that token once
in your terminal ([First run](#the-first-owner)). Only `setup --yes --no-admin`
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

### Admins and roles

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
way to read and act on it; the journal's tamper-evidence comes from M5's hash
chain, signed head and exported report, not from anything the UI does (see
Status,
above).

## Upgrade to M4.5 storage

M4.5 moved control-plane state and the journal off plain files and onto two
SQLite databases, `state.db` and `journal.db` (`docs/adr/0006-storage-sqlite.md`).
Upgrading an existing `~/.mcpcut/data/` install is **mandatory**, not
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
   mcpcut migrate
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
   those files. Point it at the CLI (`mcpcut approvals list --json`,
   `mcpcut export`) or the admin UI instead.

Nothing is deleted. The legacy `agents.json`, `admins.json`, `registry.json`,
`tool-inventory.json`, `approvals/`, and `*.jsonl` files stay on disk exactly
where they were, as a cold backup, but they are no longer read live. An
un-imported legacy journal file only becomes visible again by running
`migrate`; until then, `sessions` and `show` print a loud reminder on
stderr:

```
1 legacy *.jsonl session file(s) are not imported; run `mcpcut migrate` to see them.
```

A fresh install (no pre-M4.5 files at all) needs none of this — `state.db`
and `journal.db` are created on first write, same as the old files were.

## Backup & restore

```
mcpcut backup <destDir>
```

Copies `state.db` and `journal.db` (whichever exist) into `<destDir>` using
SQLite's own online backup, one file per database. It refuses to overwrite an
existing file at the destination rather than silently clobbering a previous
snapshot — pick a fresh directory (or timestamp it) per backup.

**Do not copy `state.db` on its own with `cp`.** Both databases run in WAL
mode: recent commits can still be sitting in a `-wal` sidecar file rather
than in `state.db` itself, so a plain file copy can miss data that a client
reading through SQLite would see. `mcpcut backup` folds the sidecar in
for you; that is the whole reason it exists instead of "copy the directory
and hope."

The rest of `~/.mcpcut/data/` is ordinary files and copies fine with `cp`,
`rsync`, or your usual backup tool: `vault.enc` and `vault.key` (copy both
together — one is useless without the other), `policy.json`, and any legacy
`*.jsonl`/`*.json` files left over from before an M4.5 upgrade.

To restore: stop every process using the journal directory (same first step
as the upgrade procedure above), put the backed-up files back in place, then
start `serve`/`ui`/`wrap`/`connect` again — the startup `PRAGMA
integrity_check` (see the CLI reference above) confirms the restored
databases are intact before anything else touches them.

## Audit reports

`mcpcut export --report` writes a self-contained snapshot of the
journal's decision history that a third party can check **offline** — with
nothing but the export directory and a public key, no access to this
installation, no database. This is the report format `journal/report.ts`
implements (`docs/adr/0007-evidentiary-journal.md`).

### Producing and handing over a report

```
mcpcut keygen
mcpcut export --report [--session <id>] [--out <dir>]
```

1. **`keygen`** generates this installation's Ed25519 signing key, once. It
   refuses to run if a key already exists (no `--force`; rotation is not
   built in M5) and prints the public key and its fingerprint — the private
   key is written straight to `signing.key` and never echoed. Skipping this
   step is fine: a report can still be produced without a key, but it comes
   out **UNSIGNED**.
2. **`export --report`** streams the in-scope records into a fresh directory
   and writes the manifest, summary and (if a key exists) the signature
   alongside them. `--session <id>` narrows the export to one session;
   omitted, it covers the whole journal. `--out` defaults to
   `./mcpcut-report` under the current directory and must be an empty
   or nonexistent directory — it refuses to write into one that already has
   files in it, rather than risk a half-overwritten export.

What you hand to the auditor is **the whole export directory, plus
`signing.pub`** (printed by `keygen`, also sitting in the journal directory).
The private key never leaves this host and is never part of the handoff.

### The four files

| File | Holds |
|---|---|
| `report.json` | The manifest: scope, record counts, chain state, the as-of contract text, and (if signed) the signing key's fingerprint. |
| `records.jsonl` | Every exported record, verbatim, one JSON object per line — the same `doc` bytes `journal.db` stores, never re-serialized or re-redacted. |
| `summary.md` | A human-readable rendering of the manifest, the pool sessions (which child session carried each server, for which agent), and a decision table with a `server` column — for reading without tooling. |
| `signature.json` | Present **only** when a signing key exists at export time. Its absence means the export is UNSIGNED — never "verified" by default. |

### Pool sessions in a report

An agent connected at the pool address (`/mcp`) is recorded as a **pool
session** of its own, and every server it reached as an ordinary per-server
**child** session — each decision is recorded by the child, under the bare
tool name the server published (the agent called it `<server>__<tool>`).
`summary.md` ties the two together: a "Pool sessions" section names each pool
session's agent, which child session each server attached as (twice, if it
left and came back), which servers did not attach and why, and what the pool
refused to pass on; each child's decision table says which server and pool
session it belongs to.

That section is attested by `summary.sha256` like the rest of the summary, but
`verify --report` does **not** recompute it — `report.json` is unchanged
(format v1), and the binding is read from the `kind:"pool"` records in
`records.jsonl`. An auditor can re-derive it independently:

```
jq -c 'select(.kind == "pool" and .payload.event == "attach")
       | {pool: .sessionId, server: .payload.serverName, child: .payload.childSessionId}' records.jsonl
```

`export --report` prints `Pool sessions: <n>`. Exporting a pool session alone
(`--session <pool session id>`) gives that session's own records only — its
decisions live in its children — so the command prints a `Note:` and the
summary names the child sessions the export leaves out. Export the whole
journal to include them.

### Checking a report offline

```
mcpcut verify --report <dir> [--pub <path>] [--require-signature]
```

`--pub` defaults to `<journal dir>/signing.pub`, which only matters if you're
checking your own export on the machine that produced it; an auditor on a
different machine always passes `--pub` explicitly, pointing at the file the
operator handed over. This command opens **no database** — it is rejected
outright if combined with `--session` or `--sign`, which belong to the
database-backed `verify` and would otherwise imply a check that never ran.

Seven checks run, in this order, every one of them reported explicitly
(never silently skipped):

1. **`records.jsonl` digest** — recomputes sha256 over the file's exact bytes
   and compares it with `report.json`'s `records.sha256`. Proves the record
   bytes in this directory are the exact bytes the manifest describes.
2. **`records.jsonl` line count** — compares the number of lines against
   `records.lineCount`. Proves no row was added or removed after export.
3. **`summary.md` digest** — the same check for the summary, which the
   manifest attests with its own `summary.sha256`. The summary is the one
   artifact a non-technical reader actually reads, so it is inside the
   integrity mechanism rather than beside it. (It is the one manifest field
   the summary itself cannot show: the digest is taken *of* the rendered
   summary, so the summary is written before that number exists. The summary
   says so in a line of its own.)
4. **Manifest self-consistency** — the manifest checked against itself:
   `records.lineCount` must agree with `counts.records`,
   `chain.verifiedAtExport` with `chain.break === null`, the `byOutcome`
   counts must sum to `counts.decisions`, and the remaining bounds must hold
   (`decisions <= records`, `unprovenanced <= decisions`, the `seqRange` span
   at least `counts.records`, `chain.head.seq` inside `seqRange`,
   `sessionIds` non-empty exactly when there are lines). v1 deliberately
   states several of those facts twice; this check turns that redundancy into
   a cross-check rather than leaving it as an ambiguity a careless edit could
   exploit.
5. **Claims recomputed from `records.jsonl`** — every number the manifest
   states that is derivable from the exported bytes is re-derived from those
   bytes and compared: `counts.records`, `counts.decisions`,
   `counts.byOutcome`, `counts.unparsableRows`, `counts.unprovenanced`,
   `sessionIds`, and whether the chain is `recomputable` at all. A signature
   proves only that the audited party authored the numbers; arithmetic over
   the exported records is the one class of claim an auditor can establish
   independently, so it is never taken on trust. `seqRange` is *not*
   derivable from the record bytes — the output says so rather than implying
   it was checked.
6. **Chain re-fold** — only when the manifest says `chain.recomputable`
   (whole-journal export, no pre-chain rows, no break, an attested head):
   re-folds the hash chain from `chain.startPrevHash` over every line of
   `records.jsonl`, in order, and compares the result with
   `chain.head.recordHash`. Proves the exported records really do chain
   together, byte for byte, into the head this report attests to. When the
   export is session-scoped (or otherwise not recomputable), this check is
   reported as **`[SKIPPED]`**, with the reason spelled out — it is not
   silently omitted, and the other six checks still run.
7. **Manifest signature** — verifies the ed25519 signature in
   `signature.json` against the supplied public key (after cross-checking
   that the manifest's `keyFingerprint`, the signature's own
   `keyFingerprint`, and the supplied key's fingerprint all agree). Proves
   the report was signed by the holder of this installation's private key;
   because the manifest commits to `records.sha256` and `summary.sha256`,
   this signature covers those files too. When `signature.json` is absent and
   the manifest claims no key, this check is reported as `[SKIPPED]` and the
   whole export is banner-printed **UNSIGNED** — not quietly dropped. When
   the manifest *does* name a
   key and `signature.json` is absent, that is a **failure**, not an unsigned
   export: the signature was removed, or the export never finished.

No check is suppressed because a *different* file is unreadable — a
truncated `signature.json` still leaves the byte, count and chain checks to
run and report. Only an unreadable or unparsable `report.json`
short-circuits, because then there is nothing to check anything against.

`--require-signature` turns an export that is not provably attributable —
unsigned, or signed by a key that cannot be checked here — into a failed
check. Without it, an unsigned bundle with internally consistent bytes exits
`0` and prints UNSIGNED, which a scripted `verify --report && accept`
pipeline never sees. Any auditor script that treats a clean exit as
acceptance should pass this flag.

### Exit codes

An auditor is expected to script against these, so they are exact:

- **`0`** — every check that applied passed. An unsigned export with intact
  bytes exits `0`, printed as **UNSIGNED** — never as verified-and-signed.
- **`1`** — could not run: a missing export directory, a `report.json` that
  is not there or that this build cannot read (including an unsupported
  `formatVersion`), or a signature present with no public key available to
  check it against. This is a failure to examine the report, not a finding
  about it.
- **`2`** — a check **failed**: a digest mismatch, a line-count mismatch, a
  recomputed count that disagrees with the manifest, a chain re-fold
  mismatch, a bad signature/fingerprint — or the **absence of a file the
  manifest positively attests**. A missing `records.jsonl` or `summary.md`
  is not "could not run": the manifest names it with a digest, so its
  absence is evidence the bundle was stripped, and an auditor's
  `verify --report || alert` must not read deletion of the evidence file as
  "retry later". `2` always wins over `1` when both apply — a missing public
  key must never downgrade a digest mismatch the byte checks already found,
  or a script that escalates on `2` and defers on `1` would never fire the
  alert.

### The out-of-band anchor

Signing a report proves it came from the holder of this installation's key.
It does **not** prove the host itself was never tampered with: a process
running under the same OS user that wrote the journal can rewrite the hash
chain end to end and re-sign it with that same key, and the result is
indistinguishable from an untouched one. The only thing that makes that
detectable is an anchor recorded **somewhere this host cannot also rewrite**.

```
mcpcut verify --sign
```

This is a separate command from `export --report` — it signs the journal's
*current chain head* (not a report) and prints an anchor block (`seq`,
`recordHash`, `signedAt`, `keyFingerprint`, signature). Record that anchor
outside this host — a ticket, a printout, a separate system the operator
does not also control — every time you take one. Later, compare a new
anchor (or a new report's `chain.head`) against a previously recorded one
for the same `seq`: an intact chain always reproduces the same
`recordHash` at a given `seq`, so a rewritten-and-re-signed chain is
exposed the moment its head is checked against a value that was written
down before the rewrite happened. Without a prior anchor kept out of band,
there is nothing to compare against, and "verified" means only "internally
consistent as exported" — never "was never rewritten."

### Honest limits

- **Same-uid rewrite is not detectable from the report alone.** See the
  anchor procedure above — this is the one gap nothing offline can close.
- **An unsigned export is UNSIGNED, not verified.** `verify --report` still
  runs and can still exit `0` on an unsigned export's byte checks, but it is
  reported as UNSIGNED throughout: anyone could have produced bytes that
  look internally consistent, and only a valid signature ties an export to
  a specific installation's key.
- **A session-scoped export cannot have its chain re-derived offline.** The
  stored hash chain runs over the *whole* journal's write order;
  `export --report --session <id>` exports only that session's rows in that
  session's own order, so folding them can never reproduce the attested
  chain head. `verify --report` reports the chain-refold check as SKIPPED
  and names every reason why — it does not pretend the check ran.
- **A pool session exported alone carries none of its decisions.** They
  are recorded by its child sessions, which `--session <pool>` does not
  include; the export says so (`Note:` on stdout, "Not in this export" in
  `summary.md`). Export the whole journal for the full picture.
- **A child session exported alone does not say it belonged to a pool.** The
  binding lives in the pool session's own records, which `--session <child>`
  does not include, so that summary reads like any per-server session's
  (bare tool names, no pool note). Export the whole journal to see which pool
  and agent a child served.
- **The report is history, not a statement of anyone's current rights.** It
  attests to what happened as of the `asOf` instant in `report.json`. A
  grant that was valid when a decision was made may have been revoked
  since; the report will still, correctly, show the decision made under it.
  Current authority is resolved elsewhere — the report is built to compose
  with that resolution, not replace it. (Full wording: `report.json`'s
  `contract` field and the `mcpcut verify --report` output both carry
  it verbatim.)
- **A report holds journal content, and inherits the journal's
  confidentiality.** The export directory is created at mode `0700` and
  every file in it at `0600` — same as the rest of `~/.mcpcut/data/`. Tool
  arguments and server responses land in `records.jsonl` exactly as the
  journal held them: secrets are redacted at write time, but personal or
  otherwise sensitive data is not (see "redaction is not anonymization,"
  above). Handle an exported report directory with the same care as the
  journal itself.

## Retention

Nothing deletes journal records on its own. There is no default retention
period, no timer, and no configuration that enables one — the only thing that
removes a record is an operator running:

```
mcpcut prune --older-than <duration>               # says what it would delete
mcpcut prune --older-than <duration> --yes         # actually deletes it
```

The deleting form requires `MCP_ADMIN_TOKEN` — the personal token of an admin
whose role is `owner`. This is the only command in the product that destroys
evidence, so an operator who can resolve approvals should not thereby be able
to delete the record of having done so. The delete is written to the journal
as an `access-edit` record (`action: 'prune'`) naming the admin, the window
and the count, alongside the retention marker itself. The dry run needs no
token and records nothing — it deletes nothing.

`keygen`, `backup`, `migrate` and `verify --sign` are **not** gated: each is
needed before an install has any admin at all, and each runs from cron. When
a valid `MCP_ADMIN_TOKEN` happens to be set, they record who ran them (the
destination for a backup, the key fingerprint for `keygen` and
`verify --sign`); with no token they behave exactly as before. A token that
matches no active admin is refused rather than ignored.

`<duration>` is a whole number of hours or days (`36h`, `90d`). Without
`--yes` the command prints the record count, the `seq` range and the chain
head of the prefix it would remove, and stops. There is no undo, and the
deleted records exist nowhere else unless you exported them first
(`export --report`).

**Why deleting is a prefix, not a filter.** A record's `ts` is its own
timestamp and does not have to rise with its `seq` — an imported legacy
session or a clock step can put an old record behind a newer one. Deleting
"every record older than X" would then punch a hole in the middle of the hash
chain, and a hole is unrepairable: nothing after it can be re-anchored to
anything. So `prune` removes only the contiguous *leading run* of records that
are all older than the cutoff, and an old record sitting behind a newer one
survives. (The cutoff itself is exclusive: a record stamped exactly at the
boundary is not older than it, and stays.)

**The retention marker.** The delete and the marker are one transaction. The
marker records the `seq` it pruned through, the `record_hash` of the last
deleted record, when it happened, and — if a signing key exists — an ed25519
signature over that head. Everything afterwards hangs off it:

- `verify` starts its walk from the marker's head instead of from genesis, so
  the surviving records still verify. Without the marker, pruning would look
  exactly like tampering, and an operator who prunes would learn to ignore the
  one signal the chain exists to give.
- the next record written chains onto the marker's head, so a journal that was
  pruned empty continues the old chain rather than silently restarting a fresh
  one.
- `verify` prints the marker before its own result, and `export --report`
  carries it as `chain.prunedThroughSeq` in the manifest and a line in
  `summary.md` — an auditor is told that records were deleted, rather than
  being handed a report that starts at seq 4,001 with no explanation.

**What a marker is worth.** It is this host's own statement about what it
deleted, written by the same OS user that could instead have deleted records
and recorded nothing at all. A signature proves the statement came from the
holder of this installation's key — not that the statement is complete. The
thing that makes it checkable is an anchor recorded **out of band before the
prune** (`verify --sign`, or a previous report's `chain.head`): compare it
against what the journal claims afterwards. Take one before you prune.

## Wiring into `.mcp.json`

An agent the plane manages needs no hand wiring: `agent create` prints its
block, ready to paste — see [Onboarding an agent](#onboarding-an-agent). What
follows is for wrapping a server of your own, outside the registry.

Wrap a real server by replacing its `command`/`args` with `mcpcut wrap --`
followed by the original command:

```json
{
  "mcpServers": {
    "some-server": {
      "command": "mcpcut",
      "args": ["wrap", "--", "npx", "-y", "@some/mcp-server"]
    }
  }
}
```

Environment variables configured for the server pass through to the wrapped
process unchanged. Secrets (tokens, API keys, passwords, bearer/basic auth
headers, etc.) are redacted before anything reaches the journal — they are
never written to disk.

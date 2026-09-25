# Services, Docker and backups

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

Service logs are **not rotated**. They
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
[`docs/deploy/README.md`](../deploy/README.md). The one prerequisite:
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
([The console](console.md)); being inside the container is the proof of
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
together — one is useless without the other) and `policy.json`.

To restore: stop every process using the data directory — `serve`, `ui`,
any live `wrap`/`connect` session, and any script that polls it — put the
backed-up files back in place, then start `serve`/`ui`/`wrap`/`connect`
again — the startup `PRAGMA integrity_check` (see the
[CLI reference](cli.md)) confirms the restored
databases are intact before anything else touches them.

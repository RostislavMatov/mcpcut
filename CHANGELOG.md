# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-09-24

First public release, under the Apache License 2.0; published to npm as
`mcpcut@0.1.0`. The first list sums up what the release contains; the entries
after it record what changed between the internal cut of 2026-09-03 and this
publication — several are security fixes, so they are kept.

### Added

- **Journaling proxy** for stdio MCP servers (`wrap`): byte-identical
  passthrough, secret-redacted journal in SQLite (`journal.db`).
- **Policies**: allow / deny / require-approval per tool, read/write/destructive
  classification, quarantine of new and changed tools with a structural
  `inputSchema` diff, fail-closed enforcement, `tools/list` filtering.
- **Registry, agents, vault**: MCP server registry, AES-256-GCM credential
  vault with `vault:` references, agent identities with per-server grants
  (tools, resources, prompts), server groups with per-server override
  semantics, streamable-HTTP front (`serve`) supporting both session models.
- **Admin UI** (no dependencies, works without JavaScript): approval queue with
  live updates, quarantine review, grant matrix, registry with live server
  status, journal with search and filters; named admins with `owner` /
  `operator` / `viewer` roles; policy rules editable from the server card
  with hot reload.
- **Evidentiary journal**: sha256 hash chain, Ed25519-signed chain head,
  `export --report` and offline `verify --report`, explicit retention pruning
  with a signed marker. The journal is tamper-evident **with an external
  anchor**.
- **Security audit** of the whole product before release
  (`docs/security-audit-2026-09.md`): 0 critical, 4 high findings, all fixed
  in the same wave.
- **Terminal console and services** (`mcpcut`): a first-run wizard, `ui` and
  `serve` as detached services (`start` / `stop` / `status` / `logs`), and the
  whole plane from a terminal, without a browser.
- **First owner from the browser or the console**: `/setup` with a one-time
  code from a file, or the console's first-owner screen; starting a service no
  longer mints a token.
- **Remote console** (`mcpcut --remote`, *preview*): the console as a client of
  a service on another host, over HTTPS with a personal admin token.
- **One address per agent** (the pool, `/mcp`), the `connect --url` bridge
  (*preview*) and a ready-made client block at `agent create` that runs the
  bridge through `npx`, pinned to the service's own version.
- **Resident stdio servers**: every stdio server an agent is granted stays
  running for it, with bounded, spaced restarts.

- **stdio servers granted to an agent keep running.** `serve` starts every
  stdio server an agent is granted (personally or through a group) in the
  background — at the grant, or when `serve` starts — at most two at once and
  never two of one command line together, and the agent's pool attaches to
  the running server, so its first `tools/list` answers at once. It is
  restarted after a pause if it dies (given up after five failed starts in a
  row), restarted when its registry record or a vault secret it uses changes,
  stopped within ~5 s of the grant going, and never handed to another agent.
  Up to 32 (agent, server) pairs; past that a server starts on demand and stays
  warm 10 minutes after its agent leaves, yielding its slot first when the
  service runs short. `serve.log` shows each start, restart and stop; pool
  `attach` records carry `lifetime` (`pool`, `warm`, `resident`). ADR-0016.
- **Servers of the stateless revision `2026-07-28` join a pool**, stdio and
  HTTP, next to older ones: the plane tries its handshake first and asks
  `server/discover` when it is refused, then stamps every frame to such a
  member with the `_meta` the revision requires (`clientCapabilities: {}` in
  the plane's own name). A member's 4xx error body is an answer, not the end of
  it; a result that is not finished (`input_required`) reaches the agent as
  `-32007`. The status probe speaks both revisions too, so `/servers` shows
  such a server `alive via tools/list`.
- **A child session exported alone names its pool.** `export --report
  --session <child>` adds "Pool membership of session … (from records outside
  this export)" to `summary.md` — each pool session that attached it, with its
  agent, server and time — read from the same snapshot and marked as not
  covered by the export's digest or chain; stdout prints only a count.
  `report.json` stays v1. A server kept running across many connections reads
  as "attached by N pool sessions", not as a forgery.

- **`setup --ui-public-url <url>` / `--serve-public-url <url>`**: state the
  address you will reach the service at (`http://<ip>:8091`,
  `https://mcp.example.com`) and `setup` derives the rest — the `Host`
  allow-list entry, for the UI the `Origin` entry, `behindTls` for `https`,
  and for plain `http` to a public address over a loopback bind, the bind.
  Until now an install opened by IP answered 403 until `--allowed-host` was
  found, and then opened pages whose every form was a 403 until
  `--allowed-origin` was found too. Also the wizard's optional `UI URL` /
  `Agent URL` fields and Docker's `MCPCUT_UI_PUBLIC_URL` /
  `MCPCUT_SERVE_PUBLIC_URL`. Plain `http` to a public address is a loud
  warning in the transcript, not a refusal.

- **The console creates the first owner too.** Opened over an install with no
  admin, `mcpcut` shows a first-owner screen instead of a sign-in nobody holds
  a token for: a name, then `admin add <name> --role owner` run without a
  session (the CLI accepts that only while the store is empty), the token held
  on screen until `y` — `q` asks first — and a sign-in with it. No setup code
  is asked: the console runs under the account that owns the data directory.

- **First-run wizard**: a bare `mcpcut` on a terminal with no install config,
  and `mcpcut setup` without `--yes`, open an interactive setup — prefilled data
  directory, `ui`/`serve` binds, the first admin's name and who starts the
  services; a non-loopback bind asks for confirmation before anything is
  written; the wizard then deploys step by step (the same `setup --yes …`, then
  `start ui`, `start serve`) with a live progress ladder, reports that the
  services run in the background, shows the one-time owner token once and,
  after you confirm you saved it, hands over to the sign-in screen. Over a data directory that already has admins the final screen says so and points at `admin rotate <name> --recover` instead of showing a token. `setup`
  without `--yes` outside a terminal refuses with a hint.
- **Interactive console** (`mcpcut tui`, or a bare `mcpcut` on a terminal that
  has an install config): sign in with an admin token and work the whole
  catalogue from eleven sections — Home, Admins, Servers, Vault, Agents,
  Groups, Policy, Quarantine, Approvals, Journal, Audit — each action a form
  that runs the same CLI command it shows you; the session token travels in
  the environment seam, never in argv; a vault secret goes from the form to
  the command's stdin and appears in no argv, frame or model; `export` writes
  its JSONL to a file you name (created exclusively, mode 0600) and the pane
  shows a one-line receipt; wide output scrolls sideways with `[`/`]`. A bare
  `mcpcut` in a pipe still prints the usage; without a config on a terminal it
  points at `setup --yes`.
- **Console: Services section** (`status · start · stop · logs · setup`) as
  data over the same `start|stop|status|logs` commands; `setup` leaves the
  console and reopens the wizard in a child process on the same terminal.
  Under `supervisor: external` (Docker, systemd, launchd) `start`/`stop` are
  not offered, `mcpcut status` names the external supervisor in its detail,
  and the header draws such a service `◉` — answering, but not our pid.
- **Console: live Approvals queue** — the section re-reads `approvals list`
  every 3 s while you are on its action list, counted from the previous
  answer, without blocking the keyboard; a poll never overwrites the output of
  another command that failed, and an answer that arrives after you left the
  section is dropped.
- **Console: one-time token hold** — the output of `admin add`, `admin rotate`
  and `agent create` stays on screen under a banner until you press `y` to say
  you saved the token; `q` asks first; `Ctrl-C` still quits at once.
- **Console: services banner on the sign-in screen** — the screen asks
  `status --json` (without a session) and shows `services: ui ● … · serve ○ …`
  with a hint to start them from Services; nothing starts on its own.
- **Console: stacked layout below 60 columns** — the action list becomes a
  strip on top and the output pane takes the full width beneath it; the list
  keeps the active action in view in both layouts; `resize` switches on the
  fly.
- **Console: `NO_COLOR` and `TERM=dumb`** — a non-empty `NO_COLOR`, or
  `TERM=dumb`, turns every colour/weight escape sequence off (the alternate
  screen stays: a terminal without cursor movement cannot run the console).
- **Console: full-width `?` help** — the help covers the whole body in both
  layouts; a line too wide for the terminal wraps as "keys, then the
  description indented"; any key closes it.
- **Console: keys pressed during a command are queued** (up to 32) and
  replayed in order once the command answers — unless the answer is a
  one-time token, in which case the queue is dropped so nothing acknowledges
  the token unread. The queue is also dropped when the session is lost and on
  quit; `Ctrl-C` is never queued.
- **Wizard step counter** — the «Starting ui»/«Starting serve» steps count
  `waiting for the service to answer (N s of up to 15 s)` once a second.
- **Unit-file examples** for systemd (user units) and launchd in
  `docs/deploy/`, with install steps in `docs/deploy/README.md`; they are
  examples to adapt, not something `mcpcut` installs. README gained «First
  run», «Services» and «Docker» sections.
- **Install config** `~/.mcpcut/config.json` (path overridable with
  `MCPCUT_CONFIG`): the data directory and the `ui` / `serve` bindings, resolved
  at process start with the priority **flag > environment variable > config >
  default**. `MCPCUT_DATA_DIR` overrides the data directory without a config
  file; with neither, the directory is `$HOME/.mcpcut/data`. A
  config that cannot be read or does not validate makes every command except
  `--help` and `setup` refuse, naming the file and the problems.
- **`setup --yes`**: non-interactive install — writes the config, prepares the
  data directory, runs the checks (directory, bindings, databases, policy,
  network exposure), initialises the vault and the signing key, and mints the
  first `owner` admin before the first `ui` start, so the one-time token never
  lands in a daemon log. Flags are overlaid on the config a previous run wrote,
  so a rerun keeps what it was not asked about; `--no-behind-tls` is how the
  `--behind-tls` claim is taken back without hand-editing the file.
- **`start` / `stop` / `status` / `logs`**: `ui` and `serve` run as detached
  services that survive the terminal, with pid and log files under
  `<data dir>/run/`. `status` reports `running` only when the pid is alive
  **and** the service answers on its port. `run/` and the files in it stay
  owner-only: a start refuses otherwise, and `setup` reports the same condition
  as a `run dir` row in its preflight.
- **`MCPCUT_DATA_DIR` must be an absolute path**, and it is honoured by every
  command including the service ones. `setup --yes` refuses when the exported
  value and the data directory it would write disagree, rather than preparing
  one directory while the daemons serve another.
- **`mcpcut status` warns about a network-reachable bind** — for every
  service bound to anything but loopback it writes
  `<service>: warning: <detail>` to stderr, the same finding and ADR-0004
  pointer `setup` prints; stdout and the exit code are unchanged, and a
  stopped service is warned about too. `status --json` writes nothing to
  stderr and instead adds `"exposure": {"level": "warn", "detail": …}` to the
  exposed service's object; a loopback install's JSON is unchanged. In the
  console the warning shows in the panel under `— stderr —`.
- **`probeHost` per service** (`ui.probeHost`, `serve.probeHost`; flags
  `setup --ui-probe-host H` / `--serve-probe-host H`, kept by a rerun without
  them) — the address `status` dials for a service with no pid file, so under
  compose each container sees its neighbour instead of reporting it
  `stopped`. `docker-compose.yml` sets `MCPCUT_UI_PROBE_HOST=ui` and
  `MCPCUT_SERVE_PROBE_HOST=serve`; the entrypoint passes the flags only when
  those are set. The bind in `status` is unchanged and the detail names the
  dialled address. Existing compose installs: `docker compose run --rm ui
  setup --yes --ui-probe-host ui --serve-probe-host serve`, then restart. The
  UI probe now sends `Host: localhost:<port>` so it passes the UI's `Host`
  screening under a wildcard bind. Under `supervisor: external` the console's
  Home no longer suggests `Services ▸ start`.

### Changed

- **A pool waits up to 40 s for a server to start** (spawn and handshake
  together), separately from the 10 s list budget; servers start at once, so
  five wait as long as the slowest. One that dies during its start is given up
  on immediately. `attach-refused` says which: `start-timeout`,
  `ended-during-start`, `handshake-failed` or `start-failed`.
- **A withdrawn grant always leaves the pool as `ungranted`**, whichever of the
  two watches notices first (it read `child-ended` about a third of the time).

- **Audit reports name the pool sessions.** `summary.md` gains a "Pool
  sessions" section: for each pool session, its agent, which child session each
  server attached as (a server that left and came back appears twice), which
  servers did not attach and why, which left and why, and how many frames the
  pool refused by reason. Each child session's decision table is headed with
  its server and pool session, and every decision table gains a `server` column
  (the agent called `<server>__<tool>`; the record keeps the bare tool name).
  `export --report` prints `Pool sessions: <n>`, and a `--session` export of a
  pool session prints a `Note:` naming how many child sessions — where its
  decisions are — it leaves out. `report.json` is unchanged (format v1),
  `verify --report` runs the same seven checks, and the binding stays
  re-derivable from the `kind:"pool"` records in `records.jsonl` (README gives
  the `jq` line). ADR-0015 phase 5 amendment; ADR-0007 note on `summary.md`.
- **The server card marks tools whose pool name is too long.** On `/servers`, a
  tool whose `<server>__<tool>` exceeds 64 characters is marked `not in pool ·
  <length>` (it is left out of every agent pool and stays reachable at the
  per-server address) and the card's tools row counts them; past 47 it is
  marked `long pool name · <length>`. The thresholds are the pool's own.
- **An example of TLS in front of `serve` on a VPS** (`docs/deploy/caddy/`): a
  `Caddyfile` and a compose override — Caddy with a Let's Encrypt certificate,
  the UI left on host loopback — exactly the stand the pool's live smoke ran
  (`docs/smoke-agent-pool.md`: official SDK v1/v2, Inspector CLI and Claude Code
  headless through `connect --url` against a VPS). README now advises
  registering pooled servers by an installed binary rather than `npx -y`: a
  pool starts them in parallel, and several cold `npx` launches on a small host
  exceed the 10-second start budget.
- **`agent create` prints the agent's client config; `agent config <name>` prints it again with `<token>`.**
  Right under the one-time token, `agent create` — CLI, web console and
  console alike, the remote console included — now shows the whole
  `mcpServers` block to paste into the agent's client: one `mcpcut` entry that
  runs `mcpcut connect --url <address>` with the token in
  `env.MCP_AGENT_TOKEN` (never in `args`). The address is the new
  `serve.publicUrl`; without one it is the loopback address of the `serve`
  bind, with a note saying it only works on this machine. `--allow-http` is in
  the block exactly when the bridge would refuse the address without it (the
  same function decides both). Until the package is on npm the block runs the
  installed `mcpcut` binary. `agent config <name> [--http]` needs no admin
  token — the block without the token is not a secret — and `--http` prints the
  form for clients that speak HTTP natively (`url` with the pool path and an
  `Authorization: Bearer` header). The web page `create` answers with shows
  both forms and, if the `agent.create` journal record was lost, says so; every
  agent card on `/agents` has the `<token>` block in a drawer. The token still
  appears in exactly one place per surface: `agent create`'s stdout and the web
  response to the create. ADR-0015, phase 4 amendment (C1–C6).
- **One address per agent, and the service decides what is behind it: `POST|GET|DELETE /mcp`.**
  An agent that connects to this single address sees the tools of **every**
  server it was granted, named `<server>__<tool>`, and gets new ones without a
  config edit or a restart on its machine. Behind the address the plane answers
  `initialize` itself, brings one ordinary per-server session up per granted
  server on the first `tools/list` (not before), merges their catalogs, strips
  the prefix from a call and hands the frame to that server's session. Policy,
  quarantine, approvals, provenance and the shape of a decision record are
  unchanged — they are simply created N times, and every decision still records
  the **bare** tool name, so a pooled call and a per-server call are
  indistinguishable in the journal. The per-server addresses
  (`/agents/<agent>/servers/<server>`) are untouched and keep working in the
  same process.

  A grant added or withdrawn while the agent is connected reaches it:
  `notifications/tools/list_changed` goes out and the next list reflects it. A
  withdrawn server leaves the pool while the session lives on, and any call in
  flight at it gets exactly one answer (`-32005`). A server that will not come
  up — unknown, protocol-mismatched, or one that will not complete the plane's
  own handshake — is simply absent: the pool opens without it rather than
  refusing, and the fact is journaled. Likewise a server that answers a
  catalog fan-out too slowly is detached rather than allowed to hold up
  everyone else's list.

  The new `kind: 'pool'` journal record binds one pool session to the child
  sessions underneath it (`open`, `attach`, `attach-refused`, `detach`,
  `members-changed`, `dropped`, `close`), which is what ties a pooled call to
  the per-server decision it produced. `mcpcut show <sessionId> --kind pool`
  reads them.

  Limits and refusals worth knowing: a pool serves tools and prompts only
  (anything else is `-32601`); it issues no cursor, so one in a request is
  `-32602`; an upstream's unsolicited request to the agent is dropped, because
  the plane declares no client capabilities to any of them; a pool holds at
  most 32 children, and those children count against the process-wide session
  ceiling. ADR-0015 and its 2026-09-22 amendment.
- **An agent on another machine connects with one command: `mcpcut connect
  --url <address>`.** The remote form of `connect` is pure transport between
  this machine's stdio and a `serve` front on another host — it reads no
  registry, no vault and no install config, so the machine it runs on needs no
  `setup` and no data directory, and it routes ahead of the broken-config gate
  like `--remote` does. The address is the service's base URL (the agent pool
  endpoint is appended) or the full `/agents/<agent>/servers/<server>` address
  of one pair. The token comes from `MCP_AGENT_TOKEN` and nowhere else: a token
  anywhere in `argv` is refused before anything is parsed or dialed. Plain
  `http` to a non-loopback host is a **refusal**, taken back only by an
  explicit `--allow-http` (which then warns once) — unlike the console's
  `--remote`, because an agent token crosses that network on every request.
  Exit codes: 0 when the client hangs up, 1 for anything refused before or
  instead of a session (401, 403, 404 included), 4 when the session itself was
  lost, which tells a client to start a fresh bridge. A network blip is none of
  those — the request it hit gets a JSON-RPC `-32004` back and the bridge keeps
  running. ADR-0015; README "From another machine: `mcpcut connect --url`".
- **A runtime below Node 24 gets one line instead of a missing builtin.** Every
  command now prints `mcpcut needs Node 24 or newer (this is vX)` and exits 1,
  ahead of the import that used to fail with `ERR_UNKNOWN_BUILTIN_MODULE:
  node:sqlite` and a stack. This matters now that `connect --url` runs the
  binary on machines nobody installed it on.
- **A bare `mcpcut` on a machine with no install asks what to do**: "Set up a
  service on this machine" (the first-run wizard, unchanged; `mcpcut setup`
  still opens it directly) or "Connect to a service on another host" (host,
  port, protocol; the address is checked before the form is left). Connecting
  installs nothing locally. The last address connected to from the form is
  remembered in `~/.mcpcut/remote.json` (0600, the address only — never a
  token): the next bare `mcpcut` goes straight to that service, or, if it
  does not answer, to the connect form with the address filled in.
  **Home ▸ disconnect** and `Ctrl-D` on the remote sign-in screen forget it
  and open the form for another service; `mcpcut --connect [url]` opens that
  form from the shell. A machine with a local install still opens its local
  console. While connected, the header shows `@ host:port`.
- **A console for a service on another host: `mcpcut --remote <url>`** (or
  `MCPCUT_REMOTE`). The client needs only the package — no `setup`, no data
  directory. It talks to four new routes on the admin UI's port,
  `/api/console/state|whoami|setup|run`: the admin's own token as
  `Authorization: Bearer` on every request (no cookie, no server-side console
  session), any request carrying `Origin` refused, the same Host validation
  and the same brute-force limits as `/login`. `run` executes an allow-listed
  command inside the `ui` process and streams its output as NDJSON; exports
  are written on the client. Over a network a role floor applies on top of
  each command's own gate (`vault`, `keygen`, `backup`, `migrate`, `verify`,
  `prune`, `start`, `stop`, `logs`, `export --report` — `owner`; streamed
  `export` and every `policy` form but a bare `policy show` — `operator`);
  vault writes are refused unless `ui` is behind TLS or the caller is on
  loopback; the first owner is created with the setup code, as on `/setup`.
  Plain `http` to a non-loopback host is a loud warning, not a refusal.
  ADR-0014; README "A console for a service on another host".

- **`setup --serve-public-url` now remembers the address** as `serve.publicUrl`
  in `~/.mcpcut/config.json` (an origin: scheme, host, optional port — no
  path). It still adds the `Host` allow-list entry and, for plain `http`, opens
  the bind as before; a rerun without the flag keeps the field, a rerun with
  another address replaces it. The wizard's `Agent URL` opens with it, and in
  Docker `MCPCUT_SERVE_PUBLIC_URL` lands there too. `ui.publicUrl` is not
  stored — nothing reads it.
- **The Docker image no longer mints an owner, and no token reaches
  `docker compose logs`.** The entrypoint runs `setup … --no-admin`;
  `MCPCUT_ADMIN` is gone. Create the first owner with
  `docker compose exec -it ui mcpcut` (the console asks for a name and shows
  the token once, no code, no browser), unattended with
  `docker compose exec ui mcpcut admin add <name> --role owner`, or in a
  browser on `/setup` with the code from
  `docker compose exec ui cat /home/node/.mcpcut/data/setup-code`. Until then
  the published port claims nothing. An existing volume is unaffected: its
  config and its admins are already there.
- **The first owner can be created in the browser.** A `ui` start over a store
  with no admins no longer mints an `owner` by itself. It writes a one-time
  setup code to `<data dir>/setup-code` (mode 0600; stderr names the path,
  never the code) and serves a first-run page at `/setup`, to which every page
  — `/login` included — redirects while the install has no admin. The page
  takes the code and the **name** you choose, creates the owner, shows its
  token once and signs you in with one press; after that `/setup` answers with
  a redirect to `/login`. The code proves its bearer can read the data
  directory and is dead once any admin exists. `<data dir>/bootstrap-token`
  is gone, and so is the console's sign-in line that named it. Installs made with `setup` or the
  wizard already have an owner and never see the page.
  The creation is journalled as `access-edit` `admin.add` via `ui` with an
  empty actor (ADR-0004, amendment of 2026-09-19).

- **One name: `mcpcut`.** The working name `mcp-journal` is gone from the
  product (ADR-0013). The package and its only `bin` entry are `mcpcut`; the
  default data directory is `~/.mcpcut/data`, next to the install config in
  `~/.mcpcut/`; the environment overrides are `MCPCUT_DATA_DIR` and
  `MCPCUT_POLICY`; the project-level policy file is
  `<cwd>/.mcpcut-project/policy.json` — deliberately not `.mcpcut`, so a command
  run from `$HOME` cannot mistake the install directory for a project;
  `export --report` defaults to `./mcpcut-report`; the vault's AAD label is
  `mcpcut-vault:v<N>`. Nothing reads the old names: a pre-release store under
  `~/.mcp-journal` is opened by pointing `dataDir` (or `MCPCUT_DATA_DIR`) at
  it, and its vault secrets have to be set again, because the AAD label is
  part of what AES-GCM authenticates.

- **`quarantine approve|reject` now need a personal admin token** of role
  `operator` or `owner` in `MCP_ADMIN_TOKEN` — the same bar the admin UI's own
  `POST /quarantine/approve|reject` applies — and every release writes an
  `access-edit` journal record (`quarantine.approve` / `quarantine.reject`)
  naming the admin, the server and the tool. `approve --all` writes one record
  per tool it releases. `quarantine list|show` are unchanged and need no token.
  The web UI now writes the same record for its own releases, so a decision
  made in a browser and one made in a terminal are indistinguishable in form.
- **`prune --older-than <dur> --yes` now needs a personal admin token** of role
  `owner`, and the delete is recorded as an `access-edit` (`action: 'prune'`)
  naming the admin, the retention window and the count. The retention marker
  itself is unchanged, so existing signed markers and `verify --report` are
  unaffected. The dry run (without `--yes`) still needs no token and records
  nothing.
- **`keygen`, `backup`, `migrate` and `verify --sign` record who ran them** when
  a valid `MCP_ADMIN_TOKEN` is present (`access-edit` with the destination or
  the key fingerprint). They stay **ungated** — each is needed before an install
  has an admin, and from cron — and with no token behave exactly as before. A
  token that matches no active admin is now refused rather than silently
  ignored.
- **Docker**: the image's entrypoint runs `setup --yes --supervisor external`
  on the first start of `ui`/`serve` (binds from `MCPCUT_UI_HOST`/`_PORT`,
  `MCPCUT_SERVE_HOST`/`_PORT`; owner token in `docker compose logs ui`), the
  install config and the data share one volume (`mcpcut`, at `~/.mcpcut`), `serve` starts after
  `ui` is healthy, and `mcpcut` is on the image's `PATH` —
  `docker compose exec -it ui mcpcut` opens the console.
- `start`/`stop`/`logs` without an install config now point at `mcpcut` (the
  interactive setup) as well as `setup --yes`.
- **Console running footer** now says `running… · keys are queued until it
  finishes · Ctrl-C aborts` (was «keys are ignored»); the short token-hold
  banner (`One-time token on screen: copy it, then press y.`) is used whenever
  the long one would wrap to more than two lines.
- **`setup --yes --no-admin` warning** now names the file the first `ui`
  start will write (`<data dir>/setup-code`, mode 0600 — the one-time code the
  `/setup` first-run page asks for, deleted once the owner exists) instead of
  `run/ui.log`.
- **`admin add|list|rotate|role|remove` now need a personal admin token** of role
  `owner` in `MCP_ADMIN_TOKEN`, and every mutation writes an `access-edit`
  journal record (`admin.add|rotate|role|remove`) naming the admin who made it —
  the same treatment `vault *`, `agent *` and `group *` already had. The web
  UI's admin page writes the same record. Two deliberate exceptions: on an
  empty plane (no admins yet) `admin add` and `admin list` need no token, and
  `admin rotate <name> --recover` mints a fresh token without one — the way back
  in for an owner who lost theirs; the record then carries `recovery: true` and
  no admin name, so an auditor can tell it apart. Scripts that ran `admin add`
  after the first admin must export the owner token first.
- **Console: the active section tab is marked `▸`** in every style —
  including `NO_COLOR` and `TERM=dumb`, where inversion alone left it
  unmarked. Each tab label carries a one-column mark and tabs are separated by
  one space, so the tab bar is one column wider than before for the same tabs.

- **A refused web sign-in is a page again, not a JSON blob.** `POST /login`
  answered a browser with a bare `{"error":"unauthorized"}`, leaving nothing to
  press but the back button. It now re-renders `/login` with the error the
  console has always shown — *Token not recognised: it may have been rotated,
  or the admin removed.* — and keeps the 401, the byte-identical answer for an
  unknown, rotated and revoked token, and the JSON body for non-browser
  callers. A refusal for rate limiting or a full session pool says so the same
  way, still as a 429.
- **Signing in takes about a second, not five and a half.** The login page's
  animation held the POST for its whole 5.5-second choreography on every
  sign-in, error or not; it is now played into a one-second budget.
  `prefers-reduced-motion: reduce` skips it entirely, as before.
- **`serve` answers `403`, not `400`, to an authenticated agent with no grant**
  for the server it addressed. The body is unchanged (`{"error":"no-grant"}`),
  and every other refusal keeps its status: 404 for a server the registry does
  not hold, 401 without a usable token, 400 for the session-model mismatch and
  the vault refusals — those are statements about the request, this one was
  about the caller.
- **A denied `resources/*` / `prompts/*` call says what is actually wrong.**
  The refusal read `agent: method not grantable in M3`, which stopped being
  true in M4 when `agent grant --resources/--prompts` arrived. Two rules now
  replace it: `agent: no resources/prompts grant: <method>` when a grant would
  open it, and `agent: method not grantable: <method>` for the methods no grant
  can describe. The JSON-RPC error talks about a *method* instead of opening
  with `Call to tool "resources/list"`. Journals written before this keep their
  old text and are still recognised by name.
- **`mcpcut server add` is journaled like `server remove`**: it writes an
  `access-edit` record (`server.add`) and an
  `[audit] server add by <name> (<role>)` line naming the owner who ran it (see
  Security below: both commands are owner-only).
- **`approvals list` shows the agent's own deadline**, not only the queue
  entry's: `agent_waits=42s expires_in=4m55s`, and
  `agent_waits=elapsed(retry-only)` once the blocked call has given up and an
  approval would only buy a retry. `--json` is unchanged.
- **An argument error prints the command, not the whole help table.**
  `prune --older-than 0s` and `show --kind bogus` answered with all ~110 lines
  of `mcpcut --help`, scrolling the actual mistake off the screen; each now
  prints its own synopsis and points at `--help`.
- **No more `ExperimentalWarning: SQLite …` on every command.** The two stderr
  lines Node prints for `node:sqlite` headed every invocation and both daemon
  logs. Exactly that one warning is suppressed; every other warning Node emits
  still reaches stderr.
- **The vault-refused probe message reads as one line**: `missing vault
  secret(s) for the server's headers: crm-token — add each with: mcpcut
  vault set <name>`. A newline in it used to surface as `crm-token?Add each…`
  in `server add|list|show`.
- **The admin UI offers no control the role cannot use.** Below `operator` the
  approve/reject buttons on `/quarantine` are gone (the schema diff and the
  `surfaceDelta` verdict stay fully visible). Server-side checks are unchanged.
- **Approve/deny on the dashboard settles in place** instead of reloading the
  whole page, the way `/quarantine` already did; the "N held" count and the
  Held tile follow the swap.
- **The console's output pane belongs to its section.** Switching tabs shows
  the new section's introduction instead of leaving the previous section's
  command on screen. A one-time token still on the pane is never dropped, and
  navigation cannot happen while a command is running.

### Security

- **A pool forwards a member's notification only when it is that member's to
  send.** Before, every notification of every server in an agent's pool reached
  the agent unscoped. Now `notifications/progress` passes only from the server
  whose in-flight call carries that `progressToken` (the token is bound to the
  call when the agent sends it and released with its answer, or when the server
  leaves); a member's `tools/list_changed` / `prompts/list_changed` reaches the
  agent as the pool's own notification, without the member's params; and
  everything the pool never declared — log lines, resource updates, cancels,
  anything new — is not passed on. The pool journals each such kind once per
  server (`dropped`, reason `unscoped-notification` or `unsupported-method`,
  at most 256 kinds per session); every notification stays in that server's own
  session traffic. ADR-0015 phase 5 amendment (N1–N4).

- **`server add` and `server remove` are owner-only** (breaking for scripts).
  Both now need `MCP_ADMIN_TOKEN` set to an owner's personal token — the role
  the admin UI's `/servers` write routes have always required — and refuse
  (`Refusing to change the server registry: …`, exit 1) before validating,
  writing or probing anything. Until now they ran without a token and
  journaled the change as `unattributed`, although registering a server
  decides which process the plane may launch and the registration probe runs
  it once. `--prune-grants` is gated the same way; `server list|show` still
  need no token (ADR-0010, owner decision 2026-09-18).
- **Registering or editing a server in the admin UI is journaled.**
  `POST /servers/add` and `POST /servers/edit` now write an `access-edit`
  record (`server.add`, and the new action `server.update`) under the
  signed-in admin's name; before, only the removal did, so the journal could
  not say who registered a server from the browser. If the record cannot be
  written the change still stands and the success page says so.
- **A policy file written after start-up is enforced without a restart.**
  `setup` starts `serve` before any `policy.json` exists; a front (or a
  long-lived `connect` session) that started with no policy used to stay
  journaling-only until restarted, while the admin UI already showed the new
  file's hash. Such a process now keeps looking where its entry point reads
  and adopts the first valid file that appears, on the very next call
  (`policy adopted: <path> (<hash>)` in its log). A broken file is never
  adopted and is reported; after adoption the source is pinned as if it had
  been there from the start. `wrap` without a policy is unchanged (ADR-0009,
  amendment 2026-09-18).
- **Skipping `tools/list` no longer lowers a tool's class.** A call was
  classified from the descriptor its own session had seen listed, and from the
  tool's name alone when the agent never asked for the catalog — so
  `write_file` was `destructive` (the server's `destructiveHint`) in one
  session and `write` in another, and under `classDefaults.write: allow` the
  second one skipped human approval. A session that never listed tools is now
  classified from the descriptor the inventory stores (the registration probe,
  `server refresh` or any earlier session put it there); the name decides only
  for a tool nobody has ever observed. The stored descriptor keeps
  `readOnlyHint`/`destructiveHint` under every size cap, so a server cannot
  pad a descriptor until its hints are dropped.
- **Every decision record of an agent session names the agent.** `agentName`
  used to be stamped only on `require-approval-pending`; allowed, denied,
  approved, timed-out and bookkeeping records named nobody, so the journal's
  agent filter found only held calls and an exported report could not say
  which agent made a call that went through. The name is now stamped by the
  one writer every decision record passes through, from the session's
  authenticated scope and never from the record's draft. Sessions without an
  agent (`wrap`) still carry no such key; records written before this change
  are not rewritten.

- **No first-run secret lands in `run/ui.log`.** When `ui` starts over a
  store with no admins (the `setup --yes --no-admin` path), what it writes —
  since the first-run page above, a one-time setup code rather than an owner's
  token — goes to a file, `<data dir>/setup-code`: mode 0600, created
  exclusively inside the 0700 data directory, with only the path printed to
  stderr. If the file cannot be written, `ui` refuses to start and points at
  `admin add <name> --role owner`. Docker is unaffected: the entrypoint passes
  `--admin`, so `setup` mints the owner and the token goes to the container's
  stdout as before.

### Fixed

- **A host that merely LOOKS like a loopback address is no longer treated as
  one.** `isLoopbackHost` matched the `127.0.0.0/8` block with a string
  prefix, so an ordinary DNS name such as `127.evil.com` — which URL parsing
  leaves as a hostname rather than folding into an address — counted as
  "unreachable from the network". Every caller that asks the question about an
  address arriving from outside was affected: `connect --url` (agent token,
  where owner decision PE8 turns the answer into a refusal), `--remote` (admin
  token) and the `--*-public-url` flags all sent a bearer token over plain
  `http` to such a host with no warning and no flag. The block is now matched
  against a real IPv4 literal; the decimal, octal and hex spellings of the
  real loopback address are unaffected, since the URL parser normalizes them
  first. Found by the security review of the bridge, 2026-09-21.

[Unreleased]: https://github.com/RostislavMatov/mcpcut/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/RostislavMatov/mcpcut/releases/tag/v0.1.0

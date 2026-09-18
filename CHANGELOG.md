# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Added

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
- **`mcpcut` binary**: a second `bin` entry pointing at the same file as
  `mcp-journal` — the two names are one dispatcher with identical behaviour.
- **Install config** `~/.mcpcut/config.json` (path overridable with
  `MCPCUT_CONFIG`): the data directory and the `ui` / `serve` bindings, resolved
  at process start with the priority **flag > environment variable > config >
  default**. `MCP_JOURNAL_DIR` overrides the data directory without a config
  file; with neither, the directory stays `$HOME/.mcp-journal` as before. A
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
- **`MCP_JOURNAL_DIR` must be an absolute path**, and it is honoured by every
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
  install config lives on its own volume (`mcp-config`), `serve` starts after
  `ui` is healthy, and `mcpcut` is on the image's `PATH` —
  `docker compose exec -it ui mcpcut` opens the console.
- `start`/`stop`/`logs` without an install config now point at `mcpcut` (the
  interactive setup) as well as `setup --yes`.
- **Console running footer** now says `running… · keys are queued until it
  finishes · Ctrl-C aborts` (was «keys are ignored»); the short token-hold
  banner (`One-time token on screen: copy it, then press y.`) is used whenever
  the long one would wrap to more than two lines.
- **`setup --yes --no-admin` warning** now names the file the first `ui`
  start will write the owner token to (`<data dir>/bootstrap-token`, mode
  0600, deleted after the first sign-in) instead of `run/ui.log`.
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

### Security

- **The bootstrap owner token no longer lands in `run/ui.log`.** When `ui`
  starts over a store with no admins (the `setup --yes --no-admin` path), it
  writes the one-time token to `<data dir>/bootstrap-token` — mode 0600,
  created exclusively inside the 0700 data directory — and prints only that
  path to stderr. The file is deleted by the first successful sign-in of any
  admin, through the web UI or the console; a failure to delete it is
  reported and does not change the sign-in's outcome. If the file cannot be
  written, `ui` refuses to start and points at `admin rotate owner`. Docker
  is unaffected: the entrypoint passes `--admin`, so `setup` mints the owner
  and the token goes to the container's stdout as before.

## [0.1.0] — 2026-09-03

First public release, under the Apache License 2.0.

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

[Unreleased]: https://example.invalid/compare/v0.1.0...HEAD
[0.1.0]: https://example.invalid/releases/tag/v0.1.0

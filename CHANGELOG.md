# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Built-in file server: give an agent folders.** `mcpcut files root add
  <folder>` declares a folder, `mcpcut files grant <agent> <folder> --ops
  read,write,edit,delete` says what an agent may do in it, and the agent
  reaches it through file tools (`list_directory`, `read_file`, `write_file`,
  `edit_file`, `move_file`, `delete_file`, …) behind the same gate as every
  other server. Rights are inherited down the tree, the most specific rule
  wins, and `--ops none` cuts a subfolder out. Groups carry folder rules too
  (`files grant --group`); an agent's own rules replace its groups'. Folders on
  network or FUSE drives are refused: there one folder can look like two.
  `files root add` also confirms the built-in tools in the quarantine (one
  `quarantine.approve` record per tool), so the agent's first call answers at
  once; other servers' tools still wait for a person.
- **A trash instead of deletes.** `delete_file` moves to `.mcpcut-trash` inside
  the root; `mcpcut files trash list | restore | purge` manage it, and `serve`
  purges what is older than 30 days once a day.
- **`mcpcut files audit`** lists every file call, allowed or refused, and every
  change of roots and rights, newest first, filtered by `--path`, `--agent` and
  `--since`. The same data is on the new **Files** page of the admin UI, where
  an owner can restore from the trash.
- **Optional Postgres for the file module.** `mcpcut files setup` installs the
  client, `files db init` prints the `docker run` command for a local
  container, `files db sync` and `files db status` fill and show it. It gives a
  complete, faster audit and a catalogue of the files under each root.
- **Optional search by meaning.** `mcpcut files setup --search` installs a
  local model (`multilingual-e5-small`, downloaded once), `files index on
  <folder>` chooses what is indexed, and agents get `search_files`, filtered by
  their rights. File text never leaves the machine; secret-like file names,
  `.git`, `node_modules`, `.ssh`, `.aws` and similar folders are never indexed,
  and secrets inside indexed text are masked. Not available on Intel Macs.
- Guide page [Giving an agent folders](docs/guide/files.md).
- **Retries are told from second calls by the client's tool-use id** (`_meta["claudecode/toolUseId"]`): the same id
  again never runs twice — it gets the server's first answer, kept in memory for 24 hours (journal: `replayed`), or
  waits for the first call if that one is still pending or running; a first call that was sent but never answered
  leaves the resend an error saying it may have run. A new id is a new call; a call without one is never answered
  from memory. All of it lives in process memory: after a restart a resend is a new call.
- `connect --url` sends a call with a tool-use id again when its connection to the service drops mid-call, so the
  agent gets the one answer instead of a transport error.
- An answer the agent no longer waited for is journaled `undelivered`; when the agent disconnects, mcpcut keeps
  reading the server for up to 30 seconds so it can finish what it started. A call the server never answered by the
  end of the session is journaled `unanswered`, and mcpcut prints one line naming the server and the command that
  shows those records. The web journal marks both as alerts; `mcpcut show` prints their `reason=`.

### Changed

- **An approval covers one call, while its agent waits.** There is no grant window any more: every call that needs
  approval asks, even a byte-identical repeat. A held call waits for as long as the agent waits (no limit of
  mcpcut's own unless `approval.timeoutMs` sets one) and tells a client that gave it a progress token, at once and
  then once a minute, that it waits for a person — Claude Code shows it and moves a long call to the background.
  `approval.grantTtlMs` is accepted and ignored; `policy show` says so.
- **The agent leaving closes its request.** Esc, the client's timeout, a dropped connection or the client closing
  withdraws the held call: nothing is sent, the journal records `agent-gone` with the reason, and a late approve is
  refused with one line saying when the agent stopped waiting.
- Over HTTP (`serve`, `connect --url`), a held call is answered with an SSE stream at once, so a client that cuts a
  JSON response after 60 s keeps waiting.
- `approvals list` and the web UI's approval card show how long the agent has been waiting and whether the process
  holding the call is still there (`agent_connected=no silent_since=…`: approving would send nothing) instead of the
  two clocks of the grant window. The card keeps counting while the page is open and re-reads the queue every
  30 seconds, so a request whose process died closes on its own without a reload.
- The approval card no longer shows the "include in bulk approve" box on read-class calls: nothing could submit it.
  Each request is approved or denied on its own.
- A pool address explains its refusal of a stateless request once per agent instead of on every Claude Code connect.
- `mcpcut agent grant` on a server that already holds folder rules no longer
  drops them when it rewrites the tools.
- `mcpcut server show` describes a built-in server and names the command that
  gives an agent folders.

## [0.3.1] — 2026-10-05

### Security

- **Secret redaction no longer slows down on crafted text.** Three of its
  patterns (credentials in a URL, a private key block without its footer, a
  JWT) rescanned the rest of the text from every candidate start, so a tool
  argument or a server answer of a few hundred kilobytes shaped for it could
  hold the proxy for minutes. All three now scan linearly. What they redact
  is unchanged with two narrow exceptions: a URL scheme is matched up to 32
  characters, and in a JWT whose header contains `-eyJ` the part of the
  header before it may stay visible (the rest of the token, payload and
  signature included, is still redacted).

## [0.3.0] — 2026-10-04

### Added

- **`mcpcut adopt` puts the MCP servers you already have behind mcpcut.** It
  finds them in Claude Code (user, local and project scopes), Cursor and
  Claude Desktop and shows what would change; `adopt --apply` writes it —
  only `command` and `args` of each entry change, a copy of every file it
  touches is kept, and a file the client rewrote in the meantime is left
  alone. On Windows it adds `cmd /c` where npm commands need it. Remote
  servers and entries already behind mcpcut are named and skipped.
  `adopt --undo` puts back the last run's entries, keeping whatever you
  changed since.
- **`adopt` is also in the console and on the web Agents page.** The terminal
  console's Agents section runs `adopt`, `adopt --apply` and `adopt --undo`
  (the last two ask first; not offered over `--remote`, where "this machine" is
  not yours). The web Agents page shows the same three commands to copy, and
  never runs them; a hosted install does not show them.
- **Confirm a call right in Claude Code.** A server's `confirmInClient`
  (`"confirmInClient": { "write_file": ["*"] }`) makes the person at the client
  confirm those tools in the session — Accept / Decline in a dialog (MCP form
  elicitation) — for the agents it names, or `"*"` for all and for `wrap`. It
  is a rule of its own beside the admin's: with `allow` the confirmation alone
  lets the call through, with `require-approval` an admin approves after it.
  Anything but an Accept refuses the call; a client that cannot show the
  dialog is refused with a line on stderr. Recorded as
  `confirmedBy: "client:<name>"`. On `wrap` and an agent's `connect`; an
  Accept faster than a second is asked again, at most five calls wait at
  once, and a declined call is not asked again for 30 seconds.
- **Set the client confirmation from the Servers page.** Each tool gets a
  **client** control beside the admin's rule — off, all, or the agents with a
  grant on that server — and servers you run under `wrap` (not in the
  registry) now appear there under "On this machine (wrap)". The edit is journaled
  like any rule change.
- **Create policy from the Servers page — no JSON to write.** With no policy
  file, the page says that mcpcut only journals and offers an owner one
  button: it writes `~/.mcpcut/data/policy.json` with every call allowed and
  quarantine off (path and content shown before the click), so nothing
  changes until you press the buttons by each tool. The answer names the next
  step — restart the client once. An existing file is never overwritten; the
  creation is journaled. `policy set` without a file now points to it.

### Fixed

- **`export --report` works on Windows.** Windows refuses to fsync a
  directory; the report treated that refusal as a failure and removed what
  it had written. It is now tolerated there, as the vault already did.
- **`wrap` says what to do when the server cannot start.** On Windows the
  line names the same server behind `cmd /c` (npm commands such as `npx` are
  `.cmd` scripts there); elsewhere it names the missing command. The session
  line pointing at `show` is no longer printed for a server that never ran.

### Changed

- **With quarantine off, the Servers page marks nothing as quarantined** —
  nothing is held then. A tool that changed after you approved it keeps a
  neutral "changed since approval · not held" marker. The empty page also
  says where servers behind mcpcut from `adopt` or `wrap` appear.
- **With quarantine off, the dashboard and the Quarantine page agree** —
  the tile reads "Quarantine · off" instead of counting every tool as
  quarantined, and the page says the tools are seen, not held, and what
  turning quarantine on would hold. The dashboard names servers seen through
  `wrap` instead of "No servers registered".
- **No admin token: the refusal names ways out that need none** — the token
  shown when your admin was created, the web UI's dashboard, or
  `admin rotate <your-name> --recover`; it no longer points at `admin add`,
  which itself asks for the owner's token once an admin exists.
- **README: the Windows form of the Quick start** — `cmd /c` before both
  `npx`, checked on a Windows runner together with the rest of the Quick start.
- **The Quick start on mcpcut.com follows the README** — `adopt` first, the
  policy in `~/.mcpcut/data/policy.json`, and the confirmation in the session.
- **An empty `approvals list` no longer says there is no policy.** It cannot
  see a `wrap` started with `--policy <file>` elsewhere, so the starter
  policy is offered "if you have no policy yet".
- **README: `--server` is described as it works.** The name appears in the
  decisions a policy writes and in the approval queue; a run without a policy
  journals requests and responses without it, so `sessions` shows `-` there.

## [0.2.4] — 2026-10-01

### Added

- **Answer an approval request from the list in the console.** In Approvals ▸
  `list`, `Enter` opens the rows: `↑`/`↓` choose a request, `Enter` asks about
  it, and `y` approves, `n` denies, `Esc` closes the question while the
  request keeps waiting. No 26-character id is typed. The rows stay live and
  keep the same request selected; a key typed ahead while the list was
  loading never answers the question.

### Changed

- **`<command> --help` prints that command's usage** instead of
  `Unknown option --help` (after `--` it still reaches the wrapped command).
  `mcpcut --help` opens with a five-command "Start here" block, and `status`
  without an install config names `setup`.
- **`wrap` names its session when it ends**, with the ready `show` command.
  A missing or invalid policy file is printed with its path once and what to
  do next (`policy validate <path>` for broken JSON); the no-policy line names
  the default path and `--policy`; a `wrap` without `-- <command>` shows a
  ready example.
- **`show` leads each decision with the verdict** (`outcome=… tool=… rule=…`)
  and ends with the `export --report` command for that session. `sessions`
  adds server and agent columns. `--json` output is unchanged.
- **`approvals list` reads plainly.** Rows say `agent=` when known and
  `agent_wait_left=` (or `agent_wait=over(retry_passes_after_approve)`), and
  cap the arguments at 120 characters — the full redacted arguments stay in
  `--json`. An empty queue names the real policy file or the command that
  writes the starter one. The "no admins yet" note is said once by the list,
  not after every approve and deny.
- **`connect`'s no-policy hint names the plane's data directory**, not the
  `--policy` flag that `connect` refuses.
- **The web UI's `invalid-policy` refusal names the file** in front of each
  error.

## [0.2.3] — 2026-09-30

### Changed

- **A held call is announced to the operator.** When a policy holds a call
  for approval, `wrap` writes one line to its stderr (the MCP client's log):
  the tool, the server, how long the agent waits, and ready
  `approvals approve <id>` / `approvals deny <id>` commands. The agent's own
  error still carries no approval command, so an agent with a shell cannot
  approve itself.
- **`approvals approve` says what happens to the call.** While the agent
  still waits, the call goes through at once, and the message now says so;
  after the wait it names the retry window, as before. The "no admins yet"
  note comes only after an approval that landed, never before an unknown-id
  error, and names `admin add` the way mcpcut was started (npx or installed).
- **`keygen` can be run again.** An existing key is kept, never overwritten,
  and named with its fingerprint; the run exits 0, so
  `keygen && export --report` survives a second run. A private key left
  without its public half is still refused.
- **The Prove step ends in the anchor.** `export --report` and a passing
  `verify --report` name `verify --sign`, which signs the chain head to keep
  outside the host. An export into a directory that is not empty names a
  free one (`--out ./report-2`).
- **`keygen` keeps only a working pair.** A second run reports "kept" only
  when the private key parses and matches `signing.pub`; a garbled or
  foreign half is refused.

### Security

- **Invisible characters are shown, not rendered.** Every readable view that
  prints a journal or agent-supplied value (tool names, arguments, ids) now
  replaces bidi marks and overrides, zero-width characters and line
  separators, as it already did control characters, so a name reads as what
  it is on the line an operator approves from.

### Changed (Quick start)

- **Quick start** (README and site): the `claude mcp add` line passes
  `--server fs`, so the journal and the approval queue show `fs` instead of
  `auto:<hash>`; the See step no longer promises decisions without a policy;
  Prove adds `verify --sign`.

## [0.2.2] — 2026-09-30

### Changed

- **The README demo is re-recorded on the current CLI.** Each of its three
  steps now ends with the next-step hint mcpcut prints; the recording script
  no longer names a fixed package version, so it re-renders on any release.
- **Empty admin UI screens say how to fill them.** Servers links to
  *Register a server*, Agents opens *Create an agent*, Approvals says a call
  waits there when a rule says `require-approval` and links to the server
  rules, the journal names the first call that fills it. An admin whose role
  cannot take the action is told an owner does.
- **The terminal console names the next step.** Home tells a new owner to
  start with *Servers ▸ add*, then *Agents ▸ create*; Servers, Agents and
  Groups say which action fills them (or that an owner does). The sign-in
  screen says how to get a lost token back (`admin rotate <name> --recover`).
  `server list`, `agent list` and `group list` with nothing in them, `vault`
  before `vault init` and `policy show` with no policy file end with the
  command or file that fills them. A console that cannot reach its service
  says what to check and offers `mcpcut --connect <address>`; a run that gets
  no answer says to check the service and run the action again; a role
  refused over the network is told an owner can run it.
- **The rest of the admin UI names the next step too.** On the dashboard, an
  empty call journal says what fills it, a server filter with no match links
  back to all servers, a cut-short list links to the journal, and an empty
  servers panel links to *Register a server*. Quarantine says when a tool
  lands there; Groups, and a group with no servers or members, open the
  matching form. A new or rotated admin token says who signs in with it.
- **mcpcut.com account pages lead on.** The owner token page links the
  console it signs in to; the account page links that console, sends you to
  its *Agents* page for an agent token (a hosted install has no CLI you can
  reach), and asks *Did it work for you?* with a one-click link to the
  project's feedback discussion. A missing install and a blocked sign-in link
  the project's issues; a stopped install offers to check again.
- **`setup` ends with the next step.** After the owner token it says
  `Next: mcpcut start, then open http://127.0.0.1:8091/ and sign in with your
  admin token.` — with the real address (the public one when set), without
  `start` once `--start` has run, and in the `npx` form under `npx`.
- **The dashboard tiles show numbers only.** The small bar charts under
  Held, Quarantined, Servers and Agents were decoration, not data, and next
  to a zero they looked like activity that never happened; they are gone.
  The per-server activity bars, which count real calls, stay.
- **Vault remedies under `npx` name the `npx` command.** A server whose
  vault is not initialized, or lacks a secret, now says
  `npx -y mcpcut@<version> vault init` / `vault set <name>` when mcpcut runs
  through `npx`.
- **`package.json` carries `mcpName`** (`io.github.RostislavMatov/mcpcut`),
  which the official MCP Registry checks before it lists the npm package.

### Fixed

- Removing, editing or refreshing a server that is not registered, or
  removing a group that does not exist, showed bare text (`unknown server`)
  on a blank page. It is now a notice that says what happened, with a link
  back to Servers or Groups; the status code is unchanged. Removing or
  demoting the last owner also says how to get past it.

## [0.2.1] — 2026-09-29

### Changed

- **Every first-minute command ends with the next one.** `sessions`, `show`,
  `approvals`, `keygen`, `export --report`, `verify` and `prune` now print
  (on stderr, so stdout and `--json` are unchanged) a command you can paste,
  with the real session id, approval id or report path filled in: the newest
  session to `show`, `approve`/`deny` for a pending call, `verify --report`
  for a report just written, and how to record a first session or put a call
  on hold when the list is empty. Run through `npx`, the hint reads
  `npx -y mcpcut@<version> …` — a bare `mcpcut …` is not on the path there.

### Fixed

- `show <id>` with an id the journal never held printed nothing and exited 0;
  it now says so on stderr, points at `sessions`, and **exits 1** (stdout is
  still empty, `--json` included — a script sees only the exit code change).
  A filter that matches nothing in a real session is still an empty answer
  with exit 0.

## [0.2.0] — 2026-09-28

### Added

- **Connect to another service from inside a local console**: `Ctrl-O` on
  the sign-in or first-owner screen, or `Home ▸ connect`, opens the connect
  form (prefilled with the last remembered address) — no `--connect` flag needed.
- **Tenant mode.** A `tenant` section in `config.json` — written by
  `mcpcut setup --yes --tenant`, or by `MCPCUT_TENANT=1` in Docker — turns an
  install into one meant to be handed to somebody who is not its operator: it
  refuses `stdio` servers, allows only public `https` upstreams (checked on
  every connection, not only at registration, so DNS rebinding does not slip
  through), caps servers/agents/groups at 5/5/2 by default, and has the
  remote console refuse any command that names a path on the server. An
  install with no `tenant` section is unaffected, byte for byte. See
  [Tenant mode (hosted)](docs/guide/install.md#tenant-mode-hosted).
- **Request budget in tenant mode.** `serve` admits 10 agent requests a
  second (bursting to 20) and 10 000 per sliding day per install, then answers
  `429` with `Retry-After`; tune with `tenant.maxRequestsPerSecond` /
  `maxRequestsPerDay` ([Tenant mode](docs/guide/install.md#tenant-mode-hosted)).
- **The hub (`hub/`)** — the service behind mcpcut.com, in the repository but
  not in the npm package: sign-in with GitHub (PKCE, the GitHub token revoked
  right after the profile is read), one mcpcut install per person on their own
  subdomain created by a provisioner (the only process with the Docker socket,
  fixed container templates: 256 MiB, 0.25 CPU, no capabilities, read-only
  root, its own network and volume), an install created in the background and
  its owner token shown once, idle installs stopped at 60 days and removed at
  90, and host isolation for tenant networks. See `hub/README.md`.
- **`admin add`/`admin rotate --json`** prints one line
  `{"admin","role","token"}` on stdout for a script to parse, moving the
  human notices to stderr instead of interleaving them with it.

### Fixed

- **`status` read a UI with no admin yet as down.** Such a UI answers
  `/login` with a redirect to `/setup`; the probe now accepts exactly that
  redirect (any other one is still not the UI answering).

## [0.1.2] — 2026-09-26

### Changed

- **`approvals approve|deny` and `policy set` need no token until the install
  has its first admin.** The first `admin add` already needed none there, so
  the refusal stopped nobody — it only made the Quick start create an owner
  for a single approval. The resolution is recorded as `cli:_unattributed`
  (a `policy set` edit with `adminName: null`); a token that is set is still
  checked, and the first admin turns the requirement back on. A data
  directory without `state.db`, or with one that cannot be read, still
  refuses.
- **The README is a landing page; the manual moved to
  [`docs/guide/`](docs/guide/README.md)**, eleven pages taken over verbatim.
  The two CLI hints that named README sections (`policy set` with no policy
  file, the database preflight refusal) now give the address of the guide
  page.
- **Commit messages are English.** The public history was rewritten once, on
  2026-09-26: no file changed, and the tags `v0.1.0` and `v0.1.1` moved to
  the rewritten commits. A clone made before that has to be made again; the
  history as first published stays reachable at
  `refs/archive/pre-english-history`.

### Fixed

- **`wrap` no longer passes `npm_config_package` to the server.** Run as
  `npx -p <package> mcpcut wrap -- npx -y <server>`, the variable reached the
  server's environment and the nested `npx` ran the server's name as a
  command. Only that variable is removed; the other `npm_config_*` settings
  are the operator's own (a private registry, for one).
- **`wrap` without `--server` says which name it uses**: one stderr line
  names the `auto:<hash>` identity the approval queue will show, and how to
  give the server a readable one. The name itself is unchanged — rules and
  the approved inventory are keyed on it.
- **The console's Home names the pool first**: `Agents ▸ config` prints the
  client config that reaches every server an agent is granted at one
  address.

## [0.1.1] — 2026-09-25

### Added

- `mcpcut --version` (and `-v`) prints `mcpcut <version>` — until now it answered
  `Unknown command`. It works over a broken install config, like `--help`.

### Fixed

- The build leaves `dist/cli.js` executable, so an `npm link` of a source checkout
  keeps working after a rebuild (a registry install was never affected).

## [0.1.0] — 2026-09-25

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
- **Security audit** of the whole product before release: 0 critical, 4 high findings, all fixed.
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
  `attach` records carry `lifetime` (`pool`, `warm`, `resident`).
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
  `<service>: warning: <detail>` to stderr, the same finding
  `setup` prints; stdout and the exit code are unchanged, and a
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
  the `jq` line).
- **The server card marks tools whose pool name is too long.** On `/servers`, a
  tool whose `<server>__<tool>` exceeds 64 characters is marked `not in pool ·
  <length>` (it is left out of every agent pool and stays reachable at the
  per-server address) and the card's tools row counts them; past 47 it is
  marked `long pool name · <length>`. The thresholds are the pool's own.
- **An example of TLS in front of `serve` on a VPS** (`docs/deploy/caddy/`): a
  `Caddyfile` and a compose override — Caddy with a Let's Encrypt certificate,
  the UI left on host loopback — exactly the stand the pool's live test ran
  (official SDK v1/v2, Inspector CLI and Claude Code
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
  response to the create.
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
  ceiling.
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
  running. See [the guide](docs/guide/serve-and-pool.md#from-another-machine-mcpcut-connect---url-preview).
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
  See [the guide](docs/guide/console.md#a-console-for-a-service-on-another-host---remote-preview).

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
  empty actor.

- **One name: `mcpcut`.** The working name `mcp-journal` is gone from the
  product. The package and its only `bin` entry are `mcpcut`; the
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
  The old refusal said the method was not grantable at all, which stopped
  being true once `agent grant --resources/--prompts` arrived. Two rules now
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
  session traffic.

- **`server add` and `server remove` are owner-only** (breaking for scripts).
  Both now need `MCP_ADMIN_TOKEN` set to an owner's personal token — the role
  the admin UI's `/servers` write routes have always required — and refuse
  (`Refusing to change the server registry: …`, exit 1) before validating,
  writing or probing anything. Until now they ran without a token and
  journaled the change as `unattributed`, although registering a server
  decides which process the plane may launch and the registration probe runs
  it once. `--prune-grants` is gated the same way; `server list|show` still
  need no token.
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
  been there from the start. `wrap` without a policy is unchanged.
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
  where the answer turns into a refusal), `--remote` (admin
  token) and the `--*-public-url` flags all sent a bearer token over plain
  `http` to such a host with no warning and no flag. The block is now matched
  against a real IPv4 literal; the decimal, octal and hex spellings of the
  real loopback address are unaffected, since the URL parser normalizes them
  first. Found by the security review of the bridge, 2026-09-21.

[Unreleased]: https://github.com/RostislavMatov/mcpcut/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/RostislavMatov/mcpcut/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/RostislavMatov/mcpcut/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/RostislavMatov/mcpcut/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/RostislavMatov/mcpcut/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/RostislavMatov/mcpcut/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/RostislavMatov/mcpcut/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/RostislavMatov/mcpcut/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/RostislavMatov/mcpcut/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/RostislavMatov/mcpcut/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/RostislavMatov/mcpcut/releases/tag/v0.1.0

# The terminal console

`mcpcut` in a terminal is a console over the same state as the admin UI: every
section is a list of actions, and every action runs the CLI command it shows.

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

## A console for a service on another host (`--remote`) (preview)

### What preview means here

The remote console and the `connect --url` bridge are **preview**: they work,
and they are covered by tests and by live smokes against a VPS over TLS, but
the network surface they open — an admin token (console) or an agent token
(bridge) crossing the network on every request — has had only this project's
**internal** security audit, no independent one (`docs/adr/0011-open-source-release.md`).
Their interface may still change within 0.x. Report anything you find through
[`SECURITY.md`](../../SECURITY.md).

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
  it can stop services and write backups to a path. That is
  deliberate, not an accident — protect that token accordingly.
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

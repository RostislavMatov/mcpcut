# Running `ui` and `serve` under systemd or launchd

`mcpcut start` runs the two services as detached daemons of its own (README
"Services"). If your host already has a process supervisor — systemd on Linux,
launchd on macOS — you can hand the two processes to it instead. This
directory holds **examples** of the unit files that do that:

| File | Supervisor | Runs |
|---|---|---|
| `mcpcut-ui.service` | systemd (user unit) | `mcpcut ui` |
| `mcpcut-serve.service` | systemd (user unit) | `mcpcut serve` |
| `com.mcpcut.ui.plist` | launchd (user agent) | `mcpcut ui` |
| `com.mcpcut.serve.plist` | launchd (user agent) | `mcpcut serve` |

They are examples, not something `mcpcut` installs, generates or reads: copy
one, adapt it, install it with the supervisor's own tool. Nothing here needs
root — both are *user* units, running as the account that owns the data
directory, which is what the owner-only modes (`0700` directory, `0600`
files) assume.

## Before anything else: tell the install who owns the processes

```
mcpcut setup --yes --supervisor external [--admin <name>] [other flags]
```

`supervisor: external` in `~/.mcpcut/config.json` makes `mcpcut start` and
`mcpcut stop` refuse with an explanation, and hides the `start`/`stop`
actions in the console's Services section. Without it two supervisors would
own one process: `mcpcut stop` would kill what systemd then restarts, and
`mcpcut start` would spawn a second `ui` next to the one launchd runs. The
field lives only in the config — there is no environment override — so a
rerun of `setup --yes` without `--supervisor` keeps it.

`mcpcut status` keeps working under an external supervisor: a service that
answers on its port shows as `external` (the console's header draws it `◉`),
and the detail says that `mcpcut` only reports it. `mcpcut logs` reads
`<data dir>/run/<service>.log`, which the launchd examples write and the
systemd examples do not (they log to journald; see the comments in the unit
for how to feed the file as well).

If you passed `--admin <name>` (or answered the wizard), `setup` printed the
first owner's token to your terminal once and the services find an admin on
their first start. If you passed `--no-admin`, the first `ui` start creates nobody:
it serves the first-run page at `/setup` and writes the one-time setup code
that page asks for to `<data dir>/setup-code` (mode `0600`); the file is
deleted once the owner exists — README "Admin UI › Starting it".

## What to adapt

- **Paths.** The examples assume the checkout is `~/mcp-control-plane`
  (`npm run build` done, so `dist/cli.js` exists) and the config is
  `~/.mcpcut/config.json`. systemd expands `%h` to the unit's home directory;
  launchd expands nothing — write absolute paths and replace `/Users/you`.
- **The node binary.** Node 24+ is required. The systemd units use
  `/usr/bin/env node`, which finds node on the PATH of the *systemd* user
  session, not your shell's; the plists name `/opt/homebrew/bin/node`. If
  `which node` prints something else (nvm, volta, `/usr/local/bin/node` on
  Intel Macs), put that path in.
- **Nothing on the command line.** Bind addresses, `--behind-tls`, allowed
  hosts, the policy path and fail-closed all come from the install config. A
  flag on `ExecStart`/`ProgramArguments` outranks it (flag > environment >
  config > default), which is exactly what you do not want in a unit file.

## Install: systemd (Linux)

```
mkdir -p ~/.config/systemd/user
cp docs/deploy/mcpcut-ui.service docs/deploy/mcpcut-serve.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mcpcut-ui mcpcut-serve
systemctl --user status mcpcut-ui mcpcut-serve
journalctl --user -u mcpcut-ui -f
```

User units stop with your login session unless lingering is enabled for the
account; on a VPS you reach over SSH that is the difference between "runs"
and "runs until I log out":

```
loginctl enable-linger $USER
```

`systemd-analyze --user verify ~/.config/systemd/user/mcpcut-ui.service`
checks the file's syntax without starting anything.

## Install: launchd (macOS)

```
cp docs/deploy/com.mcpcut.ui.plist docs/deploy/com.mcpcut.serve.plist ~/Library/LaunchAgents/
# edit both: replace /Users/you and the node path
plutil -lint ~/Library/LaunchAgents/com.mcpcut.*.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.mcpcut.ui.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.mcpcut.serve.plist
launchctl print gui/$UID/com.mcpcut.ui | head
```

To stop and unload: `launchctl bootout gui/$UID/com.mcpcut.ui` (and the same
for `serve`). `RunAtLoad` starts them at login; `KeepAlive` with
`SuccessfulExit=false` restarts them only after a failure, the counterpart of
systemd's `Restart=on-failure`. The plists send both streams to
`~/.mcpcut/data/run/<service>.log`, so `mcpcut logs` works; that directory is
created by `mcpcut setup` — if it is missing, `mkdir -m 0700
~/.mcpcut/data/run` before loading.

## Checking

After either install, in any shell as the same user:

```
mcpcut status
mcpcut                 # the console; the sign-in screen shows services: ui ◉ … · serve ◉ …
```

Both `ui` and `serve` run the `PRAGMA integrity_check` preflight before they
bind a port (README "CLI command reference"): a damaged database makes the
unit fail and the supervisor restart it until you restore from a backup —
check the supervisor's log before assuming the unit file is wrong.

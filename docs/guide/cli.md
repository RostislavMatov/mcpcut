# CLI reference

Every command in one place. A command that changes who may do what needs a
personal admin token in `MCP_ADMIN_TOKEN`; the comments name the role.

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
mcpcut approvals approve <id> [--reason TEXT]        # needs MCP_ADMIN_TOKEN once an admin exists
mcpcut approvals deny <id> [--reason TEXT]           # needs MCP_ADMIN_TOKEN once an admin exists
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
mcpcut --version                                      # print the installed version
```

`serve`, `ui`, `connect` and `wrap` — the four long-lived entry points — run
`PRAGMA integrity_check` on `state.db` and `journal.db` before binding a port
or spawning a server (an install with neither file yet is not touched by this
check, and it never creates the databases). A damaged database refuses the
process instead of letting it run on state nobody can later prove anything
about:

```
state.db failed PRAGMA integrity_check: <first problem line>
Refusing to start. Restore the database from a backup (see "Backup & restore" in https://github.com/RostislavMatov/mcpcut/blob/main/docs/guide/operations.md).
```

Short-lived commands (`sessions`, `show`, `export`, `migrate`, …) do not run
this check — a `sessions` call that prints normally is therefore *not*
evidence the databases are intact; only the startup preflight of a
long-lived entry point (or a restore verified by it) is. See
[Backup & restore](operations.md#backup--restore) for what to do if a short-lived
command turns up corruption.

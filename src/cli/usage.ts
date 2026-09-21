import {
  SERVICE_SYNOPSIS_LINES,
  SETUP_SYNOPSIS_LINES,
  TUI_SYNOPSIS_LINES,
} from './operator-usage.js'

/**
 * The dispatcher's top-level usage text (one place, imported by cli.ts).
 *
 * The `setup`, `start|stop|status|logs` and `tui` rows are SPLICED IN from
 * `./operator-usage.js` rather than restated here: those commands also
 * print a usage of their own when they refuse, and two hand-written copies of
 * the same table had already drifted apart once (`tests/cli/usage.test.ts`).
 */
export const USAGE = `Usage:
  mcpcut wrap [--server <name>] [--policy <path>] [--no-policy] [--fail-closed] -- <cmd> [args...]
                                         Run a wrapped MCP server ad hoc, journaling all traffic
  mcpcut connect <server> --agent <name> [--policy <path>] [--fail-closed]
                                         Connect an agent to a registry server (token via MCP_AGENT_TOKEN)
  mcpcut connect --url <address> [--allow-http]
                                         Bridge this machine's stdio to a remote mcpcut service
                                         (token via MCP_AGENT_TOKEN; no setup, no data directory).
                                         Plain http to another host needs --allow-http
  mcpcut serve [--port N] [--host H] [--policy <path>] [--fail-closed]
                                         Run the HTTP front for remote agents (default 127.0.0.1:8090)
  mcpcut ui [--port N] [--host H] [--behind-tls] [--allowed-host <h>]
                                         Run the local admin UI (default 127.0.0.1:8091)
${SETUP_SYNOPSIS_LINES.join('\n')}
${SERVICE_SYNOPSIS_LINES.join('\n')}
${TUI_SYNOPSIS_LINES.join('\n')}
  mcpcut admin add <name> --role owner|operator|viewer
                                         Create a named admin (prints its token once)
  mcpcut admin list|remove <name>|rotate <name>|role <name> <role>
                                         Inspect or edit admin identities (owner token via
                                         MCP_ADMIN_TOKEN; the FIRST admin of an empty store needs
                                         none, and every change is journaled under its author)
  mcpcut admin rotate <name> --recover
                                         Break glass: mint a fresh token with NO admin token, when
                                         the last owner lost theirs (recorded as unattributed)
  mcpcut server add <name> --transport stdio|http ...
                                         Register an MCP server (see server add --help);
                                         probes it once right after registration
                                         (MCP_ADMIN_TOKEN, role owner)
  mcpcut server list|show <name>|remove <name> [--prune-grants]
                                         Inspect or edit the server registry; list and show
                                         print liveness + latency, probing stale servers.
                                         remove needs MCP_ADMIN_TOKEN, role owner.
                                         remove of an UNKNOWN name is refused; --prune-grants
                                         prunes grants left dangling behind such a name
  mcpcut server refresh <name>          Force a probe of one server, re-shooting tools/list
                                         (personal admin token via MCP_ADMIN_TOKEN, role
                                         operator or owner; exit 0 alive / 1 otherwise)
  mcpcut vault init|set <name>|list|remove <name>|rekey
                                         Manage the encrypted secrets vault (set reads stdin)
  mcpcut agent create <name>            Create an agent identity (prints its token once;
                                         owner token via MCP_ADMIN_TOKEN, like every agent change)
  mcpcut agent grant <agent> <server> [--tools a,b,prefix*]
                                         Grant a server (optionally specific tools) to an agent
  mcpcut agent ungrant <agent> <server> | revoke <name> | list
                                         Edit or inspect agent identities and grants (create,
                                         grant, ungrant and revoke need an owner token in
                                         MCP_ADMIN_TOKEN; list needs none)
  mcpcut group create <name>|remove <name>|list|show <name>
                                         Manage server groups: a group carries per-server grants
                                         and the agents that inherit them (owner token via
                                         MCP_ADMIN_TOKEN; list and show need none)
  mcpcut group grant <group> <server> --tools a,b,prefix*|* [--resources ...|*] [--prompts ...|*]
                                         Grant a server to a group; --tools is REQUIRED here
                                         (it lands on every member at once), resources/prompts
                                         stay denied unless named; ungrant removes it
  mcpcut group ungrant <group> <server>
                                         Remove the group's grant for a server
  mcpcut group join <group> <agent> | leave <group> <agent>
                                         Add or remove a member; a personal grant for the same
                                         server overrides the group's
  mcpcut sessions                       List journaled sessions
  mcpcut show <sessionId> [--method X] [--direction Y] [--kind Z] [--json]
                                         Print one session's journal records
  mcpcut policy validate [path]         Validate the resolved (or given) policy file
  mcpcut policy show [--server <name>] [--json] [--policy <path>]
                     [--entry-point <name>]
                                         Print the effective policy (defaults applied);
                                         --entry-point resolves the source the way that
                                         entry point does
  mcpcut policy set <server> <tool> allow|require-approval|deny|clear [--json]
                                         Write (or clear) one exact per-tool rule in
                                         <journal dir>/policy.json (owner token via
                                         MCP_ADMIN_TOKEN); running proxies reload rules
  mcpcut quarantine list [--server <name>] [--json]
                                         List quarantined tools
  mcpcut quarantine show <server> <tool>
                                         Show the structural inputSchema diff of a quarantined tool
  mcpcut quarantine approve <server> <tool> | --all --server <name>
                                         Approve quarantined tool(s) (personal admin token via
                                         MCP_ADMIN_TOKEN, role operator or owner; the release
                                         records which admin made it)
  mcpcut quarantine reject <server> <tool>
                                         Reject (discard) a quarantined tool (same token, same
                                         record)
  mcpcut approvals list [--json]        List pending approval requests (no token needed)
  mcpcut approvals approve <id> [--reason TEXT]
                                         Approve a pending request (personal admin token via
                                         MCP_ADMIN_TOKEN, role operator or owner; the
                                         resolution records which admin decided it)
  mcpcut approvals deny <id> [--reason TEXT]
                                         Deny a pending request (same token, same record)
  mcpcut migrate                         Import legacy *.json state into state.db
  mcpcut export [--session <id>]        Export journal records as JSONL to stdout
  mcpcut export --report [--session <id>] [--out <dir>]
                                         Write an evidentiary report directory (report.json,
                                         records.jsonl, summary.md, signature.json if a signing
                                         key exists); --out defaults to ./mcpcut-report
  mcpcut backup <destDir>               Back up state.db and journal.db into <destDir>
  mcpcut verify [--session <id>] [--sign]
                                         Recompute the record hash chain and report where it
                                         stays consistent (exit 0 ok, 1 could not run, 2 broken);
                                         --sign additionally signs the current chain head
  mcpcut verify --report <dir> [--pub <path>] [--require-signature]
                                         Offline-check an exported report directory (no database
                                         opened); --pub defaults to <journal dir>/signing.pub;
                                         --require-signature fails an unsigned or unattributable
                                         export (same exit codes: 0 ok, 1 could not run, 2 failed)
  mcpcut prune --older-than <dur> [--yes]
                                         Delete journal records older than <dur> (e.g. 90d, 36h) and
                                         record a retention marker the chain continues from; prints
                                         what it would delete unless --yes is given. No automatic
                                         retention exists -- this is the only thing that deletes.
                                         --yes needs an admin token via MCP_ADMIN_TOKEN (role
                                         owner); the dry run does not
  mcpcut keygen                          Generate this installation's Ed25519 signing key
                                         (prints the public key once; needed for "verify --sign")
  mcpcut --help                         Show this message
`

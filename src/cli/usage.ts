/** The dispatcher's top-level usage text (one place, imported by cli.ts). */
export const USAGE = `Usage:
  mcp-journal wrap [--server <name>] [--policy <path>] [--no-policy] [--fail-closed] -- <cmd> [args...]
                                         Run a wrapped MCP server ad hoc, journaling all traffic
  mcp-journal connect <server> --agent <name> [--policy <path>] [--fail-closed]
                                         Connect an agent to a registry server (token via MCP_AGENT_TOKEN)
  mcp-journal serve [--port N] [--host H] [--policy <path>] [--fail-closed]
                                         Run the HTTP front for remote agents (default 127.0.0.1:8090)
  mcp-journal ui [--port N] [--host H] [--behind-tls] [--allowed-host <h>]
                                         Run the local admin UI (default 127.0.0.1:8091)
  mcp-journal admin add <name> --role owner|operator|viewer
                                         Create a named admin (prints its token once)
  mcp-journal admin list|remove <name>|rotate <name>|role <name> <role>
                                         Inspect or edit admin identities
  mcp-journal server add <name> --transport stdio|http ...
                                         Register an MCP server (see server add --help)
  mcp-journal server list|show <name>|remove <name>
                                         Inspect or edit the server registry
  mcp-journal vault init|set <name>|list|remove <name>|rekey
                                         Manage the encrypted secrets vault (set reads stdin)
  mcp-journal agent create <name>       Create an agent identity (prints its token once)
  mcp-journal agent grant <agent> <server> [--tools a,b,prefix*]
                                         Grant a server (optionally specific tools) to an agent
  mcp-journal agent ungrant <agent> <server> | revoke <name> | list
                                         Edit or inspect agent identities and grants
  mcp-journal sessions                  List journaled sessions
  mcp-journal show <sessionId> [--method X] [--direction Y] [--kind Z] [--json]
                                         Print one session's journal records
  mcp-journal policy validate [path]    Validate the resolved (or given) policy file
  mcp-journal policy show [--server <name>] [--json] [--policy <path>]
                          [--entry-point <name>]
                                         Print the effective policy (defaults applied);
                                         --entry-point resolves the source the way that
                                         entry point does
  mcp-journal quarantine list [--server <name>] [--json]
                                         List quarantined tools
  mcp-journal quarantine approve <server> <tool> | --all --server <name>
                                         Approve quarantined tool(s)
  mcp-journal quarantine reject <server> <tool>
                                         Reject (discard) a quarantined tool
  mcp-journal approvals list [--json]   List pending approval requests (no token needed)
  mcp-journal approvals approve <id> [--reason TEXT]
                                         Approve a pending request (personal admin token via
                                         MCP_ADMIN_TOKEN, role operator or owner; the
                                         resolution records which admin decided it)
  mcp-journal approvals deny <id> [--reason TEXT]
                                         Deny a pending request (same token, same record)
  mcp-journal migrate                    Import legacy *.json state into state.db
  mcp-journal export [--session <id>]   Export journal records as JSONL to stdout
  mcp-journal export --report [--session <id>] [--out <dir>]
                                         Write an evidentiary report directory (report.json,
                                         records.jsonl, summary.md, signature.json if a signing
                                         key exists); --out defaults to ./mcp-journal-report
  mcp-journal backup <destDir>          Back up state.db and journal.db into <destDir>
  mcp-journal verify [--session <id>] [--sign]
                                         Recompute the record hash chain and report where it
                                         stays consistent (exit 0 ok, 1 could not run, 2 broken);
                                         --sign additionally signs the current chain head
  mcp-journal verify --report <dir> [--pub <path>] [--require-signature]
                                         Offline-check an exported report directory (no database
                                         opened); --pub defaults to <journal dir>/signing.pub;
                                         --require-signature fails an unsigned or unattributable
                                         export (same exit codes: 0 ok, 1 could not run, 2 failed)
  mcp-journal prune --older-than <dur> [--yes]
                                         Delete journal records older than <dur> (e.g. 90d, 36h) and
                                         record a retention marker the chain continues from; prints
                                         what it would delete unless --yes is given. No automatic
                                         retention exists -- this is the only thing that deletes
  mcp-journal keygen                     Generate this installation's Ed25519 signing key
                                         (prints the public key once; needed for "verify --sign")
  mcp-journal --help                    Show this message
`

# mcpcut

[![CI](https://github.com/RostislavMatov/mcpcut/actions/workflows/ci.yml/badge.svg)](https://github.com/RostislavMatov/mcpcut/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/mcpcut)](https://www.npmjs.com/package/mcpcut) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

See every tool call your AI agent makes over MCP, hold the risky ones for your approval, give it only the folders it needs, and keep a secret-redacted journal that is tamper-evident with an external anchor.

Self-hosted · Apache-2.0 · Node.js 24+ · two runtime dependencies. Start with one server on your laptop; grow into a [control plane for many agents](docs/guide/agents.md).

![mcpcut in 60 seconds](docs/demo/quickstart.gif)

## Quick start

Requires **Node.js 24+** (`node -v`); on older Node, mcpcut prints one line and exits — install Node 24 with nvm, fnm or volta. Nothing else to install.

**See.** Put the MCP servers you already have behind mcpcut. `adopt` finds them in Claude Code, Cursor and Claude Desktop and shows the change; `--apply` writes it, keeping a copy of each file (`adopt --undo` puts them back). Then restart the client:

    npx -y mcpcut@0.4.0 adopt
    npx -y mcpcut@0.4.0 adopt --apply

Or put mcpcut in front of one server by hand — here for Claude Code; in any other client, the server's command becomes `npx -y mcpcut@0.4.0 wrap -- <your server>`:

    claude mcp add fs -- npx -y mcpcut@0.4.0 wrap --server fs -- npx -y @modelcontextprotocol/server-filesystem ~/project

On Windows, npm commands start only through `cmd /c` (`adopt` adds it for you) — by hand, put it before both `npx`:

    claude mcp add fs -- cmd /c npx -y mcpcut@0.4.0 wrap --server fs -- cmd /c npx -y @modelcontextprotocol/server-filesystem C:\path\to\project

The first start downloads mcpcut and the server; if your client gives up on it, start it once more. Let the agent work, then `npx -y mcpcut@0.4.0 sessions` and `npx -y mcpcut@0.4.0 show <id>`: every request and response, secrets redacted (with a policy, every decision too). `--server fs` names the server in the decisions a policy writes to the journal and in the approval queue.

**Stop.** Save this as `~/.mcpcut/data/policy.json` — every server behind mcpcut reads it when it starts — and restart the client. Reads pass, everything else waits for you (quarantine of new tools is off, so the first minute shows one gate: see [Quarantine](docs/guide/policies.md#quarantine)):

    { "version": 1, "defaultDecision": "require-approval", "classDefaults": { "read": "allow" },
      "quarantine": { "enabled": false } }

A server added by hand can take its own file instead: `--policy "$PWD/policy.json"` right after `wrap`.

A write now waits, for as long as the agent waits (Claude Code moves it to the background after two minutes and picks up the answer later). Approve it from another terminal — no token needed until you add your first admin. An approval sends exactly that call; if the agent stops waiting, the request closes and nothing is sent ([Approvals](docs/guide/policies.md#approval-scenario)):

    npx -y mcpcut@0.4.0 approvals list
    npx -y mcpcut@0.4.0 approvals approve <id>

Or be asked right in the session: let everything pass and stop only the tools you name — Claude Code shows **Accept** / **Decline**, no second terminal. `fs` is the server's name in your client — `adopt` keeps those names ([Confirming in the client](docs/guide/policies.md#confirming-in-the-client)):

    { "version": 1, "defaultDecision": "allow", "quarantine": { "enabled": false },
      "servers": { "fs": { "confirmInClient": { "write_file": ["*"], "edit_file": ["*"] } } } }

Rather click than write JSON? `npx -y mcpcut@0.4.0 ui` opens the admin UI. On **Servers**, **Create policy** writes a policy that lets every call pass — restart the client once — and then every tool of every server behind mcpcut has its buttons: **all** under **client** makes that tool ask you in the session, **approval** holds it for the queue, **deny** blocks it. Each click takes effect on the next call.

**Prove.** Sign the history, export it, and check it offline — with nothing but the directory:

    npx -y mcpcut@0.4.0 keygen && npx -y mcpcut@0.4.0 export --report --out ./report
    npx -y mcpcut@0.4.0 verify --report ./report
    npx -y mcpcut@0.4.0 verify --sign

The last line signs the chain head: keep what it prints somewhere this host cannot rewrite — [the out-of-band anchor](docs/guide/audit-reports.md#the-out-of-band-anchor) is what makes the journal tamper-evident, not the hashes alone.

**Grow.** `npm install -g mcpcut`, then `mcpcut`: a setup wizard, then a server registry, per-agent keys and grants, a credential vault, a web UI, a terminal console and one address per agent ([Install and first run](docs/guide/install.md)).

## What you get

- **[Journal](docs/guide/wrap-and-journal.md)** — every request, response and decision, with secrets redacted before anything is written. Optionally fail-closed: no record, no call.
- **[Policy per tool](docs/guide/policies.md)** — `allow`, `deny` or `require-approval` by server, tool name or tool class; read-only tools can pass on their own.
- **[Approvals](docs/guide/policies.md#approval-scenario)** — a risky call waits, for as long as the agent waits, until you approve that one call from the CLI, the web UI, the terminal console or [right in your Claude Code session](docs/guide/policies.md#confirming-in-the-client). If the agent stops waiting, nothing is sent; Claude Code's retry of an approved call gets its first answer instead of running twice.
- **[Quarantine](docs/guide/policies.md#quarantine)** — a new tool, or one whose description or schema changed after you trusted it, is held until reviewed, with a diff of what changed.
- **[Agents and grants](docs/guide/agents.md)** — a registry of servers, a key per agent, per-tool grants, groups, and an encrypted vault, so server credentials never sit in an agent's config.
- **[Folders for agents](docs/guide/files.md)** — built-in file tools over the folders you declare. Rights per agent or group, inherited down the tree; the most specific rule wins, and an empty one carves a subfolder out. Deletes go to a trash you can restore from, and every call is in the audit (`files audit`, and the Files page of the admin UI). Optionally a local Postgres for a complete audit, and search by meaning that runs on your machine.

      mcpcut files root add ~/project
      mcpcut files grant research-bot ~/project --ops read,write,edit

- **[One address per agent](docs/guide/serve-and-pool.md)** — every server an agent is granted behind one endpoint; grant or revoke without touching the client.
- **[Evidence](docs/guide/audit-reports.md)** — a hash chain with a signed head, and an audit report anyone can verify offline with a public key.
- **[Admin UI](docs/guide/admin-ui.md) and [terminal console](docs/guide/console.md)** — named admins with `owner`, `operator` and `viewer` roles; every change is attributed in the journal.

## How it works

```
 AI agent ── stdio or HTTP ──▶ mcpcut ──────────────────▶ MCP servers
 (Claude Code,                 grants → policy →          (filesystem,
  Cursor, …)                   quarantine → approval       GitHub, …)
                                 │
                                 ▼
                     journal.db — redacted, hash-chained
                                 │  export --report
                                 ▼
                     verify offline, anywhere
```

Three ways in, one gate:

- **`wrap`** — in front of one server, with no setup and no identity: the Quick start above.
- **`connect` and `serve`** — named servers from the registry, a key per agent, credentials from the vault.
- **The pool (`/mcp`)** — one address per agent for every server it is granted; `connect --url` bridges a stdio client on another machine to it.

The full picture, with the trust boundaries: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

| Guide | Covers |
|---|---|
| [Install and first run](docs/guide/install.md) | npm or source, the setup wizard, the first owner, reaching the service by IP |
| [Wrapping a server and reading the journal](docs/guide/wrap-and-journal.md) | `wrap`, `sessions`, `show`, `.mcp.json`, fail-closed journaling, known limits |
| [Policies, approvals and quarantine](docs/guide/policies.md) | `policy.json`, tool classes, approvals, quarantine, `tools/list` filtering |
| [Registry, agents and the vault](docs/guide/agents.md) | servers, agent keys and grants, groups, revoking access, the vault |
| [Giving an agent folders](docs/guide/files.md) | the built-in file server: roots, per-agent rights, trash, audit, optional Postgres and search by meaning |
| [HTTP agents and the pool](docs/guide/serve-and-pool.md) | `serve`, one address per agent, `connect --url` |
| [Admin UI](docs/guide/admin-ui.md) | the web console, admins and roles, its threat model |
| [The terminal console](docs/guide/console.md) | `mcpcut` in a terminal, the remote console |
| [Services, Docker and backups](docs/guide/operations.md) | `start`/`stop`/`status`, systemd and launchd, Docker, backup and restore |
| [Audit reports and retention](docs/guide/audit-reports.md) | `export --report`, `verify --report`, the out-of-band anchor, `prune` |
| [CLI reference](docs/guide/cli.md) | every command and flag |
| [Status](docs/guide/status.md) | what is shipped, and the evidence behind each line |

## Status

mcpcut is 0.x. The core — proxy, policy, approvals, quarantine, journal, audit report, the built-in file server, admin UI and console — is shipped and covered by tests; [Status](docs/guide/status.md) lists each capability with its evidence.

- **Preview:** the remote console (`mcpcut --remote`) and the `connect --url` bridge. They work and are tested against a VPS over TLS, but they put a token on the network, have had only an internal security review, and may change within 0.x.
- **Tamper-evident means with an external anchor.** A process running as the same OS user can rewrite the journal and re-sign it; only a chain head recorded somewhere this host cannot write exposes that. mcpcut is not tamper-proof, and whether a report satisfies an audit is the auditor's call.
- **A brake for mistakes, not a sandbox.** An agent that also has a shell as your user can reach the same `approvals approve` you run: an admin token records who approved, it does not stop the same OS user ([Approvals](docs/guide/policies.md#approval-scenario)). The error a held call returns tells the agent a human must approve and never names the command.

## Security

Please report vulnerabilities privately — [SECURITY.md](SECURITY.md) says how. The whole product had an internal security audit in September 2026; no independent audit has been done yet.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE) — see [NOTICE](NOTICE).

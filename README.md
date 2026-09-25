# mcpcut

[![CI](https://github.com/RostislavMatov/mcpcut/actions/workflows/ci.yml/badge.svg)](https://github.com/RostislavMatov/mcpcut/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/mcpcut)](https://www.npmjs.com/package/mcpcut) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

See every tool call your AI agent makes over MCP, hold the risky ones for your approval, and keep a secret-redacted journal that is tamper-evident with an external anchor.

Self-hosted · Apache-2.0 · Node.js 24+ · two runtime dependencies. Start with one server on your laptop; grow into a [control plane for many agents](docs/guide/agents.md).

![mcpcut in 60 seconds](docs/demo/quickstart.gif)

## Quick start

Requires **Node.js 24+** (`node -v`); on older Node, mcpcut prints one line and exits — install Node 24 with nvm, fnm or volta. Nothing else to install.

**See.** Put mcpcut in front of a server — here for Claude Code; in any other client, the server's command becomes `npx -y mcpcut@0.1.1 wrap -- <your server>`:

    claude mcp add fs -- npx -y mcpcut@0.1.1 wrap -- npx -y @modelcontextprotocol/server-filesystem ~/project

The first start downloads mcpcut and the server; if your client gives up on it, start it once more. Let the agent work, then `npx -y mcpcut@0.1.1 sessions` and `npx -y mcpcut@0.1.1 show <id>`: every request, response and decision, secrets redacted.

**Stop.** Save this as `policy.json` — reads pass, everything else waits for you (quarantine of new tools is off, so the first minute shows one gate: see [Quarantine](docs/guide/policies.md#quarantine)) — and re-add the server with `--policy "$PWD/policy.json"` right after `wrap` (`claude mcp remove fs` first):

    { "version": 1, "defaultDecision": "require-approval", "classDefaults": { "read": "allow" },
      "quarantine": { "enabled": false } }

A write now waits. Approve it from another terminal within the agent's wait (60 s; after it, the agent's retry passes) — no token needed until you add your first admin ([Approvals](docs/guide/policies.md#approval-scenario)):

    npx -y mcpcut@0.1.1 approvals list
    npx -y mcpcut@0.1.1 approvals approve <id>

**Prove.** Sign the history, export it, and check it offline — with nothing but the directory:

    npx -y mcpcut@0.1.1 keygen && npx -y mcpcut@0.1.1 export --report --out ./report
    npx -y mcpcut@0.1.1 verify --report ./report

Record the chain head somewhere this host cannot rewrite — [the out-of-band anchor](docs/guide/audit-reports.md#the-out-of-band-anchor) is what makes the journal tamper-evident, not the hashes alone.

**Grow.** `npm install -g mcpcut`, then `mcpcut`: a setup wizard, then a server registry, per-agent keys and grants, a credential vault, a web UI, a terminal console and one address per agent ([Install and first run](docs/guide/install.md)).

## What you get

- **[Journal](docs/guide/wrap-and-journal.md)** — every request, response and decision, with secrets redacted before anything is written. Optionally fail-closed: no record, no call.
- **[Policy per tool](docs/guide/policies.md)** — `allow`, `deny` or `require-approval` by server, tool name or tool class; read-only tools can pass on their own.
- **[Approvals](docs/guide/policies.md#approval-scenario)** — a risky call waits until someone approves it from the CLI, the web UI or the terminal console.
- **[Quarantine](docs/guide/policies.md#quarantine)** — a new tool, or one whose description or schema changed after you trusted it, is held until reviewed, with a diff of what changed.
- **[Agents and grants](docs/guide/agents.md)** — a registry of servers, a key per agent, per-tool grants, groups, and an encrypted vault, so server credentials never sit in an agent's config.
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
| [HTTP agents and the pool](docs/guide/serve-and-pool.md) | `serve`, one address per agent, `connect --url` |
| [Admin UI](docs/guide/admin-ui.md) | the web console, admins and roles, its threat model |
| [The terminal console](docs/guide/console.md) | `mcpcut` in a terminal, the remote console |
| [Services, Docker and backups](docs/guide/operations.md) | `start`/`stop`/`status`, systemd and launchd, Docker, backup and restore |
| [Audit reports and retention](docs/guide/audit-reports.md) | `export --report`, `verify --report`, the out-of-band anchor, `prune` |
| [CLI reference](docs/guide/cli.md) | every command and flag |
| [Status](docs/guide/status.md) | what is shipped, and the evidence behind each line |

## Status

mcpcut is 0.x. The core — proxy, policy, approvals, quarantine, journal, audit report, admin UI and console — is shipped and covered by tests; [Status](docs/guide/status.md) lists each capability with its evidence.

- **Preview:** the remote console (`mcpcut --remote`) and the `connect --url` bridge. They work and are tested against a VPS over TLS, but they put a token on the network, have had only an internal security review, and may change within 0.x.
- **Tamper-evident means with an external anchor.** A process running as the same OS user can rewrite the journal and re-sign it; only a chain head recorded somewhere this host cannot write exposes that. mcpcut is not tamper-proof, and whether a report satisfies an audit is the auditor's call.

## Security

Please report vulnerabilities privately — [SECURITY.md](SECURITY.md) says how. The whole product had an internal security audit in September 2026; no independent audit has been done yet.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE) — see [NOTICE](NOTICE).

# mcpcut guide

Start with the [Quick start](../../README.md#quick-start); come here for the details.

| Page | Covers |
|---|---|
| [Install and first run](install.md) | npm or source, the setup wizard, the first owner, reaching the service by IP |
| [Wrapping a server and reading the journal](wrap-and-journal.md) | `wrap`, `sessions`, `show`, `.mcp.json`, fail-closed journaling, known limits |
| [Policies, approvals and quarantine](policies.md) | `policy.json`, tool classes, approvals, quarantine, `tools/list` filtering |
| [Registry, agents and the vault](agents.md) | servers, agent keys and grants, groups, revoking access, the vault |
| [HTTP agents and the pool](serve-and-pool.md) | `serve`, one address per agent, `connect --url` |
| [Admin UI](admin-ui.md) | the web console, admins and roles, its threat model |
| [The terminal console](console.md) | `mcpcut` in a terminal, the remote console |
| [Services, Docker and backups](operations.md) | `start`/`stop`/`status`, systemd and launchd, Docker, backup and restore |
| [Audit reports and retention](audit-reports.md) | `export --report`, `verify --report`, the out-of-band anchor, `prune` |
| [CLI reference](cli.md) | every command and flag |
| [Status](status.md) | what is shipped, and the evidence behind each line |

How the pieces fit together: [Architecture](../ARCHITECTURE.md).

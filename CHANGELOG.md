# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Added

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

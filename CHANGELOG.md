# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

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

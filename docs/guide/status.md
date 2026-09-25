# Status

What exists today, and what does not. This table is the source of truth — no
other text about the project may claim more than it does.

| Capability | Status | Evidence |
|---|---|---|
| stdio proxy (`wrap`) | shipped | integration tests, dogfooded daily |
| allow / deny / require-approval policy | shipped | policy test matrix |
| quarantine of new & changed tools | shipped | schema-change tests |
| approvals via CLI | shipped | approval-flow tests |
| fail-closed journaling | shipped, **off by default** | fault-injection tests; opt in with `--fail-closed` |
| server registry (`server add/list/...`) | shipped | registry tests |
| credential vault (AES-256-GCM) | shipped | vault tests, `docs/adr/0003-vault-crypto.md` |
| agent identities + grant matrix | shipped | grant/revoke tests |
| streamable HTTP front (`serve`) | shipped, both session models | `docs/adr/0002-http-dual-version.md` |
| tamper-evident journal storage (hash chain + signed head) | shipped, **with an external anchor** | chain/verify tests, `docs/adr/0007-evidentiary-journal.md` |
| exportable audit report, offline-verifiable | shipped | `export --report` / `verify --report` tests, `docs/smoke-m5.md` |
| explicit retention pruning (`prune`) | shipped, **no defaults** | prune + marker tests |
| admin UI / approval queue | shipped | e2e + UI test suites, TS + security reviews, manual browser smoke (`docs/smoke-m4.md`), `docs/adr/0004-admin-ui-architecture.md` |
| named admin accounts (owner/operator/viewer) | shipped | admin CLI + role-enforcement tests |
| one address per agent (the pool, `/mcp`) | shipped, tools and prompts, sessionful agents | pool unit + e2e tests, `docs/smoke-agent-pool.md` (live clients — official SDK v1/v2, Inspector CLI, Claude Code headless — against a VPS over TLS) |
| `connect --url` bridge for agents on another machine | shipped, **[preview](console.md#what-preview-means-here)** | `docs/smoke-connect-bridge.md`, `docs/smoke-agent-pool.md` |
| remote console (`--remote`, `--connect`) | shipped, **[preview](console.md#what-preview-means-here)** | `docs/smoke-remote-console.md`, `docs/adr/0014-remote-console.md` |
| ready-made client config at `agent create` | shipped | `docs/smoke-agent-config.md`, `docs/smoke-agent-pool.md` |
| npm package (`npm i -g mcpcut`, `npx mcpcut@0.1.1`) | shipped, 0.1.0 | `tests/release/*`, `docs/release.md`, `docs/smoke-npm-package.md` |
| whole-product security audit | passed 2026-09-02, **internal** | `docs/security-audit-2026-09.md` — 0 CRITICAL, 4 HIGH fixed in the same wave; no independent pass has been done (ADR-0011), reports via `SECURITY.md` |

The journal is a persistent, append-oriented, secret-redacted SQLite database
(`journal.db`; JSONL is the export format — `mcpcut export`). Every
record is linked into a sha256 hash chain, the chain head can be signed with
this installation's Ed25519 key, and an exported report verifies offline
against a public key alone.

That makes the journal **tamper-evident with an external anchor** — a precise
claim, and the qualifier is not decoration. Tampering is detectable *because*
the chain and a signed head disagree with an anchor recorded somewhere this
host cannot rewrite. A process running as the same OS user can rewrite the
journal end to end, recompute every hash and re-sign it with the same key; the
result passes every check made against the host alone. Take anchors out of
band ([The out-of-band anchor](audit-reports.md#the-out-of-band-anchor)), or the word
"tamper-evident" is doing work nothing behind it supports. It is not
tamper-*proof*, and this project does not call itself "audit-ready" — whether
a report satisfies an audit is the auditor's judgement, not ours.

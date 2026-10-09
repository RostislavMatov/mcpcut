# Status

What exists today, and what does not. This table is the source of truth — no
other text about the project may claim more than it does.

| Capability | Status | Evidence |
|---|---|---|
| stdio proxy (`wrap`) | shipped | integration tests, dogfooded daily |
| allow / deny / require-approval policy | shipped | policy test matrix |
| quarantine of new & changed tools | shipped | schema-change tests |
| approvals via CLI | shipped | approval-flow tests |
| approval in the client (Claude Code **Accept** / **Decline**) | shipped | elicitation tests, a live run in Claude Code |
| one approval per call, held while the agent waits; a retry with the same tool-use id answered once | shipped | approval and replay tests, a live run in Claude Code |
| fail-closed journaling | shipped, **off by default** | fault-injection tests; opt in with `--fail-closed` |
| server registry (`server add/list/...`) | shipped | registry tests |
| credential vault (AES-256-GCM) | shipped | vault tests |
| agent identities + grant matrix | shipped | grant/revoke tests |
| streamable HTTP front (`serve`) | shipped, both session models | HTTP transport tests for both models |
| tamper-evident journal storage (hash chain + signed head) | shipped, **with an external anchor** | chain/verify tests |
| exportable audit report, offline-verifiable | shipped | `export --report` / `verify --report` tests, a manual end-to-end run |
| explicit retention pruning (`prune`) | shipped, **no defaults** | prune + marker tests |
| admin UI / approval queue | shipped | e2e + UI test suites, TS + security reviews, manual browser smoke |
| named admin accounts (owner/operator/viewer) | shipped | admin CLI + role-enforcement tests |
| one address per agent (the pool, `/mcp`) | shipped, tools and prompts, sessionful agents | pool unit + e2e tests, a live run with real clients (official SDK v1/v2, Inspector CLI, Claude Code headless) against a VPS over TLS |
| `connect --url` bridge for agents on another machine | shipped, **[preview](console.md#what-preview-means-here)** | bridge tests, a live run over TLS |
| remote console (`--remote`, `--connect`) | shipped, **[preview](console.md#what-preview-means-here)** | remote-console tests, a live run over TLS |
| built-in file server: folders, per-agent rights, carve-outs, trash, `files audit` | shipped | file-server unit + e2e tests, security reviews, a CI smoke on Linux, macOS and Windows, a live run in Claude Code |
| Postgres index for the file audit | shipped, **opt-in** | Postgres tests in CI |
| search by meaning (`search_files`) | shipped, **opt-in**, not on Intel Macs | index and search tests |
| ready-made client config at `agent create` | shipped | config tests, a live run with real clients |
| npm package (`npm i -g mcpcut`, `npx mcpcut@0.4.0`) | shipped, 0.1.0 | `tests/release/*`, a CI smoke of the published package on Linux, macOS and Windows |
| whole-product security audit | passed 2026-09-02, **internal** | 0 critical, 4 high findings, all fixed; no independent audit yet; reports via `SECURITY.md` |

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

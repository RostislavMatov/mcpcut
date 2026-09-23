# Architecture

mcpcut sees every tool call an AI agent makes over MCP, holds the risky ones for
a human's approval, and keeps a secret-redacted journal that is tamper-evident
with an external anchor. This page is the map; the reasons behind each choice
live in the decision records (`docs/adr/`).

## The picture

```
 agent (MCP client)
   │ stdio                     │ stdio                     │ streamable HTTP
   ▼                           ▼                           ▼
 wrap -- <cmd>           connect <server>          serve  (/mcp: the agent's pool,
 (ad hoc, no identity)   --agent <name>             /agents/<a>/servers/<s>: one server)
   │                           │                           │   ▲
   │                           │                           │   └─ connect --url (bridge on
   └──────────────┬────────────┴───────────────────────────┘      the agent's machine)
                  ▼
      gate: grants → classification → policy → quarantine
                  │ require-approval
                  ├──────────────► approval queue ◄── CLI · web UI (ui) · console (mcpcut)
                  ▼
      upstream MCP server (stdio child, or HTTP)

 on the side:  journal.db — every message, redacted, hash-chained
               state.db   — registry, agents and grants, groups, admins, approvals, inventory
               vault.enc  — server credentials (AES-256-GCM), injected into the server process
               policy.json — the one policy file, edited by hand, from the UI or with `policy set`
```

Three ways in, one gate. `wrap` runs a server as a child process for one client
with no identity. `connect` and `serve` resolve a named agent from its token and
enforce its grant matrix first. The pool (`/mcp`) puts every server an agent is
granted behind one address, prefixing tool and prompt names with `<server>__`;
that prefix is the only thing the plane rewrites. Everything else passes through
byte for byte.

## One `tools/call`, step by step

1. **Grants.** An agent without a grant covering the tool is denied before any
   policy is read (the `wrap` path has no agent and skips this).
2. **An approval already given.** A recent approval of this exact
   `(server, tool, arguments)` passes the call without asking again.
3. **An explicit rule** for the tool (`allow`, `deny`, `require-approval`).
4. **Untrusted inventory** fails closed: if the plane cannot trust what it knows
   about the server's tools, the call does not go through.
5. **Quarantine.** A tool seen for the first time, or whose schema changed, waits
   for review.
6. **Defaults**: the server's, then the class's (`read` / `write` /
   `destructive`, from annotations and name heuristics, which can only escalate),
   then the policy's.

`require-approval` parks the call in the queue; an admin approves or denies it
from the CLI, the web UI or the terminal console, and the agent gets the real
response or a JSON-RPC error. Every outcome is written as a decision record that
names the rule that fired and carries provenance: `policyHash` (the policy in
force), `grantsHash` (the agent's effective grants) and the `actor` who decided.

## The journal

```
 message ──► redaction ──► journal.db ──► sha256 hash chain ──► Ed25519-signed head
                                                  │
                         export --report ─────────┴──► records.jsonl, report.json,
                                                       summary.md, signature.json
                         verify --report  (offline: the directory and a public key)
```

- **Redaction is the only way into the journal.** Tokens, keys, passwords and
  `Authorization` headers are replaced before anything is written; tests hold
  that an agent's bearer token never reaches the journal.
- **Hash chain.** Every record is linked to the one before it; a signed chain
  head ties the whole history to this installation's key.
- **Report.** `export --report` writes a self-contained directory that
  `verify --report` checks offline with seven checks and exit codes 0 / 1 / 2.
- **What this does not protect against.** A process running as the same OS user
  can rewrite the journal, recompute every hash and re-sign it. Tampering becomes
  detectable only against an anchor recorded somewhere this host cannot rewrite —
  hence "tamper-evident with an external anchor", never more. Redaction is not
  anonymization. See README, "The out-of-band anchor" and "Honest limits".

## Trust boundaries

- **Loopback by default.** `ui` and `serve` bind to loopback unless told otherwise;
  both check `Host` against an allow-list; the UI checks `Origin` on state changes.
- **Named admins with fixed roles** (`owner`, `operator`, `viewer`): every change
  to access, policy, the vault or the queue names the admin who made it.
- **Personal keys.** Groups hand out grants in bulk but never share a key, so the
  journal can always say which agent acted.
- **Fail closed.** A broken or missing named policy stops the process; an
  untrusted inventory denies; journaling can be made fail-closed (`--fail-closed`).
- **The same-uid boundary is deliberate** (README, "Threat model summary").

## Invariants

- Transport (framing, splicing) knows nothing about JSON-RPC; semantics live in a
  thin, replaceable layer.
- Messages are forwarded byte for byte (the pool's name prefix is the one exception).
- Every request id gets exactly one outcome.
- Two runtime dependencies (`ulid`, `zod`); no MCP SDK. Node 24+ for `node:sqlite`.

## Decision records

Decision records are written in Russian; ADR-0007 has an English translation.

| ADR | Decision |
|---|---|
| [0001](adr/0001-stack.md) | Stack and dependency boundary: two runtime packages, no MCP SDK |
| [0002](adr/0002-http-dual-version.md) | Streamable HTTP: carry both session models, never translate between them |
| [0003](adr/0003-vault-crypto.md) | Vault crypto: AES-256-GCM, master key in a file next to it, an honest threat model |
| [0004](adr/0004-admin-ui-architecture.md) | Admin UI: a separate process, no dependencies, named admins with fixed roles |
| [0005](adr/0005-policy-source-resolution.md) | Where policy comes from depends on the trust class of the entry point |
| [0006](adr/0006-storage-sqlite.md) | Storage: SQLite (`node:sqlite`, WAL), two databases |
| [0007](adr/0007-evidentiary-journal.md) ([en](adr/0007-evidentiary-journal.en.md)) | Evidentiary journal: hash chain and a signed head |
| [0008](adr/0008-server-probe-threat-model.md) | Active server probe: connection state at the cost of running the server on view |
| [0009](adr/0009-policy-editing-and-hot-reload.md) | Policy edited from the UI and CLI; the file stays a file; rules reload hot |
| [0010](adr/0010-server-groups.md) | Server groups: grants in bulk, keys stay personal |
| [0011](adr/0011-open-source-release.md) | Open-source release under Apache-2.0 |
| [0012](adr/0012-mcpcut-install-config-and-services.md) | Install config `~/.mcpcut/config.json` and services under `mcpcut` |
| [0013](adr/0013-single-name-mcpcut.md) | One name, `mcpcut`; `~/.mcpcut` holds the data too |
| [0014](adr/0014-remote-console.md) | Remote console over the `ui` HTTP endpoint (preview) |
| [0015](adr/0015-agent-pool-endpoint.md) | One address per agent: a multiplexer in front of single-server sessions |
| [0016](adr/0016-pool-resident-servers.md) | Granted stdio servers stay running: held sessions and warm pool servers |

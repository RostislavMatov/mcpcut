# Architecture

mcpcut sees every tool call an AI agent makes over MCP, holds the risky ones for
a human's approval, and keeps a secret-redacted journal that is tamper-evident
with an external anchor. This page is the map: the processes, how a call flows
through them, and the invariants the code keeps.

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
  anonymization. See [The out-of-band anchor](guide/audit-reports.md#the-out-of-band-anchor)
  and the README, "Status".

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

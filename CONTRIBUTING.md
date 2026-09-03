# Contributing

## Setup

- Node.js 24 LTS or newer (the floor is enforced by `engines`; ADR-0006).
- `npm ci`, then `npm run build`, `npm test` (vitest with coverage), `npm run lint`
  (`tsc --noEmit`, strict).

## Ground rules

- **Two production dependencies** — `ulid` and `zod`. A third one needs its own
  ADR (ADR-0001). The MCP SDK is deliberately not used: the proxy works on bytes
  and the only binding to the specification is `src/protocol/mcp.ts`.
- **Tests first.** Write the failing test, then the implementation. Coverage
  stays at or above 80% (it is ~96% today); behavioural tests are not weakened
  to make a change pass.
- **Invariants** (see `CLAUDE.md`): the transport layer knows nothing about
  JSON-RPC semantics; redaction is the only path into the journal — an
  `Authorization` header or bearer token must never land there; enforcement
  fails closed; passthrough is byte-identical; one outcome per JSON-RPC id.
- **Immutable data, small units.** New objects instead of mutation; files under
  ~400 lines, functions under ~50; named constants instead of magic numbers;
  comments say *why*.
- **Every new entry point, route or dependency needs an ADR** (`docs/adr/README.md`
  explains when). Changing an accepted decision means amending its ADR, not
  quietly changing the code.

## Commits and pull requests

- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
  Security fixes use `fix(security):`.
- Security-sensitive changes (auth, vault, policy evaluation, journal, HTTP
  fronts) get a security-focused review before merge. Browser-facing changes
  are smoke-tested in a real browser — the admin UI works without JavaScript,
  and that must stay true.
- Public wording: the journal is "tamper-evident with an external anchor";
  never "tamper-proof", never "audit-ready".

## Languages

`README.md` and the files at the repository root are in English. Architecture
decision records under `docs/adr/` and the smoke-test logs under `docs/` are in
Russian; translations are welcome as long as the Russian original stays the
source of truth until it is replaced.

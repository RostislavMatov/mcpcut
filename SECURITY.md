# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting on this repository:
<https://github.com/RostislavMatov/mcpcut/security/advisories/new>. Include
the version (`git rev-parse HEAD` or the package version), the entry point
involved (`wrap`, `connect`, `serve`, `ui`, CLI), a reproduction, and what an
attacker gains.

You will get an acknowledgement within 7 days. Fixes ship as a normal commit on
`main` with a `fix(security):` subject and an entry in `CHANGELOG.md`; there is
no embargo process beyond that at this stage of the project.

## Scope and threat model

The threat model is written down, not implied. Start with:

- `README.md` → "Threat model summary" and "What the vault protects against, and
  what it does not" — the same-uid trust boundary is deliberate and documented.
- `docs/adr/` — every accepted security decision and the conditions under which
  it is revisited (ADR-0003 vault, ADR-0004 admin UI, ADR-0007 evidentiary
  journal, ADR-0008 server probe, ADR-0009 policy editing, ADR-0010 groups).
- `docs/security-audit-2026-09.md` — the whole-product internal audit that gates
  this release: what was found, what was fixed, what was accepted and why.

Reports that restate an accepted, documented risk (for example, "a process
running as the same OS user can rewrite the journal") are welcome only if they
show a way the documentation overclaims.

## Wording that matters

The journal is **tamper-evident with an external anchor**. It is not
"tamper-proof" and the project does not call its reports "audit-ready" —
whether an auditor accepts a report is their judgement. A pull request that
introduces either phrase will be asked to remove it.

## Preview features

Two features are **preview** (see README, "What preview means here"):

- the remote console (`mcpcut --remote`, `mcpcut --connect`, ADR-0014) — an
  admin token crosses the network on every request;
- the `connect --url` bridge (ADR-0015) — an agent token crosses the network on
  every request.

Both work and are covered by tests and live smokes over TLS, but their network
surface has had only the internal audit above, no independent one, and their
interface may change within 0.x. Reports about them are especially welcome.

## Versions and the supply chain

1. The block `agent create` prints pins the **exact** version
   (`npx -y mcpcut@<version of the service>`) and never writes `@latest`: the
   bridge process holds the agent's token, and `@latest` would mean "run any
   future code from npm every time the client starts".
2. The package carries only compiled JavaScript, the licences, the changelog
   and this file. There are two runtime dependencies, `ulid` and `zod`.
3. Every version is built from the tag `vX.Y.Z` of this repository. 0.1.0 was
   published by the maintainer by hand from that tag: it carries the registry's
   signature and no provenance attestation. From the next version on, releases
   are staged by GitHub Actions through npm trusted publishing (no npm token is
   stored anywhere) and reach the registry only after a maintainer approves them
   with 2FA; npm provenance is expected with it — this line will say so
   outright once the first such release has been checked.
4. To check what you installed: `npm audit signatures` in a project that
   depends on `mcpcut`. The release procedure is `docs/release.md`.

## Supported versions

The latest version on npm and the current `main` branch receive security
fixes.

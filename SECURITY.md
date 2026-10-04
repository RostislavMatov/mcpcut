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
- `docs/ARCHITECTURE.md` — the processes, how a call flows through them, and
  the invariants the code keeps.
- `docs/guide/status.md` — what exists today and what backs each claim.

The whole product went through an internal security audit in September 2026:
0 critical and 4 high findings, all fixed. No independent audit has been done
yet.

Reports that restate an accepted, documented risk (for example, "a process
running as the same OS user can rewrite the journal") are welcome only if they
show a way the documentation overclaims.

## Wording that matters

The journal is **tamper-evident with an external anchor**. It is not
"tamper-proof" and the project does not call its reports "audit-ready" —
whether an auditor accepts a report is their judgement. A pull request that
introduces either phrase will be asked to remove it.

## Preview features

Two features are **preview** (see [What preview means here](docs/guide/console.md#what-preview-means-here)):

- the remote console (`mcpcut --remote`, `mcpcut --connect`) — an
  admin token crosses the network on every request;
- the `connect --url` bridge — an agent token crosses the network on
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
   depends on `mcpcut`.

## Supported versions

The latest version on npm and the current `main` branch receive security
fixes.

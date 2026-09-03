# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting on this repository ("Security" tab → "Report a
vulnerability"). Include the version (`git rev-parse HEAD` or the package
version), the entry point involved (`wrap`, `connect`, `serve`, `ui`, CLI), a
reproduction, and what an attacker gains.

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

## Supported versions

Only the current `main` branch receives security fixes.

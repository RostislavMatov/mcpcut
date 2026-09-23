> Translation of [`0007-evidentiary-journal.md`](0007-evidentiary-journal.md) (Russian original, which prevails if they differ). Translated 2026-09-24.

# ADR-0007: Evidentiary journal — hash chain and signature (M5)

- **Status**: accepted (2026-08-18; status updated 2026-08-24 — M5 fully closed, all 6 waves
  implemented, smoke test `docs/smoke-m5.md`)
- **Scope**: `src/journal/chain.ts`, `src/journal/chain-verify.ts`, `src/journal/db.ts` (wave 3),
  `src/journal/signing.ts` (wave 4), `src/cli/verify-cmd.ts`, `src/cli/keygen-cmd.ts` (waves 3–5),
  `docs/adr/0006-storage-sqlite.md` (clarifications), `docs/adr/0004-admin-ui-architecture.md` (amendment)
- **Basis**: `.claude/PRPs/plans/m5-tamper-evident-journal.plan.md` (key design decisions,
  waves 3–4), requirements from ROADMAP.md:90–97 (input from ECZ-ID, thread `python-sdk#1705`),
  measured wave-3 chain profile

## Context

The journal from M1–M4 gives operating staff a record of what happened and when. For a company
that must prove AI-agent controllability to an auditor (EU AI Act Art. 12, SOC 2), this is not
enough: a record must be immutable after creation, must name which policy revision authorized each
action, and must be independently verifiable without access to the database.

Three separate problems:

1. **Journal integrity is not provable.** Today `journal.db` holds rows with no links between
   them. If a process under the same uid opens the DB and edits a row (or deletes rows from the
   middle), nothing detects it — a future auditor, given an export, cannot say whether the history
   was intact. ADR-0006 promises (line 130): the chain link commits in one transaction with the
   record — that decision still stands and needs to be carried out.
2. **Decision without provenance.** A `decision` record answers "what happened" but not "under
   which policy revision and grants matrix was this decision made." An auditor sees a record that
   says `rule: 'grant'` but cannot independently reproduce it — the policy version may have
   changed. ROADMAP.md:95 requires adding `policyHash` and `grantsHash` before signing.
3. **Approval without a subject.** M2–M4 shell approval (from `approvals approve` with no
   parameters) yields a resolution with no `actor`. ROADMAP.md:96 requires a subject in the signed
   chain; wave 2 of this milestone closes this (owner decision O3).

The decision stacks three layers: the hash chain proves integrity (wave 3, already implemented),
the chain-head signature proves origin (wave 4), export packages everything into a verifiable
report (wave 5, outside this ADR).

## Decision

### 1. Hash chain in `journal.db` (wave 3 — implemented)

Two new columns per row:

```sql
ALTER TABLE journal_records ADD COLUMN prev_hash TEXT;
ALTER TABLE journal_records ADD COLUMN record_hash TEXT;
```

Existing records keep `NULL` in both: this is an honest way to say "written BEFORE the chain was
enabled, not attested." Retroactively signing dead rows would be a lie about them ever having been
protected.

**Single-link formula** (function `linkHashOf` in `src/journal/chain.ts`):

```
record_hash = sha256Hex(prev_hash + '\n' + sha256Hex(doc))
```

What gets hashed is the **STORED** `doc` STRING byte-for-byte, not canonical JSON (contrast with
`policyHash`/`grantsHash`, which use `canonicalJson` because there the SEMANTIC document is hashed,
not its bytes). Reason: `doc` is exported and sent to the auditor as-is, and the verifier must
re-hash exactly the same bytes without reimplementing the canonicalization rules. The chain proves
integrity OF THE WIRE FORM, not a reinterpreted meaning.

The separating `\n` between the previous link's hash and the document hash prevents collisions
even if `doc` happens to contain a literal 64-character hex hash, or is crafted so the result would
look different otherwise.

**Computation and commit** (wave 3, function `insertRecordRows` in `src/journal/db.ts`):

- The link is computed in `insertRecordRows`, which IS THE SOLE path for writing rows (called by
  `batch-writer.ts` and `import.ts`), so there is no unchained path.
- `SELECT record_hash ORDER BY seq DESC LIMIT 1` runs ONCE per batch of rows (not once per row),
  fetching the current chain head.
- The head is read INSIDE the transaction (`handle.transaction(...)` wraps the whole batch), after
  `BEGIN IMMEDIATE`, so it cannot shift between the attempt and the lock. If a busy-retry replays
  the whole batch, the head is re-read — necessary, because another process may have added rows
  between attempts.
- The chain is computed in memory in a single pass: `prev = chainHeadOf(db)`, then in a loop over
  `rows`: `recordHash = linkHashOf(prev, row.doc)`, `prev = recordHash`.

This **fulfills the ADR-0006:130 promise** — the link and the record commit in one transaction,
ruling out the failure mode where "the record was written but the chain head was not updated."

### 2. Honest threat model: tamper-evidence, not tamper-proof

The chain and the signature (wave 4) give detectability of tampering, not impossibility of
tampering. What exactly they do not give must be said plainly, because the opposite reading is more
dangerous than having no mechanism at all.

**A process under the same uid — including an agent's child process — can rewrite the entire
chain.**

Why: this product's trust boundary is the OS account (ADR-0003), not the process. The journal
database sits in the same directory as the signing key (0600 in the operator's home directory).
Anything that runs under that account can open the database, edit any record, consistently
recompute every hash after it, and re-sign a new head. The result will be internally consistent,
and `verify` will call it intact — because it WILL be intact, just a chain of a different history.

Detectability comes **only from an external anchor**: the chain head that the operator exported and
stored outside this host. Comparing against it is the only operation that tells the original
history apart from a rewritten one. An anchor left on the same disk gives nothing.

It follows that the guarantee here is **organizational, not technical**: the operator does not hand
the signing key to the agent process, and regularly takes an anchor and stores it separately. This
is an uncomfortable consequence of an honest model: if an agent is trusted with filesystem rights,
it is also trusted with the journal's files. No technical barrier exists within the same uid, and
pretending there is one means selling the auditor a guarantee that does not exist.

ROADMAP.md:34, 96 name technical candidates for the future (a separate uid for the journal writer,
out-of-band approval confirmation) — they sit in the backlog after pilots. ADR-0004 already
describes the same-uid threat for the UI; here it is established for the journal.

### 3. Choice of signing algorithm: Ed25519 (owner decision O2)

Two alternatives:

| Option | Pros | Cons |
|---|---|---|
| **HMAC-SHA256** | Fast, built into `node:crypto` | Symmetric — the verifier must know the key and could then forge any report. Verification independence is lost |
| **Ed25519** | Asymmetric — the public key lets the auditor verify without access to the secret | Slower, but for signing one head per database rotation this is not a problem |

Chosen: **Ed25519** (asymmetric signature). Private key 0600 at `~/.mcp-journal/signing.key`; the
public key is given to the operator to hand to the auditor. The implementation
(`src/journal/signing.ts`, wave 4) uses `node:crypto.generateKeyPairSync` — built in, no npm
dependencies.

### 4. Signature format and placement

**The chain HEAD is signed, not every record.**

Why: the chain already links all records (edit one, and every hash after it breaks). Signing every
record would add no property but would cut throughput — which is already at the gate's limit after
wave 3. Signing the head attests the entire prefix at once.

The export manifest (wave 5) will be signed: it contains the `seq` range, the last `record_hash`, a
timestamp, and counts. This is the anchor the operator can save out-of-band and check against
later.

### 5. `migrate` (wipe-and-reload) becomes a refusal (wave 3)

Previously, re-import did `DELETE FROM journal_records WHERE session_id = ?` and then reloaded the
rows. After the chain is enabled, this is actively destructive: deleting rows from the middle of
the chain breaks every hash after them, and `verify` can no longer make sense of it (a break is not
an input error, it is the collapse of the history itself).

After wave 3: the `imported_sessions` marker is a BAN on re-import, not a reload trigger.

- **marker present**: the session is already fully imported, nothing to do.
- **marker absent, but session rows already exist**: a conservative refusal. It cannot be reliably
  told apart whether this is the result of a `migrate` interrupted midway, or something else (for
  example, a live proxy writing to `journal.db` concurrently). The `migrate` command prints a
  warning, exits 1, and skips the session, but continues importing the remaining files.

The `imported_sessions` model differs from `migrated_documents` in state.db: there, a table with no
rows signals an error (the document disappeared); here it is normal (retention deleted the
session's old rows, and the marker remains but is empty).

### 6. Retention and the prune marker (wave 6, reserve the extension point)

The prune operation (`journal prune --older-than <duration>`) will delete an old prefix of records
and leave a marker with the SKELETON of the deleted prefix: the `seq` boundary, the last
`record_hash` of the deleted prefix, and (if a key exists) its signature. This will let `verify`
start from the marker, not from genesis (wave 6, task 6.1), and keep the integrity of the remaining
suffix provable.

`resolveChainStartPrevHash` (function in `src/journal/chain-verify.ts`, wave 3, task 3.3) already
exists as the seam for this. Today it returns `GENESIS_PREV_HASH`; wave 6 will change that.

### 7. Export separates integrity from authority (wave 5)

Wave 5 will ship `export --report`: manifest + JSONL + summary. The contract (explicit, in text and
in the interface):

> The report attests the decision history and record integrity AS OF THE EXPORT MOMENT. It is not a
> statement about CURRENT subject rights, policy, or operators. The export composes with an
> external resolver (outside this product's perimeter) that answers the question of who is
> authoritative now.

This is ROADMAP.md:94 — the layer split: enforcement (what is allowed-and-denied) → receipt (what
happened and whether the record is intact) → resolver (what counts as authoritative now).

Private decision inputs are not exported — redaction has already been applied to the stored record.

### 8. At-rest encryption is out of scope for M5 (owner decision O1)

SQLCipher (encrypts the whole DB) and column-level encryption were considered. Outcome:

- **SQLCipher** would exceed the two-prod-dependency limit (ADR-0001).
- **Column-level** breaks journal search and the UI journalLog.
- **Neither protects against a same-uid agent**, which can open the database directly.

Answer to the request: the requirement placed on the operator is to use FileVault (macOS) or LUKS
(Linux) for disk encryption. This is documented in the README and ROADMAP.md, and the question is
revisited after pilots (listed at the top of the PRD as open, not in M5).

### 9. Chain throughput gate (wave 3, owner decision O5)

Wave 3 measured throughput on the canonical M4.5 profile (one sink, one writer):

| Profile | Result |
|---|---|
| M4.5 baseline (no chain) | 119–124k records/s |
| With hash chain | 83–86k records/s; ~75k on eight sinks |

The breakdown was measured, not assumed: the chain-head `SELECT` costs ~0.6 ms across all 391
batches — negligible, despite the plan's risk table naming it the prime suspect. The entire cost is
**hashing**: ~216 ms per 100k records. So the 30–40% loss comes down to record cryptography, not
I/O and not an extra query.

The original gate was ≥100k records/s. After measurement, the PRD owner revised it:

- Real pilot load is a handful of calls per hour, not a write stream.
- The gate was a regression guard, not a product requirement; this is the same reasoning the owner
  already applied in M4.5 to the 10k updates/s gate.
- The link format does NOT change as a result. The "one hash instead of two" variant gives ~94–95k
  — the gate is still not met, and the format would freeze in a worse shape. Paying with an
  irreversible decision for 10% is not acceptable: changing the link format after the chain has
  started attesting records would devalue everything already attested.

**Gate revised: ≥80k records/s.** The chain does not touch journal search at all: p95 0.86–3.19 ms
against a 50 ms gate.

Revision triggers: a pilot complaint about write latency, or writer-lock wait exceeding 5%.

### 10. Terminology: when it is permitted to speak of evidentiary properties

CLAUDE.md:3 forbids the words "tamper-evident" and "audit-ready" in public text _at this time_,
because M5 does not deliver them. **Condition for permitting the terminology:** when wave 5
delivers an exportable, independently verifiable report.

Today (wave 3 implemented, wave 4 in progress): in public text the journal is called "persistent,
append-oriented, secret-redacted", and that is 100% true. ADR-0007 (this document) may DESCRIBE THE
DESIGN as the target architecture (where we are headed and why), but may not ASSERT that the
product already delivers it.

**The CLAUDE.md edit** will happen in wave 6, task 6.4, once the whole five-wave set is delivered
and the smoke test has passed.

### 11. Report format v1 (wave 5, task 5.5): a versioned, minimally-sufficient field set

*(Written in English per the wave-5 documentation task's instruction; the rest of this ADR
predates that instruction and stays in Russian.)*

`REPORT_FORMAT_VERSION` (`src/journal/report.ts`) versions the report format as a whole —
`report.json`'s field set, the `records.jsonl` line convention, and the definition of
`chain.recomputable` — not any one field in isolation. Every consumer (`report-parse.ts`) checks
it BEFORE running the zod schema, and rejects an unrecognized version outright rather than
attempting a best-effort read: a v2 manifest handed to a v1-only build fails loudly ("this build
understands version 1 only… a newer report needs a newer mcp-journal"), instead of silently
degrading into a check that examines fields whose meaning this build no longer knows.

v1's field set (the frozen contract, reproduced in `report.ts`'s `ReportManifest`) is deliberately
the MINIMUM an offline auditor needs to re-derive every claim the report makes: the exact bytes
exported (`records.sha256`/`lineCount`), the decision counts and outcomes, the chain state at
export time, and whether that state can be independently re-folded from the export alone
(`isChainRecomputable`). It does not try to anticipate every question a real auditor engagement
will raise. The PRD's open question — an actual interview with a design partner's auditor — is
expected to surface fields v1 does not have (a machine-readable diff against a prior report, a
retention marker once wave 6 ships pruning, and others neither foreseeable nor useful to guess at
now). That interview has not happened; guessing its answer today would either under-specify a v2
that has to break v1 anyway, or over-specify a v1 carrying fields nobody asked for. `formatVersion`
exists precisely so that gap can be closed later without invalidating every v1 report already
handed to an auditor: an old report stays readable by an old-enough verifier, and a new report says
plainly that it needs a newer one.

### 12. Three known v2 candidates, deliberately not fixed in v1

Three points came up during wave 5 implementation where v1 could say more than it does. All three
are DIAGNOSABILITY gaps, not soundness holes — v1's checks still catch the underlying discrepancy,
just less directly than a v2 field could — and all three are deferred to a v2 informed by the
auditor interview above, rather than fixed now on a guess:

- **(a) `records.lineCount` and `counts.records` can never legitimately disagree.** Both fields
  count the same set of exported rows, produced by the same streaming pass
  (`report.ts`'s `streamRecords`); no honest export can make them differ. `report-verify.ts`'s
  manifest-self-consistency check turns that redundancy into a cross-check instead of leaving it
  as dead weight: a manifest hand-edited after export to change one copy and not the other is
  caught, where a maximally minimal manifest carrying only one of the two fields could not have
  caught it. A v2 that dropped the redundant field would need a different way to catch the same
  tamper.
- **(b) `chain.verifiedAtExport` is derivable from `chain.break === null`.** Same shape as (a),
  same treatment: `report-verify.ts` checks the two agree rather than dropping one of them, so a
  post-export edit that changes only one is caught rather than silently accepted.
- **(c) `signature.json` carries no binding to the specific report it signs** (no `manifestSha256`
  or equivalent). `signature.json`'s `keyFingerprint` says which KEY signed; nothing in v1 says
  which `report.json` the signature was produced OVER, beyond the signature verifying or not
  verifying against whatever manifest happens to be present. A `signature.json` from a DIFFERENT
  export of the same installation — same key, wrong manifest — is caught only indirectly:
  `verifyReportManifestSignature` (`report-signing.ts`) recomputes the canonical bytes from the
  manifest actually on disk, and the signature simply fails to verify against them. The auditor
  reads "the signature does not verify," not "this signature belongs to a different report" — a
  true but less specific diagnosis. No mix-and-match of a foreign `signature.json` onto a real
  manifest can pass the check, ever; a v2 field could turn that generic failure into a directly
  nameable "wrong report" error.

### 13. Manifest signing is a second, explicitly enumerated signing adapter

Manifest signing (`signReportManifest`/`verifyReportManifestSignature`) lives in
`src/journal/report-signing.ts`, not in `src/journal/signing.ts` alongside
`signChainHeadAnchor`. The reason is purely the project's 400-line file cap: `signing.ts` is
already at that limit, and `report-signing.ts`'s own "why" comments would push it over.

This widens the architecture rule `tests/architecture/imports.test.ts` enforces — from
"asymmetric crypto lives in exactly one file" to "asymmetric crypto lives in an ENUMERATED set of
files," now two, both named explicitly in that test rather than matched by a pattern. Nothing else
may import a signing primitive; adding a third file to the set means touching that test
deliberately, which keeps the boundary a decision each time, not a drift.

Key-fingerprint DERIVATION is not duplicated by this split: `report-signing.ts` imports
`privateKeyFingerprint`/`publicKeyFingerprint` from `signing.ts` rather than recomputing them, so
both signers — the chain-head anchor and the report manifest — answer "which key signed this"
through the same one code path. Splitting WHERE signing happens did not split WHERE a key's
identity is computed.

### 14. Retention: an explicitly-run prune, anchored by a marker (wave 6, task 6.1, decision O6)

*(English, like sections 11-13.)*

Pruning is a command an operator runs (`mcp-journal prune --older-than <dur> --yes`), never a
default, a timer or a configured period. The owner decision (O6) is that the first auditor who
names a retention period is the earliest moment a default could be anything but this project
guessing how long someone else's evidence is worth keeping. What ships is the mechanism plus the
disclosure; the policy stays with the operator.

Three design points are load-bearing:

- **A prefix, not a predicate.** Rows are deleted as a contiguous `seq` prefix whose every row is
  older than the cutoff, never as "every row whose `ts` is old". `ts` does not have to rise with
  `seq` (imported legacy sessions, a clock step), and a timestamp predicate would delete a row from
  the MIDDLE of the chain. A hole is unrepairable: no surviving row after it can be re-anchored to
  anything, and `verify` would report a permanent break that no operator action can clear. So an
  old row sitting behind a newer one survives its cutoff, and the CLI says so.
- **The delete and the marker are one transaction.** A committed delete without its marker leaves a
  journal whose surviving rows verify against nothing — and, worse, one that is indistinguishable
  afterwards from tampering, because the head hash the marker would have carried died with the
  deleted rows. One transaction makes "pruned" a state the journal can BE IN rather than a state it
  can be caught halfway into.
- **The marker feeds three readers, not one.** `verifyChain` starts its walk from it (otherwise
  every prune would look exactly like a `gap`, teaching operators to ignore the one signal the
  chain exists to give); `insertRecordRows` falls back to it when no attested row is left (otherwise
  a journal pruned empty would restart at genesis and read as one that never held anything); and
  the report manifest carries `chain.prunedThroughSeq` (otherwise an auditor gets a report starting
  at seq 4001 with a non-genesis `startPrevHash` and nothing explaining either).

The marker reuses the wave-4 chain-head anchor as its signed statement rather than inventing a
second signed format: "at instant T the chain head at seq N was H" is exactly what a marker
attests about the prefix it removed, and one format means one verification path for an auditor. A
prefix that held no attested row at all (pre-chain rows only) is recorded UNSIGNED on purpose --
signing would require either a placeholder hash, which is a statement about a chain position that
never existed, or a second format for "nothing was attested".

**What a marker is worth, stated plainly wherever it surfaces:** it is the host's own claim about
what it deleted, written by the same uid that could have deleted rows and recorded nothing. The
signature attributes the claim to this installation's key; it does not make the claim complete.
Only an anchor taken out of band BEFORE the prune corroborates it. This is the same honest limit as
everywhere else in M5, applied to the one operation that removes evidence rather than adding it.

> **Amendment 2026-09-08 (owner decision Q17, ADR-0010).** The marker's own SHAPE is unchanged --
> deliberately. `prune --yes` now requires an admin token of role `owner` and attributes the delete,
> but WHO ran it is recorded as a separate `access-edit` record (`action: 'prune'`, with
> `olderThan`, `deletedCount`, `prunedThroughSeq`) written right after the marker, not as a field on
> the marker itself. A field there would sit inside the payload the marker signature covers and that
> both `verify` and the offline `verify --report` read, so adding one would change the signed
> statement on every existing installation -- for a fact the journal's attributed-change category
> already has a place for. The limit above is untouched: the record, like the marker, is this host's
> own claim.

### 15. Surface-change escalation lives in the decision precedence, not in the classifier (wave 6, task 6.3, decision O4)

The plan's candidate rule was "a `widened` surface raises an approved tool's CLASS". Two things
killed it. The dogfood data: across ~2 weeks, 4 servers and 35 approved tools, exactly two
`changed` events occurred, one of them synthetic, and the real one
(`playwright/browser_take_screenshot`) carried no `inputSchema` at all, so no direction was
computed -- the proposed rule would have fired zero times. And the precedence: a `changed` tool is
already quarantined, quarantine already resolves ABOVE the class defaults, so raising the class
changes an outcome only when `quarantine.enabled` is false, i.e. exactly where the operator opted
out of drift gating.

The path that was actually open is the opposite one. A per-tool rule outranks BOTH quarantine and
the class defaults -- deliberately, since it is an operator's most specific instruction -- so an
explicit `allow` written against one tool surface kept allowing calls after the server advertised a
wider one. That is now withdrawn (`decide.ts`'s `withdrawnBySurfaceChange`): the call falls to
`quarantine.onQuarantined` under the rule `surface-changed`, and the reason names the superseded
config path so an auditor reading "policy says allow, outcome was require-approval" sees why.

An UNCOMPUTABLE delta escalates, exactly like `widened` does. The absence of the signal is not
evidence of safety, and all three ways it goes missing are real: an approval predating stored
descriptors (the live dogfood installation holds one), a schema too large to store whole
(persisted as a summary, so a diff over it can report `neutral` for a change it never saw), and a
descriptor with no `inputSchema` on either side. `narrowed` and `neutral` leave the `allow`
standing -- a smaller surface, or a wording-only edit, is still covered by what the operator
approved.

Escalation is gated on `quarantine.enabled` on purpose: that flag IS the operator's switch for
gating known schema drift, and honouring an explicit `allow` while ignoring an explicit "do not
gate drift" would be two answers to one question. State `new` is untouched for the mirror-image
reason -- a rule written for a tool that was never approved was never written against an approved
surface.

## What was rejected and why

| Option | Why not |
|---|---|
| **A network of session-based hash chains, not global** (independent per-session chains) | A per-session chain does not prove global event order across sessions; the verifier cannot say whether event A happened before event B if they are in different sessions. A global chain (via `seq AUTOINCREMENT` in `journal.db`) keeps the full order |
| **Merkle tree instead of a linear chain** | A Merkle tree gives O(log n) verification, but for 1M records that is ~20 operations — a difference that does not register in the offline-verify scenario. Simplicity and flat code favor the linear chain |
| **HMAC-SHA256 instead of Ed25519** | Symmetric algorithm: the verifier = a plausible forger. Verification independence is lost. Rejected by the owner (O2) in favor of asymmetry |
| **Signing every record, not the head** | A crypto operation per record cuts throughput and adds no property: the chain already links records, and signing the head attests the whole prefix |
| **Re-signing old NULL-hash rows** | A lie about them ever having been protected. `NULL` is honestly left in place forever |
| **Retroactive CAS/version-pin in approvals** | `policyHash`/`grantsHash` are already recorded at request time (`queue-file.ts:PendingApprovalFile`), fulfilling ROADMAP.md:95's provenance-before-signing requirement. Trying to add a version pin to old records does not help |

## Consequences

- (+) **Integrity is provable**: `verify` walks the chain, finds the first break and names it. An
  operator who regularly saves the chain and checks against it has an anchor against same-uid
  rewriting.
- (+) **Provenance in every record**: `policyHash` and `grantsHash` let an auditor reproduce which
  rules a decision was made under, and check consistency. This is ROADMAP.md:95.
- (+) **Attribution**: wave 2 (decision O3) fills in `actor` everywhere (UI, CLI, late approval).
  The chain records who approved — though the guarantee against same-uid is still organizational.
- (+) **The threat model is stated honestly**: no `tamper-proof`, only tamper-EVIDENCE with an
  external anchor. This means the product does not claim the impossible, and operators know what to
  expect.
- (+) **The throughput gate was revised**: 80k rec/s is enough, and the measurement proved it. No
  hidden debt.
- (−) **Throughput dropped by ~30%** (from a baseline of 119–124k to 83–86k); the cause is
  cryptography, not I/O. This is known, measured, and accepted.
- (−) **The trust boundary is not improved**: the same-uid threat remains. This is not the storage
  layer's fault and cannot be solved here (ADR-0003). Candidates sit in the backlog.
- (−) **The signing key is a new critical artifact**: must be 0600, must be backed up, rotation
  requires rebuilding exports. The README documents the procedure; this is an owner decision.

## Related decisions

- **ADR-0001** — the dependency boundary (two prod dependencies); this decision does not add any.
  `node:crypto` is built into the runtime (Node 24 LTS).
- **ADR-0003** — the trust boundary (OS account); this decision inherits it and honestly names the
  same-uid threat.
- **ADR-0006** — the promise (line 130): the link and the record commit in one transaction. Wave 3
  fulfills it.
- **ADR-0004** — an amendment near the top of the document, a clarification of the threat model for
  a same-uid agent.
- **PRD** `.claude/prds/mcp-control-plane.prd.md` — M5 requirements, success metrics.
- **ROADMAP.md:90–97** — external requirements from ECZ-ID.

---

## Amendment 2026-08-18 (terminology and CLAUDE.md)

**Circumstances:** Wave 3 (hash chain) is implemented and verified. Wave 4 (signature) is in
progress and recorded by this ADR. Wave 5 (report export) and wave 6 (retention, finalization) have
not started. CLAUDE.md:3 forbids the terms "tamper-evident" and "audit-ready" in public text,
pending M5's full final delivery.

**Decision:** The plan assumed the CLAUDE.md edit would happen in this ADR (task 4.1). Further
analysis showed, however, that the terminology is permitted only in wave 6, task 6.4, once **the
whole stack** (chain + signature + export + retention) is delivered. ADR-0007 can describe the
architecture as a target, but cannot assert that it works _now_ unless all waves are complete.

Per the plan, CLAUDE.md will be edited at the finale (wave 6); this ADR does not touch it. Instead,
the text here clearly states the condition: once wave 5 delivers an exportable,
offline-verifiable report, the terminology becomes appropriate in public text, because the product
then genuinely delivers it. This is a deferral, not an oversight.

**Today, in public text the journal remains:** "persistent, append-oriented, secret-redacted" — an
entirely truthful description that covers the fact without overstating the guarantees.

## Amendment 2026-09-23 (to §11: `summary.md`'s layout is not versioned)

`REPORT_FORMAT_VERSION` versions what is machine-checked: `report.json`'s fields, the
`records.jsonl` line convention, and the definition of `chain.recomputable`. `summary.md` is
**attested prose**: its bytes are attested by `summary.sha256` (A1), but `verify --report` does not
recompute a single line of it, and no consumer is required to parse it. So `summary.md`'s layout
(sections, columns, labels) changes **without** bumping `REPORT_FORMAT_VERSION`, and the report's
contract stays whatever `verify --report` checks.

The first such change is pool phase 5 (ADR-0015, phase-5 amendment 2026-09-23, owner decision O1):
the "Pool sessions" section, a pool marker on the child session's heading, and a `server` column in
the decisions table. The "pool session → children" link is derived from `kind:"pool"` records (the
`attach` event) in the same pass and the same read view as the manifest; it is independently
re-checked against `records.jsonl` (the `jq` recipe is in the README, "Pool sessions in a report").
Exporting `--session <pool session>` still yields a single session: changing the meaning of
`scope.session` is a v2 matter.

**v2 candidate (a fourth, alongside §12):** (d) exporting a pool session together with its
children, with a **verifiable** link — a manifest field that `verify --report` recomputes from
`records.jsonl`, the way `sessionIds` works today. Deferred to the same auditor interview as
(a)–(c).

---

## Amendment 2026-09-23 (to §11: lines from records outside the export)

The `summary.md` of a single-session export can contain marked lines from records that are **not**
in the export: pool sessions that attached this session (ADR-0015, amendment 2026-09-23, EX1–EX2).
They are read from the same snapshot as the export, and are explicitly marked as not covered by
`records.sha256` or by the chain. The `report.json` format stays v1, `verify --report` is
unchanged.

## When we revisit this

- **Throughput gate**: a pilot complaint about write latency, or writer-lock wait exceeding 5%.
  Candidates: asymmetric hashing, batch-amortized signing, isolating the signing process.
- **The at-rest encryption requirement**: if a partner rejects the FileVault/LUKS requirement, the
  owner decision is reassessed, and SQLCipher enters the boundary extension to three dependencies.
- **Signing-key compromise**: rotation is explicit (revoke the old key, generate a new one, sign a
  transition manifest). The procedure is in the README and ROADMAP.
- **Retention and composing with the resolver**: if a pilot needs complex queries across the chain
  and retention, a Merkle tree or an additional index in `verify` may be needed.
- **Multi-node deployment**: if a partner requires several control planes to write to a shared
  journal, a decision is needed (for example, a central log server), and that is a separate ADR.

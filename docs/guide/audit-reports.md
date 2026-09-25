# Audit reports and retention

`mcpcut export --report` writes a self-contained snapshot of the
journal's decision history that a third party can check **offline** — with
nothing but the export directory and a public key, no access to this
installation, no database. This is the report format `journal/report.ts`
implements (`docs/adr/0007-evidentiary-journal.md`).

## Producing and handing over a report

```
mcpcut keygen
mcpcut export --report [--session <id>] [--out <dir>]
```

1. **`keygen`** generates this installation's Ed25519 signing key, once. It
   refuses to run if a key already exists (no `--force`; key rotation is not
   built yet) and prints the public key and its fingerprint — the private
   key is written straight to `signing.key` and never echoed. Skipping this
   step is fine: a report can still be produced without a key, but it comes
   out **UNSIGNED**.
2. **`export --report`** streams the in-scope records into a fresh directory
   and writes the manifest, summary and (if a key exists) the signature
   alongside them. `--session <id>` narrows the export to one session;
   omitted, it covers the whole journal. `--out` defaults to
   `./mcpcut-report` under the current directory and must be an empty
   or nonexistent directory — it refuses to write into one that already has
   files in it, rather than risk a half-overwritten export.

What you hand to the auditor is **the whole export directory, plus
`signing.pub`** (printed by `keygen`, also sitting in the journal directory).
The private key never leaves this host and is never part of the handoff.

## The four files

| File | Holds |
|---|---|
| `report.json` | The manifest: scope, record counts, chain state, the as-of contract text, and (if signed) the signing key's fingerprint. |
| `records.jsonl` | Every exported record, verbatim, one JSON object per line — the same `doc` bytes `journal.db` stores, never re-serialized or re-redacted. |
| `summary.md` | A human-readable rendering of the manifest, the pool sessions (which child session carried each server, for which agent), and a decision table with a `server` column — for reading without tooling. |
| `signature.json` | Present **only** when a signing key exists at export time. Its absence means the export is UNSIGNED — never "verified" by default. |

## Pool sessions in a report

An agent connected at the pool address (`/mcp`) is recorded as a **pool
session** of its own, and every server it reached as an ordinary per-server
**child** session — each decision is recorded by the child, under the bare
tool name the server published (the agent called it `<server>__<tool>`).
`summary.md` ties the two together: a "Pool sessions" section names each pool
session's agent, which child session each server attached as (twice, if it
left and came back), which servers did not attach and why, and what the pool
refused to pass on; each child's decision table says which server and pool
session it belongs to.

That section is attested by `summary.sha256` like the rest of the summary, but
`verify --report` does **not** recompute it — `report.json` is unchanged
(format v1), and the binding is read from the `kind:"pool"` records in
`records.jsonl`. An auditor can re-derive it independently:

```
jq -c 'select(.kind == "pool" and .payload.event == "attach")
       | {pool: .sessionId, server: .payload.serverName, child: .payload.childSessionId}' records.jsonl
```

`export --report` prints `Pool sessions: <n>`. Exporting a pool session alone
(`--session <pool session id>`) gives that session's own records only — its
decisions live in its children — so the command prints a `Note:` and the
summary names the child sessions the export leaves out. Export the whole
journal to include them.

Exporting a **child** alone (`--session <child session id>`) still names the
pool it belonged to: `summary.md` adds "Pool membership of session … (from
records outside this export)" — each pool session that attached it, with its
agent, server, time and the record's `seq` — read from the same snapshot as the
export, and says plainly that these lines are **not** in `records.jsonl`, so
neither its digest nor the chain vouches for them. Export one of those pool
sessions, or the whole journal, to check them. stdout prints only
`Note: session <id> was attached by <n> pool session(s) …`.

A stdio server the plane keeps running for an agent (see *What keeps running*)
is ONE child session across many connections, so its heading reads "attached
by N pool sessions" — the norm for such a server, not a sign of forgery. Claims
on one child from different agents or servers are still named as such.

## Checking a report offline

```
mcpcut verify --report <dir> [--pub <path>] [--require-signature]
```

`--pub` defaults to `<journal dir>/signing.pub`, which only matters if you're
checking your own export on the machine that produced it; an auditor on a
different machine always passes `--pub` explicitly, pointing at the file the
operator handed over. This command opens **no database** — it is rejected
outright if combined with `--session` or `--sign`, which belong to the
database-backed `verify` and would otherwise imply a check that never ran.

Seven checks run, in this order, every one of them reported explicitly
(never silently skipped):

1. **`records.jsonl` digest** — recomputes sha256 over the file's exact bytes
   and compares it with `report.json`'s `records.sha256`. Proves the record
   bytes in this directory are the exact bytes the manifest describes.
2. **`records.jsonl` line count** — compares the number of lines against
   `records.lineCount`. Proves no row was added or removed after export.
3. **`summary.md` digest** — the same check for the summary, which the
   manifest attests with its own `summary.sha256`. The summary is the one
   artifact a non-technical reader actually reads, so it is inside the
   integrity mechanism rather than beside it. (It is the one manifest field
   the summary itself cannot show: the digest is taken *of* the rendered
   summary, so the summary is written before that number exists. The summary
   says so in a line of its own.)
4. **Manifest self-consistency** — the manifest checked against itself:
   `records.lineCount` must agree with `counts.records`,
   `chain.verifiedAtExport` with `chain.break === null`, the `byOutcome`
   counts must sum to `counts.decisions`, and the remaining bounds must hold
   (`decisions <= records`, `unprovenanced <= decisions`, the `seqRange` span
   at least `counts.records`, `chain.head.seq` inside `seqRange`,
   `sessionIds` non-empty exactly when there are lines). v1 deliberately
   states several of those facts twice; this check turns that redundancy into
   a cross-check rather than leaving it as an ambiguity a careless edit could
   exploit.
5. **Claims recomputed from `records.jsonl`** — every number the manifest
   states that is derivable from the exported bytes is re-derived from those
   bytes and compared: `counts.records`, `counts.decisions`,
   `counts.byOutcome`, `counts.unparsableRows`, `counts.unprovenanced`,
   `sessionIds`, and whether the chain is `recomputable` at all. A signature
   proves only that the audited party authored the numbers; arithmetic over
   the exported records is the one class of claim an auditor can establish
   independently, so it is never taken on trust. `seqRange` is *not*
   derivable from the record bytes — the output says so rather than implying
   it was checked.
6. **Chain re-fold** — only when the manifest says `chain.recomputable`
   (whole-journal export, no pre-chain rows, no break, an attested head):
   re-folds the hash chain from `chain.startPrevHash` over every line of
   `records.jsonl`, in order, and compares the result with
   `chain.head.recordHash`. Proves the exported records really do chain
   together, byte for byte, into the head this report attests to. When the
   export is session-scoped (or otherwise not recomputable), this check is
   reported as **`[SKIPPED]`**, with the reason spelled out — it is not
   silently omitted, and the other six checks still run.
7. **Manifest signature** — verifies the ed25519 signature in
   `signature.json` against the supplied public key (after cross-checking
   that the manifest's `keyFingerprint`, the signature's own
   `keyFingerprint`, and the supplied key's fingerprint all agree). Proves
   the report was signed by the holder of this installation's private key;
   because the manifest commits to `records.sha256` and `summary.sha256`,
   this signature covers those files too. When `signature.json` is absent and
   the manifest claims no key, this check is reported as `[SKIPPED]` and the
   whole export is banner-printed **UNSIGNED** — not quietly dropped. When
   the manifest *does* name a
   key and `signature.json` is absent, that is a **failure**, not an unsigned
   export: the signature was removed, or the export never finished.

No check is suppressed because a *different* file is unreadable — a
truncated `signature.json` still leaves the byte, count and chain checks to
run and report. Only an unreadable or unparsable `report.json`
short-circuits, because then there is nothing to check anything against.

`--require-signature` turns an export that is not provably attributable —
unsigned, or signed by a key that cannot be checked here — into a failed
check. Without it, an unsigned bundle with internally consistent bytes exits
`0` and prints UNSIGNED, which a scripted `verify --report && accept`
pipeline never sees. Any auditor script that treats a clean exit as
acceptance should pass this flag.

## Exit codes

An auditor is expected to script against these, so they are exact:

- **`0`** — every check that applied passed. An unsigned export with intact
  bytes exits `0`, printed as **UNSIGNED** — never as verified-and-signed.
- **`1`** — could not run: a missing export directory, a `report.json` that
  is not there or that this build cannot read (including an unsupported
  `formatVersion`), or a signature present with no public key available to
  check it against. This is a failure to examine the report, not a finding
  about it.
- **`2`** — a check **failed**: a digest mismatch, a line-count mismatch, a
  recomputed count that disagrees with the manifest, a chain re-fold
  mismatch, a bad signature/fingerprint — or the **absence of a file the
  manifest positively attests**. A missing `records.jsonl` or `summary.md`
  is not "could not run": the manifest names it with a digest, so its
  absence is evidence the bundle was stripped, and an auditor's
  `verify --report || alert` must not read deletion of the evidence file as
  "retry later". `2` always wins over `1` when both apply — a missing public
  key must never downgrade a digest mismatch the byte checks already found,
  or a script that escalates on `2` and defers on `1` would never fire the
  alert.

## The out-of-band anchor

Signing a report proves it came from the holder of this installation's key.
It does **not** prove the host itself was never tampered with: a process
running under the same OS user that wrote the journal can rewrite the hash
chain end to end and re-sign it with that same key, and the result is
indistinguishable from an untouched one. The only thing that makes that
detectable is an anchor recorded **somewhere this host cannot also rewrite**.

```
mcpcut verify --sign
```

This is a separate command from `export --report` — it signs the journal's
*current chain head* (not a report) and prints an anchor block (`seq`,
`recordHash`, `signedAt`, `keyFingerprint`, signature). Record that anchor
outside this host — a ticket, a printout, a separate system the operator
does not also control — every time you take one. Later, compare a new
anchor (or a new report's `chain.head`) against a previously recorded one
for the same `seq`: an intact chain always reproduces the same
`recordHash` at a given `seq`, so a rewritten-and-re-signed chain is
exposed the moment its head is checked against a value that was written
down before the rewrite happened. Without a prior anchor kept out of band,
there is nothing to compare against, and "verified" means only "internally
consistent as exported" — never "was never rewritten."

## Honest limits

- **Same-uid rewrite is not detectable from the report alone.** See the
  anchor procedure above — this is the one gap nothing offline can close.
- **An unsigned export is UNSIGNED, not verified.** `verify --report` still
  runs and can still exit `0` on an unsigned export's byte checks, but it is
  reported as UNSIGNED throughout: anyone could have produced bytes that
  look internally consistent, and only a valid signature ties an export to
  a specific installation's key.
- **A session-scoped export cannot have its chain re-derived offline.** The
  stored hash chain runs over the *whole* journal's write order;
  `export --report --session <id>` exports only that session's rows in that
  session's own order, so folding them can never reproduce the attested
  chain head. `verify --report` reports the chain-refold check as SKIPPED
  and names every reason why — it does not pretend the check ran.
- **A pool session exported alone carries none of its decisions.** They
  are recorded by its child sessions, which `--session <pool>` does not
  include; the export says so (`Note:` on stdout, "Not in this export" in
  `summary.md`). Export the whole journal for the full picture.
- **A child session's pool, in its own export, is read from outside it.** The
  "Pool membership" lines of a `--session <child>` export come from the pool
  sessions' records, which that export does not hold: they are marked as
  such, and nothing in the export vouches for them.
- **The report is history, not a statement of anyone's current rights.** It
  attests to what happened as of the `asOf` instant in `report.json`. A
  grant that was valid when a decision was made may have been revoked
  since; the report will still, correctly, show the decision made under it.
  Current authority is resolved elsewhere — the report is built to compose
  with that resolution, not replace it. (Full wording: `report.json`'s
  `contract` field and the `mcpcut verify --report` output both carry
  it verbatim.)
- **A report holds journal content, and inherits the journal's
  confidentiality.** The export directory is created at mode `0700` and
  every file in it at `0600` — same as the rest of `~/.mcpcut/data/`. Tool
  arguments and server responses land in `records.jsonl` exactly as the
  journal held them: secrets are redacted at write time, but personal or
  otherwise sensitive data is not (see [redaction is not
  anonymization](wrap-and-journal.md#known-limitation-redaction-is-not-anonymization)). Handle an exported report directory with the same care as the
  journal itself.


## Retention

Nothing deletes journal records on its own. There is no default retention
period, no timer, and no configuration that enables one — the only thing that
removes a record is an operator running:

```
mcpcut prune --older-than <duration>               # says what it would delete
mcpcut prune --older-than <duration> --yes         # actually deletes it
```

The deleting form requires `MCP_ADMIN_TOKEN` — the personal token of an admin
whose role is `owner`. This is the only command in the product that destroys
evidence, so an operator who can resolve approvals should not thereby be able
to delete the record of having done so. The delete is written to the journal
as an `access-edit` record (`action: 'prune'`) naming the admin, the window
and the count, alongside the retention marker itself. The dry run needs no
token and records nothing — it deletes nothing.

`keygen`, `backup`, `migrate` and `verify --sign` are **not** gated: each is
needed before an install has any admin at all, and each runs from cron. When
a valid `MCP_ADMIN_TOKEN` happens to be set, they record who ran them (the
destination for a backup, the key fingerprint for `keygen` and
`verify --sign`); with no token they behave exactly as before. A token that
matches no active admin is refused rather than ignored.

`<duration>` is a whole number of hours or days (`36h`, `90d`). Without
`--yes` the command prints the record count, the `seq` range and the chain
head of the prefix it would remove, and stops. There is no undo, and the
deleted records exist nowhere else unless you exported them first
(`export --report`).

**Why deleting is a prefix, not a filter.** A record's `ts` is its own
timestamp and does not have to rise with its `seq` — an imported legacy
session or a clock step can put an old record behind a newer one. Deleting
"every record older than X" would then punch a hole in the middle of the hash
chain, and a hole is unrepairable: nothing after it can be re-anchored to
anything. So `prune` removes only the contiguous *leading run* of records that
are all older than the cutoff, and an old record sitting behind a newer one
survives. (The cutoff itself is exclusive: a record stamped exactly at the
boundary is not older than it, and stays.)

**The retention marker.** The delete and the marker are one transaction. The
marker records the `seq` it pruned through, the `record_hash` of the last
deleted record, when it happened, and — if a signing key exists — an ed25519
signature over that head. Everything afterwards hangs off it:

- `verify` starts its walk from the marker's head instead of from genesis, so
  the surviving records still verify. Without the marker, pruning would look
  exactly like tampering, and an operator who prunes would learn to ignore the
  one signal the chain exists to give.
- the next record written chains onto the marker's head, so a journal that was
  pruned empty continues the old chain rather than silently restarting a fresh
  one.
- `verify` prints the marker before its own result, and `export --report`
  carries it as `chain.prunedThroughSeq` in the manifest and a line in
  `summary.md` — an auditor is told that records were deleted, rather than
  being handed a report that starts at seq 4,001 with no explanation.

**What a marker is worth.** It is this host's own statement about what it
deleted, written by the same OS user that could instead have deleted records
and recorded nothing at all. A signature proves the statement came from the
holder of this installation's key — not that the statement is complete. The
thing that makes it checkable is an anchor recorded **out of band before the
prune** (`verify --sign`, or a previous report's `chain.head`): compare it
against what the journal claims afterwards. Take one before you prune.

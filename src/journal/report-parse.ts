import { z } from 'zod'
import { REPORT_FILES, REPORT_FORMAT_VERSION, type ReportManifest } from './report.js'
import {
  REPORT_SIGNATURE_ALGORITHM,
  REPORT_SIGNATURE_FORMAT_VERSION,
  type ReportSignatureFile,
} from './report-signing.js'

/**
 * Parsing and validation of an EXPORTED report directory (M5 wave 5, task
 * 5.3) -- the consuming half of `report.ts`/`report-signing.ts`.
 *
 * WHY THIS IS ITS OWN TRUST BOUNDARY. `verify --report` runs on an auditor's
 * laptop over a directory that arrived from somewhere else: an archive, a
 * ticket attachment, a USB stick, possibly via the very party whose conduct
 * the report describes. Nothing about those bytes is trustworthy, including
 * the claim that they are a report at all. So the manifest is validated
 * field by field with zod before ANY check logic can see it -- the same rule
 * `policy/schema.ts` applies to `policy.json`, and for the same reason: a
 * shape that merely LOOKS close enough must fail loudly rather than degrade
 * into a check that silently examines `undefined` and reports "passed".
 *
 * `z.strictObject` throughout, so an unknown key is rejected rather than
 * stripped. A field this build does not know about means one of two things,
 * both of which the auditor must be told: the report came from a newer
 * exporter (then `formatVersion` should have said so, and did not), or
 * something was added to the file after it was signed. Silently ignoring it
 * would turn either case into a clean-looking result.
 *
 * FORMAT VERSION IS CHECKED FIRST, before the schema runs. A v2 manifest run
 * through a v1 schema produces a pile of per-field complaints that bury the
 * one fact that matters ("this build cannot read this format"); checking the
 * version up front means the auditor is told to get a newer build instead of
 * being handed a field-by-field diff of two formats. This is exactly what
 * `REPORT_FORMAT_VERSION`'s own doc requires of every consumer.
 *
 * Never throws: every failure is a `{ ok: false, errors }` the CLI turns
 * into a could-not-run exit. An auditor's script must be able to tell "I
 * could not read this" apart from "I read it and a check failed", and a
 * thrown exception collapses that distinction into a stack trace.
 */

/** Result of parsing one file out of an export directory. Never throws; `errors` is one human-readable line per problem. */
export type ReportParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] }

/** Lowercase sha256 hex, the encoding every digest and fingerprint in this codebase uses (`policy/hash.ts`, `signing.ts`). */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

const sha256HexSchema = z
  .string()
  .regex(SHA256_HEX_PATTERN, 'expected a lowercase 64-character sha256 hex digest')

/** Counts and sequence numbers are non-negative integers; a float or a negative here is a corrupted manifest, not a small discrepancy. */
const nonNegativeIntSchema = z.number().int().min(0)
/** `seq` is `AUTOINCREMENT` from 1, so a prune boundary of 0 would name a row that cannot exist. */
const positiveIntSchema = z.number().int().min(1)

const chainBreakSchema = z.strictObject({
  seq: nonNegativeIntSchema,
  reason: z.enum(['modified', 'gap']),
})

/**
 * `report.json` v1, field for field the frozen contract (see
 * `ReportManifest`). `formatVersion` is validated here too -- redundantly
 * with the pre-check below -- so the schema alone is a complete statement of
 * what v1 is, and cannot drift into accepting a version the pre-check would
 * have rejected.
 */
const manifestSchema = z.strictObject({
  formatVersion: z.literal(REPORT_FORMAT_VERSION),
  asOf: z.string().min(1),
  scope: z.strictObject({ session: z.string().min(1).nullable() }),
  records: z.strictObject({
    file: z.literal(REPORT_FILES.records),
    lineCount: nonNegativeIntSchema,
    sha256: sha256HexSchema,
  }),
  // Amendment A1. `summary.md` is the only artifact a non-technical reader
  // consumes, and v1 originally left it outside every integrity mechanism:
  // it could be rewritten -- or deleted outright -- with the report still
  // verifying clean. Required, not optional: a manifest without it is not a
  // v1 manifest, and treating it as optional would let a tamperer strip the
  // one field that makes the summary checkable.
  summary: z.strictObject({
    file: z.literal(REPORT_FILES.summary),
    sha256: sha256HexSchema,
  }),
  seqRange: z
    .strictObject({ firstSeq: nonNegativeIntSchema, lastSeq: nonNegativeIntSchema })
    .nullable(),
  // NOT `.min(1)` (M5 wave-5 review, finding V9). `sessionIds` is read from
  // the `session_id` COLUMN, and the exporter's `textOf` yields `''` for a
  // non-TEXT value -- a row a same-uid actor can produce. Refusing the whole
  // manifest over one odd id was the worst possible response: exit 1 meant
  // the digest, count, chain and signature checks never ran, so the actual
  // discrepancy never surfaced as a finding at all. Malformed-LOOKING
  // evidence must not suppress the checks that still apply; the recomputed
  // -claims check below is what turns an id like this into a real verdict.
  sessionIds: z.array(z.string()),
  counts: z.strictObject({
    records: nonNegativeIntSchema,
    decisions: nonNegativeIntSchema,
    unparsableRows: nonNegativeIntSchema,
    unprovenanced: nonNegativeIntSchema,
    byOutcome: z.record(z.string().min(1), nonNegativeIntSchema),
  }),
  chain: z.strictObject({
    verifiedAtExport: z.boolean(),
    break: chainBreakSchema.nullable(),
    unattestedCount: nonNegativeIntSchema,
    head: z.strictObject({ seq: nonNegativeIntSchema, recordHash: sha256HexSchema }).nullable(),
    recomputable: z.boolean(),
    // NOT `sha256HexSchema`: the genesis start is the EMPTY STRING
    // (`GENESIS_PREV_HASH`), which is a legitimate VALUE meaning "the chain
    // starts at the beginning" -- rejecting it as "not a digest" would make
    // every report from an unpruned installation unverifiable. Presence is
    // required only when `recomputable`; see `requireStartPrevHash`.
    startPrevHash: z.union([z.literal(''), sha256HexSchema]).optional(),
    // Required, nullable: a manifest that simply omits it is a manifest whose
    // producer never looked, and an auditor cannot tell that apart from "not
    // pruned". A positive integer names the highest deleted `seq` (M5 wave 6).
    prunedThroughSeq: positiveIntSchema.nullable(),
  }),
  keyFingerprint: sha256HexSchema.optional(),
  contract: z.string().min(1),
})

/** `signature.json`. Its `formatVersion` is its own, separate from the manifest's -- see `REPORT_SIGNATURE_FORMAT_VERSION`. */
const signatureSchema = z.strictObject({
  formatVersion: z.literal(REPORT_SIGNATURE_FORMAT_VERSION),
  algorithm: z.literal(REPORT_SIGNATURE_ALGORITHM),
  keyFingerprint: sha256HexSchema,
  signatureBase64: z.string().min(1),
})

/**
 * Reads and validates `report.json`'s text. The returned manifest is rebuilt
 * field by field rather than handed straight out of zod: `ReportManifest`'s
 * optional fields are declared under `exactOptionalPropertyTypes`, where
 * "absent" and "present but `undefined`" are different types, and this
 * codebase's convention (see `report.ts`'s `decisionRowOf`) is that an
 * absent optional is OMITTED, never set to `undefined`.
 */
export function parseReportManifestJson(text: string): ReportParseResult<ReportManifest> {
  const json = parseJsonObject(text, REPORT_FILES.manifest)
  if (!json.ok) return json

  const versionError = formatVersionError(json.value, REPORT_FORMAT_VERSION, 'report format')
  if (versionError !== null) return { ok: false, errors: [versionError] }

  const parsed = manifestSchema.safeParse(json.value)
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error) }

  const startPrevHashError = requireStartPrevHash(parsed.data.chain)
  if (startPrevHashError !== null) return { ok: false, errors: [startPrevHashError] }

  return { ok: true, value: manifestOf(parsed.data) }
}

/** Reads and validates `signature.json`'s text. Its ABSENCE is not this function's business -- that means UNSIGNED, and the caller decides. */
export function parseReportSignatureJson(text: string): ReportParseResult<ReportSignatureFile> {
  const json = parseJsonObject(text, REPORT_FILES.signature)
  if (!json.ok) return json

  const versionError = formatVersionError(json.value, REPORT_SIGNATURE_FORMAT_VERSION, 'signature format')
  if (versionError !== null) return { ok: false, errors: [versionError] }

  const parsed = signatureSchema.safeParse(json.value)
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error) }
  return { ok: true, value: parsed.data }
}

/**
 * The contract says `startPrevHash` is present IFF `recomputable`. A
 * manifest claiming the chain is re-derivable while withholding where the
 * fold starts is malformed, not merely inconsistent: there is no check to
 * run, so this is a could-not-run naming the field rather than a failed
 * check. (The reverse -- a `startPrevHash` on a non-recomputable manifest --
 * is harmless: the fold is skipped anyway, and rejecting the report over an
 * unused field would deny an auditor the checks that DO apply.)
 */
function requireStartPrevHash(chain: {
  readonly recomputable: boolean
  readonly startPrevHash?: string | undefined
}): string | null {
  if (!chain.recomputable || chain.startPrevHash !== undefined) return null
  return 'chain.startPrevHash: required when chain.recomputable is true (nothing says where the re-fold starts)'
}

/** Rebuilds the validated data as a `ReportManifest`, omitting absent optionals rather than setting them to `undefined`. */
function manifestOf(data: z.infer<typeof manifestSchema>): ReportManifest {
  const { startPrevHash } = data.chain
  return {
    formatVersion: data.formatVersion,
    asOf: data.asOf,
    scope: data.scope,
    records: data.records,
    summary: data.summary,
    seqRange: data.seqRange,
    sessionIds: data.sessionIds,
    counts: data.counts,
    chain: {
      verifiedAtExport: data.chain.verifiedAtExport,
      break: data.chain.break,
      unattestedCount: data.chain.unattestedCount,
      head: data.chain.head,
      recomputable: data.chain.recomputable,
      ...(startPrevHash === undefined ? {} : { startPrevHash }),
      prunedThroughSeq: data.chain.prunedThroughSeq,
    },
    ...(data.keyFingerprint === undefined ? {} : { keyFingerprint: data.keyFingerprint }),
    contract: data.contract,
  }
}

/**
 * The one key JSON and JavaScript disagree about (M5 wave-5 review, finding
 * V1 -- CRITICAL). To every other consumer of `report.json` -- jq, python,
 * Go, a human, a GRC pipeline -- `__proto__` is an ordinary member of the
 * object. To zod it is invisible: `z.strictObject` does NOT report it as an
 * unrecognized key, it DROPS it, and the manifest is then rebuilt without
 * it, so `canonicalJson` verifies the signature over bytes that are not the
 * file's bytes. Injecting
 *
 *     "__proto__": {"auditorNote": "...", "contract": "VOID"}
 *
 * into a genuinely signed manifest therefore produced "[PASS] manifest
 * signature: valid ed25519 signature over the manifest" and "RESULT: PASSED"
 * -- every non-JS reader seeing content that this verifier was blind to,
 * which is exactly the wrong way round for a tool whose entire claim is that
 * the bytes are what was signed.
 *
 * Refused at the JSON boundary, before zod (and before any object exists to
 * pollute): a reviver that throws on the key, at EVERY nesting level and for
 * both files. Prototype pollution is not the damage today -- the signature
 * bypass is -- but the guard does not depend on that staying true.
 */
const FORBIDDEN_JSON_KEY = '__proto__'

class ForbiddenJsonKeyError extends Error {
  constructor(fileName: string) {
    super(
      `${fileName}: contains a "${FORBIDDEN_JSON_KEY}" key. JavaScript's JSON parsers and every other ` +
        'reader disagree about what that key IS, so a manifest carrying one cannot be verified as the ' +
        'bytes an auditor was handed. Treat this file as tampered with, not as merely unusual.',
    )
    this.name = 'ForbiddenJsonKeyError'
  }
}

/** `JSON.parse` plus the "is it even an object" check, with the file's name in every message so an auditor knows which file to look at. */
function parseJsonObject(text: string, fileName: string): ReportParseResult<Record<string, unknown>> {
  let value: unknown
  try {
    value = JSON.parse(text, (key, entry: unknown) => {
      if (key === FORBIDDEN_JSON_KEY) throw new ForbiddenJsonKeyError(fileName)
      return entry
    })
  } catch (error) {
    // The forbidden key is a finding in its own right, not "not valid JSON":
    // the text parses perfectly well, and saying otherwise would send the
    // auditor looking for a syntax error that is not there.
    if (error instanceof ForbiddenJsonKeyError) return { ok: false, errors: [error.message] }
    return { ok: false, errors: [`${fileName}: not valid JSON (${messageOf(error)})`] }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: [`${fileName}: expected a JSON object at the top level`] }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

/**
 * The version gate, run before the schema. Reports the value actually found
 * (including "absent") because that is the one detail that tells an auditor
 * whether they need a newer build or a different file.
 */
function formatVersionError(value: Record<string, unknown>, expected: number, label: string): string | null {
  const found = value['formatVersion']
  if (found === expected) return null
  const foundText = found === undefined ? 'absent' : JSON.stringify(found)
  return (
    `formatVersion: unsupported ${label} version ${foundText}; this build understands version ` +
    `${expected} only. A newer report needs a newer mcpcut.`
  )
}

/**
 * One line per issue, `path.to.field: message`. Mirrors
 * `policy/load.ts`'s `formatPolicyErrors`, including its expansion of zod
 * v4's single `unrecognized_keys` issue into one line per key -- three
 * smuggled fields must produce three lines, not one vague container-level
 * complaint.
 */
function formatIssues(error: z.ZodError): readonly string[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => `${path}: unknown key "${key}"`)
    }
    return [`${path}: ${issue.message}`]
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

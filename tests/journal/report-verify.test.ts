import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { GENESIS_PREV_HASH, linkHashOf } from '../../src/journal/chain.js'
import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import { REPORT_FILES, buildJournalReport, type ReportManifest } from '../../src/journal/report.js'
import { signReportManifest, type ReportSignatureFile } from '../../src/journal/report-signing.js'
import {
  MAX_RECORD_LINE_BYTES,
  readVerifyingKey,
  verifyReportExport,
  type ReportCheck,
  type ReportCheckId,
  type ReportVerifyResult,
} from '../../src/journal/report-verify.js'
import {
  generateAndWriteSigningKeyPair,
  loadSigningPrivateKey,
} from '../../src/journal/signing.js'
import { sha256Hex } from '../../src/policy/hash.js'
import type { SqliteHandle } from '../../src/store/sqlite.js'

/**
 * `src/journal/report-verify.ts` (M5 wave 5, task 5.3): the auditor's offline
 * checks over an exported report, with no database in sight.
 *
 * Every fixture here is produced by the REAL producing side
 * (`buildJournalReport` + `signReportManifest`) against a real tmpdir SQLite
 * database, then tampered with. Hand-writing a manifest would let these
 * tests keep passing against a format the exporter no longer emits, which is
 * exactly the drift an offline verifier cannot afford: the two sides only
 * ever meet on an auditor's laptop, where nothing fails loudly.
 */

const AS_OF = '2026-08-18T12:00:00.000Z'

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-report-verify-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function trafficDoc(sessionId: string, id: string): string {
  return JSON.stringify({
    id,
    ts: '2026-08-18T00:00:00.000Z',
    sessionId,
    direction: 'client→server',
    kind: 'notification',
    method: 'tools/list',
    payload: { hello: 'world' },
  })
}

function rowOf(doc: string, sessionId = 'session-1'): JournalRecordRow {
  return {
    sessionId,
    recordId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: '2026-08-18T00:00:00.000Z',
    direction: 'client→server',
    kind: 'notification',
    method: 'tools/list',
    doc,
  }
}

/** One built export, exactly as the CLI would write it to disk. */
interface ExportFixture {
  readonly manifest: ReportManifest
  /** The full byte content of `records.jsonl`. */
  readonly recordsText: string
  /** The full byte content of `summary.md`, which the manifest now digests (amendment A1). */
  readonly summaryMarkdown: string
}

async function buildExport(session?: string, extraRows: readonly JournalRecordRow[] = []): Promise<ExportFixture> {
  const handle: SqliteHandle = await openJournalDbShared(journalDbPathFor(journalDir))
  handle.transaction((db) =>
    insertRecordRows(db, [
      rowOf(trafficDoc('session-1', 'a')),
      rowOf(trafficDoc('session-1', 'b')),
      rowOf(trafficDoc('session-2', 'c'), 'session-2'),
      ...extraRows,
    ]),
  )
  const lines: string[] = []
  const report = await buildJournalReport(
    handle,
    session === undefined ? { asOf: AS_OF } : { asOf: AS_OF, session },
    { writeLine: (line) => void lines.push(line) },
  )
  return {
    manifest: withSummary(report.manifest, report.summaryMarkdown),
    recordsText: lines.join(''),
    summaryMarkdown: report.summaryMarkdown,
  }
}

/**
 * Bridges the producing side while amendment A1 lands. The exporter is the
 * one that must stamp `summary` (asserted directly in
 * `report-parse.test.ts`); until it does, the consumer side still has to be
 * testable against the AMENDED v1 contract, so the fixture fills in the same
 * digest the exporter will write. A no-op the moment the exporter stamps it.
 */
function withSummary(manifest: ReportManifest, summaryMarkdown: string): ReportManifest {
  if ((manifest as { summary?: unknown }).summary !== undefined) return manifest
  return {
    ...manifest,
    summary: { file: REPORT_FILES.summary, sha256: sha256Hex(summaryMarkdown) },
  } as ReportManifest
}

/**
 * Feeds the file's BYTES in deliberately awkward slices, so a chunk boundary
 * inside a line, inside the terminator, and inside a multi-byte character
 * are all exercised. Bytes, not text: the digest claim is over the file's
 * exact bytes (finding V2), so a fixture that hands the verifier decoded
 * text could never catch a verifier that decodes.
 */
async function* chunksOf(text: string, size = 7): AsyncGenerator<Uint8Array> {
  yield* byteChunksOf(Buffer.from(text, 'utf8'), size)
}

async function* byteChunksOf(bytes: Uint8Array, size = 7): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size)
  }
}

/** sha256 over raw bytes, computed independently of the code under test. */
function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function checkOf(result: ReportVerifyResult, id: ReportCheckId): ReportCheck {
  const found = result.checks.find((check) => check.id === id)
  if (found === undefined) throw new Error(`no check with id "${id}" in the result`)
  return found
}

async function signWith(manifest: ReportManifest): Promise<{
  readonly manifest: ReportManifest
  readonly signature: ReportSignatureFile
  readonly publicKeyPem: string
}> {
  const pair = await generateAndWriteSigningKeyPair(journalDir)
  const lookup = await loadSigningPrivateKey(journalDir)
  if (!lookup.present) throw new Error('fixture keygen wrote no private key')
  const signed = signReportManifest(lookup.privateKeyPem, manifest)
  return { manifest: signed.manifest, signature: signed.signature, publicKeyPem: pair.publicKeyPem }
}

function keyOf(publicKeyPem: string) {
  const lookup = readVerifyingKey(publicKeyPem)
  if (!lookup.ok) throw new Error(`fixture public key was rejected: ${lookup.message}`)
  return lookup.key
}

describe('verifyReportExport: an intact export', () => {
  test('passes every check and reports the export as signed', async () => {
    const fixture = await buildExport()
    const signed = await signWith(fixture.manifest)

    const result = await verifyReportExport({
      manifest: signed.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'present', signature: signed.signature },
      key: keyOf(signed.publicKeyPem),
    })

    expect(result.failedCount).toBe(0)
    expect(result.couldNotRunCount).toBe(0)
    expect(result.signed).toBe(true)
    for (const check of result.checks) {
      expect(check.status).toBe('passed')
    }
  })

  test('re-folds the chain from the genesis empty-string startPrevHash', async () => {
    const fixture = await buildExport()
    expect(fixture.manifest.chain.recomputable).toBe(true)
    expect(fixture.manifest.chain.startPrevHash).toBe(GENESIS_PREV_HASH)

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'chain-refold').status).toBe('passed')
  })

  test('re-folds from a non-genesis startPrevHash when the manifest names one', async () => {
    const fixture = await buildExport()
    const startPrevHash = 'f'.repeat(64)
    const docs = fixture.recordsText.split('\n').slice(0, -1)
    const expectedHead = docs.reduce((prev, doc) => linkHashOf(prev, doc), startPrevHash)
    const manifest: ReportManifest = {
      ...fixture.manifest,
      chain: {
        ...fixture.manifest.chain,
        startPrevHash,
        head: { seq: 3, recordHash: expectedHead },
      },
    }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'chain-refold').status).toBe('passed')
  })
})

describe('verifyReportExport: tampered record bytes', () => {
  test('one flipped byte fails the digest check', async () => {
    const fixture = await buildExport()
    const tampered = fixture.recordsText.replace('world', 'w0rld')
    expect(tampered).not.toBe(fixture.recordsText)

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(tampered) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'records-digest').status).toBe('failed')
    expect(result.failedCount).toBeGreaterThan(0)
  })

  test('a flipped byte also fails the chain re-fold, not only the digest', async () => {
    const fixture = await buildExport()
    const tampered = fixture.recordsText.replace('world', 'w0rld')

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(tampered) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'chain-refold').status).toBe('failed')
  })

  test('a removed line fails the line-count check', async () => {
    const fixture = await buildExport()
    const lines = fixture.recordsText.split('\n').slice(0, -1)
    const truncated = `${lines.slice(0, -1).join('\n')}\n`

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(truncated) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    const lineCount = checkOf(result, 'records-line-count')
    expect(lineCount.status).toBe('failed')
    expect(lineCount.detail).toContain('2')
  })

  test('an unterminated trailing line is still counted, never silently dropped', async () => {
    const fixture = await buildExport()
    const withoutFinalNewline = fixture.recordsText.slice(0, -1)

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(withoutFinalNewline) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'records-line-count').status).toBe('passed')
    expect(checkOf(result, 'records-digest').status).toBe('failed')
  })
})

describe('verifyReportExport: the signature', () => {
  test('an altered manifest field fails the signature check', async () => {
    const fixture = await buildExport()
    const signed = await signWith(fixture.manifest)
    const altered: ReportManifest = { ...signed.manifest, asOf: '2020-01-01T00:00:00.000Z' }

    const result = await verifyReportExport({
      manifest: altered,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'present', signature: signed.signature },
      key: keyOf(signed.publicKeyPem),
    })

    expect(checkOf(result, 'signature').status).toBe('failed')
  })

  test("a different installation's public key fails the signature check", async () => {
    const fixture = await buildExport()
    const signed = await signWith(fixture.manifest)
    const otherDir = await mkdtemp(join(tmpdir(), 'mcp-journal-other-install-'))
    try {
      const otherPair = await generateAndWriteSigningKeyPair(otherDir)

      const result = await verifyReportExport({
        manifest: signed.manifest,
        records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
        summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
        signature: { status: 'present', signature: signed.signature },
        key: keyOf(otherPair.publicKeyPem),
      })

      const signature = checkOf(result, 'signature')
      expect(signature.status).toBe('failed')
      expect(signature.detail).toContain('fingerprint')
    } finally {
      await rm(otherDir, { recursive: true, force: true })
    }
  })

  test('an absent signature is reported as UNSIGNED, not as a failure', async () => {
    const fixture = await buildExport()

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(result.signed).toBe(false)
    expect(result.failedCount).toBe(0)
    const signature = checkOf(result, 'signature')
    expect(signature.status).toBe('not-applicable')
    expect(signature.detail).toContain('UNSIGNED')
  })

  test('a signature present with no usable key is could-not-run, not a failure', async () => {
    const fixture = await buildExport()
    const signed = await signWith(fixture.manifest)

    const result = await verifyReportExport({
      manifest: signed.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'present', signature: signed.signature },
      key: null,
    })

    expect(checkOf(result, 'signature').status).toBe('could-not-run')
    expect(result.failedCount).toBe(0)
    expect(result.couldNotRunCount).toBe(1)
  })

  test("a signature file naming a different key than the manifest fails", async () => {
    const fixture = await buildExport()
    const signed = await signWith(fixture.manifest)
    const foreign: ReportSignatureFile = { ...signed.signature, keyFingerprint: 'e'.repeat(64) }

    const result = await verifyReportExport({
      manifest: signed.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'present', signature: foreign },
      key: keyOf(signed.publicKeyPem),
    })

    expect(checkOf(result, 'signature').status).toBe('failed')
  })
})

describe('verifyReportExport: manifest self-consistency', () => {
  test('lineCount disagreeing with counts.records is a FAILED check, not malformed input', async () => {
    const fixture = await buildExport()
    const manifest: ReportManifest = {
      ...fixture.manifest,
      counts: { ...fixture.manifest.counts, records: 99 },
    }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    const consistency = checkOf(result, 'manifest-consistency')
    expect(consistency.status).toBe('failed')
    expect(consistency.detail).toContain('counts.records')
  })

  test('verifiedAtExport disagreeing with chain.break is a FAILED check', async () => {
    const fixture = await buildExport()
    const manifest: ReportManifest = {
      ...fixture.manifest,
      chain: { ...fixture.manifest.chain, verifiedAtExport: false },
    }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'manifest-consistency').status).toBe('failed')
  })
})

describe('verifyReportExport: what cannot be checked offline', () => {
  test('a session-scoped export skips the chain re-fold and says why', async () => {
    const fixture = await buildExport('session-1')
    expect(fixture.manifest.chain.recomputable).toBe(false)

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    const refold = checkOf(result, 'chain-refold')
    expect(refold.status).toBe('not-applicable')
    expect(refold.detail).toContain('session')
    expect(result.failedCount).toBe(0)
  })

  /**
   * AMENDED (wave-5 review, amendment A6). This test used to assert that a
   * MISSING records.jsonl left the digest and line-count checks
   * could-not-run with `failedCount` 0 -- i.e. exit 1, "retry later". That
   * expectation was wrong: the manifest NAMES records.jsonl and states a
   * digest and a line count over it, so the file's absence contradicts a
   * positive claim and is evidence the bundle was stripped. It also put an
   * auditor's `verify --report || alert` pipeline exactly the wrong way
   * round -- deleting the evidence file scored lower than deleting the
   * summary. Only what the manifest does NOT claim (the directory itself,
   * report.json) stays could-not-run. The unreadable-but-present case, split
   * into its own test below, is genuinely could-not-run: that is a fact
   * about this machine, not about the export.
   */
  test('a MISSING records file fails the checks that are claims about that file', async () => {
    const fixture = await buildExport()

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'missing' },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'records-digest').status).toBe('failed')
    expect(checkOf(result, 'records-digest').detail).toContain(fixture.manifest.records.sha256)
    expect(checkOf(result, 'records-line-count').status).toBe('failed')
    // Not claims ABOUT the file, only claims that NEED it: nothing was
    // re-derived and nothing was folded, which is could-not-run, not a
    // finding of disagreement.
    expect(checkOf(result, 'recomputed-claims').status).toBe('could-not-run')
    expect(checkOf(result, 'chain-refold').status).toBe('could-not-run')
  })

  test('an UNREADABLE (present) records file marks every records check could-not-run, not failed', async () => {
    const fixture = await buildExport()

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'unreadable', reason: 'EACCES: permission denied' },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'records-digest').status).toBe('could-not-run')
    expect(checkOf(result, 'records-line-count').status).toBe('could-not-run')
    expect(checkOf(result, 'recomputed-claims').status).toBe('could-not-run')
    expect(checkOf(result, 'chain-refold').status).toBe('could-not-run')
    expect(result.failedCount).toBe(0)
  })

  test('a self-inconsistent manifest still fails even when the records file is unreadable', async () => {
    const fixture = await buildExport()
    const manifest: ReportManifest = {
      ...fixture.manifest,
      counts: { ...fixture.manifest.counts, records: 99 },
    }

    const result = await verifyReportExport({
      manifest,
      // `unreadable`, not `missing`: a missing file is now a finding of its
      // own (amendment A6), and this test is about the manifest's internal
      // contradiction surviving on its own.
      records: { status: 'unreadable', reason: 'EACCES: permission denied' },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(result.failedCount).toBe(1)
  })
})

describe('readVerifyingKey', () => {
  test('accepts a real signing.pub PEM and derives its fingerprint', async () => {
    const pair = await generateAndWriteSigningKeyPair(journalDir)

    const lookup = readVerifyingKey(pair.publicKeyPem)

    expect(lookup.ok).toBe(true)
    if (lookup.ok) expect(lookup.key.fingerprint).toBe(pair.publicKeyFingerprint)
  })

  test('rejects a non-PEM file without throwing', () => {
    const lookup = readVerifyingKey('this is not a key')

    expect(lookup.ok).toBe(false)
    if (!lookup.ok) expect(lookup.message.length).toBeGreaterThan(0)
  })
})

/**
 * The digest is a BYTE check (finding V2 -- CRITICAL). The verifier used to
 * open `records.jsonl` as UTF-8 text and hash the decoded chunks, which is
 * lossy: every invalid byte decodes to U+FFFD, so two byte-different files
 * collapsed onto one digest and BOTH passed against one signature. That
 * voids "sha256 hex over the EXACT bytes", the sentence this command prints
 * and the README repeats.
 */
describe('verifyReportExport: the digest is over bytes, not decoded text', () => {
  test('two files differing only in one invalid utf-8 byte cannot both pass', async () => {
    const fixture = await buildExport()
    const base = Buffer.from(fixture.recordsText, 'utf8')
    const withEightZero = Buffer.from(base)
    withEightZero[10] = 0x80
    const withFF = Buffer.from(base)
    withFF[10] = 0xff
    const manifest: ReportManifest = {
      ...fixture.manifest,
      records: { ...fixture.manifest.records, sha256: sha256OfBytes(withEightZero) },
    }

    const matching = await verifyReportExport({
      manifest,
      records: { status: 'present', chunks: byteChunksOf(withEightZero) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })
    const other = await verifyReportExport({
      manifest,
      records: { status: 'present', chunks: byteChunksOf(withFF) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(matching, 'records-digest').status).toBe('passed')
    expect(checkOf(other, 'records-digest').status).toBe('failed')
  })

  test('lines are split on the byte 0x0a, so a chunk boundary inside a character changes nothing', async () => {
    const fixture = await buildExport()

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      // 1-byte chunks: every multi-byte character in "client→server" is split.
      records: { status: 'present', chunks: chunksOf(fixture.recordsText, 1) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown, 1) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'records-digest').status).toBe('passed')
    expect(checkOf(result, 'records-line-count').status).toBe('passed')
    expect(checkOf(result, 'chain-refold').status).toBe('passed')
  })
})

/**
 * `chain.recomputable` recomputed (finding V3 / amendment A2). It is a pure
 * function of four fields the manifest already carries
 * (`isChainRecomputable`), so a manifest that merely ASSERTS `false` was an
 * attacker-settable off switch for the chain re-fold: drop a record, fix the
 * digest and the counts, flip the flag, remove the signature, and the whole
 * thing verified clean.
 */
describe('verifyReportExport: the recomputable flag is recomputed', () => {
  test('a manifest claiming NOT recomputable while all four conditions hold FAILS', async () => {
    const fixture = await buildExport()
    expect(fixture.manifest.chain.recomputable).toBe(true)
    const { startPrevHash: _dropped, ...chainWithoutStart } = fixture.manifest.chain
    const manifest: ReportManifest = {
      ...fixture.manifest,
      chain: { ...chainWithoutStart, recomputable: false },
    }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    const consistency = checkOf(result, 'manifest-consistency')
    expect(consistency.status).toBe('failed')
    expect(consistency.detail).toContain('chain.recomputable')
  })

  test('a session-scoped export is legitimately not recomputable and still passes', async () => {
    const fixture = await buildExport('session-1')

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'manifest-consistency').status).toBe('passed')
  })
})

/**
 * The substantive claims, re-derived (finding V4 / amendment A2). A
 * signature proves only that the AUDITED PARTY authored the numbers; the one
 * class of claim an auditor can independently establish is arithmetic over
 * the bytes they were handed, and none of it was being established. A signed
 * report claiming 3200 allows over records holding 400 denials passed.
 */
describe('verifyReportExport: claims recomputed from records.jsonl', () => {
  function decisionRow(outcome: string, sessionId = 'session-1', withPolicyHash = true): JournalRecordRow {
    const doc = JSON.stringify({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      ts: '2026-08-18T00:00:01.000Z',
      sessionId,
      direction: 'client→server',
      kind: 'decision',
      method: 'tools/call',
      payload: null,
      decision: {
        outcome,
        rule: 'read-allow',
        serverName: 'files',
        toolName: 'files.read',
        toolClass: 'read',
        quarantineState: 'known',
        argsHash: 'a'.repeat(64),
        ...(withPolicyHash ? { policyHash: 'p'.repeat(64) } : {}),
      },
    })
    return { ...rowOf(doc, sessionId), kind: 'decision', method: 'tools/call' }
  }

  async function decisionFixture(): Promise<ExportFixture> {
    return buildExport(undefined, [
      decisionRow('allow'),
      decisionRow('deny'),
      decisionRow('deny', 'session-2'),
      decisionRow('allow', 'session-1', false),
    ])
  }

  test('an untouched export passes the recomputation', async () => {
    const fixture = await decisionFixture()
    expect(fixture.manifest.counts.decisions).toBe(4)

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'recomputed-claims').status).toBe('passed')
  })

  test('an inflated byOutcome tally FAILS against the records actually exported', async () => {
    const fixture = await decisionFixture()
    const manifest: ReportManifest = {
      ...fixture.manifest,
      counts: { ...fixture.manifest.counts, decisions: 3200, byOutcome: { allow: 3200 } },
    }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    const recomputed = checkOf(result, 'recomputed-claims')
    expect(recomputed.status).toBe('failed')
    expect(recomputed.detail).toContain('byOutcome')
  })

  test('a wrong counts.decisions FAILS', async () => {
    const fixture = await decisionFixture()
    const manifest: ReportManifest = {
      ...fixture.manifest,
      counts: { ...fixture.manifest.counts, decisions: 3, byOutcome: { allow: 2, deny: 1 } },
    }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'recomputed-claims').status).toBe('failed')
  })

  test('a wrong counts.unprovenanced FAILS', async () => {
    const fixture = await decisionFixture()
    const manifest: ReportManifest = {
      ...fixture.manifest,
      counts: { ...fixture.manifest.counts, unprovenanced: 0 },
    }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    const recomputed = checkOf(result, 'recomputed-claims')
    expect(recomputed.status).toBe('failed')
    expect(recomputed.detail).toContain('unprovenanced')
  })

  test('a wrong counts.unparsableRows FAILS', async () => {
    const fixture = await buildExport()
    const manifest: ReportManifest = {
      ...fixture.manifest,
      counts: { ...fixture.manifest.counts, unparsableRows: 2 },
    }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    const recomputed = checkOf(result, 'recomputed-claims')
    expect(recomputed.status).toBe('failed')
    expect(recomputed.detail).toContain('unparsableRows')
  })

  test('a sessionIds list that HIDES a session present in the records FAILS', async () => {
    const fixture = await buildExport()
    const manifest: ReportManifest = { ...fixture.manifest, sessionIds: ['session-1'] }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    const recomputed = checkOf(result, 'recomputed-claims')
    expect(recomputed.status).toBe('failed')
    expect(recomputed.detail).toContain('session-2')
  })

  test('says plainly that seqRange was NOT re-derived, since doc bytes cannot show it', async () => {
    const fixture = await buildExport()

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'recomputed-claims').detail).toContain('seqRange')
  })
})

/**
 * The manifest-internal cross-checks amendment A2 adds. Each one is a sum or
 * an ordering the manifest states twice; a careless (or selective) edit
 * moves one copy and leaves the other.
 */
describe('verifyReportExport: manifest-internal arithmetic', () => {
  test('byOutcome not summing to counts.decisions FAILS', async () => {
    const fixture = await buildExport()
    const manifest: ReportManifest = {
      ...fixture.manifest,
      counts: { ...fixture.manifest.counts, decisions: 2, byOutcome: { allow: 1 } },
    }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'missing' },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    const consistency = checkOf(result, 'manifest-consistency')
    expect(consistency.status).toBe('failed')
    expect(consistency.detail).toContain('byOutcome')
  })

  test('more decisions than records FAILS', async () => {
    const fixture = await buildExport()
    const manifest: ReportManifest = {
      ...fixture.manifest,
      counts: { ...fixture.manifest.counts, decisions: 99, byOutcome: { allow: 99 } },
    }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'missing' },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'manifest-consistency').detail).toContain('counts.decisions')
  })

  test('a seqRange span narrower than the record count FAILS', async () => {
    const fixture = await buildExport()
    const manifest: ReportManifest = { ...fixture.manifest, seqRange: { firstSeq: 1, lastSeq: 1 } }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'missing' },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'manifest-consistency').detail).toContain('seqRange')
  })

  test('a chain head beyond the exported seqRange FAILS', async () => {
    const fixture = await buildExport()
    const head = fixture.manifest.chain.head
    if (head === null) throw new Error('fixture has no chain head')
    const manifest: ReportManifest = {
      ...fixture.manifest,
      chain: { ...fixture.manifest.chain, head: { ...head, seq: 9999 } },
    }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'missing' },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'manifest-consistency').detail).toContain('chain.head')
  })

  test('an empty sessionIds list beside a non-empty export FAILS', async () => {
    const fixture = await buildExport()
    const manifest: ReportManifest = { ...fixture.manifest, sessionIds: [] }

    const result = await verifyReportExport({
      manifest,
      records: { status: 'missing' },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'manifest-consistency').detail).toContain('sessionIds')
  })
})

/**
 * `summary.md` (amendment A1 / finding V12). It is the only artifact a
 * non-technical reader consumes and it used to sit outside every integrity
 * mechanism: it could be rewritten -- or deleted outright -- with the report
 * still verifying clean.
 */
describe('verifyReportExport: the summary digest', () => {
  test('an untouched summary passes', async () => {
    const fixture = await buildExport()

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'summary-digest').status).toBe('passed')
  })

  test('an edited summary FAILS', async () => {
    const fixture = await buildExport()
    const edited = `${fixture.summaryMarkdown}\nAll decisions were approved by the auditor.\n`

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(edited) },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'summary-digest').status).toBe('failed')
  })

  test('a DELETED summary FAILS -- the manifest claims a file that is not there', async () => {
    const fixture = await buildExport()

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'missing' },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'summary-digest').status).toBe('failed')
  })

  test('an unreadable (not absent) summary is could-not-run, not a finding', async () => {
    const fixture = await buildExport()

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'unreadable', reason: 'EACCES: permission denied' },
      signature: { status: 'absent' },
      key: null,
    })

    expect(checkOf(result, 'summary-digest').status).toBe('could-not-run')
    expect(result.failedCount).toBe(0)
  })
})

/**
 * A manifest that NAMES a key with no signature file beside it (finding V6 /
 * amendment A3). `signatureVerdict` used to return not-applicable the moment
 * `signature === null`, without ever consulting `manifest.keyFingerprint` --
 * so removing `signature.json` from a signed export printed a clean UNSIGNED
 * PASS. It is also the end state of an export that died between the two
 * writes, which an auditor must be told about rather than shown as normal.
 */
describe('verifyReportExport: a manifest naming a key with no signature file', () => {
  test('FAILS and names the fingerprint the manifest claims', async () => {
    const fixture = await buildExport()
    const signed = await signWith(fixture.manifest)
    expect(signed.manifest.keyFingerprint).toBeDefined()

    const result = await verifyReportExport({
      manifest: signed.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    const signature = checkOf(result, 'signature')
    expect(signature.status).toBe('failed')
    expect(signature.detail).toContain(signed.manifest.keyFingerprint as string)
  })
})

/**
 * A malformed `signature.json` must not suppress the byte checks (finding V5
 * / amendment A5). The CLI used to return could-not-run BEFORE the checks
 * ran at all: replace `records.jsonl` AND truncate `signature.json` and the
 * verifier exited 1 with empty stdout, having checked not one byte. A
 * tamperer who corrupted both files got 1 instead of 2.
 */
describe('verifyReportExport: an unreadable signature file', () => {
  test('makes the signature check could-not-run while every byte check still runs', async () => {
    const fixture = await buildExport()

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'unreadable', reason: 'not valid JSON (Unexpected end of JSON input)' },
      key: null,
    })

    expect(checkOf(result, 'signature').status).toBe('could-not-run')
    expect(checkOf(result, 'records-digest').status).toBe('passed')
    expect(result.signed).toBe(false)
  })

  test('a FAILED digest still outranks the unreadable signature', async () => {
    const fixture = await buildExport()

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf('{"not":"the exported records"}\n') },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'unreadable', reason: 'truncated' },
      key: null,
    })

    expect(checkOf(result, 'records-digest').status).toBe('failed')
    expect(result.failedCount).toBeGreaterThan(0)
  })
})

/**
 * `--require-signature` (amendment A4 / finding V11). A scripted `verify
 * --report && accept` cannot see the UNSIGNED banner, so a pipeline that
 * demands attribution needs a switch that turns "unsigned" into a finding.
 * Default behaviour is unchanged.
 */
describe('verifyReportExport: requireSignature', () => {
  test('turns an UNSIGNED export into a FAILED check', async () => {
    const fixture = await buildExport()

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
      requireSignature: true,
    })

    const signature = checkOf(result, 'signature')
    expect(signature.status).toBe('failed')
    expect(signature.detail).toContain('--require-signature')
  })

  test('turns an unverifiable (no key) signature into a FAILED check', async () => {
    const fixture = await buildExport()
    const signed = await signWith(fixture.manifest)

    const result = await verifyReportExport({
      manifest: signed.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'present', signature: signed.signature },
      key: null,
      requireSignature: true,
    })

    expect(checkOf(result, 'signature').status).toBe('failed')
  })

  test('leaves a properly signed export passing', async () => {
    const fixture = await buildExport()
    const signed = await signWith(fixture.manifest)

    const result = await verifyReportExport({
      manifest: signed.manifest,
      records: { status: 'present', chunks: chunksOf(fixture.recordsText) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'present', signature: signed.signature },
      key: keyOf(signed.publicKeyPem),
      requireSignature: true,
    })

    expect(result.failedCount).toBe(0)
  })
})

/**
 * The line splitter is bounded (finding V7). `pending += chunk` held a whole
 * line, so a `records.jsonl` with no newline was held whole: a 200 MB
 * single-line file peaked at 1.41 GB RSS over 58 s on the machine the module
 * doc singles out as LEAST likely to have the memory, and one crafted file
 * in a hostile bundle triggers it.
 */
describe('verifyReportExport: an unreasonably long line', () => {
  test('is refused as an explicit verdict rather than being buffered whole', async () => {
    const fixture = await buildExport()
    const overlong = Buffer.alloc(MAX_RECORD_LINE_BYTES + 1, 0x61)

    const result = await verifyReportExport({
      manifest: fixture.manifest,
      records: { status: 'present', chunks: byteChunksOf(overlong, 1 << 16) },
      summary: { status: 'present', chunks: chunksOf(fixture.summaryMarkdown) },
      signature: { status: 'absent' },
      key: null,
    })

    const lineCount = checkOf(result, 'records-line-count')
    expect(lineCount.status).toBe('could-not-run')
    expect(lineCount.detail).toContain('line')
    expect(checkOf(result, 'chain-refold').status).toBe('could-not-run')
    // The digest does NOT need line structure, so it still answers -- and
    // says the bytes are not the manifest's bytes.
    expect(checkOf(result, 'records-digest').status).toBe('failed')
  })
})

/**
 * A PRIVATE key handed to `--pub` (finding V8). `createPublicKey` happily
 * derives a public key from a private PEM, so `verify --report --pub
 * ~/.mcp-journal/signing.key` printed PASS -- and an operator who discovers
 * that `signing.key` "works" has a plausible route to shipping the
 * installation's private key to an auditor.
 */
describe('readVerifyingKey: a private key is refused', () => {
  test('refuses a PKCS8 private PEM by name instead of deriving its public half', async () => {
    await generateAndWriteSigningKeyPair(journalDir)
    const lookup = await loadSigningPrivateKey(journalDir)
    if (!lookup.present) throw new Error('fixture keygen wrote no private key')

    const result = readVerifyingKey(lookup.privateKeyPem)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('PRIVATE KEY')
  })
})

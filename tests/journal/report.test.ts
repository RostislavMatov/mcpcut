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
import {
  AS_OF_CONTRACT,
  REPORT_FORMAT_VERSION,
  ReportExportError,
  buildJournalReport,
  type ReportManifest,
  type ReportRecordSink,
} from '../../src/journal/report.js'
import {
  REPORT_SIGNATURE_FORMAT_VERSION,
  signReportManifest,
  verifyReportManifestSignature,
} from '../../src/journal/report-signing.js'
import { generateAndWriteSigningKeyPair } from '../../src/journal/signing.js'
import { sha256Hex } from '../../src/policy/hash.js'
import { openSqlite, type SqliteHandle } from '../../src/store/sqlite.js'

/**
 * `src/journal/report.ts` (M5 wave 5, tasks 5.1/5.2/5.5): the audit report's
 * format core -- manifest, exported record lines, `summary.md`. Real tmpdir
 * SQLite databases throughout, no mocks (project rule). The CLI half
 * (`export --report`, `verify --report`) is tested in `tests/cli/`.
 */

const AS_OF = '2026-08-18T12:00:00.000Z'

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-report-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

async function openHandle(): Promise<SqliteHandle> {
  return openJournalDbShared(journalDbPathFor(journalDir))
}

/**
 * A SECOND connection to the same database -- what a running control plane
 * actually is while an operator exports. `openJournalDbShared` memoizes one
 * connection per path, so it cannot express "another process is writing";
 * `openSqlite` opens a genuinely separate one with the journal's own
 * durability profile.
 */
async function openWriterConnection(): Promise<SqliteHandle> {
  return openSqlite(journalDbPathFor(journalDir), { synchronous: 'full' })
}

/** Collects every line the builder emits, exactly as the CLI's file writer would receive it. */
function collectingSink(): ReportRecordSink & { readonly lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    writeLine(line: string): void {
      lines.push(line)
    },
  }
}

function rowOf(doc: string, overrides: Partial<JournalRecordRow> = {}): JournalRecordRow {
  return {
    sessionId: 'session-1',
    recordId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: '2026-08-18T00:00:00.000Z',
    direction: 'client→server',
    kind: 'notification',
    method: 'tools/call',
    doc,
    ...overrides,
  }
}

function trafficDoc(sessionId = 'session-1'): string {
  return JSON.stringify({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: '2026-08-18T00:00:00.000Z',
    sessionId,
    direction: 'client→server',
    kind: 'notification',
    method: 'tools/list',
    payload: { hello: 'world' },
  })
}

interface DecisionOverrides {
  readonly sessionId?: string
  readonly outcome?: string
  readonly actor?: string
  readonly policyHash?: string | null
  readonly grantsHash?: string
  readonly toolName?: string
  readonly rule?: string
}

function decisionDoc(overrides: DecisionOverrides = {}): string {
  const policyHash = overrides.policyHash === null ? {} : { policyHash: overrides.policyHash ?? 'p'.repeat(64) }
  return JSON.stringify({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    ts: '2026-08-18T00:00:01.000Z',
    sessionId: overrides.sessionId ?? 'session-1',
    direction: 'client→server',
    kind: 'decision',
    method: 'tools/call',
    payload: null,
    decision: {
      outcome: overrides.outcome ?? 'allow',
      rule: overrides.rule ?? 'read-allow',
      serverName: 'files',
      toolName: overrides.toolName ?? 'files.read',
      toolClass: 'read',
      quarantineState: 'known',
      argsHash: 'a'.repeat(64),
      ...(overrides.actor === undefined ? {} : { actor: overrides.actor }),
      ...(overrides.grantsHash === undefined ? {} : { grantsHash: overrides.grantsHash }),
      ...policyHash,
    },
  })
}

/** Inserts a row with NULL prev_hash/record_hash directly -- the only way to create a pre-chain row on demand. */
function insertLegacyRow(handle: SqliteHandle, row: JournalRecordRow): void {
  handle.db
    .prepare(
      'INSERT INTO journal_records (session_id, record_id, ts, direction, kind, method, doc) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(row.sessionId, row.recordId, row.ts, row.direction, row.kind, row.method, row.doc)
}

function insertChained(handle: SqliteHandle, rows: readonly JournalRecordRow[]): void {
  handle.transaction((db) => insertRecordRows(db, rows))
}

describe('buildJournalReport: empty journal', () => {
  test('produces an empty records file, zeroed counts and a null seq range', async () => {
    const handle = await openHandle()
    const sink = collectingSink()

    const report = await buildJournalReport(handle, { now: () => AS_OF }, sink)

    expect(sink.lines).toEqual([])
    expect(report.manifest.formatVersion).toBe(REPORT_FORMAT_VERSION)
    expect(report.manifest.asOf).toBe(AS_OF)
    expect(report.manifest.scope).toEqual({ session: null })
    expect(report.manifest.records).toEqual({
      file: 'records.jsonl',
      lineCount: 0,
      sha256: sha256Hex(''),
    })
    expect(report.manifest.seqRange).toBeNull()
    expect(report.manifest.sessionIds).toEqual([])
    expect(report.manifest.counts).toEqual({
      records: 0,
      decisions: 0,
      unparsableRows: 0,
      unprovenanced: 0,
      byOutcome: {},
    })
  })

  test('embeds the as-of contract verbatim', async () => {
    const handle = await openHandle()

    const report = await buildJournalReport(handle, { now: () => AS_OF }, collectingSink())

    expect(report.manifest.contract).toBe(AS_OF_CONTRACT)
  })
})

describe('buildJournalReport: whole-journal export', () => {
  test('emits every doc verbatim, in seq order, newline-terminated', async () => {
    const handle = await openHandle()
    const docs = [trafficDoc(), decisionDoc(), trafficDoc('session-2')]
    insertChained(handle, [
      rowOf(docs[0] as string),
      rowOf(docs[1] as string, { kind: 'decision' }),
      rowOf(docs[2] as string, { sessionId: 'session-2' }),
    ])
    const sink = collectingSink()

    const report = await buildJournalReport(handle, { now: () => AS_OF }, sink)

    expect(sink.lines).toEqual(docs.map((doc) => `${doc}\n`))
    expect(report.manifest.records.lineCount).toBe(3)
    expect(report.manifest.seqRange).toEqual({ firstSeq: 1, lastSeq: 3 })
    expect(report.manifest.sessionIds).toEqual(['session-1', 'session-2'])
  })

  test('records.sha256 is the digest of the exact bytes emitted to the sink', async () => {
    const handle = await openHandle()
    insertChained(handle, [rowOf(trafficDoc()), rowOf(decisionDoc(), { kind: 'decision' })])
    const sink = collectingSink()

    const report = await buildJournalReport(handle, { now: () => AS_OF }, sink)

    expect(report.manifest.records.sha256).toBe(sha256Hex(sink.lines.join('')))
    expect(report.manifest.records.lineCount).toBe(sink.lines.length)
  })

  test('awaits a sink that signals backpressure with a promise, keeping line order', async () => {
    const handle = await openHandle()
    insertChained(handle, [rowOf(trafficDoc()), rowOf(trafficDoc())])
    const lines: string[] = []
    const sink: ReportRecordSink = {
      writeLine(line: string): Promise<void> {
        return new Promise((resolve) =>
          setTimeout(() => {
            lines.push(line)
            resolve()
          }, 0),
        )
      },
    }

    const report = await buildJournalReport(handle, { now: () => AS_OF }, sink)

    expect(lines).toHaveLength(2)
    expect(report.manifest.records.sha256).toBe(sha256Hex(lines.join('')))
  })
})

describe('buildJournalReport: --session scope', () => {
  test('exports only that session, and names it as the scope', async () => {
    const handle = await openHandle()
    insertChained(handle, [
      rowOf(trafficDoc('session-1')),
      rowOf(trafficDoc('session-2'), { sessionId: 'session-2' }),
      rowOf(trafficDoc('session-1')),
    ])
    const sink = collectingSink()

    const report = await buildJournalReport(handle, { now: () => AS_OF, session: 'session-1' }, sink)

    expect(sink.lines).toEqual([`${trafficDoc('session-1')}\n`, `${trafficDoc('session-1')}\n`])
    expect(report.manifest.scope).toEqual({ session: 'session-1' })
    expect(report.manifest.sessionIds).toEqual(['session-1'])
    expect(report.manifest.seqRange).toEqual({ firstSeq: 1, lastSeq: 3 })
  })

  test('a session with no rows exports nothing and lists no session ids', async () => {
    const handle = await openHandle()
    insertChained(handle, [rowOf(trafficDoc())])
    const sink = collectingSink()

    const report = await buildJournalReport(handle, { now: () => AS_OF, session: 'absent' }, sink)

    expect(sink.lines).toEqual([])
    expect(report.manifest.seqRange).toBeNull()
    expect(report.manifest.sessionIds).toEqual([])
    expect(report.manifest.records.sha256).toBe(sha256Hex(''))
  })
})

describe('buildJournalReport: counts', () => {
  test('counts decisions and tallies byOutcome with keys in ascending order', async () => {
    const handle = await openHandle()
    insertChained(handle, [
      rowOf(decisionDoc({ outcome: 'deny' }), { kind: 'decision' }),
      rowOf(decisionDoc({ outcome: 'allow' }), { kind: 'decision' }),
      rowOf(decisionDoc({ outcome: 'allow' }), { kind: 'decision' }),
      rowOf(trafficDoc()),
    ])

    const report = await buildJournalReport(handle, { now: () => AS_OF }, collectingSink())

    expect(report.manifest.counts.records).toBe(4)
    expect(report.manifest.counts.decisions).toBe(3)
    expect(report.manifest.counts.byOutcome).toEqual({ allow: 2, deny: 1 })
    expect(Object.keys(report.manifest.counts.byOutcome)).toEqual(['allow', 'deny'])
  })

  test('counts a malformed doc row as unparsable and still exports it verbatim', async () => {
    const handle = await openHandle()
    const malformed = '{"not":"a record"'
    insertChained(handle, [rowOf(trafficDoc()), rowOf(malformed)])
    const sink = collectingSink()

    const report = await buildJournalReport(handle, { now: () => AS_OF }, sink)

    expect(sink.lines).toEqual([`${trafficDoc()}\n`, `${malformed}\n`])
    expect(report.manifest.counts.unparsableRows).toBe(1)
    expect(report.manifest.counts.records).toBe(2)
    expect(report.manifest.records.sha256).toBe(sha256Hex(sink.lines.join('')))
  })

  test('counts a decision record with no policyHash as unprovenanced', async () => {
    const handle = await openHandle()
    insertChained(handle, [
      rowOf(decisionDoc({ policyHash: null }), { kind: 'decision' }),
      rowOf(decisionDoc(), { kind: 'decision' }),
    ])

    const report = await buildJournalReport(handle, { now: () => AS_OF }, collectingSink())

    expect(report.manifest.counts.decisions).toBe(2)
    expect(report.manifest.counts.unprovenanced).toBe(1)
  })
})

describe('buildJournalReport: chain block', () => {
  test('reports a clean, fully attested whole-journal export as recomputable', async () => {
    const handle = await openHandle()
    insertChained(handle, [rowOf(trafficDoc()), rowOf(decisionDoc(), { kind: 'decision' })])

    const report = await buildJournalReport(handle, { now: () => AS_OF }, collectingSink())

    expect(report.manifest.chain.verifiedAtExport).toBe(true)
    expect(report.manifest.chain.break).toBeNull()
    expect(report.manifest.chain.unattestedCount).toBe(0)
    expect(report.manifest.chain.head).not.toBeNull()
    expect(report.manifest.chain.recomputable).toBe(true)
    expect(report.manifest.chain.startPrevHash).toBe(GENESIS_PREV_HASH)
  })

  test('an offline re-fold of linkHashOf over the emitted lines reproduces chain.head.recordHash', async () => {
    const handle = await openHandle()
    insertChained(handle, [
      rowOf(trafficDoc()),
      rowOf(decisionDoc(), { kind: 'decision' }),
      rowOf(trafficDoc('session-2'), { sessionId: 'session-2' }),
    ])
    const sink = collectingSink()

    const report = await buildJournalReport(handle, { now: () => AS_OF }, sink)

    // Exactly what an auditor with only the export directory can do.
    const emitted = sink.lines.join('')
    const docLines = emitted.split('\n').slice(0, -1)
    let folded = report.manifest.chain.startPrevHash as string
    for (const doc of docLines) {
      folded = linkHashOf(folded, doc)
    }
    expect(folded).toBe(report.manifest.chain.head?.recordHash)
  })

  test('is not recomputable when the export is scoped to a session', async () => {
    const handle = await openHandle()
    insertChained(handle, [rowOf(trafficDoc())])

    const report = await buildJournalReport(handle, { now: () => AS_OF, session: 'session-1' }, collectingSink())

    expect(report.manifest.chain.recomputable).toBe(false)
    expect(report.manifest.chain.startPrevHash).toBeUndefined()
  })

  test('is not recomputable when pre-chain (NULL-hash) rows are present', async () => {
    const handle = await openHandle()
    insertLegacyRow(handle, rowOf(trafficDoc()))
    insertChained(handle, [rowOf(decisionDoc(), { kind: 'decision' })])

    const report = await buildJournalReport(handle, { now: () => AS_OF }, collectingSink())

    expect(report.manifest.chain.unattestedCount).toBe(1)
    expect(report.manifest.chain.recomputable).toBe(false)
    expect(report.manifest.chain.startPrevHash).toBeUndefined()
    expect(report.manifest.chain.verifiedAtExport).toBe(true)
  })

  test('is not recomputable when the chain is broken, and names the break', async () => {
    const handle = await openHandle()
    insertChained(handle, [rowOf(trafficDoc()), rowOf(trafficDoc()), rowOf(trafficDoc())])
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = 2').run('{"tampered":true}')

    const report = await buildJournalReport(handle, { now: () => AS_OF }, collectingSink())

    expect(report.manifest.chain.break).toEqual({ seq: 2, reason: 'modified' })
    expect(report.manifest.chain.verifiedAtExport).toBe(false)
    expect(report.manifest.chain.recomputable).toBe(false)
    expect(report.manifest.chain.startPrevHash).toBeUndefined()
  })

  test('is not recomputable when there is no chain head at all', async () => {
    const handle = await openHandle()
    insertLegacyRow(handle, rowOf(trafficDoc()))

    const report = await buildJournalReport(handle, { now: () => AS_OF }, collectingSink())

    expect(report.manifest.chain.head).toBeNull()
    expect(report.manifest.chain.recomputable).toBe(false)
  })
})

describe('report manifest signing', () => {
  async function manifestOf(): Promise<ReportManifest> {
    const handle = await openHandle()
    insertChained(handle, [rowOf(decisionDoc(), { kind: 'decision' })])
    const report = await buildJournalReport(handle, { now: () => AS_OF }, collectingSink())
    return report.manifest
  }

  test('signs the manifest and verifies it with the matching public key', async () => {
    const keys = await generateAndWriteSigningKeyPair(join(journalDir, 'keys'))
    const manifest = await manifestOf()

    const signed = signReportManifest(await privatePemOf(keys.privateKeyPath), manifest)

    expect(signed.signature.formatVersion).toBe(REPORT_SIGNATURE_FORMAT_VERSION)
    expect(signed.signature.algorithm).toBe('ed25519')
    expect(signed.signature.keyFingerprint).toBe(keys.publicKeyFingerprint)
    expect(signed.manifest.keyFingerprint).toBe(keys.publicKeyFingerprint)
    expect(
      verifyReportManifestSignature(keys.publicKeyPem, signed.manifest, signed.signature.signatureBase64),
    ).toBe(true)
  })

  test('derives keyFingerprint from the signing key itself, ignoring any caller-supplied claim', async () => {
    const keys = await generateAndWriteSigningKeyPair(join(journalDir, 'keys'))
    const manifest = await manifestOf()
    const lying: ReportManifest = { ...manifest, keyFingerprint: 'f'.repeat(64) }

    const signed = signReportManifest(await privatePemOf(keys.privateKeyPath), lying)

    expect(signed.manifest.keyFingerprint).toBe(keys.publicKeyFingerprint)
  })

  test('fails verification after a single manifest field is altered', async () => {
    const keys = await generateAndWriteSigningKeyPair(join(journalDir, 'keys'))
    const manifest = await manifestOf()
    const signed = signReportManifest(await privatePemOf(keys.privateKeyPath), manifest)

    const tampered: ReportManifest = { ...signed.manifest, asOf: '2020-01-01T00:00:00.000Z' }

    expect(
      verifyReportManifestSignature(keys.publicKeyPem, tampered, signed.signature.signatureBase64),
    ).toBe(false)
  })

  test('fails verification against a different key pair', async () => {
    const keys = await generateAndWriteSigningKeyPair(join(journalDir, 'keys'))
    const other = await generateAndWriteSigningKeyPair(join(journalDir, 'other'))
    const manifest = await manifestOf()
    const signed = signReportManifest(await privatePemOf(keys.privateKeyPath), manifest)

    expect(
      verifyReportManifestSignature(other.publicKeyPem, signed.manifest, signed.signature.signatureBase64),
    ).toBe(false)
  })

  test('returns false rather than throwing on malformed signature material', async () => {
    const keys = await generateAndWriteSigningKeyPair(join(journalDir, 'keys'))
    const manifest = await manifestOf()

    expect(verifyReportManifestSignature(keys.publicKeyPem, manifest, 'not-base64!!')).toBe(false)
    expect(verifyReportManifestSignature('not a pem', manifest, 'AAAA')).toBe(false)
  })
})

async function privatePemOf(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}

/**
 * Wave-5 review findings, producer side. Each block below is the reproduction
 * the reviewers ran, turned into a test: the failure it names was observed
 * against the pre-fix build before the fix was written.
 */

describe('buildJournalReport: one consistent read view (P1)', () => {
  test('a row committed by another connection mid-stream is not attested by the export', async () => {
    // REPRODUCED: on a running control plane the stream, verifyChain() and
    // latestAttestedChainHead() were three separate autocommit reads, so the
    // manifest's head named a record that is NOT in records.jsonl and the
    // auditor's verifier printed "the exported records do not chain to the
    // head this report attests to" -- the product accusing its own operator.
    const handle = await openHandle()
    insertChained(handle, [rowOf(trafficDoc()), rowOf(trafficDoc())])
    const writer = await openWriterConnection()
    try {
      const lines: string[] = []
      const sink: ReportRecordSink = {
        writeLine(line: string): void {
          lines.push(line)
          if (lines.length === 1) {
            writer.transaction((db) => insertRecordRows(db, [rowOf(trafficDoc('session-late'), { sessionId: 'session-late' })]))
          }
        },
      }

      const report = await buildJournalReport(handle, { now: () => AS_OF }, sink)

      expect(lines).toHaveLength(2)
      expect(report.manifest.records.lineCount).toBe(2)
      expect(report.manifest.seqRange).toEqual({ firstSeq: 1, lastSeq: 2 })
      expect(report.manifest.sessionIds).toEqual(['session-1'])
      expect(report.manifest.chain.head?.seq).toBe(2)
      // The whole point: the head is inside the exported range, so the
      // offline re-fold over records.jsonl reproduces it.
      let folded = report.manifest.chain.startPrevHash as string
      for (const line of lines) {
        folded = linkHashOf(folded, line.slice(0, -1))
      }
      expect(folded).toBe(report.manifest.chain.head?.recordHash)
    } finally {
      writer.close()
    }
  })

  test('asOf is stamped inside the view, so no exported record post-dates it', async () => {
    // The clock runs INSIDE the snapshot: a row another connection commits at
    // the very instant asOf is taken is already outside the view.
    const handle = await openHandle()
    insertChained(handle, [rowOf(trafficDoc())])
    const writer = await openWriterConnection()
    try {
      const sink = collectingSink()
      const report = await buildJournalReport(
        handle,
        {
          now: () => {
            writer.transaction((db) => insertRecordRows(db, [rowOf(trafficDoc('session-late'), { sessionId: 'session-late' })]))
            return AS_OF
          },
        },
        sink,
      )

      expect(report.manifest.asOf).toBe(AS_OF)
      expect(sink.lines).toEqual([`${trafficDoc()}\n`])
      expect(report.manifest.seqRange).toEqual({ firstSeq: 1, lastSeq: 1 })
    } finally {
      writer.close()
    }
  })

  test('leaves no transaction open on the handle after a build', async () => {
    const handle = await openHandle()
    insertChained(handle, [rowOf(trafficDoc())])

    await buildJournalReport(handle, { now: () => AS_OF }, collectingSink())

    // A leaked read transaction would make this INSERT fail ("cannot start a
    // transaction within a transaction") and would pin the WAL forever.
    expect(() => insertChained(handle, [rowOf(trafficDoc())])).not.toThrow()
  })

  test('a sink failure does not leave the read transaction open either', async () => {
    const handle = await openHandle()
    insertChained(handle, [rowOf(trafficDoc())])
    const failing: ReportRecordSink = {
      writeLine(): void {
        throw new Error('disk full')
      },
    }

    await expect(buildJournalReport(handle, { now: () => AS_OF }, failing)).rejects.toThrow('disk full')

    expect(() => insertChained(handle, [rowOf(trafficDoc())])).not.toThrow()
  })
})

describe('buildJournalReport: a doc holding a raw newline (P3)', () => {
  test('refuses to export, naming the offending seq and pointing at verify', async () => {
    // REPRODUCED: records.jsonl cannot represent such a row -- the writer
    // emits `${doc}\n` and counts DB rows while the verifier counts "\n", so
    // one planted row made every future export of this installation verify as
    // tampered. Escaping is not an option: the chain hashes `doc` byte for
    // byte and the auditor re-hashes what they received.
    const handle = await openHandle()
    insertChained(handle, [rowOf(trafficDoc())])
    handle.db
      .prepare('UPDATE journal_records SET doc = ? WHERE seq = 1')
      .run('{"a":1}\n{"b":2}')

    await expect(buildJournalReport(handle, { now: () => AS_OF }, collectingSink())).rejects.toThrow(
      ReportExportError,
    )
    await expect(
      buildJournalReport(handle, { now: () => AS_OF }, collectingSink()),
    ).rejects.toThrow(/seq 1/)
    await expect(
      buildJournalReport(handle, { now: () => AS_OF }, collectingSink()),
    ).rejects.toThrow(/mcp-journal verify/)
  })
})

describe('buildJournalReport: outcome names that collide with Object.prototype (P6)', () => {
  test('counts an outcome literally named __proto__ instead of silently dropping it', async () => {
    // REPRODUCED: `byOutcome[outcome] = n` on an object literal hits
    // Object.prototype's __proto__ setter, which ignores a number -- the
    // count vanished from SIGNED evidence with no error, and `outcome` is
    // attacker-controlled (only a non-empty-string check guards it).
    const handle = await openHandle()
    insertChained(handle, [
      rowOf(decisionDoc({ outcome: '__proto__' }), { kind: 'decision' }),
      rowOf(decisionDoc({ outcome: 'allow' }), { kind: 'decision' }),
    ])

    const report = await buildJournalReport(handle, { now: () => AS_OF }, collectingSink())

    const byOutcome = report.manifest.counts.byOutcome
    expect(Object.keys(byOutcome).sort()).toEqual(['__proto__', 'allow'])
    expect(Object.getOwnPropertyDescriptor(byOutcome, '__proto__')?.value).toBe(1)
    // The manifest is signed after being serialized: the count must survive
    // a JSON round trip too, and must still sum to counts.decisions.
    const roundTripped = JSON.parse(JSON.stringify(byOutcome)) as Record<string, number>
    expect(Object.getOwnPropertyDescriptor(roundTripped, '__proto__')?.value).toBe(1)
    const sum = Object.values(byOutcome).reduce((total, count) => total + count, 0)
    expect(sum).toBe(report.manifest.counts.decisions)
  })
})

describe('buildJournalReport: decision fields the reader never validated (P2)', () => {
  test('a decision record with no argsHash exports and renders a marker instead of crashing', async () => {
    // REPRODUCED: formatReadableField(undefined) threw mid-write --
    // `isDecisionShape` (line-source.ts) deliberately validates only
    // outcome/rule/toolName, so argsHash/serverName/toolClass/quarantineState
    // can be absent on any row read back from disk.
    const handle = await openHandle()
    const doc = JSON.stringify({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      ts: '2026-08-18T00:00:01.000Z',
      sessionId: 'session-1',
      direction: 'client→server',
      kind: 'decision',
      method: 'tools/call',
      payload: null,
      decision: { outcome: 'allow', rule: 'read-allow', toolName: 'files.read' },
    })
    insertChained(handle, [rowOf(doc, { kind: 'decision' })])
    const sink = collectingSink()

    const report = await buildJournalReport(handle, { now: () => AS_OF }, sink)

    expect(sink.lines).toEqual([`${doc}\n`])
    expect(report.manifest.counts.decisions).toBe(1)
    expect(report.summaryMarkdown).toContain('(absent)')
  })
})

describe('buildJournalReport: the manifest attests summary.md too (A1/P4)', () => {
  test('digests the exact summary bytes and says the summary omits its own digest', async () => {
    const handle = await openHandle()
    insertChained(handle, [rowOf(decisionDoc(), { kind: 'decision' })])

    const report = await buildJournalReport(handle, { now: () => AS_OF }, collectingSink())

    expect(report.manifest.summary.file).toBe('summary.md')
    expect(report.manifest.summary.sha256).toBe(sha256Hex(report.summaryMarkdown))
    // The summary renders the manifest MINUS this digest (it cannot contain a
    // hash of itself); A1 requires it to say so rather than leave a reader
    // wondering why re-serializing what they see misses a field.
    expect(report.summaryMarkdown).not.toContain(report.manifest.summary.sha256)
    expect(report.summaryMarkdown.toLowerCase()).toContain('every field of report.json except')
  })
})

describe('report manifest signing: the stated algorithm is derived, not asserted (P10)', () => {
  test('refuses a key that is not Ed25519 rather than labelling its signature ed25519', async () => {
    // REPRODUCED: signing a manifest with an RSA key produced a signature
    // file claiming `algorithm: 'ed25519'`. An auditor verifying
    // independently with openssl follows the stated algorithm and gets a
    // wrong answer about evidence.
    const { generateKeyPairSync } = await import('node:crypto')
    const rsa = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const handle = await openHandle()
    insertChained(handle, [rowOf(trafficDoc())])
    const report = await buildJournalReport(handle, { now: () => AS_OF }, collectingSink())

    expect(() => signReportManifest(rsa.privateKey, report.manifest)).toThrow(/ed25519/i)
  })
})

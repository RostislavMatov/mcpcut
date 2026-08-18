import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { GENESIS_PREV_HASH } from '../../src/journal/chain.js'
import { resolveChainStartPrevHash, verifyChain } from '../../src/journal/chain-verify.js'
import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import { latestPruneMarker, pruneRecordsOlderThan } from '../../src/journal/prune.js'
import {
  generateAndWriteSigningKeyPair,
  loadSigningPrivateKey,
  verifyChainHeadAnchorSignature,
} from '../../src/journal/signing.js'
import type { SqliteHandle } from '../../src/store/sqlite.js'

/**
 * Retention pruning (M5 wave 6, task 6.1, owner decision O6: a MECHANISM, no
 * automatic defaults -- rows leave the journal only when an operator says so).
 *
 * The property that makes pruning compatible with an evidentiary journal: what
 * remains must still verify. Deleting a prefix of the chain would otherwise
 * leave every surviving row unverifiable (its `prev_hash` points at a row that
 * no longer exists), so the delete and the marker that records where the chain
 * now starts are one transaction, and `verifyChain` starts from that marker.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-prune-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

async function openHandle(): Promise<SqliteHandle> {
  return openJournalDbShared(journalDbPathFor(journalDir))
}

function row(tsIso: string, overrides: Partial<JournalRecordRow> = {}): JournalRecordRow {
  return {
    sessionId: 'session-1',
    recordId: `rec-${tsIso}`,
    ts: tsIso,
    direction: 'client→server',
    kind: 'notification',
    method: 'tools/call',
    doc: JSON.stringify({ ts: tsIso }),
    ...overrides,
  }
}

function insertLegacyRow(handle: SqliteHandle, entry: JournalRecordRow): void {
  handle.db
    .prepare(
      'INSERT INTO journal_records (session_id, record_id, ts, direction, kind, method, doc) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(entry.sessionId, entry.recordId, entry.ts, entry.direction, entry.kind, entry.method, entry.doc)
}

function insertChained(handle: SqliteHandle, rows: readonly JournalRecordRow[]): void {
  handle.db.exec('BEGIN IMMEDIATE')
  insertRecordRows(handle.db as never, rows)
  handle.db.exec('COMMIT')
}

const OLD = ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z']
const NEW = ['2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z']
const CUTOFF = '2026-03-01T00:00:00.000Z'
const NOW = '2026-06-03T00:00:00.000Z'

function seqsOf(handle: SqliteHandle): number[] {
  return (handle.db.prepare('SELECT seq FROM journal_records ORDER BY seq').all() as { seq: number }[]).map(
    (entry) => entry.seq,
  )
}

describe('pruneRecordsOlderThan: the delete and the marker are one act', () => {
  test('deletes the old prefix, keeps the rest, and records where the chain now starts', async () => {
    const handle = await openHandle()
    insertChained(handle, [...OLD, ...NEW].map((ts) => row(ts)))
    const headOfPrefix = handle.db
      .prepare('SELECT record_hash AS h FROM journal_records WHERE seq = 2')
      .get() as { h: string }

    const outcome = pruneRecordsOlderThan(handle, {
      cutoffIso: CUTOFF,
      nowIso: NOW,
      signingKey: { present: false },
    })

    expect(outcome.deletedCount).toBe(2)
    expect(seqsOf(handle)).toEqual([3, 4])
    expect(outcome.marker?.prunedThroughSeq).toBe(2)
    expect(outcome.marker?.headRecordHash).toBe(headOfPrefix.h)
  })

  test('what remains still verifies: the walk starts from the marker, not from genesis', async () => {
    const handle = await openHandle()
    insertChained(handle, [...OLD, ...NEW].map((ts) => row(ts)))

    pruneRecordsOlderThan(handle, { cutoffIso: CUTOFF, nowIso: NOW, signingKey: { present: false } })

    expect(resolveChainStartPrevHash(handle)).toBe(latestPruneMarker(handle)?.headRecordHash)
    const result = verifyChain(handle)
    expect(result.break).toBeNull()
    expect(result.attestedCount).toBe(2)
    expect(result.intactThroughSeq).toBe(4)
  })

  test('a later append chains onto the marker, not onto genesis, when nothing survives', async () => {
    // Pruning EVERYTHING leaves no row to read a head from. Without the marker
    // the next write would restart the chain at genesis, and the journal would
    // look untouched -- the exact history-erasure the marker exists to prevent.
    const handle = await openHandle()
    insertChained(handle, OLD.map((ts) => row(ts)))

    pruneRecordsOlderThan(handle, { cutoffIso: CUTOFF, nowIso: NOW, signingKey: { present: false } })
    insertChained(handle, [row(NEW[0]!)])

    const marker = latestPruneMarker(handle)
    const first = handle.db
      .prepare('SELECT prev_hash AS prevHash FROM journal_records ORDER BY seq LIMIT 1')
      .get() as { prevHash: string }
    expect(first.prevHash).toBe(marker?.headRecordHash)
    expect(verifyChain(handle).break).toBeNull()
  })

  test('nothing old enough: no rows deleted and no marker written', async () => {
    const handle = await openHandle()
    insertChained(handle, NEW.map((ts) => row(ts)))

    const outcome = pruneRecordsOlderThan(handle, {
      cutoffIso: CUTOFF,
      nowIso: NOW,
      signingKey: { present: false },
    })

    expect(outcome.deletedCount).toBe(0)
    expect(outcome.marker).toBeNull()
    expect(latestPruneMarker(handle)).toBeNull()
    expect(seqsOf(handle)).toEqual([1, 2])
  })

  test('only a CONTIGUOUS old prefix goes: an out-of-order old row behind a new one survives', async () => {
    // `ts` is the record's own timestamp and is not guaranteed to rise with
    // `seq` (imported legacy sessions, a clock step). Deleting by timestamp
    // alone would punch a hole in the middle of the chain, which nothing can
    // repair; the prefix rule keeps the surviving rows a verifiable suffix.
    const handle = await openHandle()
    insertChained(handle, [row(OLD[0]!), row(NEW[0]!), row(OLD[1]!)])

    const outcome = pruneRecordsOlderThan(handle, {
      cutoffIso: CUTOFF,
      nowIso: NOW,
      signingKey: { present: false },
    })

    expect(outcome.deletedCount).toBe(1)
    expect(seqsOf(handle)).toEqual([2, 3])
    expect(verifyChain(handle).break).toBeNull()
  })

  test('a second prune moves the marker forward and the suffix still verifies', async () => {
    const handle = await openHandle()
    insertChained(handle, [row(OLD[0]!), row(OLD[1]!), row(NEW[0]!), row(NEW[1]!)])

    pruneRecordsOlderThan(handle, { cutoffIso: OLD[1]!, nowIso: NOW, signingKey: { present: false } })
    const first = latestPruneMarker(handle)
    pruneRecordsOlderThan(handle, { cutoffIso: CUTOFF, nowIso: NOW, signingKey: { present: false } })
    const second = latestPruneMarker(handle)

    expect(first?.prunedThroughSeq).toBe(1)
    expect(second?.prunedThroughSeq).toBe(2)
    expect(verifyChain(handle).break).toBeNull()
    expect(seqsOf(handle)).toEqual([3, 4])
  })

  test('a prefix of pre-chain rows leaves a marker with no hash, and the chain still starts at genesis', async () => {
    const handle = await openHandle()
    insertLegacyRow(handle, row(OLD[0]!))
    insertLegacyRow(handle, row(OLD[1]!))
    insertChained(handle, [row(NEW[0]!)])

    const outcome = pruneRecordsOlderThan(handle, {
      cutoffIso: CUTOFF,
      nowIso: NOW,
      signingKey: { present: false },
    })

    expect(outcome.deletedCount).toBe(2)
    expect(outcome.marker?.headRecordHash).toBeNull()
    expect(resolveChainStartPrevHash(handle)).toBe(GENESIS_PREV_HASH)
    expect(verifyChain(handle).break).toBeNull()
  })
})

describe('pruneRecordsOlderThan: the marker is signed when a key exists', () => {
  test('signs the pruned head, and the signature verifies against the public key', async () => {
    const handle = await openHandle()
    insertChained(handle, [...OLD, ...NEW].map((ts) => row(ts)))
    const keys = await generateAndWriteSigningKeyPair(journalDir)

    const outcome = pruneRecordsOlderThan(handle, {
      cutoffIso: CUTOFF,
      nowIso: NOW,
      signingKey: await loadSigningPrivateKey(journalDir),
    })

    const signature = outcome.marker?.signature
    expect(signature).toBeDefined()
    expect(
      verifyChainHeadAnchorSignature(
        keys.publicKeyPem,
        {
          formatVersion: signature!.formatVersion,
          seq: outcome.marker!.prunedThroughSeq,
          recordHash: outcome.marker!.headRecordHash!,
          signedAt: signature!.signedAt,
          keyFingerprint: signature!.keyFingerprint,
        },
        signature!.signatureBase64,
      ),
    ).toBe(true)
  })

  test('a stored marker reads back with its signature intact', async () => {
    const handle = await openHandle()
    insertChained(handle, [...OLD, ...NEW].map((ts) => row(ts)))
    await generateAndWriteSigningKeyPair(journalDir)

    pruneRecordsOlderThan(handle, {
      cutoffIso: CUTOFF,
      nowIso: NOW,
      signingKey: await loadSigningPrivateKey(journalDir),
    })

    expect(latestPruneMarker(handle)?.signature?.signatureBase64).toEqual(expect.any(String))
  })

  test('an all-unattested prefix is not signed: there is no hash to attest to', async () => {
    const handle = await openHandle()
    insertLegacyRow(handle, row(OLD[0]!))
    insertChained(handle, [row(NEW[0]!)])
    await generateAndWriteSigningKeyPair(journalDir)

    const outcome = pruneRecordsOlderThan(handle, {
      cutoffIso: CUTOFF,
      nowIso: NOW,
      signingKey: await loadSigningPrivateKey(journalDir),
    })

    expect(outcome.marker?.headRecordHash).toBeNull()
    expect(outcome.marker?.signature).toBeUndefined()
  })
})

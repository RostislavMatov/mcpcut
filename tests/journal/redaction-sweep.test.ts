import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { REDACTED_PLACEHOLDER } from '../../src/config.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { createRecordBuilder } from '../../src/journal/record.js'
import { journalProbe } from '../../src/probe/journal-probe.js'
import { classify } from '../../src/protocol/classify.js'
import { collectPersistedBytes } from '../support/persisted-bytes.js'

/**
 * Redaction sweep (M4.5 wave 4, ADR-0006, plan Task 8): proves the whole real
 * pipeline — `classify()` → `createRecordBuilder().buildRecord()` →
 * `createJournalSink().write()`/`flush()` — never lands a secret in
 * `journal.db`, mirroring PERSISTED_BYTES_SWEEP
 * (`tests/policy/approvals/queue.test.ts`, `tests/e2e/m3-integration.test.ts`):
 * a positive sentinel (the store file was actually reached) before the
 * negative assertion (the secret is absent from either byte rendering), so
 * the check can never pass vacuously.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-redaction-sweep-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

/** Distinctive enough to grep for; the key name alone is what triggers redaction. */
const SECRET_VALUE = 'sk-live-sweepsecret123'

describe('journal redaction sweep: a secret never reaches journal.db', () => {
  test('a record built through classify()+buildRecord() is redacted before persistence', async () => {
    const rawLine = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_issue', arguments: { title: 'hello', apiKey: SECRET_VALUE } },
    })

    const record = createRecordBuilder('session-sweep').buildRecord(classify(rawLine), 'client→server')

    // Sanity: the record itself is already clean before it ever reaches storage.
    expect(JSON.stringify(record)).not.toContain(SECRET_VALUE)
    expect(JSON.stringify(record)).toContain(REDACTED_PLACEHOLDER)

    const sink = createJournalSink('session-sweep', { dir: journalDir })
    sink.write(record)
    await sink.flush()

    const { fileNames, renderings } = await collectPersistedBytes(journalDir)
    // Positive sentinel first: the sweep actually reached the store.
    expect(fileNames).toContain('journal.db')
    // `synchronous=FULL` under WAL still checkpoints lazily, so a committed
    // record may live only in the -wal sidecar until that happens — assert
    // its presence rather than assuming it, since collectPersistedBytes only
    // reports what actually exists on disk right now.
    if (fileNames.some((name) => name.endsWith('-wal'))) {
      expect(fileNames).toContain('journal.db-wal')
    }

    for (const rendering of renderings) {
      expect(rendering).not.toContain(SECRET_VALUE)
    }
    expect(renderings.some((rendering) => rendering.includes(REDACTED_PLACEHOLDER))).toBe(true)
  })

  test('the probe path — journalProbe() — never lands a secret in journal.db (M5.5 Task 5)', async () => {
    // The probe engine already writes redacted messages; this pins the
    // journal-side guarantee anyway: redaction is the ONLY path into the
    // journal, probe records included, so even an error string that arrives
    // carrying a bearer token must be scrubbed before persistence.
    const outcome = await journalProbe({
      serverName: 'github-live',
      initiator: { trigger: 'refresh', adminName: 'alice' },
      result: {
        status: 'error',
        message: `the server echoed Bearer ${SECRET_VALUE} in its failure body`,
      },
      dir: journalDir,
    })
    expect(outcome.written).toBe(true)

    const { fileNames, renderings } = await collectPersistedBytes(journalDir)
    // Positive sentinel first: the sweep actually reached the store.
    expect(fileNames).toContain('journal.db')

    for (const rendering of renderings) {
      expect(rendering).not.toContain(SECRET_VALUE)
    }
    expect(renderings.some((rendering) => rendering.includes(REDACTED_PLACEHOLDER))).toBe(true)
  })
})

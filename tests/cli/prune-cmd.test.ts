import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { runPruneCommand } from '../../src/cli/prune-cmd.js'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import { latestPruneMarker } from '../../src/journal/prune.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { generateAndWriteSigningKeyPair } from '../../src/journal/signing.js'
import { createJournalSink } from '../../src/journal/sink.js'

/**
 * `mcp-journal prune --older-than <duration>` (M5 wave 6, task 6.1).
 *
 * Deleting journal records is irreversible and destroys evidence, so the
 * command's default is to say what it WOULD do; `--yes` is what actually
 * deletes. These tests pin that asymmetry as behavior, not as documentation.
 */

let journalDir: string
/**
 * Since owner decision Q17 the deleting half needs an owner token; the gate
 * itself is pinned by `prune-cmd-token.test.ts`, so every case here runs with
 * one and keeps testing what it was written for.
 */
let ownerEnv: NodeJS.ProcessEnv

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-prune-cmd-'))
  const { token } = await createAdminStore({ journalDir }).createAdmin('alice', 'owner')
  ownerEnv = { [ADMIN_TOKEN_ENV_VAR]: token }
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function fakeIo(): {
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  out: () => string
  err: () => string
} {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

const NOW_MS = Date.parse('2026-06-01T00:00:00.000Z')

function run(args: string[], io = fakeIo()): Promise<number> {
  return runPruneCommand(args, io, { journalDir, clock: () => NOW_MS, env: ownerEnv })
}

function recordAt(sessionId: string, id: string, tsIso: string): JournalRecord {
  return {
    id,
    ts: tsIso,
    sessionId,
    direction: 'client→server',
    kind: 'request',
    method: 'tools/call',
    payload: {},
  }
}

/** Two records from January and two from May, written through the real sink. */
async function seedJournal(): Promise<void> {
  const sink = createJournalSink('session-1', { dir: journalDir })
  sink.write(recordAt('session-1', 'a', '2026-01-01T00:00:00.000Z'))
  sink.write(recordAt('session-1', 'b', '2026-01-02T00:00:00.000Z'))
  sink.write(recordAt('session-1', 'c', '2026-05-30T00:00:00.000Z'))
  sink.write(recordAt('session-1', 'd', '2026-05-31T00:00:00.000Z'))
  await sink.close()
}

async function rowCount(): Promise<number> {
  const handle = await openJournalDbShared(journalDbPathFor(journalDir))
  return (handle.db.prepare('SELECT COUNT(*) AS n FROM journal_records').get() as { n: number }).n
}

describe('prune: nothing is deleted without --yes', () => {
  test('reports what would go, deletes nothing, and names the flag that would', async () => {
    await seedJournal()
    const io = fakeIo()

    const code = await run(['--older-than', '30d'], io)

    expect(code).toBe(0)
    expect(await rowCount()).toBe(4)
    expect(io.out()).toContain('2 record(s)')
    expect(io.out()).toContain('--yes')
    expect(io.out().toLowerCase()).toContain('nothing has been deleted')
  })

  test('with --yes the old prefix is gone and a marker is recorded', async () => {
    await seedJournal()
    const io = fakeIo()

    const code = await run(['--older-than', '30d', '--yes'], io)

    expect(code).toBe(0)
    // Two survivors plus the `access-edit` record the prune itself now writes
    // (owner decision Q17): the delete is attributed, and its attribution is
    // an ordinary journal record appended after the marker.
    expect(await rowCount()).toBe(3)
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    const marker = latestPruneMarker(handle)
    expect(marker?.prunedThroughSeq).toBe(2)
    expect(marker?.deletedCount).toBe(2)
    expect(io.out()).toContain('Deleted 2 record(s)')
  })

  test('says plainly that an unsigned marker is the operator’s own claim', async () => {
    await seedJournal()
    const io = fakeIo()

    await run(['--older-than', '30d', '--yes'], io)

    expect(io.out()).toContain('UNSIGNED')
    // The honest limit: a marker is written by the same host that could have
    // deleted rows without recording anything at all.
    expect(io.out().toLowerCase()).toContain('out of band')
  })

  test('signs the marker when a key exists, and names the fingerprint', async () => {
    await seedJournal()
    const keys = await generateAndWriteSigningKeyPair(journalDir)
    const io = fakeIo()

    await run(['--older-than', '30d', '--yes'], io)

    expect(io.out()).toContain(keys.publicKeyFingerprint)
    expect(io.out()).not.toContain('UNSIGNED')
  })
})

describe('prune: refusing to run', () => {
  test('a missing --older-than is a usage error, not an empty prune', async () => {
    await seedJournal()
    const io = fakeIo()

    const code = await run([], io)

    expect(code).toBe(1)
    expect(await rowCount()).toBe(4)
    expect(io.err()).toContain('--older-than')
  })

  test.each(['0d', '-5d', '30', 'abc', '30x', '1.5d', '', '999999999999d', '9007199254740991h'])(
    'rejects the unusable duration %j without touching the journal',
    async (duration) => {
      await seedJournal()
      const io = fakeIo()

      const code = await run(['--older-than', duration, '--yes'], io)

      expect(code).toBe(1)
      expect(await rowCount()).toBe(4)
    },
  )

  test('an absurd duration is refused cleanly, not as a crash inside Date', async () => {
    // `9999999999d` is a safe integer, so the only thing that stopped it was
    // `new Date(now - ms).toISOString()` throwing RangeError -- an uncaught
    // stack trace where a usage error belongs (security review, LOW).
    await seedJournal()
    const io = fakeIo()

    const code = await run(['--older-than', '9999999999d', '--yes'], io)

    expect(code).toBe(1)
    expect(io.err()).toContain('--older-than')
    expect(io.err()).not.toContain('RangeError')
    expect(await rowCount()).toBe(4)
  })

  test('a journal with nothing old enough reports so and exits 0', async () => {
    await seedJournal()
    const io = fakeIo()

    const code = await run(['--older-than', '365d', '--yes'], io)

    expect(code).toBe(0)
    expect(await rowCount()).toBe(4)
    expect(io.out().toLowerCase()).toContain('nothing to prune')
  })

  test('an existing but empty journal is not an error', async () => {
    await openJournalDbShared(journalDbPathFor(journalDir))
    const io = fakeIo()

    const code = await run(['--older-than', '30d', '--yes'], io)

    expect(code).toBe(0)
    expect(io.out().toLowerCase()).toContain('nothing to prune')
  })

  test('no journal database at all is could-not-run, the same as verify treats it', async () => {
    const io = fakeIo()

    const code = await run(['--older-than', '30d', '--yes'], io)

    expect(code).toBe(1)
    expect(io.err()).toContain('No journal database found')
  })
})

describe('prune: hours are accepted, and the cutoff itself is retained', () => {
  test('--older-than 24h keeps the record sitting exactly ON the cutoff', async () => {
    // Cutoff is 2026-05-31T00:00:00Z, which is the fourth record's own `ts`.
    // "Older than" means strictly older: a record stamped exactly at the
    // boundary is not older than it, so it stays. Pinning this here means the
    // comparison can never drift to `<=` unnoticed -- deleting one record more
    // than an operator asked for is not a rounding difference when the record
    // is evidence.
    await seedJournal()
    const io = fakeIo()

    const code = await run(['--older-than', '24h', '--yes'], io)

    expect(code).toBe(0)
    // One survivor plus the prune's own attribution record (Q17).
    expect(await rowCount()).toBe(2)
    expect(io.out()).toContain('Deleted 3 record(s)')
  })
})

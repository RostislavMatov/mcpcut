import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR, type AdminRole } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { PRUNE_MIN_ROLE, runPruneCommand } from '../../src/cli/prune-cmd.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import { latestPruneMarker } from '../../src/journal/prune.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * Owner decision Q17 (2026-09-08): the DELETING half of `prune` needs a
 * personal admin token of role `owner` in `MCP_ADMIN_TOKEN`, and the delete is
 * attributed by an `access-edit` record written right before the marker.
 *
 * Why a record and not a field on the marker: the marker is a row of a fixed
 * SQL table whose columns are covered by the marker signature, and both
 * `verify` and the offline `verify --report` read it. Adding an admin name
 * there would change the signed payload on every existing installation, for
 * a fact the journal's own attributed-change category already has a place
 * for. The marker stays byte-compatible; the record says who.
 *
 * The DRY RUN stays ungated and unrecorded — it deletes nothing, and an
 * operator asking "what would this remove" is reading, not acting.
 */

const NOW_MS = Date.parse('2026-06-01T00:00:00.000Z')

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-prune-token-'))
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

function recordAt(id: string, tsIso: string): JournalRecord {
  return {
    id,
    ts: tsIso,
    sessionId: 'session-1',
    direction: 'client→server',
    kind: 'request',
    method: 'tools/call',
    payload: {},
  }
}

/** Two records old enough to prune, two recent ones, through the real sink. */
async function seedJournal(): Promise<void> {
  const sink = createJournalSink('session-1', { dir: journalDir })
  sink.write(recordAt('a', '2026-01-01T00:00:00.000Z'))
  sink.write(recordAt('b', '2026-01-02T00:00:00.000Z'))
  sink.write(recordAt('c', '2026-05-30T00:00:00.000Z'))
  sink.write(recordAt('d', '2026-05-31T00:00:00.000Z'))
  await sink.close()
}

async function tokenFor(name: string, role: AdminRole): Promise<string> {
  const { token } = await createAdminStore({ journalDir }).createAdmin(name, role)
  return token
}

function run(args: string[], io: ReturnType<typeof fakeIo>, env: NodeJS.ProcessEnv): Promise<number> {
  return runPruneCommand(args, io, { journalDir, clock: () => NOW_MS, env })
}

/** How many records remain in the journal database. */
async function remainingCount(): Promise<number> {
  const handle = await openJournalDbShared(journalDbPathFor(journalDir))
  return (handle.db.prepare('SELECT COUNT(*) AS n FROM journal_records').get() as { n: number }).n
}

/** The `access-edit` payloads in the journal, in commit order. */
async function accessPayloads(): Promise<Array<Record<string, unknown>>> {
  const records = await readJournalRecords(journalDir, ACCESS_EDIT_SESSION_ID)
  return records.map((record) => record.payload as Record<string, unknown>)
}

describe('the prune dry run stays ungated (Q17)', () => {
  test('without --yes and without a token it still reports what it would delete', async () => {
    await seedJournal()
    const io = fakeIo()

    const code = await run(['--older-than', '30d'], io, {})

    expect(code).toBe(0)
    expect(io.out()).toContain('NOTHING HAS BEEN DELETED')
    expect(await accessPayloads()).toEqual([])
  })
})

describe('prune --yes refuses without an owner token (Q17)', () => {
  test('no token: refused, exit 1, and not one record is deleted', async () => {
    await seedJournal()
    const before = await remainingCount()
    const io = fakeIo()

    const code = await run(['--older-than', '30d', '--yes'], io, {})

    expect(code).toBe(1)
    expect(io.err()).toContain(ADMIN_TOKEN_ENV_VAR)
    expect(await remainingCount()).toBe(before)
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    expect(latestPruneMarker(handle)).toBeNull()
  })

  test('an operator token is refused: deleting evidence is owner-only', async () => {
    await seedJournal()
    const before = await remainingCount()
    const io = fakeIo()

    const code = await run(['--older-than', '30d', '--yes'], io, {
      [ADMIN_TOKEN_ENV_VAR]: await tokenFor('op', 'operator'),
    })

    expect(code).toBe(1)
    expect(io.err()).toContain(PRUNE_MIN_ROLE)
    expect(await remainingCount()).toBe(before)
  })

  test('an unknown token is refused rather than silently treated as no token', async () => {
    await seedJournal()
    const before = await remainingCount()
    const io = fakeIo()

    const code = await run(['--older-than', '30d', '--yes'], io, {
      [ADMIN_TOKEN_ENV_VAR]: 'mcpa_not-a-real-token',
    })

    expect(code).toBe(1)
    expect(await remainingCount()).toBe(before)
  })
})

describe('prune --yes with an owner token (Q17)', () => {
  test('deletes, and records the window, the count and the admin', async () => {
    await seedJournal()
    const io = fakeIo()

    const code = await run(['--older-than', '30d', '--yes'], io, {
      [ADMIN_TOKEN_ENV_VAR]: await tokenFor('alice', PRUNE_MIN_ROLE),
    })

    expect(code).toBe(0)
    expect(io.out()).toContain('Deleted 2 record(s)')
    const payloads = await accessPayloads()
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({
      actor: { adminName: 'alice', role: PRUNE_MIN_ROLE, via: 'cli' },
      action: 'prune',
      olderThan: '30d',
      deletedCount: 2,
    })
  })

  test('the marker is still written and still signed the way it always was', async () => {
    await seedJournal()

    await run(['--older-than', '30d', '--yes'], fakeIo(), {
      [ADMIN_TOKEN_ENV_VAR]: await tokenFor('alice', 'owner'),
    })

    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    const marker = latestPruneMarker(handle)
    expect(marker).not.toBeNull()
    expect(marker?.deletedCount).toBe(2)
  })

  test('nothing old enough to delete leaves no record: the command deleted nothing', async () => {
    await seedJournal()
    const io = fakeIo()

    const code = await run(['--older-than', '3650d', '--yes'], io, {
      [ADMIN_TOKEN_ENV_VAR]: await tokenFor('alice', 'owner'),
    })

    expect(code).toBe(0)
    expect(io.out()).toContain('Nothing to prune')
    expect(await accessPayloads()).toEqual([])
  })

  test('the admin token never reaches a journal record', async () => {
    await seedJournal()
    const token = await tokenFor('alice', 'owner')

    await run(['--older-than', '30d', '--yes'], fakeIo(), { [ADMIN_TOKEN_ENV_VAR]: token })

    expect(JSON.stringify(await accessPayloads())).not.toContain(token)
  })
})

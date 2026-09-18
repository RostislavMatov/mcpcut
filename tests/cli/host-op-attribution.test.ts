import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR, type AdminRole } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { runBackupCommand } from '../../src/cli/backup-cmd.js'
import { runKeygenCommand } from '../../src/cli/keygen-cmd.js'
import { runMigrateCommand } from '../../src/cli/migrate-cmd.js'
import { runVerifyCommand } from '../../src/cli/verify-cmd.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * Owner decision Q17 (2026-09-08), third part: `keygen`, `backup`, `migrate`
 * and `verify --sign` stay HOST operations with no gate — they are needed
 * before any admin exists (a fresh install has no admin store to check a token
 * against) and from cron, where nobody is at a keyboard.
 *
 * What changes is attribution: when a VALID `MCP_ADMIN_TOKEN` happens to be in
 * the environment, each of them writes the same `access-edit` record every
 * other attributed change writes, naming the admin and the one fact worth
 * keeping (the destination, the key fingerprint). With no token they behave
 * exactly as before and record nothing. An INVALID token is refused rather
 * than silently ignored: a wrong token is a mistake the operator wants to hear
 * about, not one to be papered over by a command that quietly ran anonymously.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-host-op-'))
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

const BAD_TOKEN: NodeJS.ProcessEnv = { [ADMIN_TOKEN_ENV_VAR]: 'mcpa_not-a-real-token' }

async function envFor(name: string, role: AdminRole): Promise<NodeJS.ProcessEnv> {
  const { token } = await createAdminStore({ journalDir }).createAdmin(name, role)
  return { [ADMIN_TOKEN_ENV_VAR]: token }
}

/** One journalled record, so `verify` and `prune` have something to walk. */
async function seedJournal(): Promise<void> {
  const record: JournalRecord = {
    id: 'a',
    ts: '2026-01-01T00:00:00.000Z',
    sessionId: 'session-1',
    direction: 'client→server',
    kind: 'request',
    method: 'tools/call',
    payload: {},
  }
  const sink = createJournalSink('session-1', { dir: journalDir })
  sink.write(record)
  await sink.close()
}

/** The `access-edit` payloads in the journal, in commit order. */
async function accessPayloads(): Promise<Array<Record<string, unknown>>> {
  const records = await readJournalRecords(journalDir, ACCESS_EDIT_SESSION_ID)
  return records.map((record) => record.payload as Record<string, unknown>)
}

describe('keygen records its actor when a token is present (Q17)', () => {
  test('with no token it mints the key exactly as before and records nothing', async () => {
    const io = fakeIo()

    const code = await runKeygenCommand([], io, { journalDir, env: {} })

    expect(code).toBe(0)
    expect(io.out()).toContain('Public key')
    expect(await accessPayloads()).toEqual([])
  })

  test('with a valid token the record names the admin and the key fingerprint', async () => {
    const env = await envFor('alice', 'owner')
    const io = fakeIo()

    const code = await runKeygenCommand([], io, { journalDir, env })

    expect(code).toBe(0)
    const payloads = await accessPayloads()
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'keygen',
    })
    expect(typeof payloads[0]?.['keyFingerprint']).toBe('string')
  })

  test('a viewer token still attributes: this is a record, not a gate', async () => {
    const env = await envFor('watcher', 'viewer')

    const code = await runKeygenCommand([], fakeIo(), { journalDir, env })

    expect(code).toBe(0)
    expect((await accessPayloads())[0]).toMatchObject({
      actor: { adminName: 'watcher', role: 'viewer', via: 'cli' },
    })
  })

  test('an invalid token is refused, and no key is minted', async () => {
    const io = fakeIo()

    const code = await runKeygenCommand([], io, { journalDir, env: BAD_TOKEN })

    expect(code).toBe(1)
    expect(io.out()).not.toContain('Public key')
    expect(await accessPayloads()).toEqual([])
  })
})

describe('backup records its actor when a token is present (Q17)', () => {
  test('with no token it backs up as before and records nothing', async () => {
    await seedJournal()
    const dest = join(journalDir, 'bak-anon')
    const io = fakeIo()

    const code = await runBackupCommand([dest], io, { journalDir, env: {} })

    expect(code).toBe(0)
    expect(await accessPayloads()).toEqual([])
  })

  test('with a valid token the record names the admin and the destination', async () => {
    await seedJournal()
    const env = await envFor('alice', 'owner')
    const dest = join(journalDir, 'bak-named')

    const code = await runBackupCommand([dest], fakeIo(), { journalDir, env })

    expect(code).toBe(0)
    expect((await accessPayloads())[0]).toMatchObject({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'backup',
      dest,
    })
  })

  test('an invalid token is refused before anything is copied', async () => {
    await seedJournal()
    const io = fakeIo()

    const code = await runBackupCommand([join(journalDir, 'bak-bad')], io, {
      journalDir,
      env: BAD_TOKEN,
    })

    expect(code).toBe(1)
    expect(io.out()).toBe('')
  })
})

describe('migrate records its actor when a token is present (Q17)', () => {
  test('with no token it reports as before and records nothing', async () => {
    const io = fakeIo()

    const code = await runMigrateCommand([], io, { journalDir, env: {} })

    expect(code).toBe(0)
    expect(await accessPayloads()).toEqual([])
  })

  test('with a valid token the record names the admin and nothing else', async () => {
    const env = await envFor('alice', 'owner')

    const code = await runMigrateCommand([], fakeIo(), { journalDir, env })

    expect(code).toBe(0)
    const payloads = await accessPayloads()
    expect(payloads[0]).toEqual({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'migrate',
    })
  })

  test('an invalid token is refused', async () => {
    const code = await runMigrateCommand([], fakeIo(), { journalDir, env: BAD_TOKEN })

    expect(code).toBe(1)
  })
})

describe('verify --sign records its actor when a token is present (Q17)', () => {
  test('a plain verify records nothing, token or not', async () => {
    await seedJournal()
    const env = await envFor('alice', 'owner')

    const code = await runVerifyCommand([], fakeIo(), { journalDir, env })

    expect(code).toBe(0)
    expect(await accessPayloads()).toEqual([])
  })

  test('with no token --sign signs as before and records nothing', async () => {
    await seedJournal()
    await runKeygenCommand([], fakeIo(), { journalDir, env: {} })
    const io = fakeIo()

    const code = await runVerifyCommand(['--sign'], io, { journalDir, env: {} })

    expect(code).toBe(0)
    expect(io.out()).toContain('Chain head anchor')
    expect(await accessPayloads()).toEqual([])
  })

  test('with a valid token the record names the admin and the signing key', async () => {
    await seedJournal()
    await runKeygenCommand([], fakeIo(), { journalDir, env: {} })
    const env = await envFor('alice', 'owner')

    const code = await runVerifyCommand(['--sign'], fakeIo(), { journalDir, env })

    expect(code).toBe(0)
    const signRecords = (await accessPayloads()).filter((p) => p['action'] === 'verify.sign')
    expect(signRecords).toHaveLength(1)
    expect(signRecords[0]).toMatchObject({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'verify.sign',
    })
    expect(typeof signRecords[0]?.['keyFingerprint']).toBe('string')
  })

  test('a --sign that could not sign records nothing', async () => {
    await seedJournal()
    const env = await envFor('alice', 'owner')

    const code = await runVerifyCommand(['--sign'], fakeIo(), { journalDir, env })

    expect(code).toBe(1)
    expect(await accessPayloads()).toEqual([])
  })

  test('an invalid token is refused before the chain is walked', async () => {
    await seedJournal()
    const io = fakeIo()

    const code = await runVerifyCommand(['--sign'], io, { journalDir, env: BAD_TOKEN })

    expect(code).toBe(1)
    expect(io.out()).toBe('')
  })
})

describe('the admin token never reaches a journal record (Q17)', () => {
  test('every host operation that records an actor keeps the token out of it', async () => {
    await seedJournal()
    const env = await envFor('alice', 'owner')
    const token = env[ADMIN_TOKEN_ENV_VAR] as string

    await runKeygenCommand([], fakeIo(), { journalDir, env })
    await runBackupCommand([join(journalDir, 'bak')], fakeIo(), { journalDir, env })
    await runMigrateCommand([], fakeIo(), { journalDir, env })
    await runVerifyCommand(['--sign'], fakeIo(), { journalDir, env })

    expect(JSON.stringify(await accessPayloads())).not.toContain(token)
  })
})

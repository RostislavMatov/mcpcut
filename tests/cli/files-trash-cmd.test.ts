import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { dispatch } from '../../src/cli.js'
import { TRASH_DIR_NAME } from '../../src/files/constants.js'
import { writeManifest, type TrashManifest } from '../../src/files/trash-manifest.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import { readJournalRecords } from '../support/journal-rows.js'

/** `mcpcut files trash list|restore|purge` through the dispatcher, on temp dirs only. */

const DAY_MS = 24 * 60 * 60 * 1000
const ID_NEW = '01K9Z3Q8M5R7T2V4X6B8D0F1GH'
const ID_OLD = '01K9Z3Q8M5R7T2V4X6B8D0F2JK'

let base: string
let journalDir: string
let root: string
let ownerToken: string
let operatorToken: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-files-trash-')))
  journalDir = join(base, 'state')
  await mkdir(journalDir, { recursive: true })
  root = join(base, 'data')
  await mkdir(join(root, 'a'), { recursive: true })
  const admins = createAdminStore({ journalDir })
  ownerToken = (await admins.createAdmin('alice', 'owner')).token
  operatorToken = (await admins.createAdmin('bob', 'operator')).token
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

async function files(args: string[], token: string | null = ownerToken): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: { write: (chunk: string) => out.push(chunk) }, stderr: { write: (chunk: string) => err.push(chunk) } }
  const env = token === null ? {} : { [ADMIN_TOKEN_ENV_VAR]: token }
  const code = await dispatch(['files', ...args], io, { files: { journalDir, env } })
  return { code, out: out.join(''), err: err.join('') }
}

async function declareRoot(folder = root): Promise<void> {
  expect((await files(['root', 'add', folder])).code).toBe(0)
}

/** Puts one file into the root's trash the way `delete_file` leaves it. */
async function trashFile(id: string, relative: string, ageDays: number, folder = root): Promise<void> {
  const trashDir = join(folder, TRASH_DIR_NAME)
  const name = relative.split('/').at(-1) as string
  await mkdir(join(trashDir, id), { recursive: true })
  await writeFile(join(trashDir, id, name), 'bye')
  const manifest: TrashManifest = {
    id,
    root: folder,
    relative,
    originalPath: join(folder, relative),
    kind: 'file',
    size: 3,
    deletedAt: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
    deletedBy: 'research-bot',
  }
  expect((await writeManifest(trashDir, manifest)).ok).toBe(true)
}

async function payloads(): Promise<Array<Record<string, unknown>>> {
  return (await readJournalRecords(journalDir, ACCESS_EDIT_SESSION_ID)).map((record) => record.payload as Record<string, unknown>)
}

describe('files trash list', () => {
  test('says nothing is in the trash and how an item gets there', async () => {
    await declareRoot()

    const result = await files(['trash', 'list', root])

    expect(result.code).toBe(0)
    expect(result.out).toContain('nothing is in the trash')
    expect(result.err).toContain('files grant')
    expect(result.err).toContain('delete')
  })

  test('without roots, says how to declare one', async () => {
    const result = await files(['trash', 'list'])

    expect(result.code).toBe(0)
    expect(result.out + result.err).toContain('mcpcut files root add <folder>')
  })

  test('shows id, path, kind, size, time and actor, and ends with the real restore command', async () => {
    await declareRoot()
    await trashFile(ID_NEW, 'a/report.txt', 1)

    const result = await files(['trash', 'list', root])

    expect(result.code).toBe(0)
    expect(result.out).toContain(ID_NEW)
    expect(result.out).toContain('a/report.txt')
    expect(result.out).toContain('file')
    expect(result.out).toContain('3 B')
    expect(result.out).toContain('research-bot')
    expect(result.err).toContain(`mcpcut files trash restore ${root} ${ID_NEW}`)
  })

  test('without a root argument lists every declared root', async () => {
    const other = join(base, 'other')
    await mkdir(other)
    await declareRoot()
    await declareRoot(other)
    await trashFile(ID_NEW, 'a/one.txt', 1)
    await trashFile(ID_OLD, 'two.txt', 2, other)

    const result = await files(['trash', 'list'])

    expect(result.out).toContain(root)
    expect(result.out).toContain(other)
    expect(result.out).toContain('a/one.txt')
    expect(result.out).toContain('two.txt')
  })

  test('reports a corrupt manifest in one line and still lists the rest', async () => {
    await declareRoot()
    await trashFile(ID_NEW, 'a/ok.txt', 1)
    await writeFile(join(root, TRASH_DIR_NAME, `${ID_OLD}.json`), '{not json')

    const result = await files(['trash', 'list', root])

    expect(result.code).toBe(0)
    expect(result.out).toContain('a/ok.txt')
    const skipped = result.out.split('\n').filter((line) => line.includes('skipped'))
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toContain(ID_OLD)
  })

  test('refuses an undeclared root in one line that lists the declared ones', async () => {
    await declareRoot()

    const result = await files(['trash', 'list', join(base, 'nope')])

    expect(result.code).toBe(1)
    expect(result.err.trim().split('\n')).toHaveLength(1)
    expect(result.err).toContain(root)
  })

  test('needs no owner token', async () => {
    await declareRoot()

    expect((await files(['trash', 'list'], null)).code).toBe(0)
  })
})

describe('files trash restore', () => {
  test('puts the item back, says where, journals files.trash.restore and ends with a next step', async () => {
    await declareRoot()
    await trashFile(ID_NEW, 'a/report.txt', 1)

    const result = await files(['trash', 'restore', root, ID_NEW])

    expect(result.code).toBe(0)
    expect(result.out).toContain(join(root, 'a', 'report.txt'))
    expect(await readFile(join(root, 'a', 'report.txt'), 'utf8')).toBe('bye')
    expect(result.err).toContain('[audit] files restore by alice (owner)')
    expect(result.err).toContain(`mcpcut files trash list ${root}`)
    expect(await payloads()).toContainEqual(
      expect.objectContaining({ action: 'files.trash.restore', path: join(root, 'a', 'report.txt'), trashId: ID_NEW }),
    )
  })

  test('is owner-only: no token and an operator token are refused and nothing moves', async () => {
    await declareRoot()
    await trashFile(ID_NEW, 'a/report.txt', 1)

    const anonymous = await files(['trash', 'restore', root, ID_NEW], null)
    const operator = await files(['trash', 'restore', root, ID_NEW], operatorToken)

    expect(anonymous.code).toBe(1)
    expect(operator.code).toBe(1)
    await expect(stat(join(root, 'a', 'report.txt'))).rejects.toThrow()
    expect((await payloads()).map((payload) => payload['action'])).not.toContain('files.trash.restore')
  })

  test('refuses an undeclared root in one line listing the declared roots', async () => {
    await declareRoot()

    const result = await files(['trash', 'restore', join(base, 'nope'), ID_NEW])

    expect(result.code).toBe(1)
    expect(result.err.trim().split('\n')).toHaveLength(1)
    expect(result.err).toContain(root)
  })

  test('an unknown id is one line with the way to list the ids', async () => {
    await declareRoot()

    const result = await files(['trash', 'restore', root, ID_NEW])

    expect(result.code).toBe(1)
    expect(result.err.trim().split('\n')).toHaveLength(1)
  })

  test('a blocked destination is refused with the io message and no journal record', async () => {
    await declareRoot()
    await trashFile(ID_NEW, 'a/report.txt', 1)
    await writeFile(join(root, 'a', 'report.txt'), 'new one')

    const result = await files(['trash', 'restore', root, ID_NEW])

    expect(result.code).toBe(1)
    expect(result.err).toContain('already exists')
    expect(await readFile(join(root, 'a', 'report.txt'), 'utf8')).toBe('new one')
    expect((await payloads()).map((payload) => payload['action'])).not.toContain('files.trash.restore')
  })

  test('wrong argument count prints usage', async () => {
    expect((await files(['trash', 'restore', root])).code).toBe(1)
  })
})

describe('files trash purge', () => {
  test('removes entries older than 30 days by default and journals the count', async () => {
    await declareRoot()
    await trashFile(ID_OLD, 'a/old.txt', 45)
    await trashFile(ID_NEW, 'a/new.txt', 5)

    const result = await files(['trash', 'purge', root])

    expect(result.code).toBe(0)
    expect(result.out).toContain('purged 1 item')
    expect(result.err).toContain(`mcpcut files trash list ${root}`)
    await expect(stat(join(root, TRASH_DIR_NAME, `${ID_OLD}.json`))).rejects.toThrow()
    expect((await stat(join(root, TRASH_DIR_NAME, `${ID_NEW}.json`))).isFile()).toBe(true)
    expect(await payloads()).toContainEqual(
      expect.objectContaining({ action: 'files.trash.purge', path: root, olderThan: '30d', deletedCount: 1 }),
    )
  })

  test('--older-than-days narrows the window', async () => {
    await declareRoot()
    await trashFile(ID_NEW, 'a/new.txt', 5)

    const result = await files(['trash', 'purge', root, '--older-than-days', '3'])

    expect(result.out).toContain('purged 1 item')
    expect(await payloads()).toContainEqual(expect.objectContaining({ olderThan: '3d', deletedCount: 1 }))
  })

  test.each(['0', '-1', '1.5', 'abc', '3651', ''])('rejects --older-than-days %j in one line', async (value) => {
    await declareRoot()

    const result = await files(['trash', 'purge', root, '--older-than-days', value])

    expect(result.code).toBe(1)
    expect(result.err.trim().split('\n')).toHaveLength(1)
    expect(result.err).toContain('3650')
  })

  test('accepts the upper bound 3650', async () => {
    await declareRoot()

    expect((await files(['trash', 'purge', root, '--older-than-days', '3650'])).code).toBe(0)
  })

  test('is owner-only', async () => {
    await declareRoot()
    await trashFile(ID_OLD, 'a/old.txt', 45)

    const result = await files(['trash', 'purge', root], operatorToken)

    expect(result.code).toBe(1)
    expect((await stat(join(root, TRASH_DIR_NAME, `${ID_OLD}.json`))).isFile()).toBe(true)
  })

  test('on an empty trash prints a zero count', async () => {
    await declareRoot()

    const result = await files(['trash', 'purge', root])

    expect(result.code).toBe(0)
    expect(result.out).toContain('purged 0 items')
  })

  test('refuses an undeclared root', async () => {
    const result = await files(['trash', 'purge', join(base, 'nope')])

    expect(result.code).toBe(1)
    expect(result.err.trim().split('\n')).toHaveLength(1)
  })
})

describe('files trash usage', () => {
  test('an unknown trash action prints usage', async () => {
    const result = await files(['trash', 'burn'])

    expect(result.code).toBe(1)
    expect(result.err).toContain('files trash')
  })
})

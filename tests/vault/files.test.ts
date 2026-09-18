import { randomBytes } from 'node:crypto'
import type { Mode, PathLike } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  decodeBase64Buffer,
  readFileBufferIfExists,
  renameDurable,
  VaultLockLostError,
  withVaultLock,
  writeFileAtomic,
} from '../../src/vault/files.js'

/**
 * Durability and buffer-hygiene contract of the vault's file plumbing.
 *
 * The fsync ordering is the whole point of defect 2: a rename that becomes
 * durable before the bytes it points at leaves a staged vault key truncated
 * and every secret unrecoverable, so `sync()` on the file handle MUST land
 * before the rename, and the directory entry MUST be synced after it.
 */

const { events } = vi.hoisted(() => ({ events: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (path: PathLike, flags?: string | number, mode?: Mode): Promise<FileHandle> => {
      const handle = await actual.open(path, flags, mode)
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === 'sync') {
            return async (): Promise<void> => {
              events.push(`sync:${String(path)}`)
              await target.sync()
            }
          }
          const value = Reflect.get(target, prop, target) as unknown
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value
        },
      })
    },
    rename: async (from: PathLike, to: PathLike): Promise<void> => {
      events.push(`rename:${String(to)}`)
      await actual.rename(from, to)
    },
  }
})

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-vault-files-'))
  events.length = 0
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomic durability', () => {
  test('fsyncs the staged file BEFORE the rename and the directory AFTER it', async () => {
    const target = join(dir, 'vault.key')

    await writeFileAtomic(target, 'staged-content\n')

    const renameIndex = events.findIndex((event) => event === `rename:${target}`)
    const fileSyncIndex = events.findIndex(
      (event) => event.startsWith('sync:') && event.includes('.tmp'),
    )
    const dirSyncIndex = events.findIndex((event) => event === `sync:${dir}`)

    expect(fileSyncIndex).toBeGreaterThanOrEqual(0)
    expect(renameIndex).toBeGreaterThan(fileSyncIndex)
    expect(dirSyncIndex).toBeGreaterThan(renameIndex)
  })

  test('the committed file has the content, mode 0600, and leaves no tmp behind', async () => {
    const target = join(dir, 'vault.enc')

    await writeFileAtomic(target, '{"v":1}')

    expect(await readFile(target, 'utf8')).toBe('{"v":1}')
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    expect((await readdir(dir)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  test('overwrites an existing file in place', async () => {
    const target = join(dir, 'vault.enc')
    await writeFileAtomic(target, 'first')

    await writeFileAtomic(target, 'second')

    expect(await readFile(target, 'utf8')).toBe('second')
  })
})

describe('renameDurable', () => {
  test('renames and then fsyncs the destination directory', async () => {
    const from = join(dir, 'vault.key.new')
    const to = join(dir, 'vault.key')
    await writeFile(from, 'promoted\n')
    events.length = 0

    await renameDurable(from, to)

    expect(await readFile(to, 'utf8')).toBe('promoted\n')
    expect(events.indexOf(`sync:${dir}`)).toBeGreaterThan(events.indexOf(`rename:${to}`))
  })
})

describe('readFileBufferIfExists', () => {
  test('returns the raw bytes, never a decoded string', async () => {
    const path = join(dir, 'raw')
    await writeFile(path, Buffer.from([0x00, 0xff, 0x41]))

    const result = await readFileBufferIfExists(path)

    expect(Buffer.isBuffer(result)).toBe(true)
    expect([...(result ?? [])]).toEqual([0x00, 0xff, 0x41])
  })

  test('returns null for a missing file and propagates anything else', async () => {
    expect(await readFileBufferIfExists(join(dir, 'nope'))).toBeNull()
    await expect(readFileBufferIfExists(dir)).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe('decodeBase64Buffer', () => {
  test('matches Node’s decoder for random payloads of every length remainder', () => {
    for (let length = 1; length <= 48; length += 1) {
      const source = randomBytes(length)
      const encoded = source.toString('base64')

      const decoded = decodeBase64Buffer(Buffer.from(encoded, 'utf8'))

      expect(decoded === null ? null : [...decoded]).toEqual([...source])
    }
  })

  test('tolerates surrounding and embedded ASCII whitespace', () => {
    const source = randomBytes(32)
    const encoded = `  ${source.toString('base64')}\r\n`

    expect([...(decodeBase64Buffer(Buffer.from(encoded, 'utf8')) ?? [])]).toEqual([...source])
  })

  test('rejects bytes outside the base64 alphabet instead of silently dropping them', () => {
    expect(decodeBase64Buffer(Buffer.from('not base64!!!*', 'utf8'))).toBeNull()
  })

  test('an empty input decodes to an empty buffer', () => {
    expect(decodeBase64Buffer(Buffer.alloc(0))?.length).toBe(0)
  })
})

describe('withVaultLock holder token', () => {
  test('a lock stolen while fn runs is reported, and the new owner’s lock is left alone', async () => {
    const lockPath = join(dir, 'vault.lock')
    const foreign = JSON.stringify({ pid: 999_999, createdAtMs: Date.now(), nonce: 'foreign' })

    // A stale-lock recoverer takes over mid-flight: our own lock is gone and a
    // lock belonging to someone else sits in its place. `fn` already wrote to
    // disk, so the result cannot be trusted -- that must be raised, not
    // returned as success -- and the new owner's lockfile must survive.
    await expect(
      withVaultLock(lockPath, async () => {
        await writeFile(lockPath, foreign, 'utf8')
      }),
    ).rejects.toBeInstanceOf(VaultLockLostError)

    expect(await readFile(lockPath, 'utf8')).toBe(foreign)
  })

  test('a lock still ours at the end is released', async () => {
    const lockPath = join(dir, 'vault.lock')

    await withVaultLock(lockPath, async () => undefined)

    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a forced removal of an abandoned foreign lock reaches the injected warn sink', async () => {
    const lockPath = join(dir, 'vault.lock')
    await writeFile(lockPath, 'not a lock record at all', 'utf8')
    // Untouched for 60s: older than the default 30s staleness window.
    const past = new Date(Date.now() - 60_000)
    await utimes(lockPath, past, past)
    const warnings: string[] = []

    const result = await withVaultLock(lockPath, async () => 'done', {
      warn: (line) => warnings.push(line),
    })

    expect(result).toBe('done')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(lockPath)
  })
})

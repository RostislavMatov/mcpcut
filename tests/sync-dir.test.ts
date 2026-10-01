import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { syncDir, type DirOpener } from '../src/sync-dir.js'

/**
 * Directory fsync after a rename or a fresh file: durable where the platform
 * allows it, a no-op where it refuses (Windows answers EPERM — found by the
 * smoke of the published 0.2.4 on Windows, where `export --report` died on it).
 */

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-sync-dir-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refused`), { code })
}

/** An opener whose handle fails `sync()` with the given error; records whether the handle was closed. */
function refusingSync(error: Error): { open: DirOpener; closed: () => boolean } {
  let isClosed = false
  const open: DirOpener = async () => ({
    sync: () => Promise.reject(error),
    close: async () => {
      isClosed = true
    },
  })
  return { open, closed: () => isClosed }
}

describe('syncDir', () => {
  test('syncs a real directory', async () => {
    await expect(syncDir(dir)).resolves.toBeUndefined()
  })

  test.each(['EPERM', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EACCES', 'EBADF'])(
    'tolerates a platform that refuses to fsync a directory (%s) and still closes the handle',
    async (code) => {
      const opener = refusingSync(errno(code))

      await expect(syncDir(dir, opener.open)).resolves.toBeUndefined()

      expect(opener.closed()).toBe(true)
    },
  )

  test('propagates any other fsync failure', async () => {
    const opener = refusingSync(errno('EIO'))

    await expect(syncDir(dir, opener.open)).rejects.toThrow('EIO')
    expect(opener.closed()).toBe(true)
  })

  test('propagates a missing directory', async () => {
    await expect(syncDir(join(dir, 'gone'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('tolerates a platform that refuses to open a directory at all', async () => {
    const open: DirOpener = () => Promise.reject(errno('EISDIR'))

    await expect(syncDir(dir, open)).resolves.toBeUndefined()
  })
})

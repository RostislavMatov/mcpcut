import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { JOURNAL_FILE_MODE } from '../../src/config.js'
import {
  LOG_FILE_SUFFIX,
  PID_FILE_SUFFIX,
  PID_RECORD_VERSION,
  RUN_DIR_NAME,
  SERVICE_NAMES,
} from '../../src/services/constants.js'
import { logFilePathFor, pidFilePathFor, runDirFor } from '../../src/services/paths.js'
import {
  createPidFileExclusive,
  isProcessAlive,
  readPidFile,
  removePidFile,
  type PidRecord,
} from '../../src/services/pid-file.js'

/**
 * The service manager's on-disk bookkeeping (mcpcut phase 1, Task 7): where
 * `run/` lives, and the pid file that says which process the manager started.
 *
 * The pid file is the only durable link between a `mcpcut start` and the
 * detached process it left behind, so its failure modes are tested as first
 * class outcomes rather than exceptions: absent, corrupt, and "someone else
 * created it first" all have to be distinguishable by a caller.
 */

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mcp-journal-pid-file-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

function sampleRecord(overrides: Partial<PidRecord> = {}): PidRecord {
  return {
    version: PID_RECORD_VERSION,
    service: 'ui',
    pid: 4242,
    host: '127.0.0.1',
    port: 8091,
    startedAt: '2026-09-04T09:12:03.000Z',
    ...overrides,
  }
}

async function makeRunDir(): Promise<string> {
  const runDir = runDirFor(dataDir)
  await mkdir(runDir, { recursive: true })
  return runDir
}

describe('services/paths: the run directory layout', () => {
  test('places pid and log files for every service under <dataDir>/run', () => {
    expect(runDirFor(dataDir)).toBe(join(dataDir, RUN_DIR_NAME))

    for (const name of SERVICE_NAMES) {
      expect(pidFilePathFor(dataDir, name)).toBe(join(dataDir, RUN_DIR_NAME, `${name}${PID_FILE_SUFFIX}`))
      expect(logFilePathFor(dataDir, name)).toBe(join(dataDir, RUN_DIR_NAME, `${name}${LOG_FILE_SUFFIX}`))
    }
  })

  test('names the two services the manager knows about', () => {
    expect(SERVICE_NAMES).toEqual(['ui', 'serve'])
  })
})

describe('createPidFileExclusive', () => {
  test('creates the file and reports "created" on the first writer', async () => {
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'ui')

    const outcome = await createPidFileExclusive(path, sampleRecord())

    expect(outcome).toBe('created')
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    expect(parsed).toEqual(sampleRecord())
  })

  test('reports "exists" instead of throwing when a second writer races it', async () => {
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'ui')
    await createPidFileExclusive(path, sampleRecord())

    const outcome = await createPidFileExclusive(path, sampleRecord({ pid: 5555 }))

    expect(outcome).toBe('exists')
    // The loser of the race must not have overwritten the winner's record.
    const read = await readPidFile(path)
    expect(read).toEqual({ kind: 'ok', record: sampleRecord() })
  })

  test('writes the pid file owner-only (0600)', async () => {
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'serve')

    await createPidFileExclusive(path, sampleRecord({ service: 'serve', port: 8090 }))

    expect((await stat(path)).mode & 0o777).toBe(JOURNAL_FILE_MODE)
  })
})

describe('readPidFile', () => {
  test('returns "absent" when no service has ever been started', async () => {
    await makeRunDir()

    expect(await readPidFile(pidFilePathFor(dataDir, 'ui'))).toEqual({ kind: 'absent' })
  })

  test('returns "absent" when the run directory itself is missing', async () => {
    expect(await readPidFile(pidFilePathFor(dataDir, 'ui'))).toEqual({ kind: 'absent' })
  })

  test('returns the record a previous start wrote', async () => {
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'serve')
    const record = sampleRecord({ service: 'serve', pid: 77, port: 8090 })
    await createPidFileExclusive(path, record)

    expect(await readPidFile(path)).toEqual({ kind: 'ok', record })
  })

  test('returns "corrupt" with a detail when the file is not JSON', async () => {
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'ui')
    await writeFile(path, '{ not json', { encoding: 'utf8', mode: JOURNAL_FILE_MODE })

    const read = await readPidFile(path)

    expect(read.kind).toBe('corrupt')
    if (read.kind !== 'corrupt') throw new Error('expected a corrupt read')
    expect(read.detail).toMatch(/not valid JSON/)
  })

  test('returns "corrupt" naming the field when the record fails the schema', async () => {
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'ui')
    await writeFile(path, JSON.stringify({ ...sampleRecord(), pid: -1 }), {
      encoding: 'utf8',
      mode: JOURNAL_FILE_MODE,
    })

    const read = await readPidFile(path)

    expect(read.kind).toBe('corrupt')
    if (read.kind !== 'corrupt') throw new Error('expected a corrupt read')
    expect(read.detail).toContain('pid')
  })

  test('returns "corrupt" for an unknown extra key rather than accepting it', async () => {
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'ui')
    await writeFile(path, JSON.stringify({ ...sampleRecord(), token: 'mcpa_secret' }), {
      encoding: 'utf8',
      mode: JOURNAL_FILE_MODE,
    })

    const read = await readPidFile(path)

    expect(read.kind).toBe('corrupt')
    if (read.kind !== 'corrupt') throw new Error('expected a corrupt read')
    expect(read.detail).toContain('token')
  })
})

describe('removePidFile', () => {
  test('removes an existing pid file', async () => {
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'ui')
    await createPidFileExclusive(path, sampleRecord())

    await removePidFile(path)

    expect(await readPidFile(path)).toEqual({ kind: 'absent' })
  })

  test('is a no-op when the pid file is already gone', async () => {
    await makeRunDir()

    await expect(removePidFile(pidFilePathFor(dataDir, 'ui'))).resolves.toBeUndefined()
  })
})

describe('isProcessAlive', () => {
  test('reports this very process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  test('reports a pid whose process is gone (ESRCH) as not alive', () => {
    const kill = (): boolean => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    }

    expect(isProcessAlive(999_999, kill)).toBe(false)
  })

  test('reports a pid owned by another user (EPERM) as alive', () => {
    const kill = (): boolean => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    }

    expect(isProcessAlive(1, kill)).toBe(true)
  })

  test('probes with signal 0 so the target is never actually signalled', () => {
    const seen: Array<{ pid: number; signal: number | string | undefined }> = []
    const kill = (pid: number, signal?: number | string): boolean => {
      seen.push({ pid, signal })
      return true
    }

    expect(isProcessAlive(4242, kill)).toBe(true)
    expect(seen).toEqual([{ pid: 4242, signal: 0 }])
  })

  test('treats an unrecognised errno as not alive rather than throwing', () => {
    const kill = (): boolean => {
      throw Object.assign(new Error('kill EINVAL'), { code: 'EINVAL' })
    }

    expect(isProcessAlive(4242, kill)).toBe(false)
  })
})

describe('readPidFile: a pid file is only trusted while it is owner-only', () => {
  test('returns "corrupt" for a group- or world-accessible pid file', async () => {
    // Arrange: a perfectly valid record in a file that is not the owner's alone.
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'ui')
    await createPidFileExclusive(path, sampleRecord())
    await chmod(path, 0o644)

    // Act
    const read = await readPidFile(path)

    // Assert
    expect(read.kind).toBe('corrupt')
    if (read.kind !== 'corrupt') throw new Error('expected a corrupt read')
    expect(read.detail).toContain('owner-only')
  })

  test('still returns the record when the file is owner-only', async () => {
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'ui')
    await createPidFileExclusive(path, sampleRecord())

    expect((await readPidFile(path)).kind).toBe('ok')
  })
})

describe('readPidFile: the record is bounded, and a fault never quotes the file', () => {
  test('returns "corrupt" for a port outside the TCP range', async () => {
    // Arrange: `net.connect` throws ERR_SOCKET_BAD_PORT synchronously for this
    // number, from inside a probe whose whole contract is "never throws".
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'ui')
    await writeFile(path, JSON.stringify(sampleRecord({ port: 999_999 })), { mode: JOURNAL_FILE_MODE })

    const read = await readPidFile(path)

    expect(read.kind).toBe('corrupt')
    if (read.kind !== 'corrupt') throw new Error('expected a corrupt read')
    expect(read.detail).toContain('port')
  })

  test('accepts port 0, which is what "any free port" is recorded as', async () => {
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'ui')
    await createPidFileExclusive(path, sampleRecord({ port: 0 }))

    expect((await readPidFile(path)).kind).toBe('ok')
  })

  test('reports a JSON fault by position, never by echoing the bytes it read', async () => {
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'ui')
    await writeFile(path, '{"token": mcpa_secret{', { mode: JOURNAL_FILE_MODE })

    const read = await readPidFile(path)

    expect(read.kind).toBe('corrupt')
    if (read.kind !== 'corrupt') throw new Error('expected a corrupt read')
    expect(read.detail).toContain('not valid JSON')
    expect(read.detail).not.toContain('mcpa_')
  })
})

describe('createPidFileExclusive: a failed write leaves nothing behind', () => {
  test('removes the file it created when the record cannot be written', async () => {
    // Arrange: a BigInt makes `JSON.stringify` throw AFTER `open('wx')` has
    // already created the file — the window that would otherwise leave an
    // empty pid file that reads as `corrupt` forever.
    await makeRunDir()
    const path = pidFilePathFor(dataDir, 'ui')
    const unserializable = sampleRecord({ port: 1n as unknown as number })

    await expect(createPidFileExclusive(path, unserializable)).rejects.toThrow()

    expect(await readPidFile(path)).toEqual({ kind: 'absent' })
  })
})

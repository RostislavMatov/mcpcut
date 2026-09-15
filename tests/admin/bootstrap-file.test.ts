import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  bootstrapTokenPathFor,
  consumeBootstrapTokenFile,
  hasBootstrapTokenFile,
  writeBootstrapTokenFile,
} from '../../src/admin/bootstrap-file.js'
import { BOOTSTRAP_TOKEN_FILE_NAME } from '../../src/admin/constants.js'

/**
 * The one-time bootstrap token file (phase 6, F6 / Q27): the first `ui` start
 * with no admins writes the owner's token to `<journalDir>/bootstrap-token`
 * (0600) instead of stderr, and the first successful sign-in removes it.
 * The three operations are exercised against a real temp directory because
 * every property here is a filesystem fact — the mode bits, the exclusive
 * create, what happens to a symlink — and a fake would only restate the
 * implementation.
 */

const TOKEN = 'mcpa_test-token-value'
const OWNER_ONLY = 0o600

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-bootstrap-file-'))
  path = bootstrapTokenPathFor(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('bootstrapTokenPathFor', () => {
  test('names the file inside the journal directory', () => {
    expect(bootstrapTokenPathFor('/plane')).toBe(join('/plane', BOOTSTRAP_TOKEN_FILE_NAME))
  })
})

describe('writeBootstrapTokenFile', () => {
  test('creates the file owner-only with the token and a trailing newline', async () => {
    await writeBootstrapTokenFile(path, TOKEN)

    const info = await stat(path)
    expect(info.isFile()).toBe(true)
    expect(info.mode & 0o777).toBe(OWNER_ONLY)
    expect(await readFile(path, 'utf8')).toBe(`${TOKEN}\n`)
  })

  test('replaces a leftover file from a wiped store instead of failing on EEXIST', async () => {
    await writeFile(path, 'stale-token\n', { mode: 0o644 })

    await writeBootstrapTokenFile(path, TOKEN)

    expect(await readFile(path, 'utf8')).toBe(`${TOKEN}\n`)
    expect((await stat(path)).mode & 0o777).toBe(OWNER_ONLY)
  })

  test('removes a symlink at the path as a link and never writes through it', async () => {
    const target = join(dir, 'elsewhere')
    await writeFile(target, 'untouched\n', 'utf8')
    await symlink(target, path)

    await writeBootstrapTokenFile(path, TOKEN)

    expect((await lstat(path)).isSymbolicLink()).toBe(false)
    expect(await readFile(path, 'utf8')).toBe(`${TOKEN}\n`)
    expect(await readFile(target, 'utf8')).toBe('untouched\n')
  })

  test('a missing parent directory is an error for the caller', async () => {
    await expect(
      writeBootstrapTokenFile(join(dir, 'missing', BOOTSTRAP_TOKEN_FILE_NAME), TOKEN),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a path that cannot be created even after the retry is an error for the caller', async () => {
    // A directory with a child: `rm` without `recursive` refuses it, so the
    // retry sees the same obstacle and the failure must reach the caller.
    await mkdir(path)
    await writeFile(join(path, 'child'), '', 'utf8')

    await expect(writeBootstrapTokenFile(path, TOKEN)).rejects.toBeInstanceOf(Error)
    expect((await stat(path)).isDirectory()).toBe(true)
  })
})

describe('consumeBootstrapTokenFile', () => {
  test('removes an existing file and says so', async () => {
    await writeBootstrapTokenFile(path, TOKEN)

    const outcome = await consumeBootstrapTokenFile(path)

    expect(outcome).toEqual({ kind: 'removed' })
    expect(hasBootstrapTokenFile(path)).toBe(false)
  })

  test('reports an absent file without throwing, so a second sign-in is silent', async () => {
    const outcome = await consumeBootstrapTokenFile(path)

    expect(outcome).toEqual({ kind: 'absent' })
  })

  test('reports a failure with its message instead of throwing', async () => {
    await mkdir(path)
    await writeFile(join(path, 'child'), '', 'utf8')

    const outcome = await consumeBootstrapTokenFile(path)

    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.message.length).toBeGreaterThan(0)
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  test('removes a symlink as a link, leaving its target alone', async () => {
    const target = join(dir, 'elsewhere')
    await writeFile(target, 'untouched\n', 'utf8')
    await symlink(target, path)

    expect(await consumeBootstrapTokenFile(path)).toEqual({ kind: 'removed' })

    expect(await readFile(target, 'utf8')).toBe('untouched\n')
  })
})

describe('hasBootstrapTokenFile', () => {
  test('is true while the file exists and false once it is consumed', async () => {
    expect(hasBootstrapTokenFile(path)).toBe(false)
    await writeBootstrapTokenFile(path, TOKEN)
    expect(hasBootstrapTokenFile(path)).toBe(true)
    await consumeBootstrapTokenFile(path)
    expect(hasBootstrapTokenFile(path)).toBe(false)
  })

  test('is false for a path it cannot answer for', () => {
    expect(hasBootstrapTokenFile('\0not-a-path')).toBe(false)
  })
})

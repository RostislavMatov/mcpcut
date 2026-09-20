import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  setupCodePathFor,
  consumeSetupCodeFile,
  writeSetupCodeFile,
} from '../../src/admin/setup-code-file.js'
import { SETUP_CODE_FILE_NAME } from '../../src/admin/constants.js'

/**
 * The one-time setup code file: the first `ui` start with no admins writes
 * the code the `/setup` page asks for to `<journalDir>/setup-code` (0600)
 * instead of stderr; creating the owner, or any sign-in, removes it.
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
  dir = await mkdtemp(join(tmpdir(), 'mcp-setup-code-file-'))
  path = setupCodePathFor(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('setupCodePathFor', () => {
  test('names the file inside the journal directory', () => {
    expect(setupCodePathFor('/plane')).toBe(join('/plane', SETUP_CODE_FILE_NAME))
  })
})

describe('writeSetupCodeFile', () => {
  test('creates the file owner-only with the token and a trailing newline', async () => {
    await writeSetupCodeFile(path, TOKEN)

    const info = await stat(path)
    expect(info.isFile()).toBe(true)
    expect(info.mode & 0o777).toBe(OWNER_ONLY)
    expect(await readFile(path, 'utf8')).toBe(`${TOKEN}\n`)
  })

  test('replaces a leftover file from a wiped store instead of failing on EEXIST', async () => {
    await writeFile(path, 'stale-token\n', { mode: 0o644 })

    await writeSetupCodeFile(path, TOKEN)

    expect(await readFile(path, 'utf8')).toBe(`${TOKEN}\n`)
    expect((await stat(path)).mode & 0o777).toBe(OWNER_ONLY)
  })

  test('removes a symlink at the path as a link and never writes through it', async () => {
    const target = join(dir, 'elsewhere')
    await writeFile(target, 'untouched\n', 'utf8')
    await symlink(target, path)

    await writeSetupCodeFile(path, TOKEN)

    expect((await lstat(path)).isSymbolicLink()).toBe(false)
    expect(await readFile(path, 'utf8')).toBe(`${TOKEN}\n`)
    expect(await readFile(target, 'utf8')).toBe('untouched\n')
  })

  test('a missing parent directory is an error for the caller', async () => {
    await expect(
      writeSetupCodeFile(join(dir, 'missing', SETUP_CODE_FILE_NAME), TOKEN),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a path that cannot be created even after the retry is an error for the caller', async () => {
    // A directory with a child: `rm` without `recursive` refuses it, so the
    // retry sees the same obstacle and the failure must reach the caller.
    await mkdir(path)
    await writeFile(join(path, 'child'), '', 'utf8')

    await expect(writeSetupCodeFile(path, TOKEN)).rejects.toBeInstanceOf(Error)
    expect((await stat(path)).isDirectory()).toBe(true)
  })
})

describe('consumeSetupCodeFile', () => {
  test('removes an existing file and says so', async () => {
    await writeSetupCodeFile(path, TOKEN)

    const outcome = await consumeSetupCodeFile(path)

    expect(outcome).toEqual({ kind: 'removed' })
  })

  test('reports an absent file without throwing, so a second sign-in is silent', async () => {
    const outcome = await consumeSetupCodeFile(path)

    expect(outcome).toEqual({ kind: 'absent' })
  })

  test('reports a failure with its message instead of throwing', async () => {
    await mkdir(path)
    await writeFile(join(path, 'child'), '', 'utf8')

    const outcome = await consumeSetupCodeFile(path)

    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.message.length).toBeGreaterThan(0)
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  test('removes a symlink as a link, leaving its target alone', async () => {
    const target = join(dir, 'elsewhere')
    await writeFile(target, 'untouched\n', 'utf8')
    await symlink(target, path)

    expect(await consumeSetupCodeFile(path)).toEqual({ kind: 'removed' })

    expect(await readFile(target, 'utf8')).toBe('untouched\n')
  })
})

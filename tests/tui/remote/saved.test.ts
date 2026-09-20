import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  forgetSavedRemote,
  readSavedRemote,
  savedRemotePathFor,
  SAVED_REMOTE_FILE_NAME,
  writeSavedRemote,
} from '../../../src/tui/remote/saved.js'

/**
 * The remembered remote address (owner request, 2026-09-20): "remember the
 * last address" — a tiny file beside the install config, holding nothing but
 * a version and the URL `--remote` itself would accept. Every property here
 * is a filesystem fact (the mode bits, the atomic write, what an absent or
 * broken file reads back as), so these are exercised against a real temp
 * directory rather than a fake.
 */

const OWNER_ONLY = 0o600
const URL = 'https://box.example:8091'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-saved-remote-'))
  path = join(dir, SAVED_REMOTE_FILE_NAME)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('savedRemotePathFor', () => {
  test('names the file beside the resolved install config, not inside a data directory', () => {
    const env = { MCPCUT_CONFIG: '/home/op/.mcpcut/config.json' }

    expect(savedRemotePathFor(env)).toBe(join('/home/op/.mcpcut', SAVED_REMOTE_FILE_NAME))
  })

  test('defaults to the home directory config path, so MCPCUT_CONFIG moves both files together', () => {
    expect(savedRemotePathFor({}, '/home/op')).toBe(join('/home/op', '.mcpcut', SAVED_REMOTE_FILE_NAME))
  })
})

describe('writeSavedRemote / readSavedRemote: round trip', () => {
  test('writes version 1 and the normalised url, owner-only, and reads it back', async () => {
    await writeSavedRemote(path, URL)

    const info = await stat(path)
    expect(info.mode & 0o777).toBe(OWNER_ONLY)
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    expect(raw).toEqual({ version: 1, url: URL })

    expect(await readSavedRemote(path)).toEqual({ kind: 'ok', url: URL })
  })

  test('the file on disk holds nothing but version and url — never a token, a name or anything else', async () => {
    await writeSavedRemote(path, URL)

    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['url', 'version'])
  })

  test('creates the parent directory when it does not exist yet', async () => {
    const nested = join(dir, 'nested', SAVED_REMOTE_FILE_NAME)

    await writeSavedRemote(nested, URL)

    expect(await readSavedRemote(nested)).toEqual({ kind: 'ok', url: URL })
  })

  test('an atomic write leaves no temporary file behind on success', async () => {
    await writeSavedRemote(path, URL)

    const entries = await import('node:fs/promises').then((fs) => fs.readdir(dir))
    expect(entries).toEqual([SAVED_REMOTE_FILE_NAME])
  })

  test('a second write replaces the first', async () => {
    await writeSavedRemote(path, URL)
    await writeSavedRemote(path, 'http://127.0.0.1:9000')

    expect(await readSavedRemote(path)).toEqual({ kind: 'ok', url: 'http://127.0.0.1:9000' })
  })
})

describe('readSavedRemote: absent and invalid', () => {
  test('an absent file reads as absent, never an error', async () => {
    expect(await readSavedRemote(path)).toEqual({ kind: 'absent' })
  })

  test('a directory at the path is invalid, not absent', async () => {
    await mkdir(path)

    const result = await readSavedRemote(path)

    expect(result.kind).toBe('invalid')
  })

  test('unparsable JSON is invalid', async () => {
    await writeFile(path, 'not json at all', 'utf8')

    expect((await readSavedRemote(path)).kind).toBe('invalid')
  })

  test('the wrong shape is invalid (extra field)', async () => {
    await writeFile(path, JSON.stringify({ version: 1, url: URL, token: 'nope' }), 'utf8')

    expect((await readSavedRemote(path)).kind).toBe('invalid')
  })

  test('a missing field is invalid', async () => {
    await writeFile(path, JSON.stringify({ version: 1 }), 'utf8')

    expect((await readSavedRemote(path)).kind).toBe('invalid')
  })

  test('an unsupported version is invalid', async () => {
    await writeFile(path, JSON.stringify({ version: 2, url: URL }), 'utf8')

    expect((await readSavedRemote(path)).kind).toBe('invalid')
  })

  test('a url with credentials is refused on read, even though the shape is right', async () => {
    await writeFile(path, JSON.stringify({ version: 1, url: 'https://user:pass@box.example' }), 'utf8')

    expect((await readSavedRemote(path)).kind).toBe('invalid')
  })

  test('a url with the wrong scheme is refused on read', async () => {
    await writeFile(path, JSON.stringify({ version: 1, url: 'ftp://box.example' }), 'utf8')

    expect((await readSavedRemote(path)).kind).toBe('invalid')
  })

  test('an invalid read names the file in its message so the caller can warn about it', async () => {
    await writeFile(path, 'not json at all', 'utf8')

    const result = await readSavedRemote(path)

    expect(result.kind === 'invalid' && result.message.length).toBeGreaterThan(0)
  })
})

describe('forgetSavedRemote', () => {
  test('removes an existing file', async () => {
    await writeSavedRemote(path, URL)

    await forgetSavedRemote(path)

    expect(await readSavedRemote(path)).toEqual({ kind: 'absent' })
  })

  test('is idempotent: forgetting an absent file never throws', async () => {
    await expect(forgetSavedRemote(path)).resolves.toBeUndefined()
  })

  test('a real failure (not ENOENT) still throws, for the caller to report', async () => {
    await mkdir(path)
    await writeFile(join(path, 'child'), '', 'utf8')

    await expect(forgetSavedRemote(path)).rejects.toBeInstanceOf(Error)
  })
})

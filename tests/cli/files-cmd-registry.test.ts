import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { dispatch } from '../../src/cli.js'
import { createRootsStore } from '../../src/files/roots-store.js'
import { createRegistryStore } from '../../src/registry/store.js'

/** `files root add` ensures the built-in `files` server is registered; `files grant` needs it (ADR-0020 §1). */

let base: string
let journalDir: string
let root: string
let ownerToken: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-files-reg-')))
  journalDir = join(base, 'state')
  await mkdir(journalDir, { recursive: true })
  root = join(base, 'data')
  await mkdir(root, { recursive: true })
  ownerToken = (await createAdminStore({ journalDir }).createAdmin('alice', 'owner')).token
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function files(args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: { write: (chunk: string) => out.push(chunk) }, stderr: { write: (chunk: string) => err.push(chunk) } }
  const code = await dispatch(['files', ...args], io, { files: { journalDir, env: { [ADMIN_TOKEN_ENV_VAR]: ownerToken } } })
  return { code, out: out.join(''), err: err.join('') }
}

const registry = () => createRegistryStore(journalDir)

describe('files root add and the registry', () => {
  test('registers the built-in files server and says so', async () => {
    const result = await files(['root', 'add', root])
    expect(result.code).toBe(0)
    expect(await registry().getServer('files')).toEqual({ name: 'files', transport: 'builtin', kind: 'files' })
    expect(result.out).toContain('files')
    expect(result.out).toContain('built-in')
  })

  test('is idempotent: adding a second root keeps one record and does not repeat the registration line', async () => {
    await files(['root', 'add', root])
    const second = join(base, 'second')
    await mkdir(second)
    const result = await files(['root', 'add', second])
    expect(result.code).toBe(0)
    expect(result.out).not.toContain('registered the built-in')
    expect((await registry().listServers()).filter((server) => server.name === 'files')).toHaveLength(1)
  })

  test('re-adding the same root still repairs a removed registry record', async () => {
    await files(['root', 'add', root])
    await registry().removeServer('files')
    const result = await files(['root', 'add', root])
    expect(result.code).toBe(0)
    expect((await registry().getServer('files'))?.transport).toBe('builtin')
  })

  test('refuses in one line, changing nothing, when a non-builtin server is named files', async () => {
    await registry().addServer({ name: 'files', transport: 'stdio', command: 'node' })
    const result = await files(['root', 'add', root])
    expect(result.code).toBe(1)
    expect(result.err.trim().split('\n')).toHaveLength(1)
    expect(result.err).toContain('"files"')
    expect(result.err).toContain('mcpcut server remove files')
    expect(await createRootsStore({ journalDir }).list()).toEqual([])
    expect((await registry().getServer('files'))?.transport).toBe('stdio')
  })
})

describe('files grant and the registry', () => {
  test('refuses when the built-in server is not registered, naming the root add command', async () => {
    await createAgentsStore({ journalDir }).createAgent('me')
    const result = await files(['grant', 'me', root, '--ops', 'read'])
    expect(result.code).toBe(1)
    expect(result.err.trim().split('\n')).toHaveLength(1)
    expect(result.err).toContain(`mcpcut files root add ${root}`)
    expect((await createAgentsStore({ journalDir }).getAgent('me'))?.grants).toEqual({})
  })

  test('refuses when a non-builtin server holds the name', async () => {
    await createAgentsStore({ journalDir }).createAgent('me')
    await registry().addServer({ name: 'files', transport: 'stdio', command: 'node' })
    const result = await files(['grant', 'me', root, '--ops', 'read'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('"files"')
  })

  test('works after root add', async () => {
    await createAgentsStore({ journalDir }).createAgent('me')
    await files(['root', 'add', root])
    expect((await files(['grant', 'me', root, '--ops', 'read'])).code).toBe(0)
  })
})

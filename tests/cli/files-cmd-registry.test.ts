import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { dispatch } from '../../src/cli.js'
import { createRootsStore } from '../../src/files/roots-store.js'
import { createFilesServer } from '../../src/files/server.js'
import { PROBE_FILES_BACKEND } from '../../src/files/upstream.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import { INVENTORY_FILE_NAME, createInventory, listAllQuarantined } from '../../src/policy/inventory.js'
import type { ToolDescriptor } from '../../src/protocol/mcp.js'
import { createRegistryStore } from '../../src/registry/store.js'
import { readJournalRecords } from '../support/journal-rows.js'

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

/** The tools the built-in server lists, exactly as the gate parses them off the wire; `search_files` only while an index rule is on. */
async function builtinCatalog(isSearchListed = true): Promise<readonly ToolDescriptor[]> {
  const backend = { ...PROBE_FILES_BACKEND, searchListed: async () => isSearchListed }
  const response = await createFilesServer(backend).handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const wire = JSON.parse(JSON.stringify(response)) as { result: { tools: ToolDescriptor[] } }
  return wire.result.tools
}

async function observeBuiltin(isSearchListed = true) {
  const inventory = createInventory('files', { storePath: join(journalDir, INVENTORY_FILE_NAME) })
  await inventory.load()
  return inventory.observeToolsList(await builtinCatalog(isSearchListed))
}

async function quarantineApprovals(): Promise<Array<Record<string, unknown>>> {
  const payloads = (await readJournalRecords(journalDir, ACCESS_EDIT_SESSION_ID)).map((record) => record.payload as Record<string, unknown>)
  return payloads.filter((payload) => payload['action'] === 'quarantine.approve')
}

describe('files root add confirms the built-in tools (no quarantine stop on the first call)', () => {
  test('every built-in tool, search_files included, is known to the gate after root add', async () => {
    const result = await files(['root', 'add', root])

    expect(result.code).toBe(0)
    const observed = await observeBuiltin()
    expect(observed.new).toEqual([])
    expect(observed.changed).toEqual([])
    expect(observed.known).toEqual((await builtinCatalog()).map((tool) => tool.name))
    expect(observed.known).toContain('search_files')
  })

  test('the catalog without search_files (no index rule on) is known too', async () => {
    await files(['root', 'add', root])

    const observed = await observeBuiltin(false)
    expect(observed.known).not.toContain('search_files')
    expect(observed.new).toEqual([])
    expect(observed.changed).toEqual([])
  })

  test('says so in one stdout line and one audit line, before the next step', async () => {
    const result = await files(['root', 'add', root])
    const count = (await builtinCatalog()).length

    expect(result.out).toContain(`confirmed the built-in file server's ${count} tools`)
    const auditLines = result.err.split('\n').filter((line) => line.startsWith('[audit] quarantine approve'))
    expect(auditLines).toEqual([`[audit] quarantine approve by alice (owner): files (${count} built-in tools)`])
  })

  test('journals one quarantine.approve per tool, naming the owner', async () => {
    await files(['root', 'add', root])

    const approvals = await quarantineApprovals()
    expect(approvals.map((payload) => payload['tool'])).toEqual((await builtinCatalog()).map((tool) => tool.name))
    expect(approvals.every((payload) => payload['server'] === 'files')).toBe(true)
    expect(approvals[0]?.['actor']).toEqual(expect.objectContaining({ adminName: 'alice', role: 'owner' }))
  })

  test('a second root add confirms nothing again: no line, no records', async () => {
    await files(['root', 'add', root])
    const second = join(base, 'second')
    await mkdir(second)
    const before = (await quarantineApprovals()).length

    const result = await files(['root', 'add', second])

    expect(result.out).not.toContain('confirmed the built-in')
    expect(result.err).not.toContain('[audit] quarantine')
    expect(await quarantineApprovals()).toHaveLength(before)
  })

  test('after the built-in server is removed, root add registers it again and confirms its tools anew', async () => {
    await files(['root', 'add', root])
    await registry().removeServer('files')
    expect((await observeBuiltin()).known).toEqual([])

    const result = await files(['root', 'add', root])

    expect(result.out).toContain(`confirmed the built-in file server's ${(await builtinCatalog()).length} tools`)
    expect((await observeBuiltin()).new).toEqual([])
  })

  test("leaves another server's quarantined tools in quarantine", async () => {
    const probe = createInventory('probe', { storePath: join(journalDir, INVENTORY_FILE_NAME) })
    await probe.load()
    await probe.observeToolsList([{ name: 'list_roots', description: 'not ours' }])

    await files(['root', 'add', root])

    expect((await listAllQuarantined(join(journalDir, INVENTORY_FILE_NAME))).map((entry) => entry.serverName)).toEqual(['probe'])
  })

  test('a corrupt inventory store refuses in one line naming the command to rerun, and adds no root', async () => {
    await writeFile(join(journalDir, INVENTORY_FILE_NAME), '{ not json', 'utf8')

    const result = await files(['root', 'add', root])

    expect(result.code).toBe(1)
    const lines = result.err.trim().split('\n').filter((line) => !line.startsWith('[audit]'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('corrupt')
    expect(lines[0]).toContain(`run \`mcpcut files root add ${root}\` again`)
    expect(await createRootsStore({ journalDir }).list()).toEqual([])
    expect(await quarantineApprovals()).toEqual([])
  })

  test('a refused root add confirms nothing', async () => {
    const result = await files(['root', 'add', join(base, 'missing')])

    expect(result.code).toBe(1)
    expect(await quarantineApprovals()).toEqual([])
    expect((await observeBuiltin()).known).toEqual([])
  })
})

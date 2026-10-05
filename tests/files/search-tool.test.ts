import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createFilesServer, type FilesServerDeps } from '../../src/files/server.js'
import { needsOf } from '../../src/files/tool-access.js'
import { createIndexRulesStore } from '../../src/files/search/index-rules-store.js'
import { createAgentFilesBackend, PROBE_FILES_BACKEND } from '../../src/files/upstream.js'
import { TOOL_SPECS } from '../../src/files/tools.js'
import { makeHarness } from './server-helpers.js'

/** `search_files` without Postgres: its spec, the rights it needs, when it is listed, what it says without a backend. */

const BASE: FilesServerDeps = { roots: async () => [], rules: async () => [], actor: 'tester' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function listedNames(deps: FilesServerDeps): Promise<string[]> {
  const response = (await createFilesServer(deps).handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
    result: { tools: Array<{ name: string }> }
  }
  return response.result.tools.map((tool) => tool.name)
}

describe('search_files spec', () => {
  const spec = TOOL_SPECS.find((candidate) => candidate.name === 'search_files')

  test('is a read-class tool with a query, an optional path and an optional limit', () => {
    expect(spec?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
    expect(spec?.schema.safeParse({ query: 'refunds' }).success).toBe(true)
    expect(spec?.schema.safeParse({ query: 'refunds', path: '/data', limit: 20 }).success).toBe(true)
  })

  test.each([
    ['an empty query', { query: '' }],
    ['a query over the cap', { query: 'x'.repeat(1001) }],
    ['a limit of 0', { query: 'a', limit: 0 }],
    ['a limit over the cap', { query: 'a', limit: 21 }],
    ['a fractional limit', { query: 'a', limit: 1.5 }],
    ['an unknown key', { query: 'a', mode: 'fast' }],
    ['no query', {}],
  ])('refuses %s', (_label, args) => {
    expect(spec?.schema.safeParse(args).success).toBe(false)
  })
})

describe('search_files needs', () => {
  test('under a path it needs read on that path', () => {
    expect(needsOf('search_files', { query: 'a', path: '/data/x' })).toEqual([
      { kind: 'fixed', raw: '/data/x', ops: ['read'], isRemoved: false },
    ])
  })

  test('without a path it needs nothing at the gate, and invalid arguments are the server\'s to refuse', () => {
    expect(needsOf('search_files', { query: 'a' })).toEqual([])
    expect(needsOf('search_files', { query: '' })).toBeUndefined()
  })
})

describe('search_files listing', () => {
  test('is not listed without searchListed, or when it says false or fails', async () => {
    expect(await listedNames(BASE)).not.toContain('search_files')
    expect(await listedNames({ ...BASE, searchListed: async () => false })).not.toContain('search_files')
    expect(await listedNames({ ...BASE, searchListed: async () => { throw new Error('store broken') } })).not.toContain('search_files')
    expect(await listedNames(BASE)).toHaveLength(9)
  })

  test('is listed when an index rule is on', async () => {
    const names = await listedNames({ ...BASE, searchListed: async () => true })

    expect(names).toHaveLength(10)
    expect(names).toContain('search_files')
  })

  test('the probe backend lists it, so "Create policy" sees it', async () => {
    expect(await listedNames(PROBE_FILES_BACKEND)).toContain('search_files')
  })

  test('an agent backend lists it exactly when the index rules store has an enabled rule', async () => {
    const journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-search-list-'))
    cleanups.push(() => rm(journalDir, { recursive: true, force: true }))
    const backend = createAgentFilesBackend({ agentName: 'me', agents: { getAgent: async () => undefined }, journalDir })
    const rules = createIndexRulesStore({ journalDir })
    expect(await backend.searchListed?.()).toBe(false)

    await rules.set('/data/a', false)
    expect(await backend.searchListed?.()).toBe(false)

    await rules.set('/data/b', true)
    expect(await backend.searchListed?.()).toBe(true)
    await backend.dispose?.()
  })
})

describe('search_files without a search backend', () => {
  test('a path the agent cannot read is refused first, like read_file', async () => {
    const harness = await makeHarness(['write'])
    cleanups.push(harness.sandbox.cleanup)
    await mkdir(join(harness.sandbox.root, 'dir'))
    const target = join(harness.sandbox.root, 'dir')

    const result = await harness.call('search_files', { query: 'a', path: target })

    expect(result).toEqual({ isError: true, text: `No right to read ${target}: your rights there are write. Call list_roots to see your folders.` })
  })

  test('a call with no backend says search is not set up and what to run', async () => {
    const harness = await makeHarness(['read'])
    cleanups.push(harness.sandbox.cleanup)

    const result = await harness.call('search_files', { query: 'a' })

    expect(result.isError).toBe(true)
    expect(result.text).toBe('search by meaning is not available: this file server has no search set up: ask an administrator to run `mcpcut files setup --search`')
  })

  test('closed rules answer with their own message', async () => {
    const harness = await makeHarness(['read'])
    cleanups.push(harness.sandbox.cleanup)
    const link = join(harness.sandbox.root, 'link')
    await mkdir(join(harness.sandbox.root, 'real'))
    await symlink(join(harness.sandbox.root, 'real'), link)
    harness.rules = [{ path: link, ops: ['read'] }]

    const result = await harness.call('search_files', { query: 'a' })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('File access is closed')
  })
})

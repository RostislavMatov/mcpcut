import { afterEach, beforeEach, expect, test } from 'vitest'
import type { FileRule } from '../../../src/files/rights.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import { createSearchBackend, type SearchBackend } from '../../../src/files/search/search-backend.js'
import { createFilesServer, type FilesServer } from '../../../src/files/server.js'
import { createSearchFixture, type SearchFixture } from './search-fixture.js'
import { describePg } from '../db/pg-helpers.js'

/**
 * The acceptance test of phase 5 (ADR-0020 §2, §6): `search_files` returns passages ONLY from files the
 * agent may `read_file`, on a real Postgres, even when the files it may not read are the closest vectors.
 */

const QUERY = 'refund returns policy'
let fx: SearchFixture
let backends: SearchBackend[] = []

beforeEach(async () => {
  fx = await createSearchFixture()
})
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()))
  await fx.cleanup()
})

function serverFor(rules: () => readonly FileRule[], roots: readonly string[]): FilesServer {
  const search = createSearchBackend({
    journalDir: fx.journalDir,
    cli: 'mcpcut',
    schema: fx.schema,
    loadPg: () => loadPg(process.cwd()),
    createEmbedder: async () => fx.embedder,
  })
  backends = [...backends, search]
  return createFilesServer({ roots: async () => roots, rules: async () => rules(), actor: 'a', searchListed: async () => true, search })
}

async function callSearch(server: FilesServer, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const response = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_files', arguments: args } })) as {
    result: { content: Array<{ text: string }>; isError?: boolean }
  }
  return { text: response.result.content[0]?.text ?? '', isError: response.result.isError === true }
}

const pathsOf = (text: string): string[] => (JSON.parse(text) as { results: Array<{ path: string }> }).results.map((hit) => hit.path)

async function setup(): Promise<{ a: string; b: string }> {
  await fx.put({
    'A/pub.md': 'refund policy for returns: open to everyone in the team, ask the desk about refund returns',
    'A/private/secret.md': 'refund returns policy',
    'A/x/inner.md': 'refund returns policy inner notes',
    'B/other.md': 'refund returns policy',
  })
  await fx.index([fx.dir('A'), fx.dir('B')])
  return { a: fx.dir('A'), b: fx.dir('B') }
}

describePg('search_files: rights decide what a search can return', () => {
  test('only files outside the cut-out folder and the ungranted root come back, though they are the closest', async () => {
    const { a, b } = await setup()
    const rules: FileRule[] = [{ path: a, ops: ['read'] }, { path: `${a}/private`, ops: [] }]
    const server = serverFor(() => rules, [a, b])

    const found = await callSearch(server, { query: QUERY, limit: 20 })

    expect(found.isError).toBe(false)
    expect(pathsOf(found.text).sort()).toEqual([`${a}/pub.md`, `${a}/x/inner.md`])
  })

  test('a path on the ungranted root is refused like read_file refuses it', async () => {
    const { a, b } = await setup()
    const server = serverFor(() => [{ path: a, ops: ['read'] }], [a, b])

    const refused = await callSearch(server, { query: QUERY, path: b })

    expect(refused).toEqual({
      text: `No right to read ${b}: your rights there are none. Call list_roots to see your folders.`,
      isError: true,
    })
  })

  test('a right revoked after indexing applies to the next search without re-indexing', async () => {
    const { a, b } = await setup()
    let rules: FileRule[] = [{ path: a, ops: ['read'] }]
    const server = serverFor(() => rules, [a, b])
    expect(pathsOf((await callSearch(server, { query: QUERY, limit: 20 })).text)).toContain(`${a}/x/inner.md`)

    rules = [{ path: a, ops: ['read'] }, { path: `${a}/x`, ops: [] }]
    const after = await callSearch(server, { query: QUERY, limit: 20 })

    expect(pathsOf(after.text)).not.toContain(`${a}/x/inner.md`)
    expect(pathsOf(after.text)).toContain(`${a}/pub.md`)
  })

  test('with path, only the files under that folder come back', async () => {
    const { a, b } = await setup()
    const server = serverFor(() => [{ path: a, ops: ['read'] }], [a, b])

    const found = await callSearch(server, { query: QUERY, path: `${a}/x`, limit: 20 })

    expect(pathsOf(found.text)).toEqual([`${a}/x/inner.md`])
  })

  test('an agent that can read nothing indexed is told so, with the admin command', async () => {
    const { a, b } = await setup()
    const server = serverFor(() => [], [a, b])

    const found = await callSearch(server, { query: QUERY })

    expect(found).toEqual({
      text: 'None of the folders you can read is indexed yet: ask an administrator to run `mcpcut files index on <folder>`.',
      isError: false,
    })
  })

  test('a readable folder with nothing indexed in it says what to try next', async () => {
    await fx.put({ 'A/empty/.env': 'TOKEN=1', 'A/pub.md': 'refund policy' })
    await fx.index([fx.dir('A')])
    const a = fx.dir('A')
    const server = serverFor(() => [{ path: a, ops: ['read'] }], [a])

    const found = await callSearch(server, { query: QUERY, path: `${a}/empty` })

    expect(found).toEqual({
      text: 'Nothing matched in the indexed folders you can read: try other words, or call list_roots to see your folders.',
      isError: false,
    })
  })
})

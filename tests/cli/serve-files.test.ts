import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createIndexRulesStore } from '../../src/files/search/index-rules-store.js'
import { createRootsStore } from '../../src/files/roots-store.js'
import { AGENT, INITIALIZE_BODY, disposeServeFixtures, startServe, waitUntil, type ServeFixture } from './serve-harness.js'

/** The built-in file server behind `serve` (ADR-0020 §1): the HTTP path opens it in process and checks rights in the gate. */

/** Roots live beside mcpcut's data folder, never inside it. */
const rootParents: string[] = []

afterEach(async () => {
  await disposeServeFixtures()
  await Promise.all(rootParents.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const FILES_PATH = `/agents/${AGENT}/servers/files`

function rpc(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params })
}

async function setup(ops: readonly ('read' | 'write' | 'edit' | 'delete')[]): Promise<{ fixture: ServeFixture; folder: string; sessionId: string }> {
  const fixture = await startServe()
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-serve-root-')))
  rootParents.push(root)
  const folder = join(root, 'data', 'work')
  await mkdir(folder, { recursive: true })
  await createRootsStore({ journalDir: fixture.journalDir }).add(join(root, 'data'))
  await fixture.registry.addServer({ name: 'files', transport: 'builtin', kind: 'files' })
  await fixture.agents.setServerGrant(AGENT, 'files', { tools: '*', paths: [{ path: folder, ops: [...ops] }] })
  const init = await fixture.post(INITIALIZE_BODY, {}, FILES_PATH)
  expect(init.status).toBe(200)
  return { fixture, folder, sessionId: init.headers.get('mcp-session-id') as string }
}

async function decisionRules(fixture: ServeFixture): Promise<Array<[string, string]>> {
  const records = await fixture.journalRecords()
  return records.flatMap((record) => (record.decision && record.decision.toolName !== 'tools/list' ? [[record.decision.toolName, record.decision.rule] as [string, string]] : []))
}

describe('runServe: the built-in file server', () => {
  test('serves tools/list, writes and reads in the granted folder, and journals the calls', async () => {
    const { fixture, folder, sessionId } = await setup(['read', 'write'])
    const headers = { 'mcp-session-id': sessionId }
    const target = join(folder, 'a.txt')

    const listed = (await (await fixture.post(rpc(2, 'tools/list', {}), headers, FILES_PATH)).json()) as { result: { tools: unknown[] } }
    const written = (await (await fixture.post(rpc(3, 'tools/call', { name: 'write_file', arguments: { path: target, content: 'over http' } }), headers, FILES_PATH)).json()) as Record<string, unknown>
    const read = (await (await fixture.post(rpc(4, 'tools/call', { name: 'read_file', arguments: { path: target } }), headers, FILES_PATH)).json()) as { result: { content: Array<{ text: string }> } }

    expect(listed.result.tools).toHaveLength(9)
    expect(written['error']).toBeUndefined()
    expect(await readFile(target, 'utf8')).toBe('over http')
    expect(read.result.content[0]?.text).toContain('over http')
    await waitUntil(async () => (await decisionRules(fixture)).length >= 2, 'the tool decisions in the journal')
    expect((await decisionRules(fixture)).map(([tool]) => tool)).toEqual(expect.arrayContaining(['write_file', 'read_file']))
  })

  test('search_files with no Postgres tells the agent a fixed line and the administrator the detail once', async () => {
    const { fixture, folder, sessionId } = await setup(['read'])
    await createIndexRulesStore({ journalDir: fixture.journalDir }).set(folder, true)
    const headers = { 'mcp-session-id': sessionId }
    const search = async (id: number): Promise<string> => {
      const answer = (await (await fixture.post(rpc(id, 'tools/call', { name: 'search_files', arguments: { query: 'anything' } }), headers, FILES_PATH)).json()) as {
        result: { content: Array<{ text: string }> }
      }
      return answer.result.content[0]?.text ?? ''
    }

    const first = await search(2)
    const second = await search(3)

    const line = 'Search by meaning is not available right now: ask an administrator to run `mcpcut files db status`.'
    expect([first, second]).toEqual([line, line])
    const heard = fixture.io.errText().split('\n').filter((entry) => entry.includes('search by meaning is not available to agents'))
    expect(heard).toEqual(['serve: search by meaning is not available to agents: Postgres is not set up: an administrator runs `mcpcut files db init`. Next: mcpcut files db status'])
  })

  test('a delete without the right is denied in the gate with the files rule in the journal', async () => {
    const { fixture, folder, sessionId } = await setup(['read', 'write'])
    const target = join(folder, 'keep.txt')

    const denied = (await (await fixture.post(rpc(2, 'tools/call', { name: 'delete_file', arguments: { path: target } }), { 'mcp-session-id': sessionId }, FILES_PATH)).json()) as Record<string, unknown>

    expect(denied['error']).toBeDefined()
    await waitUntil(async () => (await decisionRules(fixture)).some(([, rule]) => rule.startsWith('files:')), 'the files decision in the journal')
    expect((await decisionRules(fixture)).map(([, rule]) => rule)).toContain(`files: no right delete on ${target}`)
  })

  test('a revoked agent right applies at the next call on the same HTTP session', async () => {
    const { fixture, folder, sessionId } = await setup(['read'])
    const target = join(folder, 'x.txt')
    await fixture.agents.setServerGrant(AGENT, 'files', { tools: '*' })

    const answer = await fixture.post(rpc(2, 'tools/call', { name: 'read_file', arguments: { path: target } }), { 'mcp-session-id': sessionId }, FILES_PATH)
    const body = JSON.stringify(await answer.json())

    expect(body).toContain('files: no right read')
  })
})

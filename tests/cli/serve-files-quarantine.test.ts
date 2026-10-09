import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { dispatch } from '../../src/cli.js'
import { AGENT, INITIALIZE_BODY, captureIo, disposeServeFixtures, startServe, waitUntil } from './serve-harness.js'

/**
 * The built-in file server under the default quarantine (found live on
 * 2026-10-09, phase E5): its tools are mcpcut's own, so the agent's first
 * `list_roots` answers at once once `files root add` has run — it does not
 * wait for a person to release a tool mcpcut itself ships.
 */

const FILES_PATH = `/agents/${AGENT}/servers/files`
/** Well under the harness's 10 s wait: a held call never answers, so this is what fails the test. */
const ANSWER_TIMEOUT_MS = 5_000
const rootParents: string[] = []

afterEach(async () => {
  await disposeServeFixtures()
  await Promise.all(rootParents.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function rpc(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params })
}

async function withinTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ANSWER_TIMEOUT_MS} ms`)), ANSWER_TIMEOUT_MS)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

describe('runServe: the built-in file server under the default quarantine', () => {
  test("after files root add, the agent's first list_roots answers at once", { timeout: 20_000 }, async () => {
    const fixture = await startServe({ policy: { version: 1, defaultDecision: 'allow' } })
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-serve-quarantine-')))
    rootParents.push(parent)
    const folder = join(parent, 'data')
    await mkdir(folder)
    const ownerToken = (await createAdminStore({ journalDir: fixture.journalDir }).createAdmin('alice', 'owner')).token
    const io = captureIo()
    const added = await dispatch(['files', 'root', 'add', folder], io, {
      files: { journalDir: fixture.journalDir, env: { [ADMIN_TOKEN_ENV_VAR]: ownerToken } },
    })
    expect(added).toBe(0)
    await fixture.agents.setServerGrant(AGENT, 'files', { tools: '*', paths: [{ path: folder, ops: ['read'] }] })

    const init = await fixture.post(INITIALIZE_BODY, {}, FILES_PATH)
    const headers = { 'mcp-session-id': init.headers.get('mcp-session-id') as string }
    await fixture.post(rpc(2, 'tools/list', {}), headers, FILES_PATH)
    const answer = await withinTimeout(
      fixture.post(rpc(3, 'tools/call', { name: 'list_roots', arguments: {} }), headers, FILES_PATH).then((res) => res.json()),
      'list_roots',
    ) as { result?: { content: Array<{ text: string }> } }

    expect(answer.result?.content[0]?.text).toContain(folder)
    await waitUntil(async () => (await fixture.journalRecords()).some((record) => record.decision?.toolName === 'list_roots'), 'the list_roots decision')
    const decision = (await fixture.journalRecords()).find((record) => record.decision?.toolName === 'list_roots')?.decision
    expect(decision?.rule).not.toBe('quarantine')
    expect(decision?.outcome).toBe('allow')
  })
})

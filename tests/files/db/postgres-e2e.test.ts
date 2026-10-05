import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../../src/admin/constants.js'
import { createAdminStore } from '../../../src/admin/store.js'
import { createAgentsStore } from '../../../src/agents/store.js'
import { runConnect } from '../../../src/cli/connect-cmd.js'
import { runFilesCommand } from '../../../src/cli/files-cmd.js'
import { FILES_PG_URL_SECRET } from '../../../src/files/db/constants.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import { DB_SCHEMA_ENV_VAR } from '../../../src/files/db/schema-env.js'
import { createVaultStore } from '../../../src/vault/store.js'
import { createCliCapture, createConnectStdio } from '../../cli/connect-harness.js'
import { requestLine, waitUntil } from '../../proxy/harness.js'
import { describePg, PG_URL, withTestSchema } from './pg-helpers.js'

/**
 * Phase 4 end to end on a real Postgres and a temp data dir: owner, root,
 * grant, calls through the built-in server, `files db init`, `files db sync`,
 * then the same `files audit --path` from Postgres and from the journal.
 */

const AGENT = 'me'
const SESSION = 'pg-e2e'

let base: string
let journalDir: string
let root: string
let folder: string
let ownerToken: string
let agentToken: string
let cleanup: (() => Promise<void>) | undefined
let schema: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-pg-e2e-')))
  journalDir = join(base, 'state')
  root = join(base, 'data')
  folder = join(root, 'work')
  await mkdir(folder, { recursive: true })
  await mkdir(journalDir, { recursive: true })
  ownerToken = (await createAdminStore({ journalDir }).createAdmin('alice', 'owner')).token
  agentToken = (await createAgentsStore({ journalDir }).createAgent(AGENT)).token
  const test_ = withTestSchema()
  schema = test_.schema
  cleanup = test_.cleanup
})

afterEach(async () => {
  await cleanup?.()
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function files(args: string[], withToken = true): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: { write: (chunk: string) => out.push(chunk) }, stderr: { write: (chunk: string) => err.push(chunk) } }
  const code = await runFilesCommand(args, io, {
    journalDir,
    env: { [DB_SCHEMA_ENV_VAR]: schema, ...(withToken ? { [ADMIN_TOKEN_ENV_VAR]: ownerToken } : {}) },
    db: { loadPg: () => loadPg(process.cwd()) },
  })
  return { code, out: out.join(''), err: err.join('') }
}

async function agentWorks(target: string): Promise<void> {
  const policy = { version: 1, quarantine: { enabled: false }, defaultDecision: 'allow', approval: { timeoutMs: 20_000 }, servers: {} }
  await writeFile(join(journalDir, 'policy.json'), JSON.stringify(policy), 'utf8')
  const stdio = createConnectStdio()
  const run = runConnect(['files', '--agent', AGENT], createCliCapture(), {
    journalDir,
    env: { MCP_AGENT_TOKEN: agentToken, PATH: process.env['PATH'] ?? '' },
    cwd: base,
    stdin: stdio.clientOutbox,
    stdout: stdio.clientStdout,
    stderr: stdio.clientStderr,
    sessionId: SESSION,
    revocationPollIntervalMs: 25,
  })
  const ask = async (id: number, method: string, params?: Record<string, unknown>): Promise<void> => {
    stdio.clientOutbox.write(requestLine(id, method, params))
    await waitUntil(() => stdio.messages().some((message) => message['id'] === id))
  }
  await ask(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  await ask(2, 'tools/call', { name: 'write_file', arguments: { path: target, content: 'hi there' } })
  await ask(3, 'tools/call', { name: 'read_file', arguments: { path: target } })
  await ask(4, 'tools/call', { name: 'delete_file', arguments: { path: target } })
  stdio.clientOutbox.end()
  expect(await run).toBe(0)
}

describePg('files audit from Postgres equals files audit from the journal', () => {
  test('init, sync, then the same entries with and without the secret', async () => {
    const target = join(folder, 'hello.txt')
    expect((await files(['root', 'add', root])).code).toBe(0)
    expect((await files(['grant', AGENT, folder, '--ops', 'read,write'])).code).toBe(0)
    await agentWorks(target)

    await createVaultStore({ journalDir }).init()
    await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, PG_URL)
    const init = await files(['db', 'init'], false)
    expect(init.code).toBe(0)
    expect(init.out).toBe(`Postgres ready: postgres://mcpcut@127.0.0.1:55439/mcpcut_test (schema ${schema}, version 1)\n`)

    const sync = await files(['db', 'sync'], false)
    expect(sync.code).toBe(0)
    expect(sync.out).toMatch(/^events: \+\d+ \(synced through record \d+\)\n/)
    expect(sync.out).toContain(`${root}  1 files, 1 folders`)
    expect(sync.err).toBe(`Next: mcpcut files audit --path ${root}\n`)

    const fromPg = await files(['audit', '--path', target], false)
    await createVaultStore({ journalDir }).removeSecret(FILES_PG_URL_SECRET)
    const fromJournal = await files(['audit', '--path', target], false)

    expect(fromPg.err).toContain('from Postgres')
    expect(fromJournal.err).not.toContain('from Postgres')
    expect(fromPg.out).toBe(fromJournal.out)
    expect(fromPg.out.trimEnd().split('\n').length).toBeGreaterThanOrEqual(5)
    expect(fromPg.out).toContain('delete_file')
    expect(fromPg.out + fromPg.err + sync.out + sync.err).not.toContain('mcpcut-test@')
  })
})

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { runConnect } from '../../src/cli/connect-cmd.js'
import { runFilesCommand } from '../../src/cli/files-cmd.js'
import { FILES_PG_URL_SECRET } from '../../src/files/db/constants.js'
import { walkRoots } from '../../src/files/db/catalog-walk.js'
import { openFilesDb, type FilesDb } from '../../src/files/db/connection.js'
import { loadPg } from '../../src/files/db/pg-loader.js'
import { createIndexRulesStore } from '../../src/files/search/index-rules-store.js'
import { indexOnce } from '../../src/files/search/indexer.js'
import { ensureSearchSchema } from '../../src/files/search/search-schema.js'
import { createGroupsStore } from '../../src/groups/store.js'
import { createVaultStore } from '../../src/vault/store.js'
import { requestLine, waitUntil } from '../proxy/harness.js'
import { createCliCapture, createConnectStdio } from '../cli/connect-harness.js'
import { readJournalRecords } from '../support/journal-rows.js'
import { createFakeEmbedder } from './search/fake-embedder.js'
import { NOW, ruleOn, usingEmbedder } from './search/index-fixture.js'
import { describePg, PG_URL, withTestSchema } from './db/pg-helpers.js'

/**
 * `search_files` end to end through `mcpcut connect`'s own code path: the agent sees the tool only when an
 * index rule is on, gets passages from the folders it may read (granted personally or through a group), and
 * the journal keeps the call with its result.
 */

const AGENT = 'me'
const SESSION = 'search-e2e'
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'

let base: string
let journalDir: string
let open: string
let closed: string
let ownerToken: string
let agentToken: string
let db: FilesDb
let dropSchema: () => Promise<void>
let schemaName: string
const embedder = createFakeEmbedder()

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-search-e2e-')))
  journalDir = join(base, 'state')
  open = join(base, 'data', 'open')
  closed = join(base, 'data', 'closed')
  await mkdir(journalDir, { recursive: true })
  await mkdir(open, { recursive: true })
  await mkdir(closed, { recursive: true })
  await writeFile(join(open, 'returns.md'), `how to return an item and get a refund\nkey ${AWS_KEY}`)
  await writeFile(join(closed, 'returns.md'), 'how to return an item and get a refund')
  ownerToken = (await createAdminStore({ journalDir }).createAdmin('alice', 'owner')).token
  agentToken = (await createAgentsStore({ journalDir }).createAgent(AGENT)).token
  await createVaultStore({ journalDir }).init()
  await createVaultStore({ journalDir }).setSecret(FILES_PG_URL_SECRET, PG_URL)
  const schema = withTestSchema()
  schemaName = schema.schema
  dropSchema = schema.cleanup
  db = await openFilesDb({ pg: await loadPg(process.cwd()), url: PG_URL, schema: schemaName })
  const sdb = await ensureSearchSchema(db)
  const roots = [join(base, 'data')]
  await walkRoots(db, { roots, now: new Date() })
  await indexOnce(sdb, { roots, rules: roots.map((root) => ruleOn(root)), ...usingEmbedder(embedder), now: NOW, budgetMs: Number.POSITIVE_INFINITY, platform: process.platform })
})

afterEach(async () => {
  await db.close().catch(() => undefined)
  await dropSchema()
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function files(args: string[]): Promise<void> {
  const sink = { write: () => true }
  const code = await runFilesCommand(args, { stdout: sink, stderr: sink }, { journalDir, env: { [ADMIN_TOKEN_ENV_VAR]: ownerToken } })
  expect(code, `mcpcut files ${args.join(' ')}`).toBe(0)
}

async function writePolicy(): Promise<void> {
  const policy = { version: 1, quarantine: { enabled: false }, defaultDecision: 'allow', approval: { timeoutMs: 20_000 }, servers: {} }
  await writeFile(join(journalDir, 'policy.json'), JSON.stringify(policy), 'utf8')
}

function startSession() {
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
    filesSearch: { loadPg: () => loadPg(process.cwd()), schema: schemaName, createEmbedder: async () => embedder },
  })
  const answerOf = async (id: number): Promise<Record<string, unknown>> => {
    await waitUntil(() => stdio.messages().some((message) => message['id'] === id))
    return stdio.messages().find((message) => message['id'] === id) ?? {}
  }
  const ask = async (id: number, method: string, params?: Record<string, unknown>) => {
    void stdio.clientOutbox.write(requestLine(id, method, params))
    return answerOf(id)
  }
  const finish = async (): Promise<number> => {
    stdio.clientOutbox.end()
    return run
  }
  return { ask, finish }
}

const textOf = (answer: Record<string, unknown>): string => ((answer['result'] as { content: Array<{ text: string }> }).content[0]?.text) ?? ''
const initialize = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }
const toolNames = (answer: Record<string, unknown>): string[] => ((answer['result'] as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name)

describePg('mcpcut connect files: search_files', () => {
  test('is listed once an index rule is on, finds the passage in the readable folder only, and is journaled', async () => {
    await files(['root', 'add', join(base, 'data')])
    await files(['grant', AGENT, open, '--ops', 'read'])
    await writePolicy()
    const session = startSession()
    await session.ask(1, 'initialize', initialize)
    const before = toolNames(await session.ask(2, 'tools/list'))
    await createIndexRulesStore({ journalDir }).set(join(base, 'data'), true)
    const after = toolNames(await session.ask(3, 'tools/list'))

    const found = await session.ask(4, 'tools/call', { name: 'search_files', arguments: { query: 'how to return an item and get a refund' } })
    const refused = await session.ask(5, 'tools/call', { name: 'search_files', arguments: { query: 'refund', path: closed } })
    const code = await session.finish()

    expect(before).not.toContain('search_files')
    expect(after).toContain('search_files')
    const results = (JSON.parse(textOf(found)) as { results: Array<{ path: string; lines: string; score: number; text: string }> }).results
    expect(results.map((hit) => hit.path)).toEqual([join(open, 'returns.md')])
    expect(results[0]?.text).not.toContain(AWS_KEY)
    expect(JSON.stringify(refused)).toContain(`files: no right read on ${closed}`)
    expect(code).toBe(0)
    const records = await readJournalRecords(journalDir, SESSION)
    const journaled = records.filter((record) => record.kind !== 'decision' && JSON.stringify(record).includes('how to return an item'))
    expect(journaled.length).toBeGreaterThan(0)
    expect(JSON.stringify(records)).not.toContain(AWS_KEY)
  })

  test('a folder granted through a group reaches the search the same way', async () => {
    await files(['root', 'add', join(base, 'data')])
    await createGroupsStore({ journalDir }).createGroup('team')
    await createGroupsStore({ journalDir }).addMember('team', AGENT)
    await files(['grant', '--group', 'team', open, '--ops', 'read'])
    await createIndexRulesStore({ journalDir }).set(join(base, 'data'), true)
    await writePolicy()
    const session = startSession()
    await session.ask(1, 'initialize', initialize)

    const found = await session.ask(2, 'tools/call', { name: 'search_files', arguments: { query: 'return an item refund' } })
    await session.finish()

    const paths = (JSON.parse(textOf(found)) as { results: Array<{ path: string }> }).results.map((hit) => hit.path)
    expect(paths).toEqual([join(open, 'returns.md')])
  })
})

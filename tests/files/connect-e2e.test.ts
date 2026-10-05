import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { runConnect } from '../../src/cli/connect-cmd.js'
import { runFilesCommand } from '../../src/cli/files-cmd.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'
import { requestLine, waitUntil, waitUntilAsync } from '../proxy/harness.js'
import { createCliCapture, createConnectStdio } from '../cli/connect-harness.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * The built-in file server end to end through `mcpcut connect`'s own code path
 * (ADR-0020 §1): registry record, agent grant, the same session core and gate
 * as a child-process server, on a temp data dir only.
 */

const AGENT = 'me'
const SESSION = 'files-e2e'

let base: string
let journalDir: string
let root: string
let folder: string
let ownerToken: string
let agentToken: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-files-e2e-')))
  journalDir = join(base, 'state')
  root = join(base, 'data')
  folder = join(root, 'work')
  await mkdir(folder, { recursive: true })
  await mkdir(journalDir, { recursive: true })
  ownerToken = (await createAdminStore({ journalDir }).createAdmin('alice', 'owner')).token
  agentToken = (await createAgentsStore({ journalDir }).createAgent(AGENT)).token
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function files(args: string[]): Promise<void> {
  const sink = { write: () => true }
  const code = await runFilesCommand(args, { stdout: sink, stderr: sink }, { journalDir, env: { [ADMIN_TOKEN_ENV_VAR]: ownerToken } })
  expect(code, `mcpcut files ${args.join(' ')}`).toBe(0)
}

async function declareAndGrant(ops: string): Promise<void> {
  await files(['root', 'add', root])
  await files(['grant', AGENT, folder, '--ops', ops])
}

async function writePolicy(servers: Record<string, unknown>): Promise<void> {
  const policy = { version: 1, quarantine: { enabled: false }, defaultDecision: 'allow', approval: { timeoutMs: 20_000 }, servers }
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
  })
  const send = (line: string): void => void stdio.clientOutbox.write(line)
  const answerOf = async (id: number): Promise<Record<string, unknown>> => {
    await waitUntil(() => stdio.messages().some((message) => message['id'] === id))
    return stdio.messages().find((message) => message['id'] === id) ?? {}
  }
  const call = async (id: number, name: string, args: unknown): Promise<Record<string, unknown>> => {
    send(requestLine(id, 'tools/call', { name, arguments: args as Record<string, unknown> }))
    return answerOf(id)
  }
  const finish = async (): Promise<number> => {
    stdio.clientOutbox.end()
    return run
  }
  return { stdio, send, answerOf, call, finish }
}

const textOf = (answer: Record<string, unknown>): string =>
  ((answer['result'] as { content: Array<{ text: string }> }).content[0]?.text) ?? ''

describe('mcpcut connect files: the built-in server through the real session path', () => {
  test('lists nine tools, writes then reads a file, and refuses a delete without the right in the gate', async () => {
    await declareAndGrant('read,write')
    await writePolicy({})
    const session = startSession()
    session.send(requestLine(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }))
    await session.answerOf(1)
    session.send(requestLine(2, 'tools/list'))
    const listed = (await session.answerOf(2))['result'] as { tools: Array<{ name: string }> }

    const target = join(folder, 'hello.txt')
    const written = await session.call(3, 'write_file', { path: target, content: 'hi there' })
    const read = await session.call(4, 'read_file', { path: target })
    const denied = await session.call(5, 'delete_file', { path: target })
    const code = await session.finish()

    expect(listed.tools).toHaveLength(9)
    expect(written['error']).toBeUndefined()
    expect(await readFile(target, 'utf8')).toBe('hi there')
    expect(textOf(read)).toContain('hi there')
    expect(denied['error']).toMatchObject({
      data: { rule: `files: no right delete on ${target}` },
      message: `Call to tool "delete_file" was refused: No right to delete ${target}: your rights there are read, write. Call list_roots to see your folders.`,
    })
    expect(await readFile(target, 'utf8')).toBe('hi there')
    expect(code).toBe(0)

    const records = await readJournalRecords(journalDir, SESSION)
    const decisionRules = records.flatMap((record) => (record.decision ? [[record.decision.toolName, record.decision.outcome, record.decision.rule]] : []))
    expect(decisionRules).toContainEqual(['delete_file', 'deny', `files: no right delete on ${target}`])
    expect(decisionRules).toContainEqual(['write_file', 'allow', expect.any(String)])
    expect(records.some((record) => record.kind !== 'decision' && JSON.stringify(record).includes('hi there'))).toBe(true)
  })

  test('a revoked folder right applies to the very next call without reconnecting', async () => {
    await declareAndGrant('read')
    await writePolicy({})
    const target = join(folder, 'a.txt')
    await writeFile(target, 'secret')
    const session = startSession()
    session.send(requestLine(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }))
    await session.answerOf(1)
    expect(textOf(await session.call(2, 'read_file', { path: target }))).toContain('secret')

    await files(['revoke', AGENT, folder])
    const after = await session.call(3, 'read_file', { path: target })
    await session.finish()

    expect(JSON.stringify(after)).toContain('files: no right read on')
  })

  test('a policy require-approval on delete_file holds the call in the approvals queue', async () => {
    await declareAndGrant('read,write,delete')
    await writePolicy({ files: { tools: { delete_file: 'require-approval' } } })
    const target = join(folder, 'doomed.txt')
    await writeFile(target, 'bye')
    const queue = createApprovalQueue({ baseDir: join(journalDir, 'approvals') })
    const session = startSession()
    session.send(requestLine(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }))
    await session.answerOf(1)

    session.send(requestLine(2, 'tools/call', { name: 'delete_file', arguments: { path: target } }))
    await waitUntilAsync(async () => (await queue.list()).length === 1)
    const [pending] = await queue.list()
    expect(pending?.toolName).toBe('delete_file')
    expect(await readFile(target, 'utf8')).toBe('bye')

    await queue.resolve(pending!.approvalId, { outcome: 'denied', actor: 'cli:alice' })
    await session.answerOf(2)
    await session.finish()
    expect(await readFile(target, 'utf8')).toBe('bye')
  })

  test('without an agent grant for files the connect is refused before any file is reachable', async () => {
    await files(['root', 'add', root])
    const stdio = createConnectStdio()
    const capture = createCliCapture()
    const code = await runConnect(['files', '--agent', AGENT], capture, {
      journalDir,
      env: { MCP_AGENT_TOKEN: agentToken, PATH: process.env['PATH'] ?? '' },
      cwd: base,
      stdin: stdio.clientOutbox,
      stdout: stdio.clientStdout,
      stderr: stdio.clientStderr,
    })
    expect(code).not.toBe(0)
    expect(capture.err()).toContain('files')
  })
})

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createAdminStore } from '../../src/admin/store.js'
import { runConnect } from '../../src/cli/connect-cmd.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'
import { MIN_HUMAN_ANSWER_MS } from '../../src/proxy/client-confirm.js'
import { requestLine, waitUntil, waitUntilAsync } from '../proxy/harness.js'
import { POLICY_SERVER_FIXTURE, addServerRecord, createCliCapture, createConnectStdio, createGrantedAgent } from './connect-harness.js'

/**
 * ADR-0019 end to end through an agent's `mcpcut connect`, on an installation
 * with admins: the policy names this agent for `echo`, so its user confirms
 * `echo` in the session and nothing waits for an admin. `risky_tool` is held
 * for an admin alone: the queue decides, and no dialog opens.
 */

const AGENT = 'research-bot'
const SERVER = 'fixture'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-connect-confirm-'))
  vi.stubEnv('npm_command', '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const POLICY = {
  version: 1,
  quarantine: { enabled: false },
  defaultDecision: 'allow',
  approval: { timeoutMs: 20_000 },
  servers: { [SERVER]: { tools: { risky_tool: 'require-approval' }, confirmInClient: { echo: [AGENT] } } },
}

const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'claude-code', version: '2.1.287' } },
})}\n`

describe('an agent\'s connect: its user confirms the tools the policy names for it', () => {
  test('echo is confirmed in the client although admins exist; risky_tool waits for an admin, with no dialog', async () => {
    await addServerRecord(tempDir, { name: SERVER, transport: 'stdio', command: process.execPath, args: [POLICY_SERVER_FIXTURE] })
    const token = await createGrantedAgent({ journalDir: tempDir, agentName: AGENT, serverName: SERVER, tools: '*' })
    await createAdminStore({ journalDir: tempDir }).createAdmin('owner', 'owner')
    await writeFile(join(tempDir, 'policy.json'), JSON.stringify(POLICY), 'utf8')
    const queue = createApprovalQueue({ baseDir: join(tempDir, 'approvals') })
    const stdio = createConnectStdio()
    const questions = (): Record<string, unknown>[] => stdio.messages().filter((m) => m['method'] === 'elicitation/create')

    const run = runConnect([SERVER, '--agent', AGENT], createCliCapture(), {
      journalDir: tempDir,
      env: { MCP_AGENT_TOKEN: token, PATH: process.env['PATH'] ?? '' },
      cwd: tempDir,
      stdin: stdio.clientOutbox,
      stdout: stdio.clientStdout,
      stderr: stdio.clientStderr,
      sessionId: 'connect-confirm-in-client',
      revocationPollIntervalMs: 25,
      childExitGraceMs: 1000,
      killEscalationMs: 500,
    })
    stdio.clientOutbox.write(INITIALIZE)
    await waitUntil(() => stdio.messages().some((m) => m['id'] === 1))

    stdio.clientOutbox.write(requestLine(2, 'tools/call', { name: 'echo', arguments: { t: 2 } }))
    await waitUntil(() => questions().length === 1)
    const [question] = questions()
    await new Promise((resolve) => setTimeout(resolve, MIN_HUMAN_ANSWER_MS + 100))
    stdio.clientOutbox.write(`${JSON.stringify({ jsonrpc: '2.0', id: question?.['id'], result: { action: 'accept', content: {} } })}\n`)
    await waitUntil(() => stdio.messages().some((m) => m['id'] === 2))

    stdio.clientOutbox.write(requestLine(3, 'tools/call', { name: 'risky_tool', arguments: {} }))
    await waitUntilAsync(async () => (await queue.list()).length === 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const questionsForRisky = questions().length - 1
    const [pending] = await queue.list()
    await queue.resolve(pending!.approvalId, { outcome: 'denied', actor: 'cli:owner' })
    await waitUntil(() => stdio.messages().some((m) => m['id'] === 3))
    stdio.clientOutbox.end()
    await run

    expect(stdio.messages().find((m) => m['id'] === 2)?.['error']).toBeUndefined()
    expect((question?.['params'] as { message: string }).message).toContain(`mcpcut: allow echo on ${SERVER}?`)
    expect(pending?.toolName).toBe('risky_tool')
    expect(questionsForRisky).toBe(0)
    expect(stdio.messages().find((m) => m['id'] === 3)?.['error']).toMatchObject({ code: -32002 })
  })
})

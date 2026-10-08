import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runConnect } from '../../src/cli/connect-cmd.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'
import { requestLine, waitUntil, waitUntilAsync } from '../proxy/harness.js'
import { POLICY_SERVER_FIXTURE, addServerRecord, createCliCapture, createConnectStdio, createGrantedAgent } from './connect-harness.js'

/**
 * Decision M36 on the stdio `connect` path, end to end: a call held for an
 * admin tells its client which approval it waits for, and the client going
 * away (stdin EOF) withdraws the request — nothing is sent, and a later
 * approve is refused with the reason.
 */

const AGENT = 'research-bot'
const SERVER = 'fixture'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-connect-held-'))
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
  servers: { [SERVER]: { tools: { risky_tool: 'require-approval' } } },
}

describe('connect holds a call for an admin while its agent waits', () => {
  test('the client hears which approval it waits for, and leaving withdraws the request', async () => {
    await addServerRecord(tempDir, { name: SERVER, transport: 'stdio', command: process.execPath, args: [POLICY_SERVER_FIXTURE] })
    const token = await createGrantedAgent({ journalDir: tempDir, agentName: AGENT, serverName: SERVER, tools: '*' })
    await writeFile(join(tempDir, 'policy.json'), JSON.stringify(POLICY), 'utf8')
    const queue = createApprovalQueue({ baseDir: join(tempDir, 'approvals') })
    const stdio = createConnectStdio()

    const run = runConnect([SERVER, '--agent', AGENT], createCliCapture(), {
      journalDir: tempDir,
      env: { MCP_AGENT_TOKEN: token, PATH: process.env['PATH'] ?? '' },
      cwd: tempDir,
      stdin: stdio.clientOutbox,
      stdout: stdio.clientStdout,
      stderr: stdio.clientStderr,
      sessionId: 'connect-held-progress',
      revocationPollIntervalMs: 25,
      childExitGraceMs: 1000,
      killEscalationMs: 500,
    })
    stdio.clientOutbox.write(
      requestLine(3, 'tools/call', { name: 'risky_tool', arguments: {}, _meta: { progressToken: 7 } }),
    )
    await waitUntilAsync(async () => (await queue.list()).length === 1)
    const [pending] = await queue.list()
    await waitUntil(() => stdio.messages().some((m) => m['method'] === 'notifications/progress'))

    stdio.clientOutbox.end() // the agent goes away while its call is held
    await run

    const progress = stdio.messages().find((m) => m['method'] === 'notifications/progress')
    expect(progress?.['params']).toEqual({
      progressToken: 7,
      progress: 1,
      message: 'waiting for a person to approve this call',
    })
    expect(stdio.messages().some((m) => m['id'] === 3)).toBe(false)
    await expect(queue.readResolution(pending!.approvalId)).resolves.toMatchObject({
      outcome: 'withdrawn',
      reason: 'disconnected',
    })
    const late = await queue.resolve(pending!.approvalId, { outcome: 'approved', actor: 'cli:owner' })
    expect(late).toMatchObject({ ok: false, reason: 'withdrawn' })
  })
})

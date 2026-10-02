import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createAdminStore } from '../../src/admin/store.js'
import { runWrapCommand } from '../../src/cli/wrap-cmd.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'
import { MIN_HUMAN_ANSWER_MS } from '../../src/proxy/client-approval.js'
import { FAKE_SERVER_PATH, createClientHarness, receivedMessagesOf, requestLine, waitUntil, waitUntilAsync } from '../proxy/harness.js'

/**
 * P2 end to end through `mcpcut wrap`: a client that declares form
 * elicitation is asked about the held call in the session, and Accept lets
 * the call through — in the client's name. With an admin on the
 * installation nobody is asked: approvals then need a token.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-wrap-ask-client-'))
  vi.stubEnv('npm_command', '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const HELD_POLICY = {
  version: 1,
  defaultDecision: 'allow',
  quarantine: { enabled: false },
  approval: { timeoutMs: 20_000 },
  servers: { fs: { tools: { echo: 'require-approval' } } },
}

const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'claude-code', version: '2.1.287' } },
})}\n`

async function startWrap(harness: ReturnType<typeof createClientHarness>): Promise<{ run: Promise<number>; approvalsBaseDir: string }> {
  const policyPath = join(journalDir, 'policy.json')
  await writeFile(policyPath, JSON.stringify(HELD_POLICY), 'utf8')
  const approvalsBaseDir = join(journalDir, 'approvals')
  const run = runWrapCommand(['--server', 'fs', '--policy', policyPath, '--', 'node', FAKE_SERVER_PATH], { stderr: { write: () => true } }, {
    runWrap: {
      dir: journalDir,
      approvalsBaseDir,
      stdin: harness.clientOutbox,
      stdout: harness.clientStdout,
      stderr: harness.clientStderr,
      killEscalationMs: 500,
      relayDrainTimeoutMs: 1000,
    },
  })
  return { run, approvalsBaseDir }
}

const questionsOf = (harness: ReturnType<typeof createClientHarness>): Record<string, unknown>[] =>
  receivedMessagesOf(harness).filter((m) => m['method'] === 'elicitation/create')

describe('wrap asks the person at the client', () => {
  test('Accept in the client lets the held call through, recorded in the client\'s name', async () => {
    const harness = createClientHarness()
    const { run, approvalsBaseDir } = await startWrap(harness)
    const queue = createApprovalQueue({ baseDir: approvalsBaseDir })

    harness.clientOutbox.write(INITIALIZE)
    harness.clientOutbox.write(requestLine(7, 'tools/call', { name: 'echo', arguments: { t: 7 } }))
    await waitUntil(() => questionsOf(harness).length === 1)
    const [question] = questionsOf(harness)
    await new Promise((resolve) => setTimeout(resolve, MIN_HUMAN_ANSWER_MS + 100))
    harness.clientOutbox.write(`${JSON.stringify({ jsonrpc: '2.0', id: question?.['id'], result: { action: 'accept', content: {} } })}\n`)
    await waitUntil(() => receivedMessagesOf(harness).some((m) => m['id'] === 7))
    harness.clientOutbox.end()
    await run

    const answer = receivedMessagesOf(harness).find((m) => m['id'] === 7)
    expect(answer?.['error']).toBeUndefined()
    expect(JSON.stringify(answer?.['result'])).toContain('\\"t\\":7')
    const [resolved] = await queue.listResolved({ limit: 1 })
    expect(resolved?.resolution).toMatchObject({ outcome: 'approved', actor: 'client:claude-code' })
    expect((question?.['params'] as { message: string }).message).toContain('mcpcut: allow echo on fs?')
  })

  test('with an admin on the installation, nobody is asked: the queue and a token decide', async () => {
    await createAdminStore({ journalDir }).createAdmin('owner', 'owner')
    const harness = createClientHarness()
    const { run, approvalsBaseDir } = await startWrap(harness)
    const queue = createApprovalQueue({ baseDir: approvalsBaseDir })

    harness.clientOutbox.write(INITIALIZE)
    harness.clientOutbox.write(requestLine(8, 'tools/call', { name: 'echo', arguments: { t: 8 } }))
    await waitUntilAsync(async () => (await queue.list()).length === 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const [pending] = await queue.list()
    await queue.resolve(pending!.approvalId, { outcome: 'approved', actor: 'cli:test' })
    await waitUntil(() => receivedMessagesOf(harness).some((m) => m['id'] === 8))
    harness.clientOutbox.end()
    await run

    expect(questionsOf(harness)).toEqual([])
  })
})

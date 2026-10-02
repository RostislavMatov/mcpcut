import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runWrapCommand } from '../../src/cli/wrap-cmd.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'
import { MIN_HUMAN_ANSWER_MS } from '../../src/proxy/client-confirm.js'
import { FAKE_SERVER_PATH, createClientHarness, receivedMessagesOf, requestLine, waitUntil, waitUntilAsync } from '../proxy/harness.js'

/**
 * ADR-0019 end to end through `mcpcut wrap` — the owner's scenario: the
 * client in full auto mode, everything passes, and only the tools named in
 * `confirmInClient` stop for the person at the client. A tool held for an
 * admin alone never opens a dialog: that is the queue's.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-wrap-confirm-'))
  vi.stubEnv('npm_command', '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function initialize(capabilities: Record<string, unknown>): string {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities, clientInfo: { name: 'claude-code', version: '2.1.287' } },
  })}\n`
}

const WITH_FORMS = initialize({ elicitation: { form: {} } })

async function startWrap(
  harness: ReturnType<typeof createClientHarness>,
  server: Record<string, unknown>,
): Promise<{ run: Promise<number>; approvalsBaseDir: string }> {
  const policyPath = join(journalDir, 'policy.json')
  const policy = { version: 1, defaultDecision: 'allow', quarantine: { enabled: false }, approval: { timeoutMs: 20_000 }, servers: { fs: server } }
  await writeFile(policyPath, JSON.stringify(policy), 'utf8')
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

describe('wrap: the person at the client confirms the named tools', () => {
  test('allow + confirm: Accept in the client runs the call, and nothing waits for an admin', async () => {
    const harness = createClientHarness()
    const { run, approvalsBaseDir } = await startWrap(harness, { confirmInClient: { echo: ['*'] } })

    harness.clientOutbox.write(WITH_FORMS)
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
    expect((question?.['params'] as { message: string }).message).toContain('mcpcut: allow echo on fs?')
    const queue = createApprovalQueue({ baseDir: approvalsBaseDir })
    expect(await queue.list()).toEqual([])
    expect(await queue.listResolved({ limit: 5 })).toEqual([])
  })

  test('require-approval alone: no dialog, even with no admins — the queue decides', async () => {
    const harness = createClientHarness()
    const { run, approvalsBaseDir } = await startWrap(harness, { tools: { echo: 'require-approval' } })
    const queue = createApprovalQueue({ baseDir: approvalsBaseDir })

    harness.clientOutbox.write(WITH_FORMS)
    harness.clientOutbox.write(requestLine(8, 'tools/call', { name: 'echo', arguments: { t: 8 } }))
    await waitUntilAsync(async () => (await queue.list()).length === 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const [pending] = await queue.list()
    await queue.resolve(pending!.approvalId, { outcome: 'approved', actor: 'cli' })
    await waitUntil(() => receivedMessagesOf(harness).some((m) => m['id'] === 8))
    harness.clientOutbox.end()
    await run

    expect(questionsOf(harness)).toEqual([])
    expect(receivedMessagesOf(harness).find((m) => m['id'] === 8)?.['error']).toBeUndefined()
  })

  test('a client that cannot show the dialog: the call is refused, and the operator reads what to do', async () => {
    const harness = createClientHarness()
    const { run } = await startWrap(harness, { confirmInClient: { echo: ['*'] } })

    harness.clientOutbox.write(initialize({}))
    harness.clientOutbox.write(requestLine(9, 'tools/call', { name: 'echo', arguments: { t: 9 } }))
    await waitUntil(() => receivedMessagesOf(harness).some((m) => m['id'] === 9))
    harness.clientOutbox.end()
    await run

    expect(receivedMessagesOf(harness).find((m) => m['id'] === 9)?.['error']).toMatchObject({ data: { reason: 'client_confirm_unavailable' } })
    expect(harness.receivedStderrText()).toContain('"confirmInClient"')
  })
})

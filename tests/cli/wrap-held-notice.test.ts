import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runWrapCommand } from '../../src/cli/wrap-cmd.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'
import {
  FAKE_SERVER_PATH,
  createClientHarness,
  receivedMessagesOf,
  requestLine,
  waitUntil,
  waitUntilAsync,
} from '../proxy/harness.js'

/**
 * `wrap` tells the operator about a held call on its stderr (0.2.3, stranger
 * run of 0.2.2): before, the Stop step sat through the whole wait in silence,
 * and the only way to learn the id was a second terminal and `approvals
 * list`. The line goes to stderr — the client's log — and never into what
 * the agent reads.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-wrap-held-notice-'))
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

describe('wrap announces a held call to the operator', () => {
  test('stderr names the tool, the server and ready approve/deny commands; the agent never sees the id', async () => {
    // Arrange
    const policyPath = join(journalDir, 'policy.json')
    await writeFile(policyPath, JSON.stringify(HELD_POLICY), 'utf8')
    const approvalsBaseDir = join(journalDir, 'approvals')
    const queue = createApprovalQueue({ baseDir: approvalsBaseDir })
    const harness = createClientHarness()
    const cmdIo = { stderr: { write: () => true } }

    // Act
    const run = runWrapCommand(['--server', 'fs', '--policy', policyPath, '--', 'node', FAKE_SERVER_PATH], cmdIo, {
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
    harness.clientOutbox.write(requestLine(7, 'tools/call', { name: 'echo', arguments: { t: 7 } }))
    await waitUntilAsync(async () => (await queue.list()).length === 1)
    const [pending] = await queue.list()
    await waitUntil(() => harness.receivedStderrText().includes('held for approval'))
    const stderrWhileHeld = harness.receivedStderrText()
    await queue.resolve(pending!.approvalId, { outcome: 'approved', actor: 'cli:test' })
    await waitUntil(() => harness.receivedLineCount() >= 1)
    harness.clientOutbox.end()
    await run

    // Assert
    expect(stderrWhileHeld).toContain('held for approval: echo on fs')
    expect(stderrWhileHeld).toContain(`mcpcut approvals approve ${pending!.approvalId}`)
    expect(stderrWhileHeld).toContain(`mcpcut approvals deny ${pending!.approvalId}`)
    const toAgent = JSON.stringify(receivedMessagesOf(harness))
    expect(toAgent).not.toContain(pending!.approvalId)
  })

  test('when the wait times out, the agent gets -32002 with no approval command in it', async () => {
    // Arrange
    const policyPath = join(journalDir, 'policy.json')
    await writeFile(policyPath, JSON.stringify({ ...HELD_POLICY, approval: { timeoutMs: 200 } }), 'utf8')
    const harness = createClientHarness()

    // Act
    const run = runWrapCommand(
      ['--server', 'fs', '--policy', policyPath, '--', 'node', FAKE_SERVER_PATH],
      { stderr: { write: () => true } },
      {
        runWrap: {
          dir: journalDir,
          approvalsBaseDir: join(journalDir, 'approvals'),
          stdin: harness.clientOutbox,
          stdout: harness.clientStdout,
          stderr: harness.clientStderr,
          killEscalationMs: 500,
          relayDrainTimeoutMs: 1000,
        },
      },
    )
    harness.clientOutbox.write(requestLine(8, 'tools/call', { name: 'echo', arguments: { t: 8 } }))
    await waitUntil(() => harness.receivedLineCount() >= 1)
    harness.clientOutbox.end()
    await run

    // Assert
    const [answer] = receivedMessagesOf(harness)
    const error = answer?.['error'] as { code?: number; message?: string } | undefined
    expect(error?.code).toBe(-32002)
    expect(JSON.stringify(answer)).not.toContain('approvals approve')
    expect(harness.receivedStderrText()).toContain('approvals approve')
  })
})

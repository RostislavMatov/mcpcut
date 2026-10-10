import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runWrapCommand } from '../../src/cli/wrap-cmd.js'
import { createApprovalQueue, type ApprovalQueue } from '../../src/policy/approvals/queue.js'
import {
  FAKE_SERVER_PATH,
  createClientHarness,
  readJournalRecords,
  receivedMessagesOf,
  requestLine,
  waitUntil,
  waitUntilAsync,
} from '../proxy/harness.js'
import { journalSessionIds } from '../support/journal-rows.js'

/**
 * A client that dies outright (SIGKILL, a crash, a closed terminal) closes
 * both ends of its pipe at once: `wrap` reads the end of its stdin, and the
 * next write to its stdout fails. The end of stdin alone is not the agent
 * leaving — a one-shot `printf … | mcpcut wrap` still reads its answers — so
 * `wrap` tells the two apart by writing to the client at once: the held call's
 * progress. Before (stranger run of 0.4.0, 2026-10-10), the first write came
 * with the once-a-minute progress, and an approval in that minute sent the
 * call to the server with nobody waiting for it.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-wrap-agent-gone-'))
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
  servers: { fs: { tools: { echo: 'require-approval' } } },
}

/** A client's stdout whose reader can die: from then on every write fails the way a pipe with no reader does. */
function createDyingStdout(): { readonly stdout: Writable; readonly lines: string[]; kill(): void } {
  const lines: string[] = []
  let isDead = false
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (isDead) {
        callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
        return
      }
      lines.push(...chunk.toString('utf8').split('\n').filter((line) => line.length > 0))
      callback()
    },
  })
  return {
    stdout,
    lines,
    kill: () => {
      isDead = true
    },
  }
}

async function startWrap(stdout: Writable, harness: ReturnType<typeof createClientHarness>): Promise<{
  readonly run: Promise<number>
  readonly queue: ApprovalQueue
}> {
  const policyPath = join(journalDir, 'policy.json')
  await writeFile(policyPath, JSON.stringify(HELD_POLICY), 'utf8')
  const approvalsBaseDir = join(journalDir, 'approvals')
  const run = runWrapCommand(
    ['--server', 'fs', '--policy', policyPath, '--', 'node', FAKE_SERVER_PATH],
    { stderr: { write: () => true } },
    {
      runWrap: {
        dir: journalDir,
        approvalsBaseDir,
        stdin: harness.clientOutbox,
        stdout,
        stderr: harness.clientStderr,
        killEscalationMs: 500,
        relayDrainTimeoutMs: 1000,
      },
    },
  )
  return { run, queue: createApprovalQueue({ baseDir: approvalsBaseDir }) }
}

function heldCallLine(id: number): string {
  return requestLine(id, 'tools/call', { name: 'echo', arguments: { t: id }, _meta: { progressToken: `p-${id}` } })
}

describe('wrap: a client that died stops waiting at once', () => {
  test('its input ends and its output is gone: the held call is withdrawn, a late approve sends nothing', async () => {
    // Arrange
    const harness = createClientHarness()
    const client = createDyingStdout()
    const { run, queue } = await startWrap(client.stdout, harness)
    harness.clientOutbox.write(heldCallLine(7))
    await waitUntilAsync(async () => (await queue.list()).length === 1)
    const [pending] = await queue.list()
    await waitUntil(() => client.lines.length >= 1)

    // Act: the client dies — both ends of its pipe close together.
    client.kill()
    harness.clientOutbox.end()
    await waitUntilAsync(async () => (await queue.list()).length === 0)
    const lateApprove = await queue.resolve(pending!.approvalId, { outcome: 'approved', actor: 'cli:test' })
    await run

    // Assert
    expect(lateApprove).toMatchObject({ ok: false, reason: 'withdrawn', withdrawnReason: 'disconnected' })
    const [sessionId] = await journalSessionIds(journalDir)
    const records = await readJournalRecords(journalDir, sessionId!)
    const outcomes = records.filter((record) => record.kind === 'decision').map((record) => record.decision?.outcome)
    expect(outcomes).toEqual(['require-approval-pending', 'agent-gone'])
    const answeredByServer = records.some((record) => record.direction === 'server→client' && record.kind === 'response')
    expect(answeredByServer).toBe(false)
  })

  test('every call it held is withdrawn, each journaled agent-gone once', async () => {
    // Arrange
    const harness = createClientHarness()
    const client = createDyingStdout()
    const { run, queue } = await startWrap(client.stdout, harness)
    harness.clientOutbox.write(heldCallLine(11) + heldCallLine(12))
    await waitUntilAsync(async () => (await queue.list()).length === 2)
    await waitUntil(() => client.lines.length >= 2)

    // Act
    client.kill()
    harness.clientOutbox.end()
    await waitUntilAsync(async () => (await queue.list()).length === 0)
    await run

    // Assert
    const [sessionId] = await journalSessionIds(journalDir)
    const records = await readJournalRecords(journalDir, sessionId!)
    const outcomes = records.filter((record) => record.kind === 'decision').map((record) => record.decision?.outcome)
    expect(outcomes.filter((outcome) => outcome === 'agent-gone')).toHaveLength(2)
    expect(outcomes.filter((outcome) => outcome === 'require-approval-pending')).toHaveLength(2)
  })

  test('a one-shot client that ends its input but still reads keeps its call held until the approve', async () => {
    // Arrange
    const harness = createClientHarness()
    const { run, queue } = await startWrap(harness.clientStdout, harness)
    harness.clientOutbox.write(heldCallLine(8))
    await waitUntilAsync(async () => (await queue.list()).length === 1)
    const [pending] = await queue.list()

    // Act: `printf … | mcpcut wrap` — the input ends right after the request.
    harness.clientOutbox.end()
    await waitUntil(() => receivedMessagesOf(harness).length >= 2)
    const stillPending = await queue.list()
    const approve = await queue.resolve(pending!.approvalId, { outcome: 'approved', actor: 'cli:test' })
    await waitUntil(() => receivedMessagesOf(harness).some((message) => message.id === 8))
    await run

    // Assert
    expect(stillPending.map((entry) => entry.approvalId)).toEqual([pending!.approvalId])
    expect(approve.ok).toBe(true)
    const answer = receivedMessagesOf(harness).find((message) => message.id === 8)
    expect(answer?.result).toBeDefined()
  })
})

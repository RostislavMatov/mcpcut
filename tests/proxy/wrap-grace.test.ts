import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ulid } from 'ulid'
import type { JournalRecord } from '../../src/journal/record.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { runWrap } from '../../src/proxy/wrap.js'
import { createClientHarness, readJournalRecords, waitUntil, type ClientHarness } from './harness.js'

/**
 * Decision M36, phase C, on `wrap`: when the client's stdin ends while a call
 * it sent is still running, the server does not see the end of ITS stdin at
 * once — most stdio servers exit on it and drop the call. It sees it once it
 * has answered every call already sent, or once the grace runs out; then what
 * it still owed is journaled `unanswered` and the operator is told, with the
 * command that shows it. The client's stdout may still be read (a one-shot
 * `printf … | mcpcut wrap`), so an answer in the grace is delivered as usual.
 */

const SLOW_SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/slow-answer-server.mjs')

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-wrap-grace-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function allowAll(): Policy {
  const result = parsePolicy({ version: 1, defaultDecision: 'allow', quarantine: { enabled: false } })
  if (!result.ok) throw new Error('test policy is invalid')
  return result.policy
}

function callLine(id: number, delayMs: number): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'slow', arguments: { delayMs }, _meta: { 'claudecode/toolUseId': `toolu_${id}` } } })}\n`
}

function runWith(harness: ClientHarness, sessionId: string, graceMs: number): Promise<number> {
  return runWrap('node', [SLOW_SERVER_PATH], {
    dir: journalDir,
    sessionId,
    stdin: harness.clientOutbox,
    stdout: harness.clientStdout,
    stderr: harness.clientStderr,
    killEscalationMs: 500,
    relayDrainTimeoutMs: 1000,
    policy: allowAll(),
    serverName: 'slow',
    forwardedAnswerGraceMs: graceMs,
    unansweredNotice: (server, count, id) => `UNANSWERED ${server} ${count} ${id}\n`,
  })
}

async function decisionsOf(sessionId: string): Promise<JournalRecord[]> {
  return (await readJournalRecords(journalDir, sessionId)).filter((record) => record.kind === 'decision')
}

describe('wrap: the teardown grace for calls already sent', () => {
  test('the client ends its input mid-call: the server still finishes, and the answer reaches the client', async () => {
    const harness = createClientHarness()
    const sessionId = ulid()
    const running = runWith(harness, sessionId, 10_000)

    harness.clientOutbox.write(callLine(1, 300))
    await waitUntil(async () => (await decisionsOf(sessionId)).length === 1)
    harness.clientOutbox.end()

    expect(await running).toBe(0)
    const outcomes = (await decisionsOf(sessionId)).map((record) => record.decision?.outcome)
    expect(outcomes).toEqual(['allow'])
    const answer = JSON.parse(Buffer.concat(harness.clientInboxChunks).toString('utf8').trim()) as Record<string, any>
    expect(answer).toMatchObject({ id: 1, result: { content: [{ text: 'answered after 300 ms' }] } })
    expect(harness.receivedStderrText()).not.toContain('UNANSWERED')
  })

  test('a server that never answers: after the grace, unanswered, and the operator is told', async () => {
    const harness = createClientHarness()
    const sessionId = ulid()
    const running = runWith(harness, sessionId, 100)

    harness.clientOutbox.write(callLine(1, -1))
    await waitUntil(async () => (await decisionsOf(sessionId)).length === 1)
    harness.clientOutbox.end()

    expect(await running).toBe(0)
    const unanswered = (await decisionsOf(sessionId)).filter((record) => record.decision?.outcome === 'unanswered')
    expect(unanswered).toHaveLength(1)
    expect(unanswered[0]?.decision?.reason).toBe('client-ended')
    expect(harness.receivedStderrText()).toContain(`UNANSWERED slow 1 ${sessionId}`)
  })
})

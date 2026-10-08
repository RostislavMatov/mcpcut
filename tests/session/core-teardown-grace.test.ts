import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createRecordBuilder, type JournalRecord } from '../../src/journal/record.js'
import { createApprovalQueue, type ApprovalQueue } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import type { GateInventory } from '../../src/proxy/gate-helpers.js'
import { createSession, type SessionEndReason, type SessionHandle } from '../../src/session/core.js'
import {
  createMemorySink,
  createMemorySource,
  messageOf,
  type MemorySink,
  type MemorySource,
} from './memory-transport.js'

/**
 * Decision M36, phase C, at the session: when the agent leaves while a call it
 * sent is still running, the session keeps reading the server for a grace —
 * the answer is journaled `undelivered`, never delivered — instead of cutting
 * the server off at once; what is still unanswered when the grace ends is
 * journaled `unanswered`, and the session says how many.
 */

const SERVER_NAME = 'testsrv'
const SESSION_ID = 'session-grace-1'
const WAIT_TIMEOUT_MS = 5_000

let tempDir: string
let queue: ApprovalQueue
let errors: unknown[]

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-session-grace-test-'))
  queue = createApprovalQueue({ baseDir: join(tempDir, 'approvals') })
  errors = []
})

afterEach(async () => {
  expect(errors).toEqual([])
  await rm(tempDir, { recursive: true, force: true })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: timed out')
    await sleep(5)
  }
}

function allowAll(): Policy {
  const result = parsePolicy({ version: 1, defaultDecision: 'allow', quarantine: { enabled: false } })
  if (!result.ok) throw new Error('test policy is invalid')
  return result.policy
}

function trustedInventory(): GateInventory {
  return {
    load: () => Promise.resolve(),
    observeToolsList: () => Promise.resolve({ known: [], new: [], changed: [], failed: false }),
    stateOf: () => 'known',
    surfaceDeltaOf: () => undefined,
    descriptorOf: () => undefined,
    hasObservedCatalog: () => true,
    isCatalogTrusted: () => true,
  }
}

interface Harness {
  readonly session: SessionHandle
  readonly clientSource: MemorySource
  readonly clientSink: MemorySink
  readonly serverSource: MemorySource
  readonly serverSink: MemorySink
  readonly records: JournalRecord[]
  readonly unanswered: number[]
  readonly endReasons: SessionEndReason[]
}

function createHarness(graceMs: number): Harness {
  const clientSource = createMemorySource()
  const clientSink = createMemorySink()
  const serverSource = createMemorySource()
  const serverSink = createMemorySink()
  const records: JournalRecord[] = []
  const unanswered: number[] = []
  const endReasons: SessionEndReason[] = []
  const session = createSession({
    sessionId: SESSION_ID,
    serverName: SERVER_NAME,
    client: { source: clientSource, sink: clientSink },
    server: { source: serverSource, sink: serverSink },
    policy: allowAll(),
    inventory: trustedInventory(),
    approvals: { queue, waiter: createApprovalWaiter({ pollIntervalMs: 5 }) },
    journal: {
      recordBuilder: createRecordBuilder(SESSION_ID),
      sink: {
        write: (record) => {
          records.push(record)
        },
        flush: () => Promise.resolve(),
      },
    },
    forwardedAnswerGraceMs: graceMs,
    onUnansweredCalls: (count) => unanswered.push(count),
    onError: (error) => errors.push(error),
    onSessionEnd: (reason) => endReasons.push(reason),
  })
  return { session, clientSource, clientSink, serverSource, serverSink, records, unanswered, endReasons }
}

function callOf(id: number, toolUseId?: string) {
  const meta = toolUseId !== undefined ? { _meta: { 'claudecode/toolUseId': toolUseId } } : {}
  return messageOf('client', { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'write_file', arguments: { path: '/x' }, ...meta } })
}

function answerOf(id: number) {
  return messageOf('server', { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'done' }] } })
}

function outcomesOf(records: JournalRecord[]): (string | undefined)[] {
  return records.filter((record) => record.kind === 'decision').map((record) => record.decision?.outcome)
}

describe('teardown grace for calls already sent', () => {
  test('the agent leaves, the server answers within the grace: journaled undelivered, delivered to nobody', async () => {
    // Arrange: one call forwarded, no answer yet.
    const harness = createHarness(5_000)
    harness.clientSource.emit(callOf(1, 'toolu_A'))
    await waitUntil(() => harness.serverSink.written.length === 1)

    // Act: the agent goes; the server finishes a moment later.
    harness.clientSource.end()
    await sleep(20)
    expect(harness.endReasons).toEqual([])
    harness.serverSource.emit(answerOf(1))
    const reason = await harness.session.ended

    // Assert
    expect(reason).toBe('client-ended')
    expect(harness.clientSink.written).toEqual([])
    expect(outcomesOf(harness.records)).toEqual(['allow', 'undelivered'])
    // The answer itself was journaled like any other, during the grace.
    expect(harness.records.some((record) => record.kind === 'response' && record.direction === 'server→client')).toBe(true)
    expect(harness.unanswered).toEqual([])
  })

  test('no answer by the end of the grace: journaled unanswered, and the session says how many', async () => {
    const harness = createHarness(40)
    harness.clientSource.emit(callOf(1))
    harness.clientSource.emit(callOf(2))
    await waitUntil(() => harness.serverSink.written.length === 2)

    harness.clientSource.end()
    await harness.session.ended

    expect(outcomesOf(harness.records)).toEqual(['allow', 'allow', 'unanswered', 'unanswered'])
    expect(harness.unanswered).toEqual([2])
  })

  test('with nothing in flight the session ends at once', async () => {
    const harness = createHarness(60_000)
    harness.clientSource.emit(callOf(1))
    await waitUntil(() => harness.serverSink.written.length === 1)
    harness.serverSource.emit(answerOf(1))
    await waitUntil(() => harness.clientSink.written.length === 1)

    const startedAt = Date.now()
    harness.clientSource.end()
    await harness.session.ended

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(harness.unanswered).toEqual([])
  })

  test('the server ending gets no grace: what it owed is unanswered at once, named server-ended', async () => {
    const harness = createHarness(60_000)
    harness.clientSource.emit(callOf(1))
    await waitUntil(() => harness.serverSink.written.length === 1)

    const startedAt = Date.now()
    harness.serverSource.end()
    await harness.session.ended

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    const unanswered = harness.records.find((record) => record.decision?.outcome === 'unanswered')
    expect(unanswered?.decision?.reason).toBe('server-ended')
    expect(harness.unanswered).toEqual([1])
  })

  test('a close by the plane counts as the agent leaving: it gets the grace too', async () => {
    const harness = createHarness(5_000)
    harness.clientSource.emit(callOf(1))
    await waitUntil(() => harness.serverSink.written.length === 1)

    const closing = harness.session.close('closed')
    await sleep(20)
    harness.serverSource.emit(answerOf(1))
    await closing

    expect(outcomesOf(harness.records)).toEqual(['allow', 'undelivered'])
  })
})

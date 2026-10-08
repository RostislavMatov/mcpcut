import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createApprovalQueue, type ApprovalQueue, type PendingApproval } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { createInventory } from '../../src/policy/inventory.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { createPolicyGate, type PolicyGate } from '../../src/proxy/gate.js'
import type { GateInventory } from '../../src/proxy/gate-helpers.js'
import type { Frame } from '../../src/protocol/split.js'
import type { Verdict } from '../../src/proxy/pipeline.js'
import { ERROR_CODE_RESEND } from '../../src/proxy/synthesize-resend.js'
import { MAX_KEPT_ANSWER_BYTES, createToolUseAnswers, type ToolUseAnswers } from '../../src/proxy/tool-use-answers.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * Decision M36, phase C, at the gate: what becomes of the answer to a call the
 * gate let through. A resend of the same tool use (`_meta["claudecode/toolUseId"]`)
 * gets the server's first answer, or is refused while the first is still open;
 * an answer that arrives after its agent left is journaled `undelivered`; what
 * the server never answers by the end of the session is journaled `unanswered`.
 */

const SERVER_NAME = 'testsrv'
const SESSION_ID = 'session-delivery-1'
const POLL_INTERVAL_MS = 5

let tempDir: string
let sink: JournalSink
let queue: ApprovalQueue
let errors: unknown[]

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-gate-delivery-test-'))
  sink = createJournalSink(SESSION_ID, { dir: tempDir })
  queue = createApprovalQueue({ baseDir: join(tempDir, 'approvals') })
  errors = []
})

afterEach(async () => {
  expect(errors).toEqual([])
  await sink.close()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function policyOf(defaultDecision: 'allow' | 'require-approval' = 'allow'): Policy {
  const result = parsePolicy({ version: 1, defaultDecision, quarantine: { enabled: false } })
  if (!result.ok) throw new Error(JSON.stringify(result.error.issues))
  return result.policy
}

function frameOf(message: unknown): Frame {
  return { bytes: Buffer.from(JSON.stringify(message), 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
}

function toolCall(id: unknown, toolUseId?: string, args: unknown = { path: '/tmp/x' }): Frame {
  const meta = toolUseId === undefined ? {} : { _meta: { 'claudecode/toolUseId': toolUseId, progressToken: 1 } }
  return frameOf({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'write_file', arguments: args, ...meta } })
}

function resultOf(id: unknown, text = 'written'): Frame {
  return frameOf({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
}

function cancelOf(requestId: unknown, reason = 'AbortError: user-cancel'): Frame {
  return frameOf({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason } })
}

function knownInventory(): GateInventory {
  const real = createInventory(SERVER_NAME, { storePath: join(tempDir, 'tool-inventory.json') })
  return {
    load: async () => undefined,
    observeToolsList: async () => ({ known: [], new: [], changed: [], failed: false }),
    stateOf: () => 'known',
    surfaceDeltaOf: (name) => real.surfaceDeltaOf(name),
    descriptorOf: () => undefined,
    hasObservedCatalog: () => true,
    isCatalogTrusted: () => true,
  }
}

interface Harness {
  readonly gate: PolicyGate
  readonly written: Buffer[]
}

interface HarnessOptions {
  readonly policy?: Policy
  readonly answers?: ToolUseAnswers
  readonly sessionSink?: JournalSink
  readonly onRequestDropped?: (id: unknown) => void
}

function createHarness(opts: HarnessOptions = {}): Harness {
  const written: Buffer[] = []
  const gate = createPolicyGate({
    policy: opts.policy ?? policyOf(),
    serverName: SERVER_NAME,
    sessionId: SESSION_ID,
    inventory: knownInventory(),
    approvalQueue: queue,
    approvalWaiter: createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS }),
    sink: opts.sessionSink ?? sink,
    clientWriter: {
      writeMessage: (bytes: Buffer) => {
        written.push(bytes)
        return Promise.resolve()
      },
      dispose: () => undefined,
    },
    ...(opts.answers !== undefined ? { toolUseAnswers: opts.answers } : {}),
    ...(opts.onRequestDropped !== undefined ? { onRequestDropped: opts.onRequestDropped } : {}),
    onError: (error) => errors.push(error),
  })
  return { gate, written }
}

async function decisions(): Promise<JournalRecord[]> {
  await sink.flush()
  return (await readJournalRecords(tempDir, SESSION_ID)).filter((record) => record.kind === 'decision')
}

function parsed(bytes: Buffer): Record<string, any> {
  return JSON.parse(bytes.toString('utf8')) as Record<string, any>
}

async function settled(verdict: Verdict | Promise<Verdict>): Promise<Verdict> {
  return Promise.resolve(verdict)
}

async function waitForPending(): Promise<PendingApproval> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [first] = await queue.list()
    if (first !== undefined) return first
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('no approval was enqueued')
}

describe('a resend of the same tool use gets the first answer', () => {
  test('the same toolUseId after the answer: the stored answer under the new id, nothing sent again', async () => {
    // Arrange: the first call runs and its answer passes through.
    const { gate, written } = createHarness()
    expect(await settled(gate.gateClientMessage(toolCall(1, 'toolu_A')))).toEqual({ action: 'forward' })
    expect(await settled(gate.gateServerMessage(resultOf(1, 'first run')))).toEqual({ action: 'forward' })

    // Act: the client sends the same tool use again under a new JSON-RPC id.
    const resend = await settled(gate.gateClientMessage(toolCall(2, 'toolu_A')))

    // Assert
    expect(resend).toEqual({ action: 'drop' })
    const answer = parsed(written.at(-1)!)
    expect(answer.id).toBe(2)
    expect(answer.result.content[0].text).toBe('first run')
    const replayed = (await decisions()).find((record) => record.decision?.outcome === 'replayed')
    expect(replayed?.decision).toMatchObject({ rule: 'tool-use-resend', toolUseId: 'toolu_A', toolName: 'write_file' })
  })

  test('a server error is given back as is', async () => {
    const { gate, written } = createHarness()
    await settled(gate.gateClientMessage(toolCall(1, 'toolu_E')))
    gate.gateServerMessage(frameOf({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'disk full' } }))

    await settled(gate.gateClientMessage(toolCall('re-1', 'toolu_E')))

    expect(parsed(written.at(-1)!)).toEqual({ jsonrpc: '2.0', id: 're-1', error: { code: -32000, message: 'disk full' } })
  })

  test('a new tool use with the same arguments runs again — it is a deliberate second call', async () => {
    const { gate } = createHarness()
    await settled(gate.gateClientMessage(toolCall(1, 'toolu_A')))
    gate.gateServerMessage(resultOf(1))

    expect(await settled(gate.gateClientMessage(toolCall(2, 'toolu_B')))).toEqual({ action: 'forward' })
  })

  test('a call without a toolUseId is never answered from the store', async () => {
    const { gate } = createHarness()
    await settled(gate.gateClientMessage(toolCall(1)))
    gate.gateServerMessage(resultOf(1))

    expect(await settled(gate.gateClientMessage(toolCall(2)))).toEqual({ action: 'forward' })
  })

  test('the same toolUseId on other arguments is not a resend of that call', async () => {
    const { gate } = createHarness()
    await settled(gate.gateClientMessage(toolCall(1, 'toolu_A', { path: '/tmp/x' })))
    gate.gateServerMessage(resultOf(1))

    expect(await settled(gate.gateClientMessage(toolCall(2, 'toolu_A', { path: '/tmp/other' })))).toEqual({ action: 'forward' })
  })

  test('a resend on another session of the same process gets the answer (a 404 re-initializes)', async () => {
    const answers = createToolUseAnswers()
    const first = createHarness({ answers })
    await settled(first.gate.gateClientMessage(toolCall(1, 'toolu_A')))
    first.gate.gateServerMessage(resultOf(1, 'from session one'))

    const second = createHarness({ answers })
    expect(await settled(second.gate.gateClientMessage(toolCall(1, 'toolu_A')))).toEqual({ action: 'drop' })
    expect(parsed(second.written.at(-1)!).result.content[0].text).toBe('from session one')
  })

  test('an answer too large to keep: the resend is told the call already ran, and it does not run again', async () => {
    const { gate, written } = createHarness()
    await settled(gate.gateClientMessage(toolCall(1, 'toolu_BIG')))
    gate.gateServerMessage(resultOf(1, 'x'.repeat(MAX_KEPT_ANSWER_BYTES)))

    expect(await settled(gate.gateClientMessage(toolCall(2, 'toolu_BIG')))).toEqual({ action: 'drop' })
    const answer = parsed(written.at(-1)!)
    expect(answer.id).toBe(2)
    expect(answer.error.code).toBe(ERROR_CODE_RESEND)
    expect(answer.error.data.reason).toBe('answer_not_kept')
  })
})

describe('one call per tool use at a time', () => {
  test('a resend while the first call is still running is refused, and nothing is sent again', async () => {
    const { gate, written } = createHarness()
    expect(await settled(gate.gateClientMessage(toolCall(1, 'toolu_A')))).toEqual({ action: 'forward' })

    expect(await settled(gate.gateClientMessage(toolCall(2, 'toolu_A')))).toEqual({ action: 'drop' })

    const refusal = parsed(written.at(-1)!)
    expect(refusal.id).toBe(2)
    expect(refusal.error.code).toBe(ERROR_CODE_RESEND)
    expect(refusal.error.data.reason).toBe('tool_use_in_flight')
    const denied = (await decisions()).find((record) => record.decision?.rule === 'tool-use-in-flight')
    expect(denied?.decision).toMatchObject({ outcome: 'deny', toolUseId: 'toolu_A' })

    // Once the first is answered, a further resend gets that answer.
    gate.gateServerMessage(resultOf(1, 'done'))
    expect(await settled(gate.gateClientMessage(toolCall(3, 'toolu_A')))).toEqual({ action: 'drop' })
    expect(parsed(written.at(-1)!).result.content[0].text).toBe('done')
  })

  test('a resend while the first call waits for a human is refused: nobody is asked twice', async () => {
    const { gate, written } = createHarness({ policy: policyOf('require-approval') })
    const first = gate.gateClientMessage(toolCall(1, 'toolu_H'))
    const pending = await waitForPending()

    expect(await settled(gate.gateClientMessage(toolCall(2, 'toolu_H')))).toEqual({ action: 'drop' })
    expect(parsed(written.at(-1)!).error.data.reason).toBe('tool_use_in_flight')
    expect((await queue.list()).map((entry) => entry.approvalId)).toEqual([pending.approvalId])

    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'operator' })
    expect(await settled(first)).toEqual({ action: 'forward' })
  })

  test('a held call the agent cancelled frees its tool use: a resend asks again', async () => {
    const { gate } = createHarness({ policy: policyOf('require-approval') })
    const first = gate.gateClientMessage(toolCall(1, 'toolu_C'))
    const pendingA = await waitForPending()
    gate.gateClientMessage(cancelOf(1))
    expect(await settled(first)).toEqual({ action: 'drop' })

    const resend = gate.gateClientMessage(toolCall(2, 'toolu_C'))
    let pendingB: PendingApproval | undefined
    for (let attempt = 0; attempt < 400 && pendingB === undefined; attempt += 1) {
      pendingB = (await queue.list()).find((entry) => entry.approvalId !== pendingA.approvalId)
      if (pendingB === undefined) await sleep(POLL_INTERVAL_MS)
    }
    expect(pendingB).toBeDefined()
    await queue.resolve(pendingB!.approvalId, { outcome: 'approved', actor: 'operator' })
    expect(await settled(resend)).toEqual({ action: 'forward' })
  })

  test('a denied call frees its tool use at once', async () => {
    const result = parsePolicy({ version: 1, defaultDecision: 'deny', quarantine: { enabled: false } })
    if (!result.ok) throw new Error('policy')
    const { gate } = createHarness({ policy: result.policy })
    await settled(gate.gateClientMessage(toolCall(1, 'toolu_D')))

    const resend = await settled(gate.gateClientMessage(toolCall(2, 'toolu_D')))

    expect(resend).toEqual({ action: 'drop' })
    expect((await decisions()).filter((record) => record.decision?.rule === 'tool-use-in-flight')).toEqual([])
  })
})

describe('an answer whose agent stopped waiting is journaled undelivered', () => {
  test('after a cancel: undelivered with the cancel\'s reason, kept for a resend', async () => {
    const { gate, written } = createHarness()
    await settled(gate.gateClientMessage(toolCall(1, 'toolu_A')))
    expect(await settled(gate.gateClientMessage(cancelOf(1)))).toEqual({ action: 'forward' })

    // The server finished anyway; its answer still takes the usual path.
    expect(await settled(gate.gateServerMessage(resultOf(1, 'late')))).toEqual({ action: 'forward' })

    const undelivered = (await decisions()).find((record) => record.decision?.outcome === 'undelivered')
    expect(undelivered?.decision).toMatchObject({
      rule: 'answer-kept',
      reason: 'AbortError: user-cancel',
      toolUseId: 'toolu_A',
      toolName: 'write_file',
    })
    expect(typeof undelivered?.decision?.latencyMs).toBe('number')

    await settled(gate.gateClientMessage(toolCall(2, 'toolu_A')))
    expect(parsed(written.at(-1)!).result.content[0].text).toBe('late')
  })

  test('after an abandoned request: undelivered as disconnected', async () => {
    const { gate } = createHarness()
    await settled(gate.gateClientMessage(toolCall(1, 'toolu_A')))
    gate.abandonRequest(1)
    gate.gateServerMessage(resultOf(1))

    const undelivered = (await decisions()).find((record) => record.decision?.outcome === 'undelivered')
    expect(undelivered?.decision).toMatchObject({ reason: 'disconnected', rule: 'answer-kept' })
  })

  test('a call without a toolUseId: undelivered, and the record says it was not kept', async () => {
    const { gate } = createHarness()
    await settled(gate.gateClientMessage(toolCall(1)))
    gate.abandonRequest(1)
    gate.gateServerMessage(resultOf(1))

    const undelivered = (await decisions()).find((record) => record.decision?.outcome === 'undelivered')
    expect(undelivered?.decision).toMatchObject({ rule: 'answer-not-kept-no-tool-use-id' })
    expect(undelivered?.decision).not.toHaveProperty('toolUseId')
  })

  test('an answer the agent did wait for leaves no delivery record', async () => {
    const { gate } = createHarness()
    await settled(gate.gateClientMessage(toolCall(1, 'toolu_A')))
    gate.gateServerMessage(resultOf(1))

    const outcomes = (await decisions()).map((record) => record.decision?.outcome)
    expect(outcomes).toEqual(['allow'])
  })

  test('a cancel that arrived while the call was still held for approval, then lost the race to the approve', async () => {
    const { gate } = createHarness({ policy: policyOf('require-approval') })
    const first = gate.gateClientMessage(toolCall(1, 'toolu_R'))
    const pending = await waitForPending()
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'operator' })
    // The cancel lands after the approval was read but before the verdict settled:
    // it queues behind the forward (one winner, by design) and marks the call left.
    gate.gateClientMessage(cancelOf(1))
    expect(await settled(first)).toEqual({ action: 'forward' })
    gate.gateServerMessage(resultOf(1))

    const outcomes = (await decisions()).map((record) => record.decision?.outcome)
    expect(outcomes).toContain('undelivered')
  })
})

describe('the end of the session: what the server never answered', () => {
  test('agentLeft, then an answer within the grace: undelivered, nothing unanswered', async () => {
    const { gate } = createHarness()
    await settled(gate.gateClientMessage(toolCall(1, 'toolu_A')))
    await gate.agentLeft()

    const settling = gate.settleForwarded(1_000, 'closed')
    gate.gateServerMessage(resultOf(1))

    expect(await settling).toBe(0)
    const undelivered = (await decisions()).find((record) => record.decision?.outcome === 'undelivered')
    expect(undelivered?.decision).toMatchObject({ reason: 'disconnected' })
  })

  test('no answer by the end of the grace: unanswered, counted', async () => {
    const { gate } = createHarness()
    await settled(gate.gateClientMessage(toolCall(1, 'toolu_A')))
    await settled(gate.gateClientMessage(toolCall(2)))
    await gate.agentLeft()

    expect(await gate.settleForwarded(20, 'closed')).toBe(2)
    const unanswered = (await decisions()).filter((record) => record.decision?.outcome === 'unanswered')
    expect(unanswered.map((record) => record.decision?.rule)).toEqual(['session-ended', 'session-ended'])
    expect(unanswered[0]?.decision).toMatchObject({ reason: 'disconnected', toolUseId: 'toolu_A' })
  })

  test('a call the agent cancelled is owed nothing: the grace does not wait for it, and it is not counted', async () => {
    const { gate } = createHarness()
    await settled(gate.gateClientMessage(toolCall(1, 'toolu_A')))
    gate.gateClientMessage(cancelOf(1))
    await gate.agentLeft()

    const startedAt = Date.now()
    expect(await gate.settleForwarded(5_000, 'closed')).toBe(0)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect((await decisions()).some((record) => record.decision?.outcome === 'unanswered')).toBe(false)
  })

  test('a session that ended with its agent still there names why it ended', async () => {
    const { gate } = createHarness()
    await settled(gate.gateClientMessage(toolCall(1)))

    expect(await gate.settleForwarded(0, 'server-ended')).toBe(1)
    const unanswered = (await decisions()).find((record) => record.decision?.outcome === 'unanswered')
    expect(unanswered?.decision?.reason).toBe('server-ended')
  })

  test('a call forwarded after the agent left is not tracked', async () => {
    const { gate } = createHarness()
    await gate.agentLeft()
    await settled(gate.gateClientMessage(toolCall(1, 'toolu_late')))

    expect(await gate.settleForwarded(0, 'closed')).toBe(0)
  })

  test('the session end frees every tool use it held', async () => {
    const answers = createToolUseAnswers()
    const { gate } = createHarness({ answers })
    await settled(gate.gateClientMessage(toolCall(1, 'toolu_A')))
    await gate.agentLeft()
    await gate.settleForwarded(0, 'closed')

    expect(answers.claim('', 'toolu_A')).not.toBeNull()
  })
})

describe('a held call its agent left is announced as never to be answered (S-L1)', () => {
  test('a cancel withdraws the held call, and the gate says no answer will come for its id', async () => {
    const dropped: unknown[] = []
    const { gate } = createHarness({ policy: policyOf('require-approval'), onRequestDropped: (id) => dropped.push(id) })
    const call = gate.gateClientMessage(toolCall(7, 'toolu_X'))
    await waitForPending()

    gate.gateClientMessage(cancelOf(7))

    expect(await settled(call)).toEqual({ action: 'drop' })
    expect(dropped).toEqual([7])
  })

  test('an approved, a denied or an answered call is not announced', async () => {
    const dropped: unknown[] = []
    const { gate } = createHarness({ policy: policyOf('require-approval'), onRequestDropped: (id) => dropped.push(id) })
    const approved = gate.gateClientMessage(toolCall(1))
    await queue.resolve((await waitForPending()).approvalId, { outcome: 'approved', actor: 'operator' })
    await settled(approved)
    const denied = gate.gateClientMessage(toolCall(2, undefined, { path: '/other' }))
    await queue.resolve((await waitForPending()).approvalId, { outcome: 'denied', actor: 'operator' })
    await settled(denied)

    expect(dropped).toEqual([])
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { openApprovalsDb } from '../../src/policy/approvals/queue-db.js'
import { createApprovalQueue, type ApprovalQueue, type PendingApproval } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { APPROVAL_HEARTBEAT_INTERVAL_MS, APPROVAL_PROGRESS_INTERVAL_MS, MAX_WITHDRAW_REASON_CHARS } from '../../src/policy/constants.js'
import { createInventory } from '../../src/policy/inventory.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { createPolicyGate, type PolicyGate } from '../../src/proxy/gate.js'
import type { HoldScheduler, HoldTimer } from '../../src/proxy/approval-hold.js'
import type { GateInventory } from '../../src/proxy/gate-helpers.js'
import type { Frame } from '../../src/protocol/split.js'
import type { Verdict } from '../../src/proxy/pipeline.js'
import { ERROR_CODE_APPROVAL } from '../../src/proxy/synthesize.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * Decision M36, phase A, at the gate: every call that needs an approval asks
 * (no grant window); a held call waits while its agent waits, telling a client
 * that gave a `progressToken` it is still waiting; and the agent that leaves —
 * a cancel, or the connection ending — takes its request with it: the request
 * is withdrawn, the journal says why, nothing is sent and nothing is answered.
 */

const SERVER_NAME = 'testsrv'
const SESSION_ID = 'session-hold-1'
const POLL_INTERVAL_MS = 5

let tempDir: string
let approvalsDir: string
let sink: JournalSink
let queue: ApprovalQueue
let errors: unknown[]

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-gate-hold-test-'))
  approvalsDir = join(tempDir, 'approvals')
  sink = createJournalSink(SESSION_ID, { dir: tempDir })
  queue = createApprovalQueue({ baseDir: approvalsDir })
  errors = []
})

afterEach(async () => {
  // Every path here is expected to run clean: a reported gate error is a failure.
  expect(errors).toEqual([])
  await sink.close()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function policyOf(approval: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({ version: 1, defaultDecision: 'require-approval', quarantine: { enabled: false }, approval })
  if (!result.ok) throw new Error(JSON.stringify(result.error.issues))
  return result.policy
}

function frameOf(message: unknown): Frame {
  return { bytes: Buffer.from(JSON.stringify(message), 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
}

function toolCall(id: unknown, args: unknown = { path: '/tmp/x' }, progressToken?: unknown): Frame {
  const meta = progressToken === undefined ? {} : { _meta: { progressToken } }
  return frameOf({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'write_file', arguments: args, ...meta } })
}

function cancelOf(requestId: unknown, reason?: unknown): Frame {
  return frameOf({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId, ...(reason !== undefined ? { reason } : {}) },
  })
}

/** A scheduler the test ticks by hand: no test waits out a real interval. */
function createManualScheduler(): HoldScheduler & { tick(ms: number): void; active(): number } {
  const timers = new Map<HoldTimer, { readonly ms: number; readonly callback: () => void }>()
  return {
    setInterval(callback, ms) {
      const timer: HoldTimer = {}
      timers.set(timer, { ms, callback })
      return timer
    },
    clearInterval(timer) {
      timers.delete(timer)
    },
    tick(ms) {
      for (const entry of Array.from(timers.values())) if (entry.ms === ms) entry.callback()
    },
    active: () => timers.size,
  }
}

/** A trivial inventory: every tool is known and the catalog is trusted. */
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
  readonly scheduler: ReturnType<typeof createManualScheduler>
}

function createHarness(opts: { policy?: Policy; progress?: boolean } = {}): Harness {
  const written: Buffer[] = []
  const scheduler = createManualScheduler()
  const gate = createPolicyGate({
    policy: opts.policy ?? policyOf(),
    serverName: SERVER_NAME,
    sessionId: SESSION_ID,
    inventory: knownInventory(),
    approvalQueue: queue,
    approvalWaiter: createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS }),
    sink,
    clientWriter: {
      writeMessage: (bytes: Buffer) => {
        written.push(bytes)
        return Promise.resolve()
      },
      dispose: () => undefined,
    },
    holdScheduler: scheduler,
    ...(opts.progress !== false ? { heldCallProgress: (id: string) => `waiting for approval ${id} — mcpcut approvals approve ${id}` } : {}),
    onError: (error) => errors.push(error),
  })
  return { gate, written, scheduler }
}

async function waitForPending(accept: (entry: PendingApproval) => boolean = () => true): Promise<PendingApproval> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const match = (await queue.list()).find(accept)
    if (match !== undefined) return match
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('no matching approval was enqueued')
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

describe('no grant window: every call that needs approval asks', () => {
  test('a byte-identical repeat right after an approval enqueues a new approval', async () => {
    const { gate } = createHarness()

    const first = gate.gateClientMessage(toolCall(1))
    const pendingA = await waitForPending()
    await queue.resolve(pendingA.approvalId, { outcome: 'approved', actor: 'operator' })
    expect(await settled(first)).toEqual({ action: 'forward' })

    const repeat = gate.gateClientMessage(toolCall(2))
    // Not a synchronous allow: the repeat is held for a human of its own.
    expect(repeat).toBeInstanceOf(Promise)
    const pendingB = await waitForPending((entry) => entry.approvalId !== pendingA.approvalId)
    expect(pendingB.argsHash).toBe(pendingA.argsHash)
    await queue.resolve(pendingB.approvalId, { outcome: 'approved', actor: 'operator' })
    expect(await settled(repeat)).toEqual({ action: 'forward' })

    const outcomes = (await decisions()).map((record) => record.decision?.outcome)
    expect(outcomes).toEqual(['require-approval-pending', 'approved', 'require-approval-pending', 'approved'])
    expect((await decisions()).some((record) => record.decision?.rule === 'grant')).toBe(false)
  })

  test('with a capped wait, the timed-out request leaves the queue and its repeat asks again', async () => {
    const { gate, written } = createHarness({ policy: policyOf({ timeoutMs: 40 }) })

    const first = gate.gateClientMessage(toolCall(3))
    const pendingA = await waitForPending()
    expect(await settled(first)).toEqual({ action: 'drop' })
    expect(parsed(written.at(-1)!).error.data.reason).toBe('approval_timeout')

    // The wait is over, so the request is no longer approvable.
    expect((await queue.readResolution(pendingA.approvalId))?.outcome).toBe('expired')
    const late = await queue.resolve(pendingA.approvalId, { outcome: 'approved', actor: 'operator' })
    expect(late.ok).toBe(false)

    const repeat = gate.gateClientMessage(toolCall(4))
    const pendingB = await waitForPending((entry) => entry.approvalId !== pendingA.approvalId)
    await queue.resolve(pendingB.approvalId, { outcome: 'approved', actor: 'operator' })
    expect(await settled(repeat)).toEqual({ action: 'forward' })
  })

  test('the pending row has no wait clock without a cap, and a 24-hour hard expiry', async () => {
    const { gate } = createHarness()

    const verdict = gate.gateClientMessage(toolCall(5))
    const pending = await waitForPending()

    expect(pending).not.toHaveProperty('waitExpiresAt')
    expect(Date.parse(pending.expiresAt) - Date.parse(pending.requestedAt)).toBe(24 * 60 * 60_000)
    expect(pending.agentConnected).toBe(true)
    await queue.resolve(pending.approvalId, { outcome: 'denied', actor: 'operator' })
    await verdict
  })
})

describe('hold while the agent holds: progress and heartbeat', () => {
  test('a call with a progressToken hears at once that it waits, then once a minute, strictly increasing', async () => {
    const { gate, written, scheduler } = createHarness()

    const verdict = gate.gateClientMessage(toolCall(7, { a: 1 }, 'tok-7'))
    const pending = await waitForPending()
    await sleep(POLL_INTERVAL_MS)

    expect(written).toHaveLength(1)
    const first = parsed(written[0]!)
    expect(first).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'tok-7',
        progress: 1,
        message: `waiting for approval ${pending.approvalId} — mcpcut approvals approve ${pending.approvalId}`,
      },
    })

    scheduler.tick(APPROVAL_PROGRESS_INTERVAL_MS)
    scheduler.tick(APPROVAL_PROGRESS_INTERVAL_MS)
    await sleep(POLL_INTERVAL_MS)
    expect(written.map((bytes) => parsed(bytes).params.progress)).toEqual([1, 2, 3])

    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'operator' })
    expect(await settled(verdict)).toEqual({ action: 'forward' })

    // The ticker stopped with the wait: nothing more reaches the client.
    expect(scheduler.active()).toBe(0)
    scheduler.tick(APPROVAL_PROGRESS_INTERVAL_MS)
    expect(written).toHaveLength(3)
  })

  test('a numeric progressToken is echoed as a number', async () => {
    const { gate, written } = createHarness()

    const verdict = gate.gateClientMessage(toolCall(8, { a: 1 }, 2))
    const pending = await waitForPending()
    await sleep(POLL_INTERVAL_MS)

    expect(parsed(written[0]!).params.progressToken).toBe(2)
    await queue.resolve(pending.approvalId, { outcome: 'denied', actor: 'operator' })
    await verdict
  })

  test('without a progressToken nothing is sent while the call waits, but the heartbeat still runs', async () => {
    const { gate, written, scheduler } = createHarness()

    const verdict = gate.gateClientMessage(toolCall(9))
    const pending = await waitForPending()
    const db = await openApprovalsDb(approvalsDir)
    db.handle.db.prepare("UPDATE approval_heartbeats SET heartbeat_at = '2000-01-01T00:00:00.000Z'").run()

    scheduler.tick(APPROVAL_PROGRESS_INTERVAL_MS)
    scheduler.tick(APPROVAL_HEARTBEAT_INTERVAL_MS)
    await sleep(POLL_INTERVAL_MS * 4)

    expect(written).toEqual([])
    const row = db.handle.db
      .prepare('SELECT heartbeat_at FROM approval_heartbeats WHERE approval_id = ?')
      .get(pending.approvalId) as { heartbeat_at: string }
    expect(row.heartbeat_at > '2000-01-01T00:00:00.000Z').toBe(true)

    await queue.resolve(pending.approvalId, { outcome: 'denied', actor: 'operator' })
    await verdict
    expect(scheduler.active()).toBe(0)
  })

  test('a path that cannot carry the gate\'s notifications (HTTP) sends no progress even with a token', async () => {
    const { gate, written } = createHarness({ progress: false })

    const verdict = gate.gateClientMessage(toolCall(10, { a: 1 }, 'tok-10'))
    const pending = await waitForPending()
    await sleep(POLL_INTERVAL_MS * 2)

    expect(written).toEqual([])
    await queue.resolve(pending.approvalId, { outcome: 'denied', actor: 'operator' })
    await verdict
  })
})

describe('the agent leaves: the request is withdrawn and nothing is sent', () => {
  test('a cancel withdraws the held call: dropped, not forwarded, not answered, journaled with its reason', async () => {
    const { gate, written } = createHarness()

    const callVerdict = gate.gateClientMessage(toolCall(11))
    const pending = await waitForPending()
    const cancelVerdict = gate.gateClientMessage(cancelOf(11, 'AbortError: user-cancel'))

    expect(await settled(callVerdict)).toEqual({ action: 'drop' })
    // The server never saw the call, so it must not see its cancel either.
    expect(await settled(cancelVerdict)).toEqual({ action: 'drop' })
    expect(written).toEqual([])
    await expect(queue.list()).resolves.toEqual([])
    await expect(queue.readResolution(pending.approvalId)).resolves.toMatchObject({
      outcome: 'withdrawn',
      reason: 'AbortError: user-cancel',
    })

    const last = (await decisions()).at(-1)?.decision
    expect(last).toMatchObject({
      outcome: 'agent-gone',
      approvalId: pending.approvalId,
      reason: 'AbortError: user-cancel',
      rule: 'defaultDecision',
    })
    expect(last).not.toHaveProperty('actor')
  })

  test('an approve after the agent left is refused, and the call is never forwarded', async () => {
    const { gate } = createHarness()

    const callVerdict = gate.gateClientMessage(toolCall(12))
    const pending = await waitForPending()
    await settled(gate.gateClientMessage(cancelOf(12, 'SdkError: Request timed out')))
    expect(await settled(callVerdict)).toEqual({ action: 'drop' })

    const late = await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'operator' })

    expect(late).toMatchObject({ ok: false, reason: 'withdrawn', withdrawnReason: 'SdkError: Request timed out' })
  })

  test('the client\'s reason is cleaned before it is stored or journaled', async () => {
    const { gate } = createHarness()

    const callVerdict = gate.gateClientMessage(toolCall(13))
    const pending = await waitForPending()
    await settled(gate.gateClientMessage(cancelOf(13, `evil\u001b[2J‮${'r'.repeat(1000)}`)))
    await settled(callVerdict)

    const reason = (await queue.readResolution(pending.approvalId))?.reason ?? ''
    expect(reason.startsWith('evil[2J')).toBe(true)
    expect(reason).not.toMatch(/[\u001b‮]/u)
    expect(reason.length).toBe(MAX_WITHDRAW_REASON_CHARS)
    expect((await decisions()).at(-1)?.decision?.reason).toBe(reason)
  })

  test('an approval that landed first wins: the call is forwarded once and its cancel follows it', async () => {
    const { gate } = createHarness()

    const callVerdict = gate.gateClientMessage(toolCall(14))
    const pending = await waitForPending()
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'operator' })
    const cancelVerdict = gate.gateClientMessage(cancelOf(14, 'AbortError: user-cancel'))

    expect(await settled(callVerdict)).toEqual({ action: 'forward' })
    expect(await settled(cancelVerdict)).toEqual({ action: 'forward' })
    await expect(queue.readResolution(pending.approvalId)).resolves.toMatchObject({ outcome: 'approved' })
    expect((await decisions()).map((record) => record.decision?.outcome)).toEqual([
      'require-approval-pending',
      'approved',
    ])
  })

  test('a cancel that names another request leaves the held call alone', async () => {
    const { gate } = createHarness()

    const callVerdict = gate.gateClientMessage(toolCall(15))
    const pending = await waitForPending()
    expect(await settled(gate.gateClientMessage(cancelOf(999, 'AbortError: user-cancel')))).toEqual({ action: 'forward' })
    await sleep(POLL_INTERVAL_MS * 3)

    await expect(queue.list()).resolves.toHaveLength(1)
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'operator' })
    expect(await settled(callVerdict)).toEqual({ action: 'forward' })
  })

  test('the connection ending withdraws every held call as disconnected, with no answer', async () => {
    const { gate, written, scheduler } = createHarness()

    const one = gate.gateClientMessage(toolCall(16, { a: 1 }))
    const two = gate.gateClientMessage(toolCall(17, { a: 2 }))
    for (let attempt = 0; attempt < 400 && (await queue.list()).length < 2; attempt += 1) await sleep(POLL_INTERVAL_MS)
    const held = await queue.list()
    expect(held).toHaveLength(2)

    await gate.cancelPending()

    expect(await settled(one)).toEqual({ action: 'drop' })
    expect(await settled(two)).toEqual({ action: 'drop' })
    expect(written).toEqual([])
    expect(scheduler.active()).toBe(0)
    for (const entry of held) {
      await expect(queue.readResolution(entry.approvalId)).resolves.toMatchObject({
        outcome: 'withdrawn',
        reason: 'disconnected',
      })
    }
    const gone = (await decisions()).filter((record) => record.decision?.outcome === 'agent-gone')
    expect(gone.map((record) => record.decision?.reason)).toEqual(['disconnected', 'disconnected'])
  })

  test('a call still being enqueued when the session ends is withdrawn as soon as it is queued', async () => {
    const { gate, written } = createHarness()

    const verdict = gate.gateClientMessage(toolCall(18))
    const teardown = gate.cancelPending()

    expect(await settled(verdict)).toEqual({ action: 'drop' })
    await teardown
    expect(written).toEqual([])
    const resolved = await queue.listResolved({ limit: 5 })
    expect(resolved.map((record) => record.resolution)).toEqual([{ outcome: 'withdrawn', reason: 'disconnected' }])
  })

  test('a request closed behind a live agent\'s back (stale-heartbeat sweep) still gets the agent an answer', async () => {
    const { gate, written } = createHarness()

    const verdict = gate.gateClientMessage(toolCall(19))
    const pending = await waitForPending()
    // Another process judged the heartbeat stale (a laptop that slept, a disk
    // that stalled) while this gate is very much alive and its agent waiting.
    await createApprovalQueue({ baseDir: approvalsDir }).withdraw(pending.approvalId, 'process-lost')

    expect(await settled(verdict)).toEqual({ action: 'drop' })
    expect(written).toHaveLength(1)
    const answer = parsed(written[0]!)
    expect(answer.id).toBe(19)
    expect(answer.error.code).toBe(ERROR_CODE_APPROVAL)
    expect(answer.error.data.reason).toBe('approval_timeout')
    expect((await decisions()).at(-1)?.decision?.outcome).toBe('timeout')
  })
})

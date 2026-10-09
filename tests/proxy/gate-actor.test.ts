import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'
import {
  createApprovalQueue,
  type ApprovalQueue,
  type PendingApproval,
} from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter, type ApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { createPolicyGate, type PolicyGate } from '../../src/proxy/gate.js'
import type { GateAgentScope, GateInventory, GateSink } from '../../src/proxy/gate-helpers.js'
import type { Frame } from '../../src/protocol/split.js'
import type { OrderedWriter } from '../../src/proxy/writer.js'

/**
 * Decision-record ATTRIBUTION at the gate (M5 wave 2). Wave 1 pinned the
 * rules a call was decided under; this pins WHO decided it, for the only
 * outcomes a human determines.
 *
 * The invariant is two-sided and both sides are evidence:
 *  - every record whose outcome was determined by an operator names that
 *    operator (`approved`, `denied-by-operator`, and — the defect this wave
 *    closes — the retry admitted by a LATE approval);
 *  - every record whose outcome no human determined carries NO `actor` key
 *    at all. A `timeout` is the absence of a decision and an `expired`
 *    resolution is one no operator made; a record claiming an actor for
 *    either would be a lie in evidence waves 3-4 chain and sign.
 *
 * Absence is asserted with `Object.hasOwn` on the record as the gate BUILT
 * it (captured through a fake sink), never on a JSON round trip:
 * `JSON.stringify` drops `actor: undefined` exactly as it drops an absent
 * key, so a serialized record would make the assertion pass vacuously
 * (wave 1 hit exactly this trap).
 */

const SERVER_NAME = 'testsrv'
const SESSION_ID = 'session-gate-actor'
const OPERATOR = 'ui:alice'

const APPROVAL_POLICY = {
  defaultDecision: 'require-approval',
  quarantine: { enabled: false },
  approval: { timeoutMs: 10_000, grantTtlMs: 60_000 },
} as const

/** Short wait, long grant window: the shape a late approval needs. */
const LATE_APPROVAL_POLICY = {
  ...APPROVAL_POLICY,
  approval: { timeoutMs: 30, grantTtlMs: 60_000 },
} as const

let tempDir: string
let sink: JournalSink
let queue: ApprovalQueue
let approvalsDir: string
let errors: unknown[]

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-gate-actor-test-'))
  approvalsDir = join(tempDir, 'approvals')
  sink = createJournalSink(SESSION_ID, { dir: tempDir })
  queue = createApprovalQueue({ baseDir: approvalsDir })
  errors = []
})

afterEach(async () => {
  await sink.close()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function policyOf(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({ version: 1, quarantine: { enabled: false }, ...overrides })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

function frameOf(message: unknown): Frame {
  const text = typeof message === 'string' ? message : JSON.stringify(message)
  return { bytes: Buffer.from(text, 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
}

function toolCall(id: unknown, name: string): Frame {
  return frameOf({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: { path: '/tmp/x' } },
  })
}

function trustedInventory(): GateInventory {
  return {
    load: () => Promise.resolve(),
    observeToolsList: (tools) =>
      Promise.resolve({ known: tools.map((tool) => tool.name), new: [], changed: [], failed: false }),
    stateOf: () => 'known',
    surfaceDeltaOf: () => undefined,
    descriptorOf: () => undefined,
    hasObservedCatalog: () => true,
    isCatalogTrusted: () => true,
  }
}

function scopeOf(agentName: string): GateAgentScope {
  return {
    agentName,
    isGranted: () => true,
    filterVisible: (tools) => [...tools],
    grantsHash: () => 'a'.repeat(64),
  }
}

interface HarnessOptions {
  readonly policy?: Policy
  readonly agentScope?: GateAgentScope
  readonly approvalWaiter?: ApprovalWaiter
}

interface GateHarness {
  readonly gate: PolicyGate
  /** Records as the gate BUILT them — the only place an absent key is visible. */
  readonly captured: JournalRecord[]
}

function createHarness(opts: HarnessOptions = {}): GateHarness {
  const captured: JournalRecord[] = []
  const writer: OrderedWriter = {
    writeMessage: () => Promise.resolve(),
    dispose: () => undefined,
  }
  const capturingSink: GateSink = {
    write: (record: JournalRecord) => {
      captured.push(record)
      sink.write(record)
    },
    flush: () => sink.flush(),
  }
  const gate = createPolicyGate({
    policy: opts.policy ?? policyOf(APPROVAL_POLICY),
    serverName: SERVER_NAME,
    sessionId: SESSION_ID,
    inventory: trustedInventory(),
    ...(opts.agentScope !== undefined ? { agentScope: opts.agentScope } : {}),
    approvalQueue: queue,
    approvalWaiter: opts.approvalWaiter ?? createApprovalWaiter({ pollIntervalMs: 5 }),
    sink: capturingSink,
    clientWriter: writer,
    onError: (error: unknown) => errors.push(error),
  })
  return { gate, captured }
}

/** The decision records the gate built, in write order. */
function decisionsOf(harness: GateHarness): Record<string, unknown>[] {
  return harness.captured
    .filter((record) => record.kind === 'decision')
    .map((record) => record.decision as unknown as Record<string, unknown>)
}

async function waitForPendingApproval(): Promise<PendingApproval> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [match] = await queue.list()
    if (match !== undefined) return match
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('no approval was enqueued')
}

describe('a LATE approval admits nothing: the retry is a question of its own (M36)', () => {
  /**
   * Before M36 an operator could approve a call AFTER its wait timed out and
   * the agent's identical retry passed on that approval (`rule: grant`); M5
   * wave 2 made that retry's record name the approval and the operator. M36
   * removed the window: the timed-out request is closed with its answer, a
   * late approval of it is refused, and the retry raises its own prompt —
   * whose terminal record names ITS operator, never the earlier one.
   */
  test('the late approval is refused, and the retry is approved under its own id and operator', async () => {
    const harness = createHarness({ policy: policyOf(LATE_APPROVAL_POLICY) })

    await harness.gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const [closed] = await queue.listResolved({ limit: 1 })
    expect((await queue.resolve(closed!.approvalId, { outcome: 'approved', actor: OPERATOR })).ok).toBe(false)

    const retry = harness.gate.gateClientMessage(toolCall(2, 'delete_repo'))
    const fresh = await waitForPendingApproval()
    await queue.resolve(fresh.approvalId, { outcome: 'approved', actor: 'ui:bob' })

    expect(await retry).toEqual({ action: 'forward' })
    const approved = decisionsOf(harness).at(-1)!
    expect(approved['outcome']).toBe('approved')
    expect(approved['approvalId']).toBe(fresh.approvalId)
    expect(approved['actor']).toBe('ui:bob')
    expect(decisionsOf(harness).map((decision) => decision['rule'])).not.toContain('grant')
    expect(errors).toEqual([])
  })

  test('no record of the retry carries the earlier request\'s id', async () => {
    const harness = createHarness({ policy: policyOf(LATE_APPROVAL_POLICY) })

    await harness.gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const [closed] = await queue.listResolved({ limit: 1 })
    const before = decisionsOf(harness).length

    const retry = harness.gate.gateClientMessage(toolCall(2, 'delete_repo'))
    const fresh = await waitForPendingApproval()
    await queue.resolve(fresh.approvalId, { outcome: 'approved' })
    await retry

    const retryRecords = decisionsOf(harness).slice(before)
    expect(retryRecords.map((decision) => decision['approvalId'])).toEqual([fresh.approvalId, fresh.approvalId])
    expect(retryRecords.map((decision) => decision['approvalId'])).not.toContain(closed!.approvalId)
    expect(Object.hasOwn(retryRecords.at(-1)!, 'actor')).toBe(false)
  })

  test('an approval for agent alpha never admits the identical call from agent beta (audit 2026-09-02, F1)', async () => {
    // Two authenticated agents, one approvals queue. The human answered
    // ALPHA's question; beta's byte-identical call is a question nobody was
    // asked, so it raises its own prompt.
    const alpha = createHarness({ policy: policyOf(APPROVAL_POLICY), agentScope: scopeOf('alpha') })
    const beta = createHarness({ policy: policyOf(LATE_APPROVAL_POLICY), agentScope: scopeOf('beta') })

    const alphaCall = alpha.gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const pending = await waitForPendingApproval()
    expect(pending.agentName).toBe('alpha')
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: OPERATOR })
    expect(await alphaCall).toEqual({ action: 'forward' })

    const retry = await beta.gate.gateClientMessage(toolCall(2, 'delete_repo'))

    // Beta's own wait timed out: nobody approved BETA.
    expect(retry).toEqual({ action: 'drop' })
    const [betaClosed] = await queue.listResolved({ limit: 1 })
    expect(betaClosed?.agentName).toBe('beta')
    expect(betaClosed?.approvalId).not.toBe(pending.approvalId)
    const betaDecisions = decisionsOf(beta)
    expect(betaDecisions.map((decision) => decision['rule'])).not.toContain('grant')
    expect(betaDecisions.at(-1)?.['outcome']).toBe('timeout')
    expect(errors).toEqual([])
  })
})

describe('the terminal record of a waited-out approval names its operator', () => {
  test('an approved record carries the resolving actor', async () => {
    const harness = createHarness({ agentScope: scopeOf('research-bot') })

    const verdict = harness.gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const pending = await waitForPendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: OPERATOR })
    await verdict

    const terminal = decisionsOf(harness).at(-1)!
    expect(terminal['outcome']).toBe('approved')
    expect(terminal['actor']).toBe(OPERATOR)
  })

  test('a denied-by-operator record carries the resolving actor', async () => {
    const harness = createHarness()

    const verdict = harness.gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const pending = await waitForPendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'denied', actor: 'cli' })
    await verdict

    const terminal = decisionsOf(harness).at(-1)!
    expect(terminal['outcome']).toBe('denied-by-operator')
    expect(terminal['actor']).toBe('cli')
  })

  test('the require-approval-pending record has no actor: nobody has decided yet', async () => {
    const harness = createHarness()

    const verdict = harness.gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const pending = await waitForPendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: OPERATOR })
    await verdict

    const [requested] = decisionsOf(harness)
    expect(requested!['outcome']).toBe('require-approval-pending')
    expect(Object.hasOwn(requested!, 'actor')).toBe(false)
  })

  test('a resolution recorded with no actor produces a record with no actor key', async () => {
    const harness = createHarness()

    const verdict = harness.gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const pending = await waitForPendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'denied' })
    await verdict

    const terminal = decisionsOf(harness).at(-1)!
    expect(terminal['outcome']).toBe('denied-by-operator')
    expect(Object.hasOwn(terminal, 'actor')).toBe(false)
  })
})

describe('an outcome no human determined carries no actor', () => {
  test('a timeout record has no actor key at all', async () => {
    // A timeout is the ABSENCE of a decision. Nobody to attribute it to, so
    // the key is absent rather than empty — asserted on the in-memory
    // record, because a JSON round trip cannot tell absent from undefined.
    const harness = createHarness({ policy: policyOf(LATE_APPROVAL_POLICY) })

    await harness.gate.gateClientMessage(toolCall(1, 'delete_repo'))

    const terminal = decisionsOf(harness).at(-1)!
    expect(terminal['outcome']).toBe('timeout')
    expect(Object.hasOwn(terminal, 'actor')).toBe(false)
  })

  test('an expired resolution (a capped wait, the expiry sweep) attributes nobody', async () => {
    // `markExpired()` records a resolution no operator made. The waiter
    // reports it as a timeout (fail closed, and not a human denial — review
    // R6), so the record exists — but it must not name anyone.
    const harness = createHarness()

    const verdict = harness.gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const pending = await waitForPendingApproval()
    await queue.markExpired(pending.approvalId)
    await verdict

    const terminal = decisionsOf(harness).at(-1)!
    expect(terminal['outcome']).toBe('timeout')
    expect(Object.hasOwn(terminal, 'actor')).toBe(false)
  })
})

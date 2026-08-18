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
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
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
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-gate-actor-test-'))
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
    grantRegistry: createGrantRegistry(),
    sink: capturingSink,
    clientWriter: writer,
    approvalsBaseDir: approvalsDir,
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

describe('a retry admitted by a LATE approval names the approval and the operator', () => {
  /**
   * THE defect of this wave. An operator approves a destructive call AFTER
   * its wait already timed out; the agent retries, `checkRecentApproval`
   * finds the resolution on disk and the gate lets the call through. The
   * record it wrote said `allow` / `rule: grant` and nothing else: an
   * auditor reading the retry saw a destructive call simply succeeding,
   * with the human approval that authorized it recorded nowhere on it.
   */
  test('the allow record carries both the approvalId and the resolving actor', async () => {
    const harness = createHarness({ policy: policyOf(LATE_APPROVAL_POLICY) })

    await harness.gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const pending = await waitForPendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: OPERATOR })

    const retry = await harness.gate.gateClientMessage(toolCall(2, 'delete_repo'))

    expect(retry).toEqual({ action: 'forward' })
    expect(await queue.list()).toEqual([]) // no second prompt: this IS the late-grant path
    const granted = decisionsOf(harness).at(-1)!
    expect(granted['outcome']).toBe('allow')
    expect(granted['rule']).toBe('grant')
    expect(granted['approvalId']).toBe(pending.approvalId)
    expect(granted['actor']).toBe(OPERATOR)
    expect(errors).toEqual([])
  })

  test('a pre-M5 resolution with no actor still grants, and the record has no actor key', async () => {
    // Records written before this wave (and every `resolve()` call that
    // passes none) carry no actor. Attribution must not become a condition
    // of the grant: the call is still authorized, the record simply says
    // nothing it cannot support.
    const harness = createHarness({ policy: policyOf(LATE_APPROVAL_POLICY) })

    await harness.gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const pending = await waitForPendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'approved' })

    const retry = await harness.gate.gateClientMessage(toolCall(2, 'delete_repo'))

    expect(retry).toEqual({ action: 'forward' })
    const granted = decisionsOf(harness).at(-1)!
    expect(granted['approvalId']).toBe(pending.approvalId)
    expect(Object.hasOwn(granted, 'actor')).toBe(false)
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

  test('an expired resolution (session teardown) attributes nobody', async () => {
    // `markExpired()` records a resolution no operator made. The waiter
    // reports it as a denial (fail closed), so the record exists — but it
    // must not name anyone.
    const harness = createHarness()

    const verdict = harness.gate.gateClientMessage(toolCall(1, 'delete_repo'))
    const pending = await waitForPendingApproval()
    await queue.markExpired(pending.approvalId)
    await verdict

    const terminal = decisionsOf(harness).at(-1)!
    expect(terminal['outcome']).toBe('denied-by-operator')
    expect(Object.hasOwn(terminal, 'actor')).toBe(false)
  })
})

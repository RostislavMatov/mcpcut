import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createApprovalQueue, type ApprovalQueue, type PendingApproval } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
import { SURFACE_CHANGED_RULE } from '../../src/policy/decide.js'
import type { SurfaceDelta } from '../../src/policy/schema-diff.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { createPolicyGate, type PolicyGate } from '../../src/proxy/gate.js'
import type { GateInventory, GateSink } from '../../src/proxy/gate-helpers.js'
import type { Frame } from '../../src/protocol/split.js'
import type { OrderedWriter } from '../../src/proxy/writer.js'

/**
 * The gate half of owner decision O4 (M5 wave 6): the surface signal the
 * inventory holds has to REACH `decide()` on the call path, and the resulting
 * withdrawal has to be legible in the journal.
 *
 * The unit-level rule lives in `tests/policy/decide-surface-change.test.ts`;
 * what is proven here is the wiring -- an escalation that only works in a pure
 * function nobody calls with the real signal would be worth nothing.
 */

const SERVER_NAME = 'testsrv'
const SESSION_ID = 'session-gate-surface'

let tempDir: string
let sink: JournalSink
let queue: ApprovalQueue
let approvalsDir: string
let errors: unknown[]

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-gate-surface-test-'))
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
  const result = parsePolicy({
    version: 1,
    defaultDecision: 'deny',
    quarantine: { enabled: true, onQuarantined: 'require-approval' },
    servers: { [SERVER_NAME]: { tools: { read_file: 'allow' } } },
    ...overrides,
  })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

function frameOf(message: unknown): Frame {
  return { bytes: Buffer.from(JSON.stringify(message), 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
}

function toolCall(id: number): Frame {
  return frameOf({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'read_file', arguments: {} } })
}

/** An inventory reporting one tool as `changed`, with the delta under test. */
function inventoryWith(delta: SurfaceDelta | undefined): GateInventory {
  return {
    load: () => Promise.resolve(),
    observeToolsList: () => Promise.resolve({ known: [], new: [], changed: ['read_file'], failed: false }),
    stateOf: () => 'changed',
    surfaceDeltaOf: () => delta,
    descriptorOf: () => undefined,
    hasObservedCatalog: () => true,
    isCatalogTrusted: () => true,
  }
}

interface Harness {
  readonly gate: PolicyGate
  readonly captured: JournalRecord[]
}

function createHarness(policy: Policy, inventory: GateInventory): Harness {
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
    policy,
    serverName: SERVER_NAME,
    sessionId: SESSION_ID,
    inventory,
    approvalQueue: queue,
    approvalWaiter: createApprovalWaiter({ pollIntervalMs: 5 }),
    grantRegistry: createGrantRegistry(),
    sink: capturingSink,
    clientWriter: writer,
    approvalsBaseDir: approvalsDir,
    onError: (error: unknown) => errors.push(error),
  })
  return { gate, captured }
}

function decisionsOf(harness: Harness): JournalRecord[] {
  return harness.captured.filter((record) => record.kind === 'decision')
}

/** Generous ceiling for "this was never going to happen"; never waited out. */
const OBSERVE_TIMEOUT_MS = 5_000

async function pendingApproval(): Promise<PendingApproval> {
  const deadline = Date.now() + OBSERVE_TIMEOUT_MS
  for (;;) {
    const [match] = await queue.list()
    if (match !== undefined) return match
    if (Date.now() > deadline) throw new Error('timed out waiting for an enqueued approval')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/**
 * Drives one gated call to completion: an escalated call parks on the approval
 * queue, so the verdict promise only settles once an operator answers. Denying
 * keeps the test about the DECISION, not about approval mechanics.
 */
async function runEscalatedCall(harness: Harness): Promise<void> {
  const verdict = harness.gate.gateClientMessage(toolCall(1))
  const pending = await pendingApproval()
  await queue.resolve(pending.approvalId, { outcome: 'denied', actor: 'operator' })
  await verdict
}

describe('the gate feeds the surface delta into the decision (O4 wiring)', () => {
  test('a widened surface withdraws the explicit allow and the record says so', async () => {
    const harness = createHarness(policyOf(), inventoryWith('widened'))

    await runEscalatedCall(harness)

    const decision = decisionsOf(harness)[0]?.decision
    expect(decision?.outcome).toBe('require-approval-pending')
    expect(decision?.rule).toBe(SURFACE_CHANGED_RULE)
    expect(decision?.quarantineState).toBe('changed')
    // Provenance is what makes the withdrawal auditable rather than magic: the
    // record names the ruleset the call was decided under (M5 wave 1).
    expect(decision?.policyHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('an inventory that cannot establish a direction still withdraws the allow', async () => {
    const harness = createHarness(policyOf(), inventoryWith(undefined))

    await runEscalatedCall(harness)

    expect(decisionsOf(harness)[0]?.decision?.rule).toBe(SURFACE_CHANGED_RULE)
  })

  test('a narrowed surface leaves the allow standing, under the operator rule', async () => {
    const harness = createHarness(policyOf(), inventoryWith('narrowed'))

    await harness.gate.gateClientMessage(toolCall(1))

    const decision = decisionsOf(harness)[0]?.decision
    expect(decision?.outcome).toBe('allow')
    expect(decision?.rule).toBe(`servers.${SERVER_NAME}.tools.read_file`)
  })

  test('errors never leak: the escalation path writes a decision, not a gate error', async () => {
    const harness = createHarness(policyOf(), inventoryWith('widened'))

    await runEscalatedCall(harness)

    expect(errors).toEqual([])
  })
})

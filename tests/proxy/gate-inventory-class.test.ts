import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createApprovalQueue, type ApprovalQueue, type PendingApproval } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { createPolicyGate, type PolicyGate } from '../../src/proxy/gate.js'
import type { GateInventory, GateSink } from '../../src/proxy/gate-helpers.js'
import type { ToolDescriptor } from '../../src/protocol/mcp.js'
import type { Frame } from '../../src/protocol/split.js'
import type { OrderedWriter } from '../../src/proxy/writer.js'

/**
 * User-journey smoke 2026-09-18, H1. Under `classDefaults.write: allow` the
 * same `write_file` call was held for approval in a session that had asked for
 * `tools/list` (class `destructive`, from the server's `destructiveHint`) and
 * sailed through in a session that had not (class `write`, from the name
 * alone). Whether to ask for the catalog is the agent's choice, so the class
 * -- and with it the approval -- was the agent's choice too.
 *
 * What is proven here is the wiring: with no catalog seen in the session, the
 * call is classified from the descriptor the inventory holds.
 */

const SERVER_NAME = 'files'
const SESSION_ID = 'session-gate-inventory-class'

let tempDir: string
let sink: JournalSink
let queue: ApprovalQueue
let approvalsDir: string
let errors: unknown[]

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-gate-inventory-class-'))
  approvalsDir = join(tempDir, 'approvals')
  sink = createJournalSink(SESSION_ID, { dir: tempDir })
  queue = createApprovalQueue({ baseDir: approvalsDir })
  errors = []
})

afterEach(async () => {
  await sink.close()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function smokePolicy(): Policy {
  const result = parsePolicy({
    version: 1,
    defaultDecision: 'require-approval',
    classDefaults: { read: 'allow', write: 'allow' },
  })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

function frameOf(message: unknown): Frame {
  return { bytes: Buffer.from(JSON.stringify(message), 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
}

function callWriteFile(id: number): Frame {
  return frameOf({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'write_file', arguments: { path: '/x' } } })
}

/** A released (`known`) tool whose stored descriptor is `stored`; no catalog seen in this session. */
function inventoryHolding(stored: ToolDescriptor | undefined): GateInventory {
  return {
    load: () => Promise.resolve(),
    observeToolsList: () => Promise.resolve({ known: [], new: [], changed: [], failed: false }),
    stateOf: () => 'known',
    surfaceDeltaOf: () => undefined,
    descriptorOf: (toolName) => (stored?.name === toolName ? stored : undefined),
    hasObservedCatalog: () => false,
    isCatalogTrusted: () => true,
  }
}

interface Harness {
  readonly gate: PolicyGate
  readonly captured: JournalRecord[]
}

function createHarness(inventory: GateInventory): Harness {
  const captured: JournalRecord[] = []
  const writer: OrderedWriter = { writeMessage: () => Promise.resolve(), dispose: () => undefined }
  const capturingSink: GateSink = {
    write: (record: JournalRecord) => {
      captured.push(record)
      sink.write(record)
    },
    flush: () => sink.flush(),
  }
  const gate = createPolicyGate({
    policy: smokePolicy(),
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

function firstDecision(harness: Harness): JournalRecord['decision'] {
  return harness.captured.find((record) => record.kind === 'decision')?.decision
}

describe('a call made without tools/list is classified from the inventory descriptor', () => {
  test('a stored destructiveHint holds the call for approval instead of allowing it as "write"', async () => {
    const harness = createHarness(inventoryHolding({ name: 'write_file', annotations: { destructiveHint: true } }))

    const verdict = harness.gate.gateClientMessage(callWriteFile(1))
    const pending = await pendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'denied', actor: 'operator' })
    await verdict

    const decision = firstDecision(harness)
    expect(decision?.toolClass).toBe('destructive')
    expect(decision?.outcome).toBe('require-approval-pending')
    expect(errors).toEqual([])
  })

  test('a catalog listed in this session wins over the stored descriptor', async () => {
    // Stored: no hint. Listed now: destructive. The listing is the fresher word.
    const harness = createHarness(inventoryHolding({ name: 'write_file', annotations: { destructiveHint: false } }))
    await harness.gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 9, method: 'tools/list' }))
    await harness.gate.gateServerMessage(
      frameOf({ jsonrpc: '2.0', id: 9, result: { tools: [{ name: 'write_file', annotations: { destructiveHint: true } }] } }),
    )

    const verdict = harness.gate.gateClientMessage(callWriteFile(1))
    const pending = await pendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'denied', actor: 'operator' })
    await verdict

    const call = harness.captured.find((record) => record.decision?.toolName === 'write_file')
    expect(call?.decision?.toolClass).toBe('destructive')
  })

  test('with nothing stored the name alone still decides, as before', async () => {
    const harness = createHarness(inventoryHolding(undefined))

    await harness.gate.gateClientMessage(callWriteFile(1))

    const decision = firstDecision(harness)
    expect(decision?.toolClass).toBe('write')
    expect(decision?.outcome).toBe('allow')
  })
})

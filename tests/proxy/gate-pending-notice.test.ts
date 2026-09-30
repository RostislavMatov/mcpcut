import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import { createApprovalQueue, type ApprovalQueue, type PendingApproval } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { createPolicyGate, type PolicyGate } from '../../src/proxy/gate.js'
import type { GateInventory } from '../../src/proxy/gate-helpers.js'
import type { PendingApprovalNotice } from '../../src/proxy/gate-types.js'
import type { Frame } from '../../src/protocol/split.js'
import type { OrderedWriter } from '../../src/proxy/writer.js'

/**
 * A held call is announced to whoever runs the proxy (0.2.3, stranger run of
 * 0.2.2): without it, `wrap` sat silent for the whole approval wait and the
 * operator had no way to learn a call was waiting, or which id to approve.
 *
 * The announcement goes to the operator's side only — `wrap` writes it to
 * its stderr. The agent's own channel (the -32002 error) must keep carrying
 * no approval command: an agent with a shell would run it and approve itself.
 */

const SERVER_NAME = 'testsrv'
const SESSION_ID = 'session-gate-pending-notice'
const WAIT_MS = 10_000

let tempDir: string
let sink: JournalSink
let queue: ApprovalQueue
let approvalsDir: string
let errors: unknown[]

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-gate-pending-notice-'))
  approvalsDir = join(tempDir, 'approvals')
  sink = createJournalSink(SESSION_ID, { dir: tempDir })
  queue = createApprovalQueue({ baseDir: approvalsDir })
  errors = []
})

afterEach(async () => {
  await sink.close()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function policyOf(overrides: Record<string, unknown>): Policy {
  const result = parsePolicy({ version: 1, quarantine: { enabled: false }, ...overrides })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

function toolCall(id: number, name: string): Frame {
  const text = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })
  return { bytes: Buffer.from(text, 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
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

function createGate(policy: Policy, onApprovalPending: (notice: PendingApprovalNotice) => void): PolicyGate {
  const writer: OrderedWriter = { writeMessage: () => Promise.resolve(), dispose: () => undefined }
  return createPolicyGate({
    policy,
    serverName: SERVER_NAME,
    sessionId: SESSION_ID,
    inventory: trustedInventory(),
    approvalQueue: queue,
    approvalWaiter: createApprovalWaiter({ pollIntervalMs: 5 }),
    grantRegistry: createGrantRegistry(),
    sink,
    clientWriter: writer,
    approvalsBaseDir: approvalsDir,
    onError: (error: unknown) => errors.push(error),
    onApprovalPending,
  })
}

async function waitForPendingApproval(): Promise<PendingApproval> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [match] = await queue.list()
    if (match !== undefined) return match
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('no approval was enqueued')
}

const APPROVAL_POLICY = {
  defaultDecision: 'allow',
  approval: { timeoutMs: WAIT_MS, grantTtlMs: 60_000 },
  servers: { [SERVER_NAME]: { tools: { write_file: 'require-approval', delete_file: 'deny' } } },
}

describe('the gate announces a held call once, while it waits', () => {
  test('names the queued approval, the tool, the server and the wait', async () => {
    // Arrange
    const notices: PendingApprovalNotice[] = []
    const gate = createGate(policyOf(APPROVAL_POLICY), (notice) => notices.push(notice))

    // Act
    const verdict = gate.gateClientMessage(toolCall(1, 'write_file'))
    const pending = await waitForPendingApproval()
    const noticesWhileWaiting = [...notices]
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'cli:test' })
    await verdict

    // Assert
    expect(noticesWhileWaiting).toEqual([
      { approvalId: pending.approvalId, toolName: 'write_file', serverName: SERVER_NAME, waitMs: WAIT_MS },
    ])
    expect(notices).toHaveLength(1)
    expect(errors).toEqual([])
  })

  test('says nothing for a call the policy allows or denies outright', async () => {
    const notices: PendingApprovalNotice[] = []
    const gate = createGate(policyOf(APPROVAL_POLICY), (notice) => notices.push(notice))

    await gate.gateClientMessage(toolCall(1, 'read_file'))
    await gate.gateClientMessage(toolCall(2, 'delete_file'))

    expect(notices).toEqual([])
  })

  test('a failing announcement is reported, and the approval still decides the call', async () => {
    // Arrange
    const failure = new Error('stderr is gone')
    const gate = createGate(policyOf(APPROVAL_POLICY), () => {
      throw failure
    })

    // Act
    const verdict = gate.gateClientMessage(toolCall(1, 'write_file'))
    const pending = await waitForPendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'cli:test' })

    // Assert
    expect(await verdict).toEqual({ action: 'forward' })
    expect(errors).toEqual([failure])
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { matchesFilters } from '../../src/journal/search-filters.js'
import { createApprovalQueue, type ApprovalQueue, type PendingApproval } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { createPolicyGate, type PolicyGate } from '../../src/proxy/gate.js'
import { createDecisionProvenance, createDecisionWriter } from '../../src/proxy/gate-decision-writer.js'
import type { GateAgentScope, GateInventory, GateSink } from '../../src/proxy/gate-helpers.js'
import type { Frame } from '../../src/protocol/split.js'
import type { OrderedWriter } from '../../src/proxy/writer.js'

/**
 * User-journey smoke 2026-09-18, H2. `agentName` was stamped only on
 * `require-approval-pending` records, so an agent's ALLOWED and DENIED calls
 * named nobody: the journal's agent filter found 2 records of a 20-record
 * session, and an exported report could not say which agent made a call that
 * went through. Attribution is evidence, so -- like `policyHash` -- it is
 * stamped at the one writer every decision record passes through, not at the
 * places a decision happens to be assembled.
 */

const SERVER_NAME = 'files'
const SESSION_ID = 'session-gate-agent-attribution'
const AGENT_NAME = 'research-bot'

let tempDir: string
let sink: JournalSink
let queue: ApprovalQueue
let approvalsDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-gate-agent-attribution-'))
  approvalsDir = join(tempDir, 'approvals')
  sink = createJournalSink(SESSION_ID, { dir: tempDir })
  queue = createApprovalQueue({ baseDir: approvalsDir })
})

afterEach(async () => {
  await sink.close()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function policyOf(overrides: Record<string, unknown>): Policy {
  const result = parsePolicy({ version: 1, defaultDecision: 'allow', ...overrides })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

function frameOf(message: unknown): Frame {
  return { bytes: Buffer.from(JSON.stringify(message), 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
}

function toolCall(id: number, name: string): Frame {
  return frameOf({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { path: '/x' } } })
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

function agentScope(granted: (tool: string) => boolean = () => true): GateAgentScope {
  return {
    agentName: AGENT_NAME,
    isGranted: granted,
    filterVisible: (tools) => tools.filter(granted),
    grantsHash: () => 'a'.repeat(64),
  }
}

interface Harness {
  readonly gate: PolicyGate
  readonly decisions: () => JournalRecord[]
}

function createHarness(policy: Policy, scope?: GateAgentScope): Harness {
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
    policy,
    serverName: SERVER_NAME,
    sessionId: SESSION_ID,
    inventory: trustedInventory(),
    approvalQueue: queue,
    approvalWaiter: createApprovalWaiter({ pollIntervalMs: 5 }),
    grantRegistry: createGrantRegistry(),
    sink: capturingSink,
    clientWriter: writer,
    approvalsBaseDir: approvalsDir,
    ...(scope !== undefined ? { agentScope: scope } : {}),
  })
  return { gate, decisions: () => captured.filter((record) => record.kind === 'decision') }
}

describe('every decision record of an agent session names the agent', () => {
  test('an allowed call names the agent', async () => {
    const harness = createHarness(policyOf({}), agentScope())

    await harness.gate.gateClientMessage(toolCall(1, 'read_file'))

    const [record] = harness.decisions()
    expect(record?.decision?.outcome).toBe('allow')
    expect(record?.decision?.agentName).toBe(AGENT_NAME)
  })

  test('a call denied by policy names the agent', async () => {
    const harness = createHarness(policyOf({ defaultDecision: 'deny' }), agentScope())

    await harness.gate.gateClientMessage(toolCall(1, 'delete_repo'))

    const [record] = harness.decisions()
    expect(record?.decision?.outcome).toBe('deny')
    expect(record?.decision?.agentName).toBe(AGENT_NAME)
  })

  test('a call denied for lack of a grant names the agent', async () => {
    const harness = createHarness(policyOf({}), agentScope((tool) => tool === 'read_file'))

    await harness.gate.gateClientMessage(toolCall(1, 'write_file'))

    const [record] = harness.decisions()
    expect(record?.decision?.rule).toContain('no grant')
    expect(record?.decision?.agentName).toBe(AGENT_NAME)
  })

  test('the tools/list bookkeeping records name the agent', async () => {
    const harness = createHarness(policyOf({}), agentScope())

    await harness.gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 7, method: 'tools/list' }))
    await harness.gate.gateServerMessage(frameOf({ jsonrpc: '2.0', id: 7, result: { tools: [{ name: 'read_file' }] } }))

    const records = harness.decisions()
    expect(records.length).toBeGreaterThan(0)
    for (const record of records) expect(record.decision?.agentName).toBe(AGENT_NAME)
  })

  test('the journal agent filter finds an allowed call', async () => {
    const harness = createHarness(policyOf({}), agentScope())

    await harness.gate.gateClientMessage(toolCall(1, 'read_file'))

    const [record] = harness.decisions()
    expect(matchesFilters(record!, { agentName: AGENT_NAME })).toBe(true)
    expect(matchesFilters(record!, { agentName: 'someone-else' })).toBe(false)
  })
})

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

describe('the records of a held call name the agent through to its resolution', () => {
  /**
   * Before the fix only `require-approval-pending` carried the name; the
   * record of what the operator then DECIDED did not, so "who was this
   * approved for" needed a join on `approvalId`.
   */
  async function resolveHeldCall(outcome: 'approved' | 'denied'): Promise<JournalRecord[]> {
    const harness = createHarness(policyOf({ defaultDecision: 'require-approval' }), agentScope())
    const verdict = harness.gate.gateClientMessage(toolCall(1, 'write_file'))
    const pending = await pendingApproval()
    await queue.resolve(pending.approvalId, { outcome, actor: 'cli:alice' })
    await verdict
    return harness.decisions()
  }

  test('pending and approved records both name the agent', async () => {
    const records = await resolveHeldCall('approved')

    expect(records.map((record) => record.decision?.outcome)).toEqual(['require-approval-pending', 'approved'])
    for (const record of records) expect(record.decision?.agentName).toBe(AGENT_NAME)
  })

  test('pending and denied-by-operator records both name the agent', async () => {
    const records = await resolveHeldCall('denied')

    expect(records.map((record) => record.decision?.outcome)).toEqual([
      'require-approval-pending',
      'denied-by-operator',
    ])
    for (const record of records) expect(record.decision?.agentName).toBe(AGENT_NAME)
  })
})

describe('the writer is the only source of the name', () => {
  const draft = {
    outcome: 'allow',
    rule: 'defaultDecision',
    serverName: SERVER_NAME,
    toolName: 'read_file',
    toolClass: 'read',
    quarantineState: 'known',
    argsHash: '',
    agentName: 'somebody-else',
  } as const

  function writeThrough(scope?: GateAgentScope): JournalRecord {
    const written: JournalRecord[] = []
    const write = createDecisionWriter({
      sink: { write: (record) => written.push(record), flush: () => Promise.resolve() },
      sessionId: SESSION_ID,
      clock: Date.now,
      provenance: createDecisionProvenance(policyOf({}), scope),
    })
    write(draft)
    return written[0]!
  }

  test('a name carried by a draft is replaced by the session scope’s', () => {
    expect(writeThrough(agentScope()).decision?.agentName).toBe(AGENT_NAME)
  })

  test('a name carried by a draft does not survive on a session that has no agent', () => {
    expect(Object.hasOwn(writeThrough().decision!, 'agentName')).toBe(false)
  })
})

describe('a session with no agent names nobody', () => {
  test('the key is absent, not undefined, so the record cannot merely look unattributed', async () => {
    const harness = createHarness(policyOf({}))

    await harness.gate.gateClientMessage(toolCall(1, 'read_file'))

    const [record] = harness.decisions()
    expect(Object.hasOwn(record!.decision!, 'agentName')).toBe(false)
  })
})

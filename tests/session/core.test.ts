import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { AgentRecord } from '../../src/agents/schema.js'
import { createRecordBuilder } from '../../src/journal/record.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
import { createApprovalQueue, type ApprovalQueue, type PendingApproval } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { grantsHashOf, policyHashOf } from '../../src/policy/provenance.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import type { GateInventory } from '../../src/proxy/gate-helpers.js'
import {
  ERROR_CODE_APPROVAL,
  ERROR_CODE_POLICY_DENIED,
} from '../../src/proxy/synthesize.js'
import { AGENT_REVOKED_RULE, SESSION_TOOL_NAME } from '../../src/session/constants.js'
import { createSession, type CreateSessionDeps, type SessionEndReason, type SessionHandle } from '../../src/session/core.js'
import type { McpMessage } from '../../src/transport/message.js'
import {
  createMemorySink,
  createMemorySource,
  messageOf,
  parseMessage,
  type MemorySink,
  type MemorySource,
} from './memory-transport.js'

const SERVER_NAME = 'testsrv'
const SESSION_ID = 'session-core-1'
const POLL_INTERVAL_MS = 15
const WAIT_TIMEOUT_MS = 5_000

let tempDir: string
let approvalsDir: string
let queue: ApprovalQueue
let errors: unknown[]

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-session-core-test-'))
  approvalsDir = join(tempDir, 'approvals')
  queue = createApprovalQueue({ baseDir: approvalsDir })
  errors = []
})

afterEach(async () => {
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

async function waitForPendingApproval(): Promise<PendingApproval> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  for (;;) {
    const match = (await queue.list())[0]
    if (match !== undefined) return match
    if (Date.now() > deadline) throw new Error('no approval was enqueued')
    await sleep(5)
  }
}

function policyOf(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({ version: 1, quarantine: { enabled: false }, ...overrides })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

/** A well-behaved inventory: hydrated, trusted, everything already known. */
function trustedInventory(): GateInventory {
  return {
    load: () => Promise.resolve(),
    observeToolsList: (tools) =>
      Promise.resolve({ known: tools.map((tool) => tool.name), new: [], changed: [], failed: false }),
    stateOf: () => 'known',
    surfaceDeltaOf: () => undefined,
    hasObservedCatalog: () => true,
    isCatalogTrusted: () => true,
  }
}

function agentRecordOf(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: 'research-bot',
    tokenHash: 'a'.repeat(64),
    createdAt: '2026-08-01T00:00:00.000Z',
    grants: { [SERVER_NAME]: { tools: ['read_*'] } },
    ...overrides,
  }
}

/** Agents-store fake with a mutable current record and a read counter. */
function mutableAgentStore(initial: AgentRecord | undefined) {
  let current = initial
  let reads = 0
  return {
    getAgent: (_name: string) => {
      reads += 1
      return Promise.resolve(current)
    },
    set: (record: AgentRecord | undefined) => {
      current = record
    },
    readCount: () => reads,
  }
}

interface SessionHarness {
  readonly session: SessionHandle
  readonly clientSource: MemorySource
  readonly clientSink: MemorySink
  readonly serverSource: MemorySource
  readonly serverSink: MemorySink
  readonly records: JournalRecord[]
  readonly endReasons: SessionEndReason[]
}

interface HarnessOptions {
  readonly policy?: Policy
  readonly agent?: CreateSessionDeps['agent']
  readonly inventory?: GateInventory
}

function createSessionHarness(opts: HarnessOptions = {}): SessionHarness {
  const clientSource = createMemorySource()
  const clientSink = createMemorySink()
  const serverSource = createMemorySource()
  const serverSink = createMemorySink()
  const records: JournalRecord[] = []
  const endReasons: SessionEndReason[] = []

  const session = createSession({
    sessionId: SESSION_ID,
    serverName: SERVER_NAME,
    client: { source: clientSource, sink: clientSink },
    server: { source: serverSource, sink: serverSink },
    policy: opts.policy ?? policyOf({ defaultDecision: 'allow' }),
    inventory: opts.inventory ?? trustedInventory(),
    approvals: {
      queue,
      waiter: createApprovalWaiter({ pollIntervalMs: 5 }),
      baseDir: approvalsDir,
    },
    grants: createGrantRegistry(),
    journal: {
      recordBuilder: createRecordBuilder(SESSION_ID),
      sink: {
        write: (record) => {
          records.push(record)
        },
        flush: () => Promise.resolve(),
      },
    },
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    revocationPollIntervalMs: POLL_INTERVAL_MS,
    onError: (error) => errors.push(error),
    onSessionEnd: (reason) => endReasons.push(reason),
  })

  return { session, clientSource, clientSink, serverSource, serverSink, records, endReasons }
}

function toolCallMessage(id: unknown, name: string, args: unknown = { path: '/tmp/x' }): McpMessage {
  return messageOf('client', {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  })
}

function decisionsOf(records: JournalRecord[]): JournalRecord[] {
  return records.filter((record) => record.kind === 'decision')
}

describe('createSession: end-to-end through fake transports', () => {
  test('an allowed tools/call is forwarded to the server sink byte-identically and journaled', async () => {
    const harness = createSessionHarness()
    const call = toolCallMessage(1, 'read_file')

    harness.clientSource.emit(call)
    await waitUntil(() => harness.serverSink.written.length === 1)

    // The exact message object flows through: same bytes, same meta.
    expect(harness.serverSink.written[0]).toBe(call)
    expect(harness.clientSink.written).toEqual([])
    const decisions = decisionsOf(harness.records)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.decision).toMatchObject({ outcome: 'allow', toolName: 'read_file' })
    // The tap journaled the message itself, before (and independent of) the verdict.
    expect(harness.records.some((r) => r.kind === 'request' && r.direction === 'client→server')).toBe(true)

    await harness.session.close()
  })

  test('a denied tools/call answers the client with content-only bytes and never reaches the server', async () => {
    const harness = createSessionHarness({ policy: policyOf({ defaultDecision: 'deny' }) })

    harness.clientSource.emit(toolCallMessage(7, 'delete_repo'))
    await waitUntil(() => harness.clientSink.written.length === 1)

    expect(harness.serverSink.written).toEqual([])
    const answer = harness.clientSink.written[0]!
    // Message-level synthetics carry no framing: no trailing newline, no terminator meta.
    expect(answer.bytes.toString('utf8').endsWith('\n')).toBe(false)
    expect(answer.meta.terminator).toBeUndefined()
    expect(answer.meta.origin).toBe('server')
    const parsed = parseMessage(answer)
    expect(parsed['id']).toBe(7)
    expect(parsed['error'].code).toBe(ERROR_CODE_POLICY_DENIED)
    expect(decisionsOf(harness.records)[0]!.decision?.outcome).toBe('deny')

    await harness.session.close()
  })

  test('non-gated traffic flows in both directions even under deny-everything', async () => {
    const harness = createSessionHarness({ policy: policyOf({ defaultDecision: 'deny' }) })
    const notification = messageOf('client', { jsonrpc: '2.0', method: 'notifications/progress', params: {} })
    const response = messageOf('server', { jsonrpc: '2.0', id: 3, result: { ok: true } })

    harness.clientSource.emit(notification)
    harness.serverSource.emit(response)
    await waitUntil(() => harness.serverSink.written.length === 1 && harness.clientSink.written.length === 1)

    expect(harness.serverSink.written[0]).toBe(notification)
    expect(harness.clientSink.written[0]).toBe(response)
    expect(decisionsOf(harness.records)).toEqual([])

    await harness.session.close()
  })

  test('a blank message bypasses tap and gate but is still forwarded', async () => {
    const harness = createSessionHarness({ policy: policyOf({ defaultDecision: 'deny' }) })
    const blank = messageOf('client', '')

    harness.clientSource.emit(blank)
    await waitUntil(() => harness.serverSink.written.length === 1)

    expect(harness.serverSink.written[0]).toBe(blank)
    expect(harness.records).toEqual([])

    await harness.session.close()
  })

  test('require-approval waits for the operator and forwards on approval', async () => {
    const harness = createSessionHarness({
      policy: policyOf({
        defaultDecision: 'require-approval',
        approval: { timeoutMs: 10_000, grantTtlMs: 60_000 },
      }),
    })

    harness.clientSource.emit(toolCallMessage(1, 'write_file'))
    const pendingApproval = await waitForPendingApproval()
    await queue.resolve(pendingApproval.approvalId, { outcome: 'approved', actor: 'operator' })
    await waitUntil(() => harness.serverSink.written.length === 1)

    expect(parseMessage(harness.serverSink.written[0]!)['method']).toBe('tools/call')
    const outcomes = decisionsOf(harness.records).map((record) => record.decision?.outcome)
    expect(outcomes).toEqual(['require-approval-pending', 'approved'])

    await harness.session.close()
  })

  test('a gate emit (filtered tools/list) reaches the client as a fresh server-origin message', async () => {
    const harness = createSessionHarness({
      policy: policyOf({
        defaultDecision: 'allow',
        servers: { [SERVER_NAME]: { tools: { 'delete_*': 'deny' } } },
      }),
    })

    harness.clientSource.emit(messageOf('client', { jsonrpc: '2.0', id: 9, method: 'tools/list' }))
    await waitUntil(() => harness.serverSink.written.length === 1)
    harness.serverSource.emit(
      messageOf('server', {
        jsonrpc: '2.0',
        id: 9,
        result: { tools: [{ name: 'read_file' }, { name: 'delete_repo' }] },
      }),
    )
    await waitUntil(() => harness.clientSink.written.length === 1)

    const rewritten = harness.clientSink.written[0]!
    expect(rewritten.meta.origin).toBe('server')
    expect(rewritten.bytes.toString('utf8').endsWith('\n')).toBe(false)
    expect(
      (parseMessage(rewritten)['result'].tools as Array<{ name: string }>).map((tool) => tool.name),
    ).toEqual(['read_file'])

    await harness.session.close()
  })
})

describe('createSession: lifecycle', () => {
  test('close() is idempotent, disposes everything, and reports "closed"', async () => {
    const harness = createSessionHarness()

    const first = harness.session.close()
    const second = harness.session.close('server-ended')
    await Promise.all([first, second])

    expect(await harness.session.ended).toBe('closed') // the first reason wins
    expect(harness.endReasons).toEqual(['closed'])
    expect(harness.clientSource.isDisposed()).toBe(true)
    expect(harness.serverSource.isDisposed()).toBe(true)
    expect(harness.clientSink.isDisposed()).toBe(true)
    expect(harness.serverSink.isDisposed()).toBe(true)
  })

  test.each([
    ['client end', (h: SessionHarness) => h.clientSource.end(), 'client-ended'],
    ['server end', (h: SessionHarness) => h.serverSource.end(), 'server-ended'],
    ['client error', (h: SessionHarness) => h.clientSource.fail(new Error('boom')), 'client-ended'],
    ['server error', (h: SessionHarness) => h.serverSource.fail(new Error('boom')), 'server-ended'],
  ])('%s ends the session with the matching reason', async (_label, trigger, expected) => {
    const harness = createSessionHarness()

    trigger(harness)

    expect(await harness.session.ended).toBe(expected)
    expect(harness.endReasons).toEqual([expected])
  })

  test('no message is relayed after the session ended', async () => {
    const harness = createSessionHarness()
    await harness.session.close()

    harness.clientSource.emit(toolCallMessage(1, 'read_file'))
    await sleep(20)

    expect(harness.serverSink.written).toEqual([])
    expect(harness.records).toEqual([])
  })
})

describe('createSession: agent scope', () => {
  test('a granted tool goes through the M2 chain; a non-granted one is denied with the agent rule', async () => {
    const store = mutableAgentStore(agentRecordOf())
    const harness = createSessionHarness({ agent: { record: agentRecordOf(), store } })

    harness.clientSource.emit(toolCallMessage(1, 'read_file'))
    await waitUntil(() => harness.serverSink.written.length === 1)

    harness.clientSource.emit(toolCallMessage(2, 'write_file'))
    await waitUntil(() => harness.clientSink.written.length === 1)

    expect(harness.serverSink.written).toHaveLength(1) // only the granted call
    const denial = parseMessage(harness.clientSink.written[0]!)
    expect(denial['error'].code).toBe(ERROR_CODE_POLICY_DENIED)
    expect(String(denial['error'].data.rule)).toContain('agent: no grant')
    const last = decisionsOf(harness.records).at(-1)
    expect(last?.decision?.rule).toBe(`agent: no grant for ${SERVER_NAME}/write_file`)

    await harness.session.close()
  })

  test('tools/list is intersected with the agent grants', async () => {
    const store = mutableAgentStore(agentRecordOf())
    const harness = createSessionHarness({ agent: { record: agentRecordOf(), store } })

    harness.clientSource.emit(messageOf('client', { jsonrpc: '2.0', id: 4, method: 'tools/list' }))
    await waitUntil(() => harness.serverSink.written.length === 1)
    harness.serverSource.emit(
      messageOf('server', {
        jsonrpc: '2.0',
        id: 4,
        result: { tools: [{ name: 'read_file' }, { name: 'write_file' }] },
      }),
    )
    await waitUntil(() => harness.clientSink.written.length === 1)

    expect(
      (parseMessage(harness.clientSink.written[0]!)['result'].tools as Array<{ name: string }>).map(
        (tool) => tool.name,
      ),
    ).toEqual(['read_file'])

    await harness.session.close()
  })
})

describe('createSession: revocation and live grant changes', () => {
  test('revoking the agent mid-session answers in-flight approvals, journals, and ends within the poll interval', async () => {
    const record = agentRecordOf({ grants: { [SERVER_NAME]: { tools: '*' } } })
    const store = mutableAgentStore(record)
    const harness = createSessionHarness({
      agent: { record, store },
      policy: policyOf({
        defaultDecision: 'require-approval',
        approval: { timeoutMs: 60_000, grantTtlMs: 60_000 },
      }),
    })

    harness.clientSource.emit(toolCallMessage(11, 'write_file'))
    await waitForPendingApproval()

    store.set(agentRecordOf({ revokedAt: '2026-08-06T00:00:00.000Z' }))

    expect(await harness.session.ended).toBe('revoked')
    expect(harness.endReasons).toEqual(['revoked'])
    // The in-flight call got the existing synthetic approval-timeout answer.
    expect(harness.clientSink.written).toHaveLength(1)
    const answer = parseMessage(harness.clientSink.written[0]!)
    expect(answer['error'].code).toBe(ERROR_CODE_APPROVAL)
    expect(answer['error'].data.reason).toBe('approval_timeout')
    // The final journal record marks the revocation.
    const last = decisionsOf(harness.records).at(-1)
    expect(last?.decision).toMatchObject({
      outcome: 'deny',
      rule: AGENT_REVOKED_RULE,
      serverName: SERVER_NAME,
      toolName: SESSION_TOOL_NAME,
    })
    expect(harness.clientSource.isDisposed()).toBe(true)
    expect(harness.serverSource.isDisposed()).toBe(true)
  })

  test('the revocation record names the matrix the agent held when it was cut off', async () => {
    // "What could this agent do at that moment" is exactly the question a
    // revocation record exists to answer, so it is the last record that may
    // have a provenance hole. The revoking poll calls `stop()` WITHOUT
    // touching the fingerprint, so the last known-good matrix -- the one the
    // agent held while it still had the session -- is intact and is what
    // gets stamped. (Review finding 3: the session built its own
    // `{ policyHash }` literal here and dropped `grantsHash` entirely.)
    const record = agentRecordOf()
    const store = mutableAgentStore(record)
    const policy = policyOf({ defaultDecision: 'allow' })
    const harness = createSessionHarness({ policy, agent: { record, store } })

    store.set(agentRecordOf({ revokedAt: '2026-08-06T00:00:00.000Z' }))
    expect(await harness.session.ended).toBe('revoked')

    const last = decisionsOf(harness.records).at(-1)
    expect(last?.decision?.rule).toBe(AGENT_REVOKED_RULE)
    expect(last?.decision?.grantsHash).toBe(grantsHashOf(record.grants))
    expect(last?.decision?.policyHash).toBe(policyHashOf(policy))
  })

  test('the session and its gate stamp one and the same policy fingerprint', async () => {
    // Two independent `policyHashOf` calls off two independently-passed
    // references agreed only because the caller happened to pass the same
    // object. One provenance object per session makes that structural.
    const record = agentRecordOf()
    const store = mutableAgentStore(record)
    const harness = createSessionHarness({ agent: { record, store } })

    harness.clientSource.emit(toolCallMessage(1, 'read_file'))
    await waitUntil(() => decisionsOf(harness.records).length > 0)
    store.set(agentRecordOf({ revokedAt: '2026-08-06T00:00:00.000Z' }))
    expect(await harness.session.ended).toBe('revoked')

    const decisions = decisionsOf(harness.records)
    const fingerprints = new Set(decisions.map((entry) => entry.decision?.policyHash))
    expect(decisions.length).toBeGreaterThan(1)
    expect(fingerprints.size).toBe(1)
  })

  test('removing the server grant entirely ends the session like a revocation', async () => {
    const record = agentRecordOf()
    const store = mutableAgentStore(record)
    const harness = createSessionHarness({ agent: { record, store } })

    store.set(agentRecordOf({ grants: {} }))

    expect(await harness.session.ended).toBe('revoked')
  })

  test('a grant edit without revocation applies from the next call, without ending the session', async () => {
    const record = agentRecordOf() // read_* granted
    const store = mutableAgentStore(record)
    const harness = createSessionHarness({ agent: { record, store } })

    harness.clientSource.emit(toolCallMessage(1, 'read_file'))
    await waitUntil(() => harness.serverSink.written.length === 1)

    // Flip the grant to write_* and wait for the watch to observe it.
    const readsBefore = store.readCount()
    store.set(agentRecordOf({ grants: { [SERVER_NAME]: { tools: ['write_*'] } } }))
    await waitUntil(() => store.readCount() >= readsBefore + 2)

    harness.clientSource.emit(toolCallMessage(2, 'read_file'))
    await waitUntil(() => harness.clientSink.written.length === 1)
    harness.clientSource.emit(toolCallMessage(3, 'write_file'))
    await waitUntil(() => harness.serverSink.written.length === 2)

    expect(parseMessage(harness.clientSink.written[0]!)['error'].data.rule).toContain('agent: no grant')
    expect(harness.endReasons).toEqual([]) // the session survived

    await harness.session.close()
  })

  test('a store read failure is reported, keeps the last scope, and does not kill the session', async () => {
    const record = agentRecordOf()
    let shouldFail = false
    const store = {
      getAgent: (): Promise<AgentRecord | undefined> =>
        shouldFail ? Promise.reject(new Error('store unavailable')) : Promise.resolve(record),
    }
    const harness = createSessionHarness({ agent: { record, store } })

    shouldFail = true
    await waitUntil(() => errors.length >= 1)

    harness.clientSource.emit(toolCallMessage(1, 'read_file'))
    await waitUntil(() => harness.serverSink.written.length === 1)
    expect(harness.endReasons).toEqual([])

    await harness.session.close()
  })

  test('a session for an already-revoked agent ends immediately, before any traffic', async () => {
    const record = agentRecordOf({ revokedAt: '2026-08-01T00:00:00.000Z' })
    const store = mutableAgentStore(record)
    const harness = createSessionHarness({ agent: { record, store } })

    expect(await harness.session.ended).toBe('revoked')
    harness.clientSource.emit(toolCallMessage(1, 'read_file'))
    await sleep(20)
    expect(harness.serverSink.written).toEqual([])
  })
})

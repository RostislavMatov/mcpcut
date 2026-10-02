import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import { createApprovalQueue, type ApprovalQueue, type PendingApproval } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
import { STATIC_POLICY_SOURCE, type PolicyProvider } from '../../src/policy/provider.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { CLIENT_CONFIRM_ID_PREFIX } from '../../src/proxy/client-confirm.js'
import { createPolicyGate, type PolicyGate } from '../../src/proxy/gate.js'
import type { GateAgentScope, GateInventory } from '../../src/proxy/gate-helpers.js'
import type { Frame } from '../../src/protocol/split.js'
import type { OrderedWriter } from '../../src/proxy/writer.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * The confirmation in the client through the real gate (ADR-0019): a rule of
 * its own beside the admin's outcome. `allow` + confirm is the person at the
 * client alone; `require-approval` + confirm is the person first, then an
 * admin; `require-approval` alone never opens a dialog.
 */

const SERVER_NAME = 'fs'
const SESSION_ID = 'session-gate-confirm'
const WAIT_MS = 10_000
const HUMAN_PACE_MS = 2_000

let tempDir: string
let sink: JournalSink
let queue: ApprovalQueue
let approvalsDir: string
let errors: unknown[]
let notices: string[]
let toClient: Record<string, unknown>[]
let now: number

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-gate-confirm-'))
  approvalsDir = join(tempDir, 'approvals')
  sink = createJournalSink(SESSION_ID, { dir: tempDir })
  queue = createApprovalQueue({ baseDir: approvalsDir })
  errors = []
  notices = []
  toClient = []
  now = Date.now()
})

afterEach(async () => {
  await sink.close()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function policyOf(server: Record<string, unknown>): Policy {
  const result = parsePolicy({
    version: 1,
    quarantine: { enabled: false },
    defaultDecision: 'allow',
    approval: { timeoutMs: WAIT_MS, grantTtlMs: 60_000 },
    servers: { [SERVER_NAME]: server },
  })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

/** A provider the test can swap under the gate, as a hot reload would. */
function swappable(initial: Policy): PolicyProvider & { set(next: Policy): void } {
  let current = initial
  return {
    current: () => current,
    maybeRefresh: () => undefined,
    refresh: () => Promise.resolve(),
    sourcePath: STATIC_POLICY_SOURCE,
    set: (next) => {
      current = next
    },
  }
}

function frameOf(message: unknown): Frame {
  return { bytes: Buffer.from(JSON.stringify(message), 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
}

function initializeWith(capabilities: Record<string, unknown>): Frame {
  return frameOf({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities, clientInfo: { name: 'claude-code', version: '2.1.287' } },
  })
}

const INITIALIZE = initializeWith({ elicitation: { form: {} } })
const WRITE_CALL = frameOf({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_file', arguments: { path: '/w/a.txt' } } })

function trustedInventory(): GateInventory {
  return {
    load: () => Promise.resolve(),
    observeToolsList: (tools) => Promise.resolve({ known: tools.map((tool) => tool.name), new: [], changed: [], failed: false }),
    stateOf: () => 'known',
    surfaceDeltaOf: () => undefined,
    descriptorOf: () => undefined,
    hasObservedCatalog: () => true,
    isCatalogTrusted: () => true,
  }
}

function agentScope(agentName: string): GateAgentScope {
  return { agentName, isGranted: () => true, filterVisible: (tools) => [...tools], grantsHash: () => 'a'.repeat(64) }
}

interface GateOptions {
  /** `false`: the gate has no channel to the client (the HTTP paths). */
  readonly confirm?: boolean
  readonly agent?: string
}

function createGate(policy: Policy | PolicyProvider, opts: GateOptions = {}): PolicyGate {
  const writer: OrderedWriter = {
    writeMessage: (chunk) => {
      toClient.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>)
      return Promise.resolve()
    },
    dispose: () => undefined,
  }
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
    clock: () => now,
    onError: (error: unknown) => errors.push(error),
    ...(opts.agent !== undefined ? { agentScope: agentScope(opts.agent) } : {}),
    ...(opts.confirm === false ? {} : { confirmInClient: { command: 'mcpcut', onNotice: (text: string) => notices.push(text) } }),
  })
}

async function waitFor<T>(find: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const found = await find()
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('waited in vain')
}

const pendingApproval = (): Promise<PendingApproval> => waitFor(async () => (await queue.list())[0])
const question = (): Promise<Record<string, unknown>> => waitFor(() => toClient.find((m) => m['method'] === 'elicitation/create'))
const questionsAsked = (): Record<string, unknown>[] => toClient.filter((m) => m['method'] === 'elicitation/create')
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

function answer(gate: PolicyGate, asked: Record<string, unknown>, action: string): Promise<unknown> {
  return Promise.resolve(gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: asked['id'], result: { action, content: {} } })))
}

async function decisions(): Promise<NonNullable<JournalRecord['decision']>[]> {
  await sink.flush()
  const records = await readJournalRecords(tempDir, SESSION_ID)
  return records.filter((record) => record.kind === 'decision').flatMap((record) => (record.decision ? [record.decision] : []))
}

function errorTo(id: number): Record<string, unknown> | undefined {
  return toClient.find((m) => m['id'] === id)?.['error'] as Record<string, unknown> | undefined
}

describe('allow + confirm: the person at the client alone', () => {
  const POLICY = policyOf({ confirmInClient: { write_file: ['*'] } })

  test('Accept forwards the call; the record names the client, and nothing waits in the queue', async () => {
    const gate = createGate(POLICY)
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const asked = await question()
    now += HUMAN_PACE_MS
    const answerVerdict = await answer(gate, asked, 'accept')

    expect(String(asked['id'])).toMatch(new RegExp(`^${CLIENT_CONFIRM_ID_PREFIX}[0-9a-f]{12}-1$`))
    expect((asked['params'] as { message: string }).message).toContain('Accept runs it now.')
    expect(answerVerdict).toEqual({ action: 'drop' })
    expect(await verdict).toEqual({ action: 'forward' })
    expect(await queue.list()).toEqual([])
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'allow', toolName: 'write_file', confirmedBy: 'client:claude-code' })])
    expect(errors).toEqual([])
  })

  test.each([
    ['decline', 'client-confirm-declined'],
    ['cancel', 'client-confirm-cancelled'],
  ])('%s refuses the call in the client\'s name', async (action, rule) => {
    const gate = createGate(POLICY)
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const asked = await question()
    now += HUMAN_PACE_MS
    await answer(gate, asked, action)

    expect(await verdict).toEqual({ action: 'drop' })
    expect(errorTo(1)).toMatchObject({ code: -32002, data: { reason: 'client_confirm_refused', toolName: 'write_file' } })
    expect(await decisions()).toEqual([
      expect.objectContaining({ outcome: 'denied-by-operator', rule, actor: 'client:claude-code' }),
    ])
  })

  test('an Accept too fast twice is refused, and the operator is told why', async () => {
    const gate = createGate(POLICY)
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    await answer(gate, await question(), 'accept')
    const second = await waitFor(() => questionsAsked()[1])
    await answer(gate, second, 'accept')

    expect(await verdict).toEqual({ action: 'drop' })
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'deny', rule: 'client-confirm-too-fast' })])
    expect(notices.join('')).toContain('too fast')
  })

  test('no answer within the wait: a timeout, the dialog closed', async () => {
    const policy = parsePolicy({
      version: 1,
      quarantine: { enabled: false },
      defaultDecision: 'allow',
      approval: { timeoutMs: 50 },
      servers: { [SERVER_NAME]: { confirmInClient: { write_file: ['*'] } } },
    })
    if (!policy.ok) throw new Error('invalid')
    const gate = createGate(policy.policy)
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const asked = await question()

    expect(await verdict).toEqual({ action: 'drop' })
    expect(toClient).toContainEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: asked['id'], reason: expect.any(String) } })
    expect(errorTo(1)).toMatchObject({ data: { reason: 'client_confirm_timeout' } })
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'timeout', rule: 'client-confirm-timeout' })])
  })

  test('a tool without the rule passes without a dialog', async () => {
    const gate = createGate(POLICY)
    await gate.gateClientMessage(INITIALIZE)

    const verdict = await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: {} } }))

    expect(verdict).toEqual({ action: 'forward' })
    expect(questionsAsked()).toEqual([])
  })
})

describe('require-approval + confirm: the person first, then an admin', () => {
  const POLICY = policyOf({ tools: { write_file: 'require-approval' }, confirmInClient: { write_file: ['*'] } })

  test('Accept queues the call for an admin; the admin\'s approval forwards it, and both are on the record', async () => {
    const gate = createGate(POLICY)
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const asked = await question()
    expect(await queue.list()).toEqual([])
    expect((asked['params'] as { message: string }).message).toContain('Accept passes it on to an admin')
    now += HUMAN_PACE_MS
    await answer(gate, asked, 'accept')
    const pending = await pendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'ui:alice' })

    expect(await verdict).toEqual({ action: 'forward' })
    expect(await decisions()).toEqual([
      expect.objectContaining({ outcome: 'require-approval-pending', confirmedBy: 'client:claude-code' }),
      expect.objectContaining({ outcome: 'approved', actor: 'ui:alice', confirmedBy: 'client:claude-code' }),
    ])
  })

  test('Decline refuses it at once: no admin is bothered', async () => {
    const gate = createGate(POLICY)
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    await answer(gate, await question(), 'decline')

    expect(await verdict).toEqual({ action: 'drop' })
    expect(await queue.list()).toEqual([])
    expect(await queue.listResolved({ limit: 5 })).toEqual([])
  })

  test('an admin\'s denial after the Accept is the admin\'s', async () => {
    const gate = createGate(POLICY)
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const asked = await question()
    now += HUMAN_PACE_MS
    await answer(gate, asked, 'accept')
    await queue.resolve((await pendingApproval()).approvalId, { outcome: 'denied', actor: 'ui:alice' })

    expect(await verdict).toEqual({ action: 'drop' })
    expect((await decisions()).at(-1)).toMatchObject({ outcome: 'denied-by-operator', actor: 'ui:alice', confirmedBy: 'client:claude-code' })
  })
})

describe('require-approval alone never opens a dialog', () => {
  test('the call waits for an admin, as in 0.2.4', async () => {
    const gate = createGate(policyOf({ tools: { write_file: 'require-approval' } }))
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const pending = await pendingApproval()
    await settle()
    expect(questionsAsked()).toEqual([])
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'cli' })

    expect(await verdict).toEqual({ action: 'forward' })
  })
})

describe('deny wins', () => {
  test('a denied tool is denied, never asked', async () => {
    const gate = createGate(policyOf({ tools: { write_file: 'deny' }, confirmInClient: { write_file: ['*'] } }))
    await gate.gateClientMessage(INITIALIZE)

    expect(await gate.gateClientMessage(WRITE_CALL)).toEqual({ action: 'drop' })
    expect(questionsAsked()).toEqual([])
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'deny' })])
  })

  test('a rule turned to deny while the dialog was open: the Accept does not run it', async () => {
    const provider = swappable(policyOf({ confirmInClient: { write_file: ['*'] } }))
    const gate = createGate(provider)
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const asked = await question()
    provider.set(policyOf({ tools: { write_file: 'deny' }, confirmInClient: { write_file: ['*'] } }))
    now += HUMAN_PACE_MS
    await answer(gate, asked, 'accept')

    expect(await verdict).toEqual({ action: 'drop' })
    expect((await decisions()).at(-1)).toMatchObject({ outcome: 'deny' })
  })
})

describe('whose clients confirm', () => {
  const POLICY = policyOf({ confirmInClient: { write_file: ['laptop'] } })

  test('a listed agent is asked', async () => {
    const gate = createGate(POLICY, { agent: 'laptop' })
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const asked = await question()
    now += HUMAN_PACE_MS
    await answer(gate, asked, 'accept')

    expect(await verdict).toEqual({ action: 'forward' })
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'allow', agentName: 'laptop', confirmedBy: 'client:claude-code' })])
  })

  test('an agent not on the list gets the admin\'s rule alone: here allow, no dialog', async () => {
    const gate = createGate(POLICY, { agent: 'ci-bot' })
    await gate.gateClientMessage(INITIALIZE)

    expect(await gate.gateClientMessage(WRITE_CALL)).toEqual({ action: 'forward' })
    expect(questionsAsked()).toEqual([])
  })

  test('the local wrap path (no agent) is covered only by "*"', async () => {
    const gate = createGate(POLICY)
    await gate.gateClientMessage(INITIALIZE)

    expect(await gate.gateClientMessage(WRITE_CALL)).toEqual({ action: 'forward' })
    expect(questionsAsked()).toEqual([])
  })
})

describe('a confirmation nobody can give is a refusal', () => {
  const POLICY = policyOf({ confirmInClient: { write_file: ['*'] } })

  test('a client that cannot show a form: refused with what to do, nothing queued', async () => {
    const gate = createGate(POLICY)
    await gate.gateClientMessage(initializeWith({}))

    expect(await gate.gateClientMessage(WRITE_CALL)).toEqual({ action: 'drop' })
    expect(errorTo(1)).toMatchObject({ data: { reason: 'client_confirm_unavailable' } })
    expect(String(errorTo(1)?.['message'])).toContain('cannot show')
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'deny', rule: 'client-confirm-unavailable' })])
    expect(notices.join('')).toContain('confirmInClient')
    expect(await queue.list()).toEqual([])
  })

  test('a client that answers the dialog with an error: refused, and the operator is told', async () => {
    const gate = createGate(POLICY)
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const asked = await question()
    await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: asked['id'], error: { code: -32603, message: 'dialog failed' } }))

    expect(await verdict).toEqual({ action: 'drop' })
    expect(errorTo(1)).toMatchObject({ data: { reason: 'client_confirm_unavailable' } })
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'deny', rule: 'client-confirm-failed' })])
    expect(notices.join('')).toContain('cannot show the dialog')
  })

  test('a gate with no channel to the client (the HTTP paths): refused, and responses still forward', async () => {
    const gate = createGate(POLICY, { confirm: false })
    await gate.gateClientMessage(INITIALIZE)

    expect(await gate.gateClientMessage(WRITE_CALL)).toEqual({ action: 'drop' })
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'deny', rule: 'client-confirm-unavailable' })])
    const response = await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: `${CLIENT_CONFIRM_ID_PREFIX}X`, result: { action: 'accept' } }))
    expect(response).toEqual({ action: 'forward' })
  })

  test('an id-less call has no return address: refused without a dialog', async () => {
    const gate = createGate(POLICY)
    await gate.gateClientMessage(INITIALIZE)

    const verdict = await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'write_file', arguments: {} } }))

    expect(verdict).toEqual({ action: 'drop' })
    expect(questionsAsked()).toEqual([])
  })
})

describe('the session ends while a dialog is open', () => {
  test('the call is refused, the dialog closed, and teardown does not hang', async () => {
    const gate = createGate(policyOf({ confirmInClient: { write_file: ['*'] } }))
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    await question()
    await gate.cancelPending()

    expect(await verdict).toEqual({ action: 'drop' })
    expect(toClient.some((m) => m['method'] === 'notifications/cancelled')).toBe(true)
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'deny', rule: 'client-confirm-session-ended' })])
  })
})

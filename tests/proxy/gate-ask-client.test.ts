import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import { createApprovalQueue, type ApprovalQueue, type PendingApproval } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { CLIENT_APPROVAL_ID_PREFIX } from '../../src/proxy/client-approval.js'
import { createPolicyGate, type PolicyGate } from '../../src/proxy/gate.js'
import type { GateInventory } from '../../src/proxy/gate-helpers.js'
import type { AskClientDeps } from '../../src/proxy/gate-types.js'
import type { Frame } from '../../src/protocol/split.js'
import type { OrderedWriter } from '../../src/proxy/writer.js'

/**
 * P2 through the real gate: a held call is asked in a client that can show
 * a form, and the client's answer settles it through the queue — with the
 * client named as the one who decided.
 */

const SERVER_NAME = 'fs'
const SESSION_ID = 'session-gate-ask-client'
const WAIT_MS = 10_000
const HUMAN_PACE_MS = 2_000

let tempDir: string
let sink: JournalSink
let queue: ApprovalQueue
let approvalsDir: string
let errors: unknown[]
let toClient: Record<string, unknown>[]
let now: number

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-gate-ask-client-'))
  approvalsDir = join(tempDir, 'approvals')
  sink = createJournalSink(SESSION_ID, { dir: tempDir })
  queue = createApprovalQueue({ baseDir: approvalsDir })
  errors = []
  toClient = []
  now = Date.now()
})

afterEach(async () => {
  await sink.close()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const POLICY: Policy = (() => {
  const result = parsePolicy({
    version: 1,
    quarantine: { enabled: false },
    defaultDecision: 'allow',
    approval: { timeoutMs: WAIT_MS, grantTtlMs: 60_000 },
    servers: { [SERVER_NAME]: { tools: { write_file: 'require-approval' } } },
  })
  if (!result.ok) throw new Error('test policy is invalid')
  return result.policy
})()

function frameOf(message: unknown): Frame {
  return { bytes: Buffer.from(JSON.stringify(message), 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
}

const INITIALIZE = frameOf({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'claude-code', version: '2.1.287' } },
})

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

/** `null`: the gate is not given the asker at all (the HTTP paths). */
function createGate(askClient: Partial<AskClientDeps> | null = {}): PolicyGate {
  const writer: OrderedWriter = {
    writeMessage: (chunk) => {
      toClient.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>)
      return Promise.resolve()
    },
    dispose: () => undefined,
  }
  return createPolicyGate({
    policy: POLICY,
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
    ...(askClient === null ? {} : { askClient: { resolve: (question, resolution) => queue.resolve(question.approvalId, resolution), ...askClient } }),
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

describe('a held call in a client that can show a form', () => {
  test('is asked under mcpcut\'s own id; Accept forwards it and names the client', async () => {
    const gate = createGate()
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const pending = await pendingApproval()
    const asked = await question()
    now += HUMAN_PACE_MS
    const answerVerdict = await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: asked['id'], result: { action: 'accept', content: {} } }))

    expect(String(asked['id'])).toMatch(new RegExp(`^${CLIENT_APPROVAL_ID_PREFIX}[0-9a-f]{12}-${pending.approvalId}$`))
    expect(answerVerdict).toEqual({ action: 'drop' })
    expect(await verdict).toEqual({ action: 'forward' })
    const [resolved] = await queue.listResolved({ limit: 1 })
    expect(resolved?.approvalId).toBe(pending.approvalId)
    expect(resolved?.resolution).toMatchObject({ outcome: 'approved', actor: 'client:claude-code' })
    expect(errors).toEqual([])
  })

  test('Decline answers the agent with the denial and names the client', async () => {
    const gate = createGate()
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const asked = await question()
    await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: asked['id'], result: { action: 'decline' } }))

    expect(await verdict).toEqual({ action: 'drop' })
    const denial = toClient.find((m) => m['id'] === 1)
    expect(denial?.['error']).toMatchObject({ code: -32002 })
    const [resolved] = await queue.listResolved({ limit: 1 })
    expect(resolved?.resolution).toMatchObject({ outcome: 'denied', actor: 'client:claude-code' })
  })

  test('settled from the terminal instead: the dialog is withdrawn', async () => {
    const gate = createGate()
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const pending = await pendingApproval()
    const asked = await question()
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'cli:test' })

    expect(await verdict).toEqual({ action: 'forward' })
    expect(toClient).toContainEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: asked['id'], reason: expect.any(String) } })
  })

  test('Esc leaves it to the queue', async () => {
    const gate = createGate()
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const pending = await pendingApproval()
    const asked = await question()
    now += HUMAN_PACE_MS
    await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: asked['id'], result: { action: 'cancel' } }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(await queue.list()).toHaveLength(1)
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'cli:test' })
    expect(await verdict).toEqual({ action: 'forward' })
  })
})

describe('nobody is asked', () => {
  test('when the client cannot show a form', async () => {
    const gate = createGate()
    await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: {} } }))

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const pending = await pendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'cli:test' })

    expect(await verdict).toEqual({ action: 'forward' })
    expect(toClient.filter((m) => m['method'] === 'elicitation/create')).toEqual([])
  })

  test('when the installation says a person at the client may not approve (admins exist)', async () => {
    const gate = createGate({ mayAsk: () => Promise.resolve(false) })
    await gate.gateClientMessage(INITIALIZE)

    const verdict = gate.gateClientMessage(WRITE_CALL)
    const pending = await pendingApproval()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'cli:test' })

    expect(await verdict).toEqual({ action: 'forward' })
    expect(toClient.filter((m) => m['method'] === 'elicitation/create')).toEqual([])
  })

  test('when the gate is not given the asker at all (the HTTP paths): responses still forward', async () => {
    const gate = createGate(null)
    await gate.gateClientMessage(INITIALIZE)

    const answer = await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: `${CLIENT_APPROVAL_ID_PREFIX}X`, result: { action: 'accept' } }))

    expect(answer).toEqual({ action: 'forward' })
  })
})

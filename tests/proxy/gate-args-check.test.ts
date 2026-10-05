import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import { createApprovalQueue, type ApprovalQueue } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import type { Frame } from '../../src/protocol/split.js'
import { createPolicyGate, type PolicyGate } from '../../src/proxy/gate.js'
import type { ArgsCheck } from '../../src/proxy/gate-args-check.js'
import type { GateInventory } from '../../src/proxy/gate-helpers.js'
import type { OrderedWriter } from '../../src/proxy/writer.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * `argsCheck` (ADR-0020 §2): an injected, tighten-only step run after `decide()`.
 * It may turn allow or require-approval into deny; it can never loosen, and a
 * session without it behaves exactly as before.
 */

const SERVER_NAME = 'files'
const SESSION_ID = 'session-gate-args-check'
const RULE = 'files: no right delete on /w/a.txt'

let tempDir: string
let sink: JournalSink
let queue: ApprovalQueue
let toClient: Record<string, unknown>[]
let errors: unknown[]

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-gate-args-'))
  sink = createJournalSink(SESSION_ID, { dir: tempDir })
  queue = createApprovalQueue({ baseDir: join(tempDir, 'approvals') })
  toClient = []
  errors = []
})

afterEach(async () => {
  await sink.close()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function policyOf(server: Record<string, unknown> | undefined, defaultDecision: 'allow' | 'deny' = 'allow'): Policy {
  const result = parsePolicy({
    version: 1,
    quarantine: { enabled: false },
    defaultDecision,
    approval: { timeoutMs: 10_000, grantTtlMs: 60_000 },
    ...(server !== undefined ? { servers: { [SERVER_NAME]: server } } : {}),
  })
  if (!result.ok) throw new Error('test policy is invalid')
  return result.policy
}

function frameOf(message: unknown): Frame {
  return { bytes: Buffer.from(JSON.stringify(message), 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
}

const call = (id: number, name: string, args: unknown = { path: '/w/a.txt' }): Frame =>
  frameOf({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

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

function createGate(policy: Policy, argsCheck?: ArgsCheck): PolicyGate {
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
    approvalsBaseDir: join(tempDir, 'approvals'),
    onError: (error: unknown) => errors.push(error),
    ...(argsCheck !== undefined ? { argsCheck } : {}),
  })
}

async function decisions(): Promise<NonNullable<JournalRecord['decision']>[]> {
  await sink.flush()
  const records = await readJournalRecords(tempDir, SESSION_ID)
  return records.filter((record) => record.kind === 'decision').flatMap((record) => (record.decision ? [record.decision] : []))
}

const CLIENT_MESSAGE = 'No right to delete /w/a.txt: your rights there are read. Call list_roots to see your folders.'
const refuse = (rule = RULE): ArgsCheck => async () => ({ rule, reason: 'no right to delete /w/a.txt', clientMessage: CLIENT_MESSAGE })
const accept: ArgsCheck = async () => null

describe('argsCheck: refusal becomes a deny with its rule string', () => {
  test('writes the deny decision with the files rule and answers the client without forwarding', async () => {
    const gate = createGate(policyOf(undefined), refuse())

    const verdict = await gate.gateClientMessage(call(1, 'delete_file'))

    expect(verdict).toEqual({ action: 'drop' })
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'deny', rule: RULE, toolName: 'delete_file', serverName: SERVER_NAME })])
    expect(toClient[0]).toMatchObject({ id: 1, error: { data: { rule: RULE } } })
    expect(errors).toEqual([])
  })

  test('the client is told what the check found, not the generic policy line', async () => {
    const gate = createGate(policyOf(undefined), refuse())

    await gate.gateClientMessage(call(1, 'delete_file'))

    const error = toClient[0]?.['error'] as Record<string, unknown>
    expect(error['message']).toBe(`Call to tool "delete_file" was refused: ${CLIENT_MESSAGE}`)
    expect(error['message']).not.toContain('change the policy')
  })

  test('hands the parsed call (tool name and arguments) to the check', async () => {
    const seen: Array<{ toolName: string; args: unknown }> = []
    const gate = createGate(policyOf(undefined), async (parsed) => {
      seen.push({ toolName: parsed.toolName, args: parsed.args })
      return null
    })

    await gate.gateClientMessage(call(1, 'read_file', { path: '/w/x' }))

    expect(seen).toEqual([{ toolName: 'read_file', args: { path: '/w/x' } }])
  })

  test('a refusal on a require-approval call denies it and queues nothing', async () => {
    const gate = createGate(policyOf({ tools: { delete_file: 'require-approval' } }), refuse())

    const verdict = await gate.gateClientMessage(call(1, 'delete_file'))

    expect(verdict).toEqual({ action: 'drop' })
    expect(await queue.list()).toEqual([])
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'deny', rule: RULE })])
  })
})

describe('argsCheck: the allow path is unchanged', () => {
  test('without a check an allowed call is forwarded and the check is never needed', async () => {
    const gate = createGate(policyOf(undefined))
    expect(await gate.gateClientMessage(call(1, 'read_file'))).toEqual({ action: 'forward' })
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'allow', toolName: 'read_file' })])
  })

  test('a check that finds nothing wrong leaves the call forwarded and records an allow', async () => {
    const gate = createGate(policyOf(undefined), accept)
    expect(await gate.gateClientMessage(call(1, 'read_file'))).toEqual({ action: 'forward' })
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'allow', toolName: 'read_file' })])
  })

  test('a check that finds nothing wrong leaves a require-approval call in the approval queue', async () => {
    const gate = createGate(policyOf({ tools: { delete_file: 'require-approval' } }), accept)

    void gate.gateClientMessage(call(1, 'delete_file'))
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect((await queue.list()).map((entry) => entry.toolName)).toEqual(['delete_file'])
  })
})

describe('argsCheck: never loosens', () => {
  test('a policy deny stays the policy deny and the check is not even consulted', async () => {
    let consulted = 0
    const gate = createGate(policyOf({ tools: { delete_file: 'deny' } }), async () => {
      consulted += 1
      return null
    })

    const verdict = await gate.gateClientMessage(call(1, 'delete_file'))

    expect(verdict).toEqual({ action: 'drop' })
    expect(consulted).toBe(0)
    const [record] = await decisions()
    expect(record).toMatchObject({ outcome: 'deny' })
    expect(record?.rule).not.toBe(RULE)
    expect((toClient[0]?.['error'] as Record<string, unknown>)['message']).toContain('A human operator can change the policy')
  })

  test('a default deny with a check that accepts is still a deny', async () => {
    const gate = createGate(policyOf(undefined, 'deny'), accept)
    expect(await gate.gateClientMessage(call(1, 'read_file'))).toEqual({ action: 'drop' })
  })
})

describe('argsCheck: confirmation in the client', () => {
  test('a refused call is denied before any dialog opens', async () => {
    const policy = policyOf({ confirmInClient: { delete_file: ['*'] } })
    const gate = createGate(policy, refuse())
    await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'c', version: '1' } } }))

    const verdict = await gate.gateClientMessage(call(1, 'delete_file'))

    expect(verdict).toEqual({ action: 'drop' })
    expect(toClient.filter((message) => message['method'] === 'elicitation/create')).toEqual([])
    expect(await decisions()).toEqual([expect.objectContaining({ outcome: 'deny', rule: RULE })])
  })
})

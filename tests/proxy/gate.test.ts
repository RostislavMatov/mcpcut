import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createApprovalQueue, type ApprovalQueue, type PendingApproval } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
import { createInventory, type Inventory } from '../../src/policy/inventory.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { createPolicyGate, type PolicyGate } from '../../src/proxy/gate.js'
import { createBoundedIdSet } from '../../src/proxy/gate-helpers.js'
import {
  ERROR_CODE_APPROVAL,
  ERROR_CODE_POLICY_DENIED,
  ERROR_CODE_QUARANTINED,
} from '../../src/proxy/synthesize.js'
import type { Verdict } from '../../src/proxy/pipeline.js'
import type { Frame } from '../../src/protocol/split.js'
import type { OrderedWriter } from '../../src/proxy/writer.js'

const SERVER_NAME = 'testsrv'
const SESSION_ID = 'session-gate-1'
const POLL_INTERVAL_MS = 5

let tempDir: string
let sink: JournalSink
let queue: ApprovalQueue
let inventory: Inventory
let approvalsDir: string
let errors: unknown[]

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-gate-test-'))
  approvalsDir = join(tempDir, 'approvals')
  sink = createJournalSink(SESSION_ID, { dir: tempDir })
  queue = createApprovalQueue({ baseDir: approvalsDir })
  inventory = createInventory(SERVER_NAME, { storePath: join(tempDir, 'tool-inventory.json') })
  errors = []
})

afterEach(async () => {
  await sink.close()
  await rm(tempDir, { recursive: true, force: true })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Builds a `Policy` through the real schema so defaults match production. */
function policyOf(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({ version: 1, ...overrides })
  if (!result.ok) {
    throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  }
  return result.policy
}

function frameOf(message: unknown): Frame {
  const text = typeof message === 'string' ? message : JSON.stringify(message)
  return { bytes: Buffer.from(text, 'utf8'), terminator: '\n', isBlank: false }
}

function toolCall(id: unknown, name: string, args: unknown = { path: '/tmp/x' }): Frame {
  return frameOf({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
}

/** A minimal `OrderedWriter` that records every message it was handed. */
function createRecordingWriter(): { writer: OrderedWriter; written: Buffer[] } {
  const written: Buffer[] = []
  return {
    writer: {
      writeMessage: (bytes: Buffer) => {
        written.push(bytes)
        return Promise.resolve()
      },
      dispose: () => undefined,
    },
    written,
  }
}

interface GateHarness {
  readonly gate: PolicyGate
  readonly written: Buffer[]
  readonly clientWriter: OrderedWriter
}

interface HarnessOptions {
  readonly policy?: Policy
  readonly inventory?: Inventory
  readonly timeoutMs?: number
}

function createHarness(opts: HarnessOptions = {}): GateHarness {
  const { writer, written } = createRecordingWriter()
  const gate = createPolicyGate({
    policy: opts.policy ?? policyOf({ defaultDecision: 'allow', quarantine: { enabled: false } }),
    serverName: SERVER_NAME,
    sessionId: SESSION_ID,
    inventory: opts.inventory ?? inventory,
    approvalQueue: queue,
    approvalWaiter: createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS }),
    grantRegistry: createGrantRegistry(),
    sink,
    clientWriter: writer,
    approvalsBaseDir: approvalsDir,
    onError: (error) => errors.push(error),
  })
  return { gate, written, clientWriter: writer }
}

/** All decision records currently on disk for this session. */
function readDecisionsSync(): JournalRecord[] {
  let text: string
  try {
    text = readFileSync(join(tempDir, `${SESSION_ID}.jsonl`), 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JournalRecord)
    .filter((record) => record.kind === 'decision')
}

async function readDecisions(): Promise<JournalRecord[]> {
  await sink.flush()
  return readDecisionsSync()
}

function parseWritten(bytes: Buffer): Record<string, any> {
  return JSON.parse(bytes.toString('utf8')) as Record<string, any>
}

async function waitForApproval(accept: (entry: PendingApproval) => boolean): Promise<PendingApproval> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const match = (await queue.list()).find(accept)
    if (match !== undefined) return match
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('no matching approval was enqueued')
}

function waitForPendingApproval(): Promise<PendingApproval> {
  return waitForApproval(() => true)
}

function waitForOtherPendingApproval(knownId: string): Promise<PendingApproval> {
  return waitForApproval((entry) => entry.approvalId !== knownId)
}

const DENY_EVERYTHING = {
  defaultDecision: 'deny',
  quarantine: { enabled: false },
} as const

describe('createPolicyGate: traffic that is never gated', () => {
  test.each([
    ['a non-tools/call request', { jsonrpc: '2.0', id: 1, method: 'resources/read', params: {} }],
    ['a notification', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }],
    ['a tools/call notification (no id at all)', { jsonrpc: '2.0', method: 'tools/call', params: { name: 'delete_repo' } }],
    ['a response', { jsonrpc: '2.0', id: 1, result: { ok: true } }],
  ])('%s is forwarded even under a deny-everything policy', async (_label, message) => {
    const { gate, written } = createHarness({ policy: policyOf(DENY_EVERYTHING) })

    const verdict = await gate.gateClientMessage(frameOf(message))

    expect(verdict).toEqual({ action: 'forward' })
    expect(written).toEqual([])
    expect(await readDecisions()).toEqual([])
  })

  test('invalid junk is forwarded and never journaled as a decision', async () => {
    const { gate, written } = createHarness({ policy: policyOf(DENY_EVERYTHING) })

    const verdict = await gate.gateClientMessage(frameOf('} not json at all {'))

    expect(verdict).toEqual({ action: 'forward' })
    expect(written).toEqual([])
    expect(await readDecisions()).toEqual([])
  })

  test('a malformed tools/call (no params.name) is forwarded for the server to reject', async () => {
    const { gate, written } = createHarness({ policy: policyOf(DENY_EVERYTHING) })

    const verdict = await gate.gateClientMessage(
      frameOf({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }),
    )

    expect(verdict).toEqual({ action: 'forward' })
    expect(written).toEqual([])
    expect(await readDecisions()).toEqual([])
  })
})

describe('createPolicyGate: deny', () => {
  test.each([
    ['a numeric id of 0', 0],
    ['a string id', 'req-abc'],
  ])('drops the call and answers the client exactly once with %s', async (_label, id) => {
    const { gate, written } = createHarness({
      policy: policyOf({
        defaultDecision: 'allow',
        quarantine: { enabled: false },
        servers: { [SERVER_NAME]: { tools: { 'delete_*': 'deny' } } },
      }),
    })

    const verdict = await gate.gateClientMessage(toolCall(id, 'delete_repo'))

    expect(verdict).toEqual({ action: 'drop' })
    expect(written).toHaveLength(1)
    const answer = parseWritten(written[0]!)
    expect(answer.id).toBe(id)
    expect(answer.error.code).toBe(ERROR_CODE_POLICY_DENIED)
    expect(answer.error.data.toolName).toBe('delete_repo')
  })

  test('journals one decision record carrying the firing rule', async () => {
    const { gate } = createHarness({
      policy: policyOf({
        defaultDecision: 'allow',
        quarantine: { enabled: false },
        servers: { [SERVER_NAME]: { tools: { 'delete_*': 'deny' } } },
      }),
    })

    await gate.gateClientMessage(toolCall(1, 'delete_repo'))

    const decisions = await readDecisions()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.decision).toMatchObject({
      outcome: 'deny',
      rule: `servers.${SERVER_NAME}.tools.delete_*`,
      serverName: SERVER_NAME,
      toolName: 'delete_repo',
      toolClass: 'destructive',
    })
  })

  test('a spec-violating tools/call with id null is dropped, journaled, and never answered', async () => {
    const { gate, written } = createHarness({ policy: policyOf(DENY_EVERYTHING) })

    const verdict = await gate.gateClientMessage(toolCall(null, 'write_file'))

    expect(verdict).toEqual({ action: 'drop' })
    expect(written).toEqual([])
    const decisions = await readDecisions()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.decision?.outcome).toBe('deny')
  })

  test('a quarantined tool is answered with the quarantine error, not the generic denial', async () => {
    await inventory.observeToolsList([{ name: 'write_file', description: 'writes' }])
    const { gate, written } = createHarness({
      policy: policyOf({
        defaultDecision: 'allow',
        quarantine: { enabled: true, onQuarantined: 'deny' },
      }),
    })

    const verdict = await gate.gateClientMessage(toolCall(9, 'write_file'))

    expect(verdict).toEqual({ action: 'drop' })
    const answer = parseWritten(written[0]!)
    expect(answer.error.code).toBe(ERROR_CODE_QUARANTINED)
    expect(answer.error.message).toContain('quarantine approve')
    const decisions = await readDecisions()
    expect(decisions[0]!.decision).toMatchObject({ outcome: 'quarantined', rule: 'quarantine' })
  })
})

describe('createPolicyGate: allow', () => {
  test('forwards the call synchronously and journals an allow decision', async () => {
    const { gate, written } = createHarness()

    const verdict = gate.gateClientMessage(toolCall(1, 'read_file'))

    // Order-preserving fast path: an allowed call must not become async.
    expect(verdict).toEqual({ action: 'forward' })
    expect(written).toEqual([])
    const decisions = await readDecisions()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.decision).toMatchObject({ outcome: 'allow', toolName: 'read_file' })
  })

  test('records the argument hash and redacted arguments on the decision record', async () => {
    const { gate } = createHarness()

    await gate.gateClientMessage(toolCall(1, 'read_file', { token: 'sk-live-abcdefghijklmnop' }))

    const decisions = await readDecisions()
    expect(decisions[0]!.decision?.argsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(decisions[0]!.payload)).not.toContain('sk-live-abcdefghijklmnop')
  })
})

describe('createPolicyGate: require-approval', () => {
  const APPROVAL_POLICY = {
    defaultDecision: 'require-approval',
    quarantine: { enabled: false },
    approval: { timeoutMs: 10_000, grantTtlMs: 60_000 },
  } as const

  test('an approved call is forwarded, journaled with latency, and leaves a reusable grant', async () => {
    const { gate, written } = createHarness({ policy: policyOf(APPROVAL_POLICY) })

    const verdictPromise = gate.gateClientMessage(toolCall(1, 'write_file'))
    const pending = await waitForPendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'operator' })

    expect(await verdictPromise).toEqual({ action: 'forward' })
    expect(written).toEqual([])

    const decisions = await readDecisions()
    expect(decisions.map((record) => record.decision?.outcome)).toEqual([
      'require-approval-pending',
      'approved',
    ])
    expect(decisions[0]!.decision?.approvalId).toBe(pending.approvalId)
    expect(decisions[1]!.decision?.latencyMs).toBeGreaterThanOrEqual(0)

    // The in-memory grant makes the identical retry a synchronous allow.
    const retry = gate.gateClientMessage(toolCall(2, 'write_file'))
    expect(retry).toEqual({ action: 'forward' })
    expect((await readDecisions())[2]!.decision).toMatchObject({ outcome: 'allow', rule: 'grant' })
  })

  test('an operator denial answers the client and drops the call', async () => {
    const { gate, written } = createHarness({ policy: policyOf(APPROVAL_POLICY) })

    const verdictPromise = gate.gateClientMessage(toolCall('call-7', 'write_file'))
    const pending = await waitForPendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'denied', actor: 'operator' })

    expect(await verdictPromise).toEqual({ action: 'drop' })
    expect(written).toHaveLength(1)
    const answer = parseWritten(written[0]!)
    expect(answer.id).toBe('call-7')
    expect(answer.error.code).toBe(ERROR_CODE_APPROVAL)
    expect(answer.error.data.reason).toBe('approval_denied')

    const decisions = await readDecisions()
    expect(decisions[1]!.decision?.outcome).toBe('denied-by-operator')
  })

  test('a timeout answers with an actionable error and a late approval cannot flip the verdict', async () => {
    const { gate, written } = createHarness({
      policy: policyOf({ ...APPROVAL_POLICY, approval: { timeoutMs: 30, grantTtlMs: 60_000 } }),
    })

    const verdictPromise = gate.gateClientMessage(toolCall(3, 'write_file'))
    const pending = await waitForPendingApproval()

    expect(await verdictPromise).toEqual({ action: 'drop' })
    const answer = parseWritten(written[0]!)
    expect(answer.id).toBe(3)
    expect(answer.error.message).toContain(`approvals approve ${pending.approvalId}`)
    expect((await readDecisions())[1]!.decision?.outcome).toBe('timeout')

    // Approving after the fact must not resurrect the already-answered call.
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'operator' })
    await sleep(POLL_INTERVAL_MS * 4)
    expect(await verdictPromise).toEqual({ action: 'drop' })
    expect(written).toHaveLength(1)
  })

  test('a retry after a late approval is allowed by the on-disk grant, without a second prompt', async () => {
    const { gate, written } = createHarness({
      policy: policyOf({ ...APPROVAL_POLICY, approval: { timeoutMs: 30, grantTtlMs: 60_000 } }),
    })

    await gate.gateClientMessage(toolCall(3, 'write_file'))
    const pending = await waitForPendingApproval()
    await queue.resolve(pending.approvalId, { outcome: 'approved', actor: 'operator' })

    const retry = await gate.gateClientMessage(toolCall(4, 'write_file'))

    expect(retry).toEqual({ action: 'forward' })
    expect(await queue.list()).toEqual([]) // no second approval was enqueued
    expect(written).toHaveLength(1) // only the original timeout error
    const last = (await readDecisions()).at(-1)
    expect(last?.decision).toMatchObject({ outcome: 'allow', rule: 'grant' })
  })

  test('an approval that lands on an id already answered locally is dropped, never forwarded', async () => {
    // 300ms (not 30) so attempt 2's resolve reliably beats the deadline under load;
    // attempt 1 still times out because nothing ever resolves it.
    const { gate, written } = createHarness({
      policy: policyOf({ ...APPROVAL_POLICY, approval: { timeoutMs: 300, grantTtlMs: 60_000 } }),
    })

    // Attempt 1 times out, so id 5 is answered locally.
    await gate.gateClientMessage(toolCall(5, 'write_file', { a: 1 }))
    const first = await waitForPendingApproval()
    expect(written).toHaveLength(1)

    // Attempt 2 reuses id 5 with different args (no grant applies) and is approved.
    const verdictPromise = gate.gateClientMessage(toolCall(5, 'write_file', { a: 2 }))
    const second = await waitForOtherPendingApproval(first.approvalId)
    await queue.resolve(second.approvalId, { outcome: 'approved', actor: 'operator' })

    expect(await verdictPromise).toEqual({ action: 'drop' })
    expect(written).toHaveLength(1)
    expect((await readDecisions()).at(-1)?.decision?.rule).toBe('already-answered-locally')
  })

  test('cancelPending settles an in-flight approval as a timeout and answers the client', async () => {
    const { gate, written } = createHarness({
      policy: policyOf({ ...APPROVAL_POLICY, approval: { timeoutMs: 60_000, grantTtlMs: 60_000 } }),
    })

    const verdictPromise = gate.gateClientMessage(toolCall(11, 'write_file'))
    await waitForPendingApproval()

    await gate.cancelPending()

    expect(await verdictPromise).toEqual({ action: 'drop' })
    expect(written).toHaveLength(1)
    expect(parseWritten(written[0]!).error.data.reason).toBe('approval_timeout')
  })
})

describe('createPolicyGate: tools/list', () => {
  const CATALOG = [
    { name: 'read_file', description: 'reads', annotations: { readOnlyHint: true }, 'x-vendor': 'keep-me' },
    { name: 'delete_repo', description: 'deletes' },
  ]

  function toolsListResponse(id: unknown): Frame {
    return frameOf({
      jsonrpc: '2.0',
      id,
      result: { tools: CATALOG, nextCursor: 'cursor-2', _meta: { vendor: 1 } },
    })
  }

  const HIDE_DENIED_POLICY = {
    defaultDecision: 'allow',
    quarantine: { enabled: false },
    servers: { [SERVER_NAME]: { tools: { 'delete_*': 'deny' } } },
  } as const

  test('observes the catalog and rewrites the response without denied tools', async () => {
    const { gate } = createHarness({ policy: policyOf(HIDE_DENIED_POLICY) })

    expect(await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 77, method: 'tools/list' }))).toEqual({
      action: 'forward',
    })
    const verdict = (await gate.gateServerMessage(toolsListResponse(77))) as Extract<
      Verdict,
      { action: 'emit' }
    >

    expect(verdict.action).toBe('emit')
    const rewritten = parseWritten(verdict.bytes)
    expect(rewritten.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['read_file'])
    expect(rewritten.result.nextCursor).toBe('cursor-2')
    expect(rewritten.result._meta).toEqual({ vendor: 1 })
    expect(verdict.bytes.toString('utf8').endsWith('\n')).toBe(true)
    expect(inventory.stateOf('delete_repo')).toBe('new')
  })

  test('keeps vendor fields on the tools it does not hide', async () => {
    const { gate } = createHarness({ policy: policyOf(HIDE_DENIED_POLICY) })

    await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 77, method: 'tools/list' }))
    const verdict = (await gate.gateServerMessage(toolsListResponse(77))) as Extract<
      Verdict,
      { action: 'emit' }
    >

    const kept = parseWritten(verdict.bytes).result.tools as Array<Record<string, unknown>>
    expect(kept.find((tool) => tool.name === 'read_file')?.['x-vendor']).toBe('keep-me')
  })

  test('forwards the original bytes when the filter hides nothing, but still journals both views', async () => {
    const { gate } = createHarness({
      policy: policyOf({ defaultDecision: 'allow', quarantine: { enabled: false } }),
    })

    await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 77, method: 'tools/list' }))
    const verdict = await gate.gateServerMessage(toolsListResponse(77))

    // Byte identity: re-serializing an unfiltered response would change the
    // bytes for a stream nothing was actually hidden from.
    expect(verdict).toEqual({ action: 'forward' })
    const decisions = await readDecisions()
    expect(decisions.map((record) => record.payload)).toEqual([
      { tools: ['read_file', 'delete_repo'] },
      { tools: ['read_file', 'delete_repo'] },
    ])
  })

  test('journals both the original catalog and what the client actually saw', async () => {
    const { gate } = createHarness({ policy: policyOf(HIDE_DENIED_POLICY) })

    await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 77, method: 'tools/list' }))
    await gate.gateServerMessage(toolsListResponse(77))

    const decisions = await readDecisions()
    expect(decisions.map((record) => record.decision?.rule)).toEqual([
      'toolsList.original',
      'toolsList.filtered',
    ])
    expect(decisions[0]!.payload).toEqual({ tools: ['read_file', 'delete_repo'] })
    expect(decisions[1]!.payload).toEqual({ tools: ['read_file'] })
  })

  test('an unmatched tools/list response is forwarded untouched (no request was seen)', async () => {
    const { gate } = createHarness({ policy: policyOf(HIDE_DENIED_POLICY) })

    const verdict = await gate.gateServerMessage(toolsListResponse(77))

    expect(verdict).toEqual({ action: 'forward' })
    expect(await readDecisions()).toEqual([])
  })

  test('filter "off" still observes the catalog but forwards the original bytes', async () => {
    const { gate } = createHarness({
      policy: policyOf({ ...HIDE_DENIED_POLICY, toolsList: { filter: 'off' } }),
    })

    await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 77, method: 'tools/list' }))
    const verdict = await gate.gateServerMessage(toolsListResponse(77))

    expect(verdict).toEqual({ action: 'forward' })
    expect(inventory.stateOf('read_file')).toBe('new')
    expect(await readDecisions()).toEqual([])
  })

  test('a response whose result is not a tool list is forwarded unchanged', async () => {
    const { gate } = createHarness({ policy: policyOf(HIDE_DENIED_POLICY) })

    await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 77, method: 'tools/list' }))
    const verdict = await gate.gateServerMessage(frameOf({ jsonrpc: '2.0', id: 77, error: { code: -1, message: 'no' } }))

    expect(verdict).toEqual({ action: 'forward' })
  })

  test('a server response for an id the gate already answered is forwarded and journaled as a warning', async () => {
    const { gate } = createHarness({ policy: policyOf(DENY_EVERYTHING) })

    await gate.gateClientMessage(toolCall(42, 'write_file'))
    const verdict = await gate.gateServerMessage(frameOf({ jsonrpc: '2.0', id: 42, result: { ok: 1 } }))

    expect(verdict).toEqual({ action: 'forward' })
    expect((await readDecisions()).at(-1)?.decision?.rule).toBe('duplicate-response-warning')
  })
})

describe('createPolicyGate: fail-closed journaling', () => {
  const FAIL_CLOSED_POLICY = {
    defaultDecision: 'allow',
    quarantine: { enabled: false },
    journal: { failClosed: true },
  } as const

  test('an allowed call is only forwarded after its decision record is on disk', async () => {
    const { gate } = createHarness({ policy: policyOf(FAIL_CLOSED_POLICY) })

    const verdict = await gate.gateClientMessage(toolCall(1, 'read_file'))

    expect(verdict).toEqual({ action: 'forward' })
    // Read synchronously, with no flush: if the gate had not awaited the
    // sink, the record would still be queued in memory here.
    expect(readDecisionsSync()).toHaveLength(1)
  })

  test('a denied call is only answered after its decision record is on disk', async () => {
    const { gate, written } = createHarness({
      policy: policyOf({ ...FAIL_CLOSED_POLICY, defaultDecision: 'deny' }),
    })

    await gate.gateClientMessage(toolCall(1, 'write_file'))

    expect(written).toHaveLength(1)
    expect(readDecisionsSync()).toHaveLength(1)
  })
})

describe('createPolicyGate: internal errors fail closed', () => {
  function brokenInventory(): Inventory {
    return {
      ...inventory,
      stateOf: () => {
        throw new Error('inventory exploded')
      },
    }
  }

  test('a tools/call is dropped and denied when the gate itself throws', async () => {
    const { gate, written } = createHarness({ inventory: brokenInventory() })

    const verdict = await gate.gateClientMessage(toolCall(1, 'read_file'))

    expect(verdict).toEqual({ action: 'drop' })
    expect(parseWritten(written[0]!).error.code).toBe(ERROR_CODE_POLICY_DENIED)
    expect((await readDecisions()).at(-1)?.decision).toMatchObject({
      outcome: 'deny',
      rule: 'gate-error',
    })
    expect(errors).toHaveLength(1)
  })

  test('ordinary traffic still flows when the gate throws internally', async () => {
    const { gate, written } = createHarness({ inventory: brokenInventory() })

    const verdict = await gate.gateClientMessage(
      frameOf({ jsonrpc: '2.0', id: 2, method: 'resources/read' }),
    )

    expect(verdict).toEqual({ action: 'forward' })
    expect(written).toEqual([])
  })

  test('a gate error on a tools/call with id null drops without answering', async () => {
    const { gate, written } = createHarness({ inventory: brokenInventory() })

    const verdict = await gate.gateClientMessage(toolCall(null, 'read_file'))

    expect(verdict).toEqual({ action: 'drop' })
    expect(written).toEqual([])
  })

  test('a failure while answering a gate error still drops, and never rejects', async () => {
    const gate = createPolicyGate({
      policy: policyOf({ defaultDecision: 'allow', quarantine: { enabled: false } }),
      serverName: SERVER_NAME,
      sessionId: SESSION_ID,
      inventory: brokenInventory(),
      approvalQueue: queue,
      approvalWaiter: createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS }),
      grantRegistry: createGrantRegistry(),
      sink,
      clientWriter: {
        writeMessage: () => {
          throw new Error('client stdin is gone')
        },
        dispose: () => undefined,
      },
      approvalsBaseDir: approvalsDir,
      onError: (error) => errors.push(error),
    })

    await expect(gate.gateClientMessage(toolCall(1, 'read_file'))).resolves.toEqual({
      action: 'drop',
    })
    expect(errors).toHaveLength(2) // the original failure, then the answer failure
  })

  test('a failing tools/list observation forwards the response instead of breaking the stream', async () => {
    const failingInventory: Inventory = {
      ...inventory,
      observeToolsList: () => Promise.reject(new Error('store is unwritable')),
    }
    const { gate } = createHarness({ inventory: failingInventory })

    await gate.gateClientMessage(frameOf({ jsonrpc: '2.0', id: 5, method: 'tools/list' }))
    const verdict = await gate.gateServerMessage(
      frameOf({ jsonrpc: '2.0', id: 5, result: { tools: [{ name: 'read_file' }] } }),
    )

    expect(verdict).toEqual({ action: 'forward' })
    expect(errors).toHaveLength(1)
  })

  test('reports through stderr when no onError is injected', async () => {
    const writes: string[] = []
    const restore = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const { writer } = createRecordingWriter()
      const gate = createPolicyGate({
        policy: policyOf({ defaultDecision: 'allow', quarantine: { enabled: false } }),
        serverName: SERVER_NAME,
        sessionId: SESSION_ID,
        inventory: brokenInventory(),
        approvalQueue: queue,
        approvalWaiter: createApprovalWaiter({ pollIntervalMs: POLL_INTERVAL_MS }),
        grantRegistry: createGrantRegistry(),
        sink,
        clientWriter: writer,
        approvalsBaseDir: approvalsDir,
      })
      await gate.gateClientMessage(toolCall(1, 'read_file'))
    } finally {
      process.stderr.write = restore
    }

    expect(writes.join('')).toContain('[gate] inventory exploded')
  })
})

describe('createBoundedIdSet', () => {
  test('remembers ids until the cap, then forgets the oldest first', () => {
    const ids = createBoundedIdSet(2)

    ids.add('a')
    ids.add('b')
    ids.add('c')

    expect(ids.has('a')).toBe(false)
    expect(ids.has('b')).toBe(true)
    expect(ids.has('c')).toBe(true)
  })

  test('re-adding an id makes it the newest, and delete reports whether it was present', () => {
    const ids = createBoundedIdSet(2)

    ids.add('a')
    ids.add('b')
    ids.add('a') // 'a' is now the newest, so 'b' is evicted next
    ids.add('c')

    expect(ids.has('a')).toBe(true)
    expect(ids.has('b')).toBe(false)
    expect(ids.delete('c')).toBe(true)
    expect(ids.delete('c')).toBe(false)
  })
})

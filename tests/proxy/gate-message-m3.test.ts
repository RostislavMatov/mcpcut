import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createJournalSink, type JournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createGrantRegistry } from '../../src/policy/approvals/grants.js'
import { createApprovalQueue, type ApprovalQueue } from '../../src/policy/approvals/queue.js'
import { createApprovalWaiter } from '../../src/policy/approvals/waiter.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import {
  createMessagePolicyGate,
  createPolicyGate,
  type MessagePolicyGate,
  type PolicyGate,
} from '../../src/proxy/gate.js'
import {
  trimTrailingNewline,
  type GateAgentScope,
  type GateInventory,
} from '../../src/proxy/gate-helpers.js'
import { ERROR_CODE_POLICY_DENIED } from '../../src/proxy/synthesize.js'
import type { Verdict } from '../../src/proxy/pipeline.js'
import type { Frame } from '../../src/protocol/split.js'
import { clientMessage, serverMessage, type McpMessage, type MessageVerdict } from '../../src/transport/message.js'
import { frameToMessage, messageToChunk } from '../../src/transport/stdio-adapter.js'

/**
 * M3 gate tests: the message-level core (`createMessagePolicyGate`), its
 * parity with the Frame adapter (`createPolicyGate`), and the agent
 * dimension. The M2 Frame-level behavior itself is pinned by
 * `gate.test.ts`, which this file deliberately does not touch.
 */

const SERVER_NAME = 'testsrv'
const SESSION_ID = 'session-gate-m3'

let tempDir: string
let approvalsDir: string
let sinks: JournalSink[]
let queue: ApprovalQueue
let errors: unknown[]

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-gate-m3-test-'))
  approvalsDir = join(tempDir, 'approvals')
  queue = createApprovalQueue({ baseDir: approvalsDir })
  sinks = []
  errors = []
})

afterEach(async () => {
  await Promise.all(sinks.map((sink) => sink.close()))
  await rm(tempDir, { recursive: true, force: true })
})

function policyOf(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({ version: 1, quarantine: { enabled: false }, ...overrides })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

/** A hydrated, trusted inventory whose tools are all known. */
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

function scopeOf(granted: readonly string[]): GateAgentScope {
  const isGranted = (tool: string): boolean =>
    granted.some((pattern) =>
      pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern,
    )
  return {
    agentName: 'research-bot',
    isGranted,
    filterVisible: (tools) => tools.filter(isGranted),
  }
}

function frameOf(body: unknown): Frame {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return { bytes: Buffer.from(text, 'utf8'), terminator: '\n', isBlank: false, reason: 'line' }
}

function toolCallBody(id: unknown, name: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { path: '/tmp/x' } } }
}

interface MessageHarness {
  readonly gate: MessagePolicyGate
  readonly answered: McpMessage[]
  readonly journalPath: string
}

interface FrameHarness {
  readonly gate: PolicyGate
  readonly written: Buffer[]
}

interface HarnessOptions {
  readonly policy?: Policy
  readonly agentScope?: GateAgentScope
  readonly sessionId?: string
}

function sinkFor(sessionId: string): JournalSink {
  const sink = createJournalSink(sessionId, { dir: tempDir })
  sinks.push(sink)
  return sink
}

function commonDeps(opts: HarnessOptions, sessionId: string) {
  return {
    policy: opts.policy ?? policyOf({ defaultDecision: 'allow' }),
    serverName: SERVER_NAME,
    sessionId,
    inventory: trustedInventory(),
    approvalQueue: queue,
    approvalWaiter: createApprovalWaiter({ pollIntervalMs: 5 }),
    grantRegistry: createGrantRegistry(),
    sink: sinkFor(sessionId),
    approvalsBaseDir: approvalsDir,
    ...(opts.agentScope !== undefined ? { agentScope: opts.agentScope } : {}),
    onError: (error: unknown) => errors.push(error),
  }
}

function createMessageHarness(opts: HarnessOptions = {}): MessageHarness {
  const sessionId = opts.sessionId ?? `${SESSION_ID}-msg`
  const answered: McpMessage[] = []
  const gate = createMessagePolicyGate({
    ...commonDeps(opts, sessionId),
    clientSink: {
      write: (message) => {
        answered.push(message)
        return Promise.resolve()
      },
    },
  })
  return { gate, answered, journalPath: join(tempDir, `${sessionId}.jsonl`) }
}

function createFrameHarness(opts: HarnessOptions = {}): FrameHarness {
  const sessionId = opts.sessionId ?? `${SESSION_ID}-frame`
  const written: Buffer[] = []
  const gate = createPolicyGate({
    ...commonDeps(opts, sessionId),
    clientWriter: {
      writeMessage: (bytes) => {
        written.push(bytes)
        return Promise.resolve()
      },
    },
  })
  return { gate, written }
}

describe('message-level gate: parity with the Frame adapter', () => {
  const CATALOG_RESPONSE = {
    jsonrpc: '2.0',
    id: 77,
    result: { tools: [{ name: 'read_file' }, { name: 'delete_repo' }], nextCursor: 'c2' },
  }
  const HIDE_DENIED_POLICY = {
    defaultDecision: 'allow',
    servers: { [SERVER_NAME]: { tools: { 'delete_*': 'deny' } } },
  } as const

  test('the same allowed call yields the same forward verdict through both entries', async () => {
    const messageHarness = createMessageHarness()
    const frameHarness = createFrameHarness()
    const body = toolCallBody(1, 'read_file')

    const messageVerdict = await messageHarness.gate.gateClientMessage(
      clientMessage(Buffer.from(JSON.stringify(body))),
    )
    const frameVerdict = await frameHarness.gate.gateClientMessage(frameOf(body))

    expect(messageVerdict).toEqual({ action: 'forward' })
    expect(frameVerdict).toEqual({ action: 'forward' })
  })

  test('the same denied call produces byte-identical wire answers through both entries', async () => {
    const opts = { policy: policyOf({ defaultDecision: 'deny' }) }
    const messageHarness = createMessageHarness(opts)
    const frameHarness = createFrameHarness(opts)
    const body = toolCallBody(5, 'delete_repo')

    const messageVerdict = await messageHarness.gate.gateClientMessage(
      clientMessage(Buffer.from(JSON.stringify(body))),
    )
    const frameVerdict = await frameHarness.gate.gateClientMessage(frameOf(body))

    expect(messageVerdict).toEqual({ action: 'drop' })
    expect(frameVerdict).toEqual({ action: 'drop' })
    // Message level: content-only bytes, no framing.
    const messageAnswer = messageHarness.answered[0]!
    expect(messageAnswer.bytes.toString('utf8').endsWith('\n')).toBe(false)
    expect(messageAnswer.meta.origin).toBe('server')
    // Frame level: the exact M2 line — and it equals the message's stdio chunk.
    const frameAnswer = frameHarness.written[0]!
    expect(frameAnswer.toString('utf8').endsWith('\n')).toBe(true)
    expect(frameAnswer.equals(messageToChunk(messageAnswer))).toBe(true)
    expect(JSON.parse(messageAnswer.bytes.toString('utf8')).error.code).toBe(ERROR_CODE_POLICY_DENIED)
  })

  test('the same filtered tools/list emits the same rewritten catalog, modulo line framing', async () => {
    const opts = { policy: policyOf(HIDE_DENIED_POLICY) }
    const messageHarness = createMessageHarness(opts)
    const frameHarness = createFrameHarness(opts)
    const listRequest = { jsonrpc: '2.0', id: 77, method: 'tools/list' }

    await messageHarness.gate.gateClientMessage(clientMessage(Buffer.from(JSON.stringify(listRequest))))
    await frameHarness.gate.gateClientMessage(frameOf(listRequest))
    const messageVerdict = (await messageHarness.gate.gateServerMessage(
      serverMessage(Buffer.from(JSON.stringify(CATALOG_RESPONSE))),
    )) as Extract<MessageVerdict, { action: 'emit' }>
    const frameVerdict = (await frameHarness.gate.gateServerMessage(
      frameOf(CATALOG_RESPONSE),
    )) as Extract<Verdict, { action: 'emit' }>

    expect(messageVerdict.action).toBe('emit')
    expect(frameVerdict.action).toBe('emit')
    // Message emit is content-only; frame emit is the same content line-framed.
    expect(messageVerdict.bytes.toString('utf8').includes('\n')).toBe(false)
    expect(frameVerdict.bytes.toString('utf8').endsWith('\n')).toBe(true)
    expect(trimTrailingNewline(frameVerdict.bytes).equals(messageVerdict.bytes)).toBe(true)
    const rewritten = JSON.parse(messageVerdict.bytes.toString('utf8'))
    expect(rewritten.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['read_file'])
    expect(rewritten.result.nextCursor).toBe('c2')
  })

  test('a frame converted by frameToMessage round-trips through the message gate as forward', async () => {
    const messageHarness = createMessageHarness()
    const frame = frameOf({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: {} })

    const verdict = await messageHarness.gate.gateClientMessage(frameToMessage(frame, 'client'))

    expect(verdict).toEqual({ action: 'forward' })
  })
})

describe('message-level gate: agent scope', () => {
  test('a call outside the grant matrix is denied with the agent rule before the M2 chain', async () => {
    const harness = createMessageHarness({ agentScope: scopeOf(['read_*']) })

    const verdict = await harness.gate.gateClientMessage(
      clientMessage(Buffer.from(JSON.stringify(toolCallBody(1, 'delete_repo')))),
    )

    expect(verdict).toEqual({ action: 'drop' })
    const answer = JSON.parse(harness.answered[0]!.bytes.toString('utf8'))
    expect(answer.error.code).toBe(ERROR_CODE_POLICY_DENIED)
    expect(String(answer.error.data.rule)).toBe(`agent: no grant for ${SERVER_NAME}/delete_repo`)
  })

  test('a granted call falls through to the unchanged M2 chain', async () => {
    const harness = createMessageHarness({ agentScope: scopeOf(['read_*']) })

    const verdict = await harness.gate.gateClientMessage(
      clientMessage(Buffer.from(JSON.stringify(toolCallBody(2, 'read_file')))),
    )

    expect(verdict).toEqual({ action: 'forward' })
    expect(harness.answered).toEqual([])
  })

  test('an agent deny still wins over an allow-everything policy', async () => {
    const harness = createMessageHarness({
      agentScope: scopeOf([]),
      policy: policyOf({ defaultDecision: 'allow' }),
    })

    const verdict = await harness.gate.gateClientMessage(
      clientMessage(Buffer.from(JSON.stringify(toolCallBody(3, 'read_file')))),
    )

    expect(verdict).toEqual({ action: 'drop' })
  })

  test('tools/list visibility is the intersection of grants and policy', async () => {
    const harness = createMessageHarness({
      agentScope: scopeOf(['read_*', 'delete_*']),
      policy: policyOf({
        defaultDecision: 'allow',
        servers: { [SERVER_NAME]: { tools: { 'delete_*': 'deny' } } },
      }),
    })

    await harness.gate.gateClientMessage(
      clientMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }))),
    )
    const verdict = (await harness.gate.gateServerMessage(
      serverMessage(
        Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 8,
            result: {
              tools: [{ name: 'read_file' }, { name: 'write_file' }, { name: 'delete_repo' }],
            },
          }),
        ),
      ),
    )) as Extract<MessageVerdict, { action: 'emit' }>

    expect(verdict.action).toBe('emit')
    const names = JSON.parse(verdict.bytes.toString('utf8')).result.tools.map(
      (tool: { name: string }) => tool.name,
    )
    // write_file is policy-visible but not granted; delete_repo is granted but
    // policy-denied; only the intersection survives.
    expect(names).toEqual(['read_file'])
  })

  test('grant filtering applies even when policy tools/list filtering is off', async () => {
    const harness = createMessageHarness({
      agentScope: scopeOf(['read_*']),
      policy: policyOf({ defaultDecision: 'allow', toolsList: { filter: 'off' } }),
    })

    await harness.gate.gateClientMessage(
      clientMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }))),
    )
    const verdict = (await harness.gate.gateServerMessage(
      serverMessage(
        Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 9,
            result: { tools: [{ name: 'read_file' }, { name: 'write_file' }] },
          }),
        ),
      ),
    )) as Extract<MessageVerdict, { action: 'emit' }>

    expect(verdict.action).toBe('emit')
    expect(
      JSON.parse(verdict.bytes.toString('utf8')).result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(['read_file'])
  })

  test('without an agentScope, filter off forwards the original bytes untouched (M2)', async () => {
    const harness = createMessageHarness({
      policy: policyOf({ defaultDecision: 'allow', toolsList: { filter: 'off' } }),
    })

    await harness.gate.gateClientMessage(
      clientMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }))),
    )
    const verdict = await harness.gate.gateServerMessage(
      serverMessage(
        Buffer.from(
          JSON.stringify({ jsonrpc: '2.0', id: 10, result: { tools: [{ name: 'write_file' }] } }),
        ),
      ),
    )

    expect(verdict).toEqual({ action: 'forward' })
  })
})

describe('trimTrailingNewline', () => {
  test('strips exactly one trailing newline and leaves everything else alone', () => {
    expect(trimTrailingNewline(Buffer.from('abc\n')).toString('utf8')).toBe('abc')
    expect(trimTrailingNewline(Buffer.from('abc\n\n')).toString('utf8')).toBe('abc\n')
    expect(trimTrailingNewline(Buffer.from('abc')).toString('utf8')).toBe('abc')
    expect(trimTrailingNewline(Buffer.alloc(0)).length).toBe(0)
  })
})

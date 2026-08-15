import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { agentScope } from '../../src/agents/scope.js'
import type { AgentGrant } from '../../src/agents/schema.js'
import { journalDbPathFor } from '../../src/journal/db.js'
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
import { readJournalRecords } from '../support/journal-rows.js'

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
  /** Flushes the journal and returns every decision record written so far. */
  decisions(): Promise<JournalRecord[]>
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

function commonDeps(opts: HarnessOptions, sessionId: string, sink: JournalSink) {
  return {
    policy: opts.policy ?? policyOf({ defaultDecision: 'allow' }),
    serverName: SERVER_NAME,
    sessionId,
    inventory: trustedInventory(),
    approvalQueue: queue,
    approvalWaiter: createApprovalWaiter({ pollIntervalMs: 5 }),
    grantRegistry: createGrantRegistry(),
    sink,
    approvalsBaseDir: approvalsDir,
    ...(opts.agentScope !== undefined ? { agentScope: opts.agentScope } : {}),
    onError: (error: unknown) => errors.push(error),
  }
}

function createMessageHarness(opts: HarnessOptions = {}): MessageHarness {
  const sessionId = opts.sessionId ?? `${SESSION_ID}-msg`
  const answered: McpMessage[] = []
  const sink = sinkFor(sessionId)
  const gate = createMessagePolicyGate({
    ...commonDeps(opts, sessionId, sink),
    clientSink: {
      write: (message) => {
        answered.push(message)
        return Promise.resolve()
      },
    },
  })
  return {
    gate,
    answered,
    journalPath: journalDbPathFor(tempDir),
    decisions: async () => {
      await sink.flush()
      // A session that journaled nothing never creates journal.db at all;
      // readJournalRecords already returns [] in that case.
      const records = await readJournalRecords(tempDir, sessionId)
      return records.filter((record) => record.kind === 'decision')
    },
  }
}

function createFrameHarness(opts: HarnessOptions = {}): FrameHarness {
  const sessionId = opts.sessionId ?? `${SESSION_ID}-frame`
  const written: Buffer[] = []
  const gate = createPolicyGate({
    ...commonDeps(opts, sessionId, sinkFor(sessionId)),
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

describe('message-level gate: methods outside the grant vocabulary (agent sessions)', () => {
  const NON_GRANTABLE = [
    'resources/read',
    'resources/list',
    'resources/subscribe',
    'resources/unsubscribe',
    'resources/templates/list',
    'prompts/list',
    'prompts/get',
    'completion/complete',
  ] as const

  test.each(NON_GRANTABLE)(
    '%s is denied and never reaches the server when an agent is present',
    async (method) => {
      const harness = createMessageHarness({
        agentScope: scopeOf(['*']),
        sessionId: `${SESSION_ID}-nongrantable-${method.replace(/\//g, '-')}`,
      })

      const verdict = await harness.gate.gateClientMessage(
        clientMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 11, method, params: {} }))),
      )

      expect(verdict).toEqual({ action: 'drop' })
      const answer = JSON.parse(harness.answered[0]!.bytes.toString('utf8'))
      expect(answer.id).toBe(11)
      expect(answer.error.code).toBe(ERROR_CODE_POLICY_DENIED)
      expect(String(answer.error.data.rule)).toBe(`agent: method not grantable in M3: ${method}`)
    },
  )

  test('the denial is journaled as a decision naming the method', async () => {
    const harness = createMessageHarness({
      agentScope: scopeOf(['*']),
      sessionId: `${SESSION_ID}-nongrantable-journal`,
    })

    await harness.gate.gateClientMessage(
      clientMessage(
        Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'resources/read', params: { uri: 'file:///etc/passwd' } })),
      ),
    )

    const decisions = await harness.decisions()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.decision).toMatchObject({
      outcome: 'deny',
      rule: 'agent: method not grantable in M3: resources/read',
      toolName: 'resources/read',
      serverName: SERVER_NAME,
    })
  })

  test('an id-less (notification-shaped) resources/read is dropped without an answer', async () => {
    const harness = createMessageHarness({
      agentScope: scopeOf(['*']),
      sessionId: `${SESSION_ID}-nongrantable-idless`,
    })

    const verdict = await harness.gate.gateClientMessage(
      clientMessage(
        Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'resources/read', params: { uri: 'file:///x' } })),
      ),
    )

    expect(verdict).toEqual({ action: 'drop' })
    // No id, no return address: the drop is journaled, nothing is synthesized.
    expect(harness.answered).toEqual([])
    expect((await harness.decisions())[0]?.decision?.outcome).toBe('deny')
  })

  test('protocol plumbing an agent session still needs is forwarded untouched', async () => {
    const harness = createMessageHarness({
      agentScope: scopeOf(['*']),
      sessionId: `${SESSION_ID}-plumbing`,
    })

    for (const [id, method] of [
      [21, 'initialize'],
      [22, 'ping'],
      [23, 'tools/list'],
      [24, 'logging/setLevel'],
    ] as const) {
      const verdict = await harness.gate.gateClientMessage(
        clientMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }))),
      )
      expect(verdict).toEqual({ action: 'forward' })
    }
    const notification = await harness.gate.gateClientMessage(
      clientMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))),
    )

    expect(notification).toEqual({ action: 'forward' })
    expect(harness.answered).toEqual([])
  })

  test('without an agentScope (wrap) resources/read forwards exactly as in M2', async () => {
    const harness = createMessageHarness({ sessionId: `${SESSION_ID}-wrap-resources` })

    const verdict = await harness.gate.gateClientMessage(
      clientMessage(
        Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'resources/read', params: {} })),
      ),
    )

    expect(verdict).toEqual({ action: 'forward' })
    expect(harness.answered).toEqual([])
    await expect(harness.decisions()).resolves.toEqual([])
  })
})

describe('message-level gate: an untracked tools/list-shaped response', () => {
  /** A catalog response whose id was never seen in a tracked `tools/list` request. */
  function unsolicitedCatalog(id: number): McpMessage {
    return serverMessage(
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { tools: [{ name: 'read_file' }, { name: 'delete_repo' }], nextCursor: 'c9' },
        }),
      ),
    )
  }

  test('still passes the grant filter, so an agent cannot see what it was never given', async () => {
    const harness = createMessageHarness({
      agentScope: scopeOf(['read_*']),
      sessionId: `${SESSION_ID}-untracked-agent`,
    })

    const verdict = (await harness.gate.gateServerMessage(unsolicitedCatalog(99))) as Extract<
      MessageVerdict,
      { action: 'emit' }
    >

    expect(verdict.action).toBe('emit')
    const result = JSON.parse(verdict.bytes.toString('utf8')).result
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(['read_file'])
    expect(result.nextCursor).toBe('c9')
  })

  test('an untracked catalog whose tools are all granted forwards byte-identically', async () => {
    const harness = createMessageHarness({
      agentScope: scopeOf(['read_*', 'delete_*']),
      sessionId: `${SESSION_ID}-untracked-all-granted`,
    })

    const verdict = await harness.gate.gateServerMessage(unsolicitedCatalog(98))

    expect(verdict).toEqual({ action: 'forward' })
  })

  test('without an agentScope it forwards untouched, exactly as in M2', async () => {
    const harness = createMessageHarness({ sessionId: `${SESSION_ID}-untracked-wrap` })

    const verdict = await harness.gate.gateServerMessage(unsolicitedCatalog(97))

    expect(verdict).toEqual({ action: 'forward' })
  })

  test('a non-catalog response is forwarded untouched even under an agent scope', async () => {
    const harness = createMessageHarness({
      agentScope: scopeOf([]),
      sessionId: `${SESSION_ID}-untracked-non-catalog`,
    })

    const verdict = await harness.gate.gateServerMessage(
      serverMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 96, result: { content: [] } }))),
    )

    expect(verdict).toEqual({ action: 'forward' })
  })
})

/**
 * M4 Task 6: a `GateAgentScope` whose method-grant dimension is the REAL one
 * derived by `agents/scope.ts` from a real grant record — so these tests pin
 * the integrated matcher semantics, not a test double's.
 */
function methodScopeOf(grant: Partial<AgentGrant>): GateAgentScope {
  const record = {
    name: 'research-bot',
    tokenHash: 'f'.repeat(64),
    createdAt: '2026-08-05T10:00:00.000Z',
    grants: { [SERVER_NAME]: { tools: [], ...grant } as AgentGrant },
  }
  const scope = agentScope(record, SERVER_NAME)
  return {
    agentName: 'research-bot',
    isGranted: scope.isGranted,
    filterVisible: scope.filterVisible,
    methodGrants: scope.methodGrants,
  }
}

function requestOf(id: number, method: string, params?: unknown): McpMessage {
  return clientMessage(
    Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })),
  )
}

describe('message-level gate: method grants open the M3-denied methods (M4)', () => {
  test('resources/read with a matching resources grant forwards and journals class read', async () => {
    const harness = createMessageHarness({
      agentScope: methodScopeOf({ resources: ['file:///project/*'] }),
      sessionId: `${SESSION_ID}-mg-read-allow`,
    })

    const verdict = await harness.gate.gateClientMessage(
      requestOf(41, 'resources/read', { uri: 'file:///project/readme.md' }),
    )

    expect(verdict).toEqual({ action: 'forward' })
    expect(harness.answered).toEqual([])
    const decisions = await harness.decisions()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.decision).toMatchObject({
      outcome: 'allow',
      rule: 'agent: method granted: resources/read',
      toolName: 'resources/read',
      toolClass: 'read',
      serverName: SERVER_NAME,
    })
  })

  test('resources/read outside the granted URIs is denied with a rule naming the URI', async () => {
    const harness = createMessageHarness({
      agentScope: methodScopeOf({ resources: ['file:///project/*'] }),
      sessionId: `${SESSION_ID}-mg-read-deny`,
    })

    const verdict = await harness.gate.gateClientMessage(
      requestOf(42, 'resources/read', { uri: 'file:///etc/passwd' }),
    )

    expect(verdict).toEqual({ action: 'drop' })
    const answer = JSON.parse(harness.answered[0]!.bytes.toString('utf8'))
    expect(answer.id).toBe(42)
    expect(answer.error.code).toBe(ERROR_CODE_POLICY_DENIED)
    expect(String(answer.error.data.rule)).toBe('agent: no resources grant for file:///etc/passwd')
    const decisions = await harness.decisions()
    expect(decisions[0]?.decision).toMatchObject({ outcome: 'deny', toolClass: 'read' })
  })

  test('without a resources grant the denial is byte-identical to M3 (same rule, same record shape)', async () => {
    const harness = createMessageHarness({
      agentScope: methodScopeOf({ prompts: ['greet*'] }),
      sessionId: `${SESSION_ID}-mg-read-m3`,
    })

    const verdict = await harness.gate.gateClientMessage(
      requestOf(43, 'resources/read', { uri: 'file:///project/readme.md' }),
    )

    expect(verdict).toEqual({ action: 'drop' })
    const answer = JSON.parse(harness.answered[0]!.bytes.toString('utf8'))
    expect(answer.id).toBe(43)
    expect(answer.error.code).toBe(ERROR_CODE_POLICY_DENIED)
    expect(String(answer.error.data.rule)).toBe('agent: method not grantable in M3: resources/read')
    const decisions = await harness.decisions()
    expect(decisions[0]?.decision).toMatchObject({
      outcome: 'deny',
      rule: 'agent: method not grantable in M3: resources/read',
      toolName: 'resources/read',
      toolClass: 'destructive',
    })
  })

  test('an empty resources array behaves exactly like an absent field (M3 rule)', async () => {
    const harness = createMessageHarness({
      agentScope: methodScopeOf({ resources: [] }),
      sessionId: `${SESSION_ID}-mg-read-empty`,
    })

    await harness.gate.gateClientMessage(requestOf(44, 'resources/read', { uri: 'file:///x' }))

    const answer = JSON.parse(harness.answered[0]!.bytes.toString('utf8'))
    expect(String(answer.error.data.rule)).toBe('agent: method not grantable in M3: resources/read')
  })

  test("a '*' resources grant admits any URI", async () => {
    const harness = createMessageHarness({
      agentScope: methodScopeOf({ resources: '*' }),
      sessionId: `${SESSION_ID}-mg-read-star`,
    })

    const verdict = await harness.gate.gateClientMessage(
      requestOf(45, 'resources/read', { uri: 'anything://at/all' }),
    )

    expect(verdict).toEqual({ action: 'forward' })
  })

  test('resources/list response is filtered down to the granted URIs', async () => {
    const harness = createMessageHarness({
      agentScope: methodScopeOf({ resources: ['file:///project/*'] }),
      sessionId: `${SESSION_ID}-mg-res-list`,
    })

    const requestVerdict = await harness.gate.gateClientMessage(requestOf(46, 'resources/list'))
    expect(requestVerdict).toEqual({ action: 'forward' })

    const verdict = (await harness.gate.gateServerMessage(
      serverMessage(
        Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 46,
            result: {
              resources: [
                { uri: 'file:///project/a.txt', name: 'A' },
                { uri: 'file:///etc/passwd', name: 'P' },
              ],
              nextCursor: 'c7',
            },
          }),
        ),
      ),
    )) as Extract<MessageVerdict, { action: 'emit' }>

    expect(verdict.action).toBe('emit')
    const result = JSON.parse(verdict.bytes.toString('utf8')).result
    expect(result.resources.map((entry: { uri: string }) => entry.uri)).toEqual([
      'file:///project/a.txt',
    ])
    expect(result.nextCursor).toBe('c7')
  })

  test('a resources/list response that is entirely granted forwards untouched', async () => {
    const harness = createMessageHarness({
      agentScope: methodScopeOf({ resources: '*' }),
      sessionId: `${SESSION_ID}-mg-res-list-all`,
    })

    await harness.gate.gateClientMessage(requestOf(47, 'resources/list'))
    const verdict = await harness.gate.gateServerMessage(
      serverMessage(
        Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 47,
            result: { resources: [{ uri: 'file:///anything' }] },
          }),
        ),
      ),
    )

    expect(verdict).toEqual({ action: 'forward' })
  })

  test('prompts/list response is filtered down to the granted names', async () => {
    const harness = createMessageHarness({
      agentScope: methodScopeOf({ prompts: ['greet*'] }),
      sessionId: `${SESSION_ID}-mg-prompt-list`,
    })

    await harness.gate.gateClientMessage(requestOf(48, 'prompts/list'))
    const verdict = (await harness.gate.gateServerMessage(
      serverMessage(
        Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 48,
            result: { prompts: [{ name: 'greeting' }, { name: 'secret-prompt' }] },
          }),
        ),
      ),
    )) as Extract<MessageVerdict, { action: 'emit' }>

    expect(verdict.action).toBe('emit')
    const result = JSON.parse(verdict.bytes.toString('utf8')).result
    expect(result.prompts.map((entry: { name: string }) => entry.name)).toEqual(['greeting'])
  })

  test('prompts/get is matched with the shared tool matcher semantics', async () => {
    const harness = createMessageHarness({
      agentScope: methodScopeOf({ prompts: ['greet*'] }),
      sessionId: `${SESSION_ID}-mg-prompt-get`,
    })

    const allowed = await harness.gate.gateClientMessage(
      requestOf(49, 'prompts/get', { name: 'greeting' }),
    )
    const denied = await harness.gate.gateClientMessage(
      requestOf(50, 'prompts/get', { name: 'secret-prompt' }),
    )

    expect(allowed).toEqual({ action: 'forward' })
    expect(denied).toEqual({ action: 'drop' })
    const answer = JSON.parse(harness.answered[0]!.bytes.toString('utf8'))
    expect(String(answer.error.data.rule)).toBe('agent: no prompts grant for secret-prompt')
  })

  test('completion/complete is gated by the subject of params.ref, not by mere grant presence (review M1)', async () => {
    const withPrompts = createMessageHarness({
      agentScope: methodScopeOf({ prompts: ['greet*'] }),
      sessionId: `${SESSION_ID}-mg-completion-prompts`,
    })
    const withResources = createMessageHarness({
      agentScope: methodScopeOf({ resources: ['file:///p/*'] }),
      sessionId: `${SESSION_ID}-mg-completion-resources`,
    })
    const withNeither = createMessageHarness({
      agentScope: methodScopeOf({ tools: '*' }),
      sessionId: `${SESSION_ID}-mg-completion-neither`,
    })

    // a granted subject forwards
    expect(
      await withPrompts.gate.gateClientMessage(
        requestOf(51, 'completion/complete', { ref: { type: 'ref/prompt', name: 'greeting' } }),
      ),
    ).toEqual({ action: 'forward' })
    expect(
      await withResources.gate.gateClientMessage(
        requestOf(52, 'completion/complete', { ref: { type: 'ref/resource', uri: 'file:///p/x' } }),
      ),
    ).toEqual({ action: 'forward' })

    // an ungranted resource subject is denied with a rule naming the URI
    expect(
      await withResources.gate.gateClientMessage(
        requestOf(56, 'completion/complete', { ref: { type: 'ref/resource', uri: 'file:///etc/passwd' } }),
      ),
    ).toEqual({ action: 'drop' })
    const uncoveredAnswer = JSON.parse(withResources.answered[0]!.bytes.toString('utf8'))
    expect(String(uncoveredAnswer.error.data.rule)).toBe(
      'agent: no resources grant for file:///etc/passwd',
    )

    // an ungranted subject is denied even though the OTHER vocabulary is granted
    expect(
      await withPrompts.gate.gateClientMessage(
        requestOf(54, 'completion/complete', { ref: { type: 'ref/prompt', name: 'secret' } }),
      ),
    ).toEqual({ action: 'drop' })

    // no grant at all stays the byte-identical M3 denial
    expect(await withNeither.gate.gateClientMessage(requestOf(53, 'completion/complete', {}))).toEqual(
      { action: 'drop' },
    )
    const answer = JSON.parse(withNeither.answered[0]!.bytes.toString('utf8'))
    expect(String(answer.error.data.rule)).toBe(
      'agent: method not grantable in M3: completion/complete',
    )
  })

  test('resources/subscribe on a granted URI forwards and journals class write', async () => {
    const harness = createMessageHarness({
      agentScope: methodScopeOf({ resources: ['file:///project/*'] }),
      sessionId: `${SESSION_ID}-mg-subscribe`,
    })

    const verdict = await harness.gate.gateClientMessage(
      requestOf(54, 'resources/subscribe', { uri: 'file:///project/a.txt' }),
    )

    expect(verdict).toEqual({ action: 'forward' })
    const decisions = await harness.decisions()
    expect(decisions[0]?.decision).toMatchObject({
      outcome: 'allow',
      toolName: 'resources/subscribe',
      toolClass: 'write',
    })
  })

  test('a method outside the enumerated vocabulary stays M3-denied even with wildcard grants', async () => {
    const harness = createMessageHarness({
      agentScope: methodScopeOf({ resources: '*', prompts: '*' }),
      sessionId: `${SESSION_ID}-mg-templates`,
    })

    const verdict = await harness.gate.gateClientMessage(
      requestOf(55, 'resources/templates/list', {}),
    )

    expect(verdict).toEqual({ action: 'drop' })
    const answer = JSON.parse(harness.answered[0]!.bytes.toString('utf8'))
    expect(String(answer.error.data.rule)).toBe(
      'agent: method not grantable in M3: resources/templates/list',
    )
  })
})

/**
 * Review H1: the method-grant ALLOW path must be as fail-closed as the deny
 * path. A journal that cannot settle (ENOSPC, EACCES) must never crash the
 * process with an unhandled rejection, and must never forward a frame whose
 * decision record is not durable.
 */
describe('message-level gate: method-grant paths fail closed on journal failure (H1)', () => {
  function failingFlushHarness(sessionId: string) {
    const answered: McpMessage[] = []
    let failFlush = false
    const gate = createMessagePolicyGate({
      policy: policyOf({ defaultDecision: 'allow', journal: { failClosed: true } }),
      serverName: SERVER_NAME,
      sessionId,
      inventory: trustedInventory(),
      approvalQueue: queue,
      approvalWaiter: createApprovalWaiter({ pollIntervalMs: 5 }),
      grantRegistry: createGrantRegistry(),
      sink: {
        write: () => undefined,
        flush: () => (failFlush ? Promise.reject(new Error('disk full')) : Promise.resolve()),
      },
      approvalsBaseDir: approvalsDir,
      agentScope: methodScopeOf({ resources: ['file:///project/*'] }),
      onError: (error: unknown) => errors.push(error),
      clientSink: {
        write: (message: McpMessage) => {
          answered.push(message)
          return Promise.resolve()
        },
      },
    })
    return { gate, answered, setFailFlush: (value: boolean) => (failFlush = value) }
  }

  test('a granted resources/read is denied and dropped, never forwarded or rejected, when the flush fails', async () => {
    const harness = failingFlushHarness(`${SESSION_ID}-mg-flushfail-read`)
    harness.setFailFlush(true)

    await expect(
      harness.gate.gateClientMessage(
        requestOf(61, 'resources/read', { uri: 'file:///project/readme.md' }),
      ),
    ).resolves.toEqual({ action: 'drop' })

    expect(errors.length).toBeGreaterThanOrEqual(1)
    const answer = JSON.parse(harness.answered[0]!.bytes.toString('utf8'))
    expect(answer.id).toBe(61)
    expect(answer.error.code).toBe(ERROR_CODE_POLICY_DENIED)
  })

  test('a grant-filtered list response is dropped, never emitted unjournaled, when the flush fails', async () => {
    const harness = failingFlushHarness(`${SESSION_ID}-mg-flushfail-list`)

    await expect(harness.gate.gateClientMessage(requestOf(62, 'resources/list'))).resolves.toEqual({
      action: 'forward',
    })
    harness.setFailFlush(true)

    await expect(
      harness.gate.gateServerMessage(
        serverMessage(
          Buffer.from(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 62,
              result: {
                resources: [
                  { uri: 'file:///project/a.txt', name: 'A' },
                  { uri: 'file:///etc/passwd', name: 'P' },
                ],
              },
            }),
          ),
        ),
      ),
    ).resolves.toEqual({ action: 'drop' })
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })
})

/** Review M5: the journaled `removed` list of a grant-filtered listing is capped. */
describe('message-level gate: grant-filtered listing journals a bounded removed list (M5)', () => {
  test('at most 20 removed subjects are journaled, with a "+N more" tail carrying the count', async () => {
    const harness = createMessageHarness({
      agentScope: methodScopeOf({ resources: ['file:///project/*'] }),
      sessionId: `${SESSION_ID}-mg-removed-cap`,
    })
    const ungranted = Array.from({ length: 25 }, (_, index) => ({
      uri: `file:///secret/${index}.txt`,
      name: `S${index}`,
    }))

    await harness.gate.gateClientMessage(requestOf(63, 'resources/list'))
    const verdict = await harness.gate.gateServerMessage(
      serverMessage(
        Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 63,
            result: { resources: [{ uri: 'file:///project/a.txt', name: 'A' }, ...ungranted] },
          }),
        ),
      ),
    )

    expect(verdict).toMatchObject({ action: 'emit' })
    const decisions = await harness.decisions()
    const record = decisions.find((entry) =>
      entry.decision?.rule.startsWith('agent: grant-filtered'),
    )
    expect(record).toBeDefined()
    const payload = record?.payload as { removed: string[]; removedCount: number }
    expect(payload.removed).toHaveLength(21)
    expect(payload.removed.at(-1)).toBe('+5 more')
    expect(payload.removedCount).toBe(25)
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

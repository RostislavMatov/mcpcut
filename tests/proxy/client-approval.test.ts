import { describe, expect, test } from 'vitest'
import { CLIENT_APPROVAL_ID_PREFIX, createClientApprover, type ClientApprovalDeps } from '../../src/proxy/client-approval.js'

/**
 * P2: a held call is also asked in the client (MCP form elicitation) — the
 * person at Claude Code answers Accept / Decline in the session instead of a
 * second terminal. The queue stays the source of truth: an answer here is
 * written into it, and anything but a deliberate answer leaves the call there.
 */

interface Harness {
  readonly sent: Record<string, unknown>[]
  readonly resolved: { approvalId: string; outcome: string; actor: string }[]
  readonly notices: string[]
  now: number
  readonly deps: ClientApprovalDeps
}

function harness(): Harness {
  const h: Harness = {
    sent: [],
    resolved: [],
    notices: [],
    now: 1_000_000,
    deps: {
      send: async (message) => {
        h.sent.push(message as Record<string, unknown>)
      },
      resolve: async (approvalId, resolution) => {
        h.resolved.push({ approvalId, outcome: resolution.outcome, actor: resolution.actor })
      },
      clock: () => h.now,
      onError: (error) => {
        throw error
      },
      onNotice: (text) => h.notices.push(text),
    },
  }
  return h
}

const INITIALIZE_WITH_FORMS = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {}, url: {} } }, clientInfo: { name: 'claude-code', version: '2.1.287' } },
})

const QUESTION = { approvalId: 'A1', toolName: 'write_file', serverName: 'fs', args: { path: '/w/a.txt', content: 'hi' } }

/** The id of the n-th question sent (ids carry a per-session nonce). */
function idOf(h: Harness, index = 0): string {
  return String(h.sent.filter((m) => m['method'] === 'elicitation/create')[index]?.['id'])
}

function responseTo(id: unknown, result: unknown): { id: string; raw: string } {
  return { id: id as string, raw: JSON.stringify({ jsonrpc: '2.0', id, result }) }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('what the client said it can do', () => {
  test('no initialize seen: nothing is asked', () => {
    const h = harness()
    const approver = createClientApprover(h.deps)

    expect(approver.ask(QUESTION)).toBeUndefined()
    expect(h.sent).toEqual([])
  })

  test.each([
    ['no elicitation capability', { capabilities: {} }],
    ['URL elicitation only', { capabilities: { elicitation: { url: {} } } }],
    ['a capability that is not an object', { capabilities: { elicitation: true } }],
  ])('%s: nothing is asked', (_label, params) => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params }))

    expect(approver.ask(QUESTION)).toBeUndefined()
  })

  test('an empty elicitation object (2025-06-18 clients) means forms: asked, without a mode field', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: { elicitation: {} } } }))

    approver.ask(QUESTION)
    await flush()

    expect(h.sent).toHaveLength(1)
    expect((h.sent[0]?.['params'] as Record<string, unknown>)['mode']).toBeUndefined()
  })
})

describe('the question', () => {
  test('is a form elicitation under an id of mcpcut\'s own, naming the tool, the server and the arguments', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)

    approver.ask(QUESTION)
    await flush()

    expect(h.sent).toEqual([
      {
        jsonrpc: '2.0',
        id: expect.stringMatching(new RegExp(`^${CLIENT_APPROVAL_ID_PREFIX}[0-9a-f]{12}-A1$`)),
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: expect.stringContaining('mcpcut: allow write_file on fs?'),
          requestedSchema: { type: 'object', properties: {}, required: [] },
        },
      },
    ])
    const message = (h.sent[0]?.['params'] as { message: string }).message
    expect(message).toContain('  path: "/w/a.txt"')
    expect(message).toMatch(/Accept runs it now/)
    expect(message).toMatch(/approvals list/)
  })

  test('secrets in the arguments are redacted, control characters replaced, and a long preview cut', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)

    approver.ask({ ...QUESTION, toolName: 'write\u001b[2Kfile', args: { password: 'hunter2xyz', content: 'x'.repeat(2000) } })
    await flush()

    const message = (h.sent[0]?.['params'] as { message: string }).message
    expect(message).not.toContain('hunter2xyz')
    expect(message).not.toContain('\u001b')
    expect(message).toMatch(/content: "x{159}… \(1842 more characters\)\n/)
    expect(message).toMatch(/Not everything is shown\. Read it whole: mcpcut approvals list --json/)
  })
})

describe('the answer', () => {
  async function asked(h: Harness): Promise<ReturnType<typeof createClientApprover>> {
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    approver.ask(QUESTION)
    await flush()
    return approver
  }

  test('Accept approves the call in the queue, in the name of the client', async () => {
    const h = harness()
    const approver = await asked(h)
    h.now += 3_000

    expect(approver.takeResponse(responseTo(idOf(h), { action: 'accept', content: {} }))).toBe(true)
    await flush()

    expect(h.resolved).toEqual([{ approvalId: 'A1', outcome: 'approved', actor: 'client:claude-code' }])
  })

  test('Decline denies it', async () => {
    const h = harness()
    const approver = await asked(h)
    h.now += 3_000

    approver.takeResponse(responseTo(idOf(h), { action: 'decline' }))
    await flush()

    expect(h.resolved).toEqual([{ approvalId: 'A1', outcome: 'denied', actor: 'client:claude-code' }])
  })

  test.each([
    ['Esc (cancel)', { action: 'cancel' }],
    ['an unknown action', { action: 'maybe' }],
    ['no result at all', null],
  ])('%s leaves the call waiting in the queue', async (_label, result) => {
    const h = harness()
    const approver = await asked(h)
    h.now += 3_000

    expect(approver.takeResponse(responseTo(idOf(h), result))).toBe(true)
    await flush()

    expect(h.resolved).toEqual([])
  })

  test('an error response leaves it waiting too, and is not forwarded', async () => {
    const h = harness()
    const approver = await asked(h)
    const raw = JSON.stringify({ jsonrpc: '2.0', id: idOf(h), error: { code: -32601, message: 'no' } })

    expect(approver.takeResponse({ id: idOf(h), raw })).toBe(true)
    await flush()

    expect(h.resolved).toEqual([])
  })

  test('an Accept faster than a person can read does not count: asked once more, then left to the queue', async () => {
    const h = harness()
    const approver = await asked(h)
    h.now += 200

    approver.takeResponse(responseTo(idOf(h), { action: 'accept' }))
    await flush()

    expect(h.resolved).toEqual([])
    expect(h.sent).toHaveLength(2)
    const again = h.sent[1] as { id: string; params: { message: string } }
    expect(again.id).toBe(`${idOf(h)}-2`)
    expect(again.params.message).toMatch(/too fast/)

    h.now += 100
    approver.takeResponse(responseTo(again.id, { action: 'accept' }))
    await flush()

    expect(h.resolved).toEqual([])
    expect(h.sent).toHaveLength(2)
    expect(h.notices.join('\n')).toMatch(/approvals approve A1/)
  })

  test('the second question answered at a human pace approves', async () => {
    const h = harness()
    const approver = await asked(h)
    h.now += 200
    approver.takeResponse(responseTo(idOf(h), { action: 'accept' }))
    await flush()
    h.now += 2_500

    approver.takeResponse(responseTo(idOf(h, 1), { action: 'accept' }))
    await flush()

    expect(h.resolved).toEqual([{ approvalId: 'A1', outcome: 'approved', actor: 'client:claude-code' }])
  })

  test('a fast Decline counts: refusing is never the risky direction', async () => {
    const h = harness()
    const approver = await asked(h)
    h.now += 50

    approver.takeResponse(responseTo(idOf(h), { action: 'decline' }))
    await flush()

    expect(h.resolved).toEqual([{ approvalId: 'A1', outcome: 'denied', actor: 'client:claude-code' }])
  })

  test('responses that are not mcpcut\'s own are left for the server', () => {
    const h = harness()
    const approver = createClientApprover(h.deps)

    expect(approver.takeResponse(responseTo(7, { roots: [] }))).toBe(false)
    expect(approver.takeResponse(responseTo('server-elicit-1', { action: 'accept' }))).toBe(false)
  })

  test('an answer to a question already withdrawn is swallowed, not forwarded and not counted', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    const question = approver.ask(QUESTION)
    await flush()
    const id = idOf(h)
    question?.withdraw()
    await flush()
    h.now += 5_000

    expect(approver.takeResponse(responseTo(id, { action: 'accept' }))).toBe(true)
    await flush()

    expect(h.resolved).toEqual([])
  })
})

describe('withdrawing the question', () => {
  test('a call settled elsewhere (terminal, timeout) closes the dialog with a cancellation', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    const question = approver.ask(QUESTION)
    await flush()

    question?.withdraw()
    await flush()

    expect(h.sent[1]).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: idOf(h), reason: expect.any(String) },
    })
  })

  test('after an answer, withdrawing sends nothing', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    const question = approver.ask(QUESTION)
    await flush()
    h.now += 3_000
    approver.takeResponse(responseTo(idOf(h), { action: 'accept' }))
    await flush()

    question?.withdraw()
    await flush()

    expect(h.sent).toHaveLength(1)
  })
})

describe('the actor', () => {
  test.each([
    ['claude-code', 'client:claude-code'],
    ['Cursor IDE', 'client:Cursor-IDE'],
    ['\u001b[31mevil\u001b[0m', 'client:-31mevil-0m'],
    ['', 'client:unknown'],
    ['x'.repeat(300), `client:${'x'.repeat(64)}`],
  ])('a client named %j is recorded as %s', async (name, actor) => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: { elicitation: { form: {} } }, clientInfo: { name } } }))
    approver.ask(QUESTION)
    await flush()
    h.now += 3_000

    approver.takeResponse(responseTo(idOf(h), { action: 'accept' }))
    await flush()

    expect(h.resolved[0]?.actor).toBe(actor)
  })
})

describe('one question at a time', () => {
  test('a second held call is asked only after the first dialog is answered', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    approver.ask(QUESTION)
    approver.ask({ ...QUESTION, approvalId: 'B2' })
    await flush()

    expect(h.sent.filter((m) => m['method'] === 'elicitation/create')).toHaveLength(1)

    h.now += 3_000
    approver.takeResponse(responseTo(idOf(h), { action: 'accept' }))
    await flush()

    expect(idOf(h, 1)).toMatch(/-B2$/)
    expect(h.resolved).toEqual([{ approvalId: 'A1', outcome: 'approved', actor: 'client:claude-code' }])
  })

  test('the next dialog\'s clock starts when it is sent: an Enter meant for the first does not approve it', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    approver.ask(QUESTION)
    approver.ask({ ...QUESTION, approvalId: 'B2' })
    await flush()
    h.now += 3_000
    approver.takeResponse(responseTo(idOf(h), { action: 'accept' }))
    await flush()
    h.now += 150

    approver.takeResponse(responseTo(idOf(h, 1), { action: 'accept' }))
    await flush()

    expect(h.resolved.map((r) => r.approvalId)).toEqual(['A1'])
    expect(idOf(h, 2)).toMatch(/-B2-2$/)
  })

  test('a waiting question withdrawn before its turn is never shown', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    approver.ask(QUESTION)
    approver.ask({ ...QUESTION, approvalId: 'B2' })?.withdraw()
    await flush()
    h.now += 3_000

    approver.takeResponse(responseTo(idOf(h), { action: 'decline' }))
    await flush()

    expect(h.sent.filter((m) => m['method'] === 'elicitation/create')).toHaveLength(1)
  })

  test('withdrawing the dialog on screen shows the next one', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    const first = approver.ask(QUESTION)
    approver.ask({ ...QUESTION, approvalId: 'B2' })
    await flush()

    first?.withdraw()
    await flush()

    expect(idOf(h, 1)).toMatch(/-B2$/)
  })
})

describe('the session', () => {
  test('ids carry a nonce: a server cannot squat or guess one, and its own prefixed ids pass through', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    approver.ask(QUESTION)
    await flush()

    expect(approver.takeResponse(responseTo(`${CLIENT_APPROVAL_ID_PREFIX}A1`, { action: 'accept' }))).toBe(false)
    expect(createClientApprover(harness().deps)).not.toBe(approver)
  })

  test('the first initialize wins', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    approver.observeInitialize(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 'cli:owner' } } }))

    approver.ask(QUESTION)
    await flush()
    h.now += 3_000
    approver.takeResponse(responseTo(idOf(h), { action: 'accept' }))
    await flush()

    expect(h.resolved[0]?.actor).toBe('client:claude-code')
  })

  test('the first question tells the operator how to turn asking off', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    approver.ask(QUESTION)
    approver.ask({ ...QUESTION, approvalId: 'B2' })
    await flush()

    expect(h.notices).toEqual([expect.stringContaining('"askClient": false')])
  })

  test('mayAsk false: nothing is shown and nothing is announced', async () => {
    const h = harness()
    const approver = createClientApprover({ ...h.deps, mayAsk: () => Promise.resolve(false) })
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    approver.ask(QUESTION)
    await flush()

    expect(h.sent).toEqual([])
    expect(h.notices).toEqual([])
  })

  test('a very long tool name is cut so Decline and Esc stay in view', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    approver.ask({ ...QUESTION, toolName: 't'.repeat(5_000) })
    await flush()

    const message = (h.sent[0]?.['params'] as { message: string }).message
    expect(message).toContain(`allow ${'t'.repeat(80)}… on fs?`)
    expect(message).toContain('Esc leaves it waiting')
  })

  test('many fields: each name is shown up to twelve, then how many more', async () => {
    const h = harness()
    const approver = createClientApprover(h.deps)
    approver.observeInitialize(INITIALIZE_WITH_FORMS)
    const args = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${i}`, i]))
    approver.ask({ ...QUESTION, args })
    await flush()

    const message = (h.sent[0]?.['params'] as { message: string }).message
    expect(message).toContain('  f11: 11')
    expect(message).toContain('  … and 3 more fields')
    expect(message).toContain('Not everything is shown')
  })
})

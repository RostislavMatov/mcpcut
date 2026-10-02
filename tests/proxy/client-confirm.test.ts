import { describe, expect, test } from 'vitest'
import {
  CLIENT_CONFIRM_ID_PREFIX,
  createClientConfirmer,
  type ClientConfirmDeps,
  type ClientConfirmer,
  type ConfirmAnswer,
  type ConfirmQuestion,
} from '../../src/proxy/client-confirm.js'

/**
 * The confirmation in the client (ADR-0019): the person at Claude Code
 * confirms a call in the session — an MCP form elicitation with Accept /
 * Decline. It is a rule of its own, not a way to answer the admin's queue:
 * the confirmer only reports what the person did, and the gate decides.
 */

interface Harness {
  readonly sent: Record<string, unknown>[]
  now: number
  readonly deps: ClientConfirmDeps
}

function harness(): Harness {
  const h: Harness = {
    sent: [],
    now: 1_000_000,
    deps: {
      send: async (message) => {
        h.sent.push(message as Record<string, unknown>)
      },
      clock: () => h.now,
      onError: (error) => {
        throw error
      },
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

const QUESTION: ConfirmQuestion = { toolName: 'write_file', serverName: 'fs', args: { path: '/w/a.txt', content: 'hi' }, thenAdmin: false }

function questionsSent(h: Harness): Record<string, unknown>[] {
  return h.sent.filter((m) => m['method'] === 'elicitation/create')
}

/** The id of the n-th question sent (ids carry a per-session nonce). */
function idOf(h: Harness, index = 0): string {
  return String(questionsSent(h)[index]?.['id'])
}

function messageOf(h: Harness, index = 0): string {
  return (questionsSent(h)[index]?.['params'] as { message: string }).message
}

function responseTo(id: unknown, result: unknown): { id: string; raw: string } {
  return { id: id as string, raw: JSON.stringify({ jsonrpc: '2.0', id, result }) }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function ready(h: Harness): ClientConfirmer {
  const confirmer = createClientConfirmer(h.deps)
  confirmer.observeInitialize(INITIALIZE_WITH_FORMS)
  return confirmer
}

/** Settles to the answer, or to `'pending'` when there is none yet. */
async function stateOf(answer: Promise<ConfirmAnswer>): Promise<ConfirmAnswer | 'pending'> {
  return Promise.race([answer, flush().then(() => 'pending' as const)])
}

describe('what the client said it can do', () => {
  test('no initialize seen: it cannot confirm, and nothing is sent', () => {
    const h = harness()
    const confirmer = createClientConfirmer(h.deps)

    expect(confirmer.canConfirm()).toBe(false)
    expect(confirmer.confirm(QUESTION)).toBeUndefined()
    expect(h.sent).toEqual([])
  })

  test.each([
    ['no elicitation capability', { capabilities: {} }],
    ['URL elicitation only', { capabilities: { elicitation: { url: {} } } }],
    ['a capability that is not an object', { capabilities: { elicitation: true } }],
  ])('%s: it cannot confirm', (_label, params) => {
    const confirmer = createClientConfirmer(harness().deps)
    confirmer.observeInitialize(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params }))

    expect(confirmer.canConfirm()).toBe(false)
    expect(confirmer.confirm(QUESTION)).toBeUndefined()
  })

  test('an empty elicitation object (2025-06-18 clients) means forms: asked, without a mode field', async () => {
    const h = harness()
    const confirmer = createClientConfirmer(h.deps)
    confirmer.observeInitialize(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: { elicitation: {} } } }))

    confirmer.confirm(QUESTION)
    await flush()

    expect(questionsSent(h)[0]?.['params']).not.toHaveProperty('mode')
  })

  test('the client is named by what its initialize said, made safe for a journal field', () => {
    const confirmer = createClientConfirmer(harness().deps)
    confirmer.observeInitialize(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: { elicitation: {} }, clientInfo: { name: 'my client\n<x>' } } }))

    expect(confirmer.clientName()).toBe('my-client-x-')
  })
})

describe('the question', () => {
  test('is a form elicitation under an id of mcpcut\'s own, naming the tool, the server and the arguments', async () => {
    const h = harness()
    ready(h).confirm(QUESTION)
    await flush()

    expect(h.sent).toEqual([
      {
        jsonrpc: '2.0',
        id: expect.stringMatching(new RegExp(`^${CLIENT_CONFIRM_ID_PREFIX}[0-9a-f]{12}-1$`)),
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: expect.stringContaining('mcpcut: allow write_file on fs?'),
          requestedSchema: { type: 'object', properties: {}, required: [] },
        },
      },
    ])
    expect(messageOf(h)).toContain('  path: "/w/a.txt"')
    expect(messageOf(h)).toMatch(/Accept runs it now\. Decline or Esc refuses it\.$/)
  })

  test('when an admin approves next, the question says so: Accept does not run it yet', async () => {
    const h = harness()
    ready(h).confirm({ ...QUESTION, thenAdmin: true })
    await flush()

    expect(messageOf(h)).toMatch(/Accept passes it on to an admin, who approves it too\. Decline or Esc refuses it\.$/)
    expect(messageOf(h)).not.toContain('runs it now')
  })

  test('secrets in the arguments are redacted, control characters replaced, and a long preview cut', async () => {
    const h = harness()
    ready(h).confirm({ ...QUESTION, toolName: 'write\u001b[2Kfile', args: { password: 'hunter2xyz', content: 'x'.repeat(2000) } })
    await flush()

    expect(messageOf(h)).not.toContain('hunter2xyz')
    expect(messageOf(h)).not.toContain('\u001b')
    expect(messageOf(h)).toMatch(/content: "x{159}… \(1842 more characters\)\n/)
    // Nothing waits in a queue yet, so there is no other place to read it whole.
    expect(messageOf(h)).toContain('Not everything is shown. Decline if you are not sure.')
  })

  test('a very long tool name is cut so Decline and Esc stay in view', async () => {
    const h = harness()
    ready(h).confirm({ ...QUESTION, toolName: 't'.repeat(5_000) })
    await flush()

    expect(messageOf(h)).toContain(`allow ${'t'.repeat(80)}… on fs?`)
    expect(messageOf(h)).toContain('Decline or Esc refuses it')
  })

  test('many fields: each name is shown up to twelve, then how many more', async () => {
    const h = harness()
    ready(h).confirm({ ...QUESTION, args: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${i}`, i])) })
    await flush()

    expect(messageOf(h)).toContain('  f11: 11')
    expect(messageOf(h)).toContain('  … and 3 more fields')
    expect(messageOf(h)).toContain('Not everything is shown')
  })
})

describe('the answer', () => {
  /** Asked and on screen, with a person's pause already taken. */
  async function asked(h: Harness): Promise<{ readonly answer: Promise<ConfirmAnswer>; readonly confirmer: ClientConfirmer }> {
    const confirmer = ready(h)
    const pending = confirmer.confirm(QUESTION)
    await flush()
    if (pending === undefined) throw new Error('not asked')
    h.now += 3_000
    return { answer: pending.answer, confirmer }
  }

  test('Accept at a human pace: accepted, in the name of the client', async () => {
    const h = harness()
    const { answer, confirmer } = await asked(h)

    expect(confirmer.takeResponse(responseTo(idOf(h), { action: 'accept', content: {} }))).toBe(true)

    expect(await answer).toEqual({ kind: 'accepted', actor: 'client:claude-code' })
  })

  test('Decline: declined, in the name of the client', async () => {
    const h = harness()
    const { answer, confirmer } = await asked(h)

    confirmer.takeResponse(responseTo(idOf(h), { action: 'decline' }))

    expect(await answer).toEqual({ kind: 'declined', actor: 'client:claude-code' })
  })

  test('Esc: cancelled, in the name of the client', async () => {
    const h = harness()
    const { answer, confirmer } = await asked(h)

    confirmer.takeResponse(responseTo(idOf(h), { action: 'cancel' }))

    expect(await answer).toEqual({ kind: 'cancelled', actor: 'client:claude-code' })
  })

  test.each([
    ['an error response', (id: string) => ({ id, raw: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no' } }) })],
    ['a result with no action', (id: string) => responseTo(id, {})],
    ['an action nobody defined', (id: string) => responseTo(id, { action: 'maybe' })],
  ])('%s: failed — taken out of the stream, never a yes', async (_label, build) => {
    const h = harness()
    const { answer, confirmer } = await asked(h)

    expect(confirmer.takeResponse(build(idOf(h)))).toBe(true)

    expect(await answer).toEqual({ kind: 'failed' })
  })

  test('an Accept faster than a person can read does not count: asked once more', async () => {
    const h = harness()
    const confirmer = ready(h)
    const answer = confirmer.confirm(QUESTION)?.answer
    await flush()
    h.now += 200

    confirmer.takeResponse(responseTo(idOf(h), { action: 'accept' }))
    await flush()

    expect(await stateOf(answer as Promise<ConfirmAnswer>)).toBe('pending')
    expect(questionsSent(h)).toHaveLength(2)
    expect(idOf(h, 1)).toMatch(/-1-2$/)
    expect(messageOf(h, 1)).toMatch(/^That Accept came too fast to be read, so it did not count\. Press Accept again if you mean it\.\n/)
  })

  test('the second question answered at a human pace is accepted', async () => {
    const h = harness()
    const confirmer = ready(h)
    const answer = confirmer.confirm(QUESTION)?.answer
    await flush()
    h.now += 200
    confirmer.takeResponse(responseTo(idOf(h), { action: 'accept' }))
    await flush()
    h.now += 2_000

    confirmer.takeResponse(responseTo(idOf(h, 1), { action: 'accept' }))

    expect(await answer).toEqual({ kind: 'accepted', actor: 'client:claude-code' })
  })

  test('too fast twice: too-fast, which the gate refuses', async () => {
    const h = harness()
    const confirmer = ready(h)
    const answer = confirmer.confirm(QUESTION)?.answer
    await flush()
    confirmer.takeResponse(responseTo(idOf(h), { action: 'accept' }))
    await flush()

    confirmer.takeResponse(responseTo(idOf(h, 1), { action: 'accept' }))

    expect(await answer).toEqual({ kind: 'too-fast' })
    expect(questionsSent(h)).toHaveLength(2)
  })

  test('a fast Decline counts: refusing is never the risky direction', async () => {
    const h = harness()
    const confirmer = ready(h)
    const answer = confirmer.confirm(QUESTION)?.answer
    await flush()

    confirmer.takeResponse(responseTo(idOf(h), { action: 'decline' }))

    expect(await answer).toEqual({ kind: 'declined', actor: 'client:claude-code' })
  })

  test('responses that are not mcpcut\'s own are left for the server', () => {
    const confirmer = ready(harness())

    expect(confirmer.takeResponse(responseTo(7, { action: 'accept' }))).toBe(false)
    expect(confirmer.takeResponse(responseTo('server-elicit-1', { action: 'accept' }))).toBe(false)
  })

  test('an answer to a question already withdrawn is swallowed, not forwarded and not counted', async () => {
    const h = harness()
    const confirmer = ready(h)
    const pending = confirmer.confirm(QUESTION)
    await flush()
    const staleId = idOf(h)
    pending?.withdraw()
    h.now += 3_000

    expect(confirmer.takeResponse(responseTo(staleId, { action: 'accept' }))).toBe(true)

    expect(await pending?.answer).toEqual({ kind: 'withdrawn' })
  })
})

describe('withdrawing the question', () => {
  test('a call settled elsewhere (timeout, session end) closes the dialog with a cancellation', async () => {
    const h = harness()
    const confirmer = ready(h)
    const pending = confirmer.confirm(QUESTION)
    await flush()

    pending?.withdraw()

    expect(h.sent[1]).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: idOf(h), reason: 'The call was settled outside this dialog.' },
    })
    expect(await pending?.answer).toEqual({ kind: 'withdrawn' })
  })

  test('after an answer, withdrawing sends nothing and changes nothing', async () => {
    const h = harness()
    const confirmer = ready(h)
    const pending = confirmer.confirm(QUESTION)
    await flush()
    h.now += 3_000
    confirmer.takeResponse(responseTo(idOf(h), { action: 'decline' }))

    pending?.withdraw()

    expect(h.sent.filter((m) => m['method'] === 'notifications/cancelled')).toEqual([])
    expect(await pending?.answer).toEqual({ kind: 'declined', actor: 'client:claude-code' })
  })

  test('withdrawAll answers every open and waiting question', async () => {
    const h = harness()
    const confirmer = ready(h)
    const first = confirmer.confirm(QUESTION)
    const second = confirmer.confirm({ ...QUESTION, toolName: 'delete_file' })
    await flush()

    confirmer.withdrawAll()

    expect(await first?.answer).toEqual({ kind: 'withdrawn' })
    expect(await second?.answer).toEqual({ kind: 'withdrawn' })
    expect(questionsSent(h)).toHaveLength(1)
  })
})

describe('one question at a time', () => {
  test('a second call is asked only after the first dialog is answered', async () => {
    const h = harness()
    const confirmer = ready(h)
    confirmer.confirm(QUESTION)
    const second = confirmer.confirm({ ...QUESTION, toolName: 'delete_file' })
    await flush()
    expect(questionsSent(h)).toHaveLength(1)

    h.now += 3_000
    confirmer.takeResponse(responseTo(idOf(h), { action: 'decline' }))
    await flush()

    expect(questionsSent(h)).toHaveLength(2)
    expect(messageOf(h, 1)).toContain('allow delete_file on fs?')
    expect(await stateOf(second?.answer as Promise<ConfirmAnswer>)).toBe('pending')
  })

  test('the next dialog\'s clock starts when it is sent: an Enter meant for the first does not accept it', async () => {
    const h = harness()
    const confirmer = ready(h)
    confirmer.confirm(QUESTION)
    const second = confirmer.confirm({ ...QUESTION, toolName: 'delete_file' })
    await flush()
    h.now += 3_000
    confirmer.takeResponse(responseTo(idOf(h), { action: 'accept' }))
    await flush()
    h.now += 100

    confirmer.takeResponse(responseTo(idOf(h, 1), { action: 'accept' }))
    await flush()

    expect(await stateOf(second?.answer as Promise<ConfirmAnswer>)).toBe('pending')
    expect(idOf(h, 2)).toMatch(/-2-2$/)
  })

  test('a waiting question withdrawn before its turn is never shown', async () => {
    const h = harness()
    const confirmer = ready(h)
    confirmer.confirm(QUESTION)
    const second = confirmer.confirm({ ...QUESTION, toolName: 'delete_file' })
    await flush()

    second?.withdraw()
    h.now += 3_000
    confirmer.takeResponse(responseTo(idOf(h), { action: 'decline' }))
    await flush()

    expect(questionsSent(h)).toHaveLength(1)
    expect(await second?.answer).toEqual({ kind: 'withdrawn' })
  })

  test('withdrawing the dialog on screen shows the next one', async () => {
    const h = harness()
    const confirmer = ready(h)
    const first = confirmer.confirm(QUESTION)
    confirmer.confirm({ ...QUESTION, toolName: 'delete_file' })
    await flush()

    first?.withdraw()
    await flush()

    expect(questionsSent(h)).toHaveLength(2)
    expect(messageOf(h, 1)).toContain('allow delete_file on fs?')
  })
})

describe('the session', () => {
  test('ids carry a nonce: a server cannot squat or guess one, and its own prefixed ids pass through', async () => {
    const h = harness()
    const confirmer = ready(h)
    confirmer.confirm(QUESTION)
    await flush()

    expect(confirmer.takeResponse(responseTo(`${CLIENT_CONFIRM_ID_PREFIX}1`, { action: 'accept' }))).toBe(false)
  })

  test('the first initialize wins', async () => {
    const h = harness()
    const confirmer = ready(h)
    confirmer.observeInitialize(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 'cli:owner' } } }))

    const answer = confirmer.confirm(QUESTION)?.answer
    await flush()
    h.now += 3_000
    confirmer.takeResponse(responseTo(idOf(h), { action: 'accept' }))

    expect(await answer).toEqual({ kind: 'accepted', actor: 'client:claude-code' })
  })

  test('a question that cannot be sent is reported and answered failed, and the next one is still asked', async () => {
    const h = harness()
    const errors: unknown[] = []
    let sends = 0
    const confirmer = createClientConfirmer({
      ...h.deps,
      send: async (message) => {
        sends += 1
        if (sends === 1) throw new Error('client pipe closed')
        h.sent.push(message as Record<string, unknown>)
      },
      onError: (error) => errors.push(error),
    })
    confirmer.observeInitialize(INITIALIZE_WITH_FORMS)

    const first = confirmer.confirm(QUESTION)
    const second = confirmer.confirm({ ...QUESTION, toolName: 'delete_file' })
    await flush()
    await flush()

    expect(await first?.answer).toEqual({ kind: 'failed' })
    expect(errors).toHaveLength(1)
    expect(await stateOf(second?.answer as Promise<ConfirmAnswer>)).toBe('pending')
    expect(messageOf(h)).toContain('allow delete_file on fs?')
  })
})

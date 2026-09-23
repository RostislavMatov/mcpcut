import { describe, expect, test } from 'vitest'
import type { PoolRecordInfo } from '../../src/journal/pool-record.js'
import { createChildFrameHandler, createDropNotes, judgeChildNotification } from '../../src/pool/child-frames.js'
import { createPoolCorrelator, type PoolCorrelator } from '../../src/pool/correlator.js'
import type { PoolFanout } from '../../src/pool/fanout.js'
import { serverMessage } from '../../src/transport/message.js'
import { progressTokenOfNotification, progressTokenOfRequest } from '../../src/pool/multiplexer-frames.js'

/**
 * Which notifications of a pool member reach the agent (ADR-0015 phase 5,
 * N1/N2/N3). The pool declares only `tools.listChanged` and
 * `prompts.listChanged` to the agent (PE12), so that is all it passes on --
 * and progress, whose token the AGENT chose, only from the server it gave
 * that token to.
 */

const EXPLAIN = { progressServerOf: (): string | undefined => undefined }

function notification(method: string, params?: unknown): { raw: string; bytes: Buffer } {
  const raw = JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  return { raw, bytes: Buffer.from(raw, 'utf8') }
}

function judge(server: string, method: string, params: unknown, owners: Record<string, string> = {}) {
  const frame = notification(method, params)
  return judgeChildNotification({
    server,
    method,
    raw: frame.raw,
    bytes: frame.bytes,
    progressServerOf: (token) => owners[String(token)],
  })
}

describe('judgeChildNotification: progress (N2)', () => {
  test('forwards progress byte for byte from the server that holds the token', () => {
    const frame = notification('notifications/progress', { progressToken: 'p-1', progress: 1, total: 2 })

    const verdict = judgeChildNotification({
      server: 'alpha',
      method: 'notifications/progress',
      raw: frame.raw,
      bytes: frame.bytes,
      progressServerOf: (token) => (token === 'p-1' ? 'alpha' : undefined),
    })

    expect(verdict).toEqual({ kind: 'forward', bytes: frame.bytes })
    expect(verdict.kind === 'forward' && verdict.bytes).toBe(frame.bytes)
  })

  test('drops progress on a token another server holds', () => {
    expect(judge('beta', 'notifications/progress', { progressToken: 'p-1', progress: 1 }, { 'p-1': 'alpha' })).toEqual({
      kind: 'drop',
      reason: 'unscoped-notification',
    })
  })

  test('drops progress on a token no live request holds (answered, or never given)', () => {
    expect(judge('alpha', 'notifications/progress', { progressToken: 'p-1', progress: 1 })).toEqual({
      kind: 'drop',
      reason: 'unscoped-notification',
    })
  })

  test('drops progress that names no readable token', () => {
    expect(judge('alpha', 'notifications/progress', { progress: 1 }, { undefined: 'alpha' })).toEqual({
      kind: 'drop',
      reason: 'unscoped-notification',
    })
    expect(judge('alpha', 'notifications/progress', undefined)).toEqual({
      kind: 'drop',
      reason: 'unscoped-notification',
    })
  })
})

describe('judgeChildNotification: list_changed and everything else (N1)', () => {
  test.each(['notifications/tools/list_changed', 'notifications/prompts/list_changed'])(
    're-issues %s as the pool own frame, without the member params',
    (method) => {
      const verdict = judge('alpha', method, { injected: 'x' })

      expect(verdict.kind).toBe('forward')
      const sent = verdict.kind === 'forward' ? JSON.parse(verdict.bytes.toString('utf8')) : null
      expect(sent).toEqual({ jsonrpc: '2.0', method })
    },
  )

  test.each([
    'notifications/message',
    'notifications/resources/updated',
    'notifications/resources/list_changed',
    'notifications/cancelled',
    'notifications/elicitation/complete',
    'notifications/something-new',
  ])('drops %s as a method the pool never declared', (method) => {
    expect(judgeChildNotification({ server: 'alpha', method, raw: '{}', bytes: Buffer.from('{}'), ...EXPLAIN })).toEqual({
      kind: 'drop',
      reason: 'unsupported-method',
    })
  })
})

describe('createDropNotes (N3)', () => {
  test('says "first time" once per (server, reason, method)', () => {
    const notes = createDropNotes(10)

    expect(notes.firstTime('alpha', 'unsupported-method', 'notifications/message')).toBe(true)
    expect(notes.firstTime('alpha', 'unsupported-method', 'notifications/message')).toBe(false)
    expect(notes.firstTime('beta', 'unsupported-method', 'notifications/message')).toBe(true)
    expect(notes.firstTime('alpha', 'unscoped-notification', 'notifications/message')).toBe(true)
    expect(notes.firstTime('alpha', 'unsupported-method', 'notifications/resources/updated')).toBe(true)
  })

  test('keeps parts apart: no two different keys collide through the separator', () => {
    const notes = createDropNotes(10)

    expect(notes.firstTime('a-b', 'c', 'd')).toBe(true)
    expect(notes.firstTime('a', 'b-c', 'd')).toBe(true)
  })

  test('stops noting anything new at its cap', () => {
    const notes = createDropNotes(2)
    notes.firstTime('a', 'r', 'm1')
    notes.firstTime('a', 'r', 'm2')

    expect(notes.firstTime('a', 'r', 'm3')).toBe(false)
    expect(notes.firstTime('a', 'r', 'm1')).toBe(false)
  })
})

describe('progress token readers', () => {
  test.each([
    ['a string', 'p-1', 'p-1'],
    ['a number', 7, 7],
    ['zero', 0, 0],
    ['an object', { a: 1 }, null],
    ['null', null, null],
    ['a boolean', true, null],
  ])('reads %s from a request _meta', (_label, token, expected) => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', _meta: { progressToken: token } } })

    expect(progressTokenOfRequest(raw)).toEqual(expected)
  })

  test('reads nothing from a request without _meta, or with garbage', () => {
    expect(progressTokenOfRequest(JSON.stringify({ id: 1, method: 'tools/call', params: {} }))).toBeNull()
    expect(progressTokenOfRequest(JSON.stringify({ id: 1, method: 'tools/call', params: { _meta: 3 } }))).toBeNull()
    expect(progressTokenOfRequest(JSON.stringify({ id: 1, method: 'tools/call' }))).toBeNull()
    expect(progressTokenOfRequest('not json')).toBeNull()
  })

  test('reads the token a progress notification reports on', () => {
    expect(progressTokenOfNotification(JSON.stringify({ method: 'notifications/progress', params: { progressToken: 'p' } }))).toBe('p')
    expect(progressTokenOfNotification(JSON.stringify({ method: 'notifications/progress', params: { progressToken: 1e400 } }))).toBeNull()
    expect(progressTokenOfNotification(JSON.stringify({ method: 'notifications/progress' }))).toBeNull()
    expect(progressTokenOfNotification('{')).toBeNull()
  })
})

describe('createChildFrameHandler: the paths the multiplexer tests do not reach', () => {
  function handlerWith(overrides: { correlator?: PoolCorrelator; fanoutSettles?: boolean; closed?: boolean } = {}) {
    const sent: Buffer[] = []
    const records: Omit<PoolRecordInfo, 'agentName'>[] = []
    const errors: unknown[] = []
    const fanout: PoolFanout = {
      settle: () => overrides.fanoutSettles ?? false,
    } as unknown as PoolFanout
    const handle = createChildFrameHandler({
      correlator: overrides.correlator ?? createPoolCorrelator(10),
      fanout,
      send: (bytes) => sent.push(bytes),
      record: (info) => records.push(info),
      onError: (error) => errors.push(error),
      isClosed: () => overrides.closed ?? false,
    })
    const emit = (server: string, text: string): void => handle(server, serverMessage(Buffer.from(text, 'utf8')))
    return { emit, sent, records, errors }
  }

  test('notes a fan-out reply that outlived its own timeout as uncorrelated', () => {
    const correlator = createPoolCorrelator(10)
    const id = correlator.trackFanout('alpha', 'tools') ?? ''
    const { emit, sent, records } = handlerWith({ correlator, fanoutSettles: false })

    emit('alpha', JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }))

    expect(sent).toEqual([])
    expect(records).toEqual([{ event: 'dropped', serverName: 'alpha', reason: 'uncorrelated-reply' }])
  })

  test('settles a fan-out reply its waiter took, without a record', () => {
    const correlator = createPoolCorrelator(10)
    const id = correlator.trackFanout('alpha', 'tools') ?? ''
    const { emit, sent, records } = handlerWith({ correlator, fanoutSettles: true })

    emit('alpha', JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }))

    expect(sent).toEqual([])
    expect(records).toEqual([])
  })

  test('records an unreadable frame as unreadable, and sends nothing', () => {
    const { emit, sent, records } = handlerWith()

    emit('alpha', 'not json at all')

    expect(sent).toEqual([])
    expect(records).toEqual([{ event: 'dropped', serverName: 'alpha', reason: 'unreadable' }])
  })

  test('turns a failure inside the dispatch into a reported error, never a throw', () => {
    const correlator = {
      ...createPoolCorrelator(10),
      settle: () => {
        throw new Error('boom')
      },
    } as PoolCorrelator
    const { emit, errors } = handlerWith({ correlator })

    expect(() => emit('alpha', JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))).not.toThrow()
    expect(errors).toHaveLength(1)
  })

  test('ignores every frame once the pool is closed', () => {
    const { emit, sent, records } = handlerWith({ closed: true })

    emit('alpha', '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}')

    expect(sent).toEqual([])
    expect(records).toEqual([])
  })
})

describe('createChildFrameHandler: a server-chosen method is bounded before it is kept (security review LOW)', () => {
  test('keys and records at most 128 characters of the method', () => {
    const records: Omit<PoolRecordInfo, 'agentName'>[] = []
    const handle = createChildFrameHandler({
      correlator: createPoolCorrelator(10),
      fanout: { settle: () => false } as unknown as PoolFanout,
      send: () => undefined,
      record: (info) => records.push(info),
      onError: () => undefined,
      isClosed: () => false,
    })
    const long = `notifications/${'x'.repeat(5000)}`

    handle('alpha', serverMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: `${long}-a` }), 'utf8')))
    handle('alpha', serverMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: `${long}-b` }), 'utf8')))

    expect(records).toHaveLength(1)
    expect(records[0]?.method).toHaveLength(128)
  })
})

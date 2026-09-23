import { describe, expect, test } from 'vitest'
import {
  negotiateUpstream,
  type NegotiateInput,
  type UpstreamRevisionHint,
} from '../../src/pool/handshake.js'

/**
 * How the plane introduces itself to one pool member (ADR-0015 §4 and the
 * 2026-09-23 amendment, RV1-RV2): the handshake first, `server/discover` only
 * after an error or a revision with no handshake, and ONE deadline for both.
 */

const PLANE_VERSION = '0.1.0'

/** One scripted answer per tag; `null` = the upstream never answered. */
type Script = Readonly<Record<string, string | null>>

interface Run {
  readonly asked: Array<{ tag: string; line: string; timeoutMs: number }>
  readonly notified: string[]
  readonly outcome: Awaited<ReturnType<typeof negotiateUpstream>>
}

async function negotiate(
  script: Script,
  options: { hint?: UpstreamRevisionHint; deadline?: number; clock?: number[] } = {},
): Promise<Run> {
  const asked: Run['asked'] = []
  const notified: string[] = []
  // Each read of the clock takes the next value; the last one repeats.
  const clock = [...(options.clock ?? [0])]
  const now = (): number => (clock.length > 1 ? (clock.shift() as number) : (clock[0] as number))
  const input: NegotiateInput = {
    ask: (tag, buildLine, timeoutMs) => {
      asked.push({ tag, line: buildLine('plane-1'), timeoutMs })
      return Promise.resolve(script[tag] ?? null)
    },
    notify: (line) => {
      notified.push(line)
      return Promise.resolve()
    },
    hint: options.hint ?? 'legacy-first',
    deadline: options.deadline ?? 40_000,
    now,
    planeVersion: PLANE_VERSION,
  }
  const outcome = await negotiateUpstream(input)
  return { asked, notified, outcome }
}

function initializeResult(protocolVersion: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 'plane-1',
    result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fs', version: '1' } },
  })
}

const INITIALIZE_ERROR = JSON.stringify({
  jsonrpc: '2.0',
  id: 'plane-1',
  error: { code: -32022, message: 'unsupported', data: { supported: ['2026-07-28'], requested: '2025-11-25' } },
})

const DISCOVER_RESULT = JSON.stringify({
  jsonrpc: '2.0',
  id: 'plane-1',
  result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, resultType: 'complete' },
})

const DISCOVER_ERROR = JSON.stringify({ jsonrpc: '2.0', id: 'plane-1', error: { code: -32601, message: 'no' } })

describe('an old server', () => {
  test('is a sessionful member, greeted with `notifications/initialized`', async () => {
    const run = await negotiate({ initialize: initializeResult('2025-06-18') })

    expect(run.outcome).toEqual({ ok: true, discipline: { model: 'sessionful', protocolVersion: '2025-06-18' } })
    expect(run.asked.map((entry) => entry.tag)).toEqual(['initialize'])
    expect(run.notified).toEqual([JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })])
  })

  test('is told of NO client capabilities, so it will initiate none (PE3)', async () => {
    const run = await negotiate({ initialize: initializeResult('2025-11-25') })

    const sent = JSON.parse(run.asked[0]?.line as string) as {
      method: string
      params: { capabilities: Record<string, unknown>; clientInfo: { version: string } }
    }
    expect(sent.method).toBe('initialize')
    expect(sent.params.capabilities).toEqual({})
    expect(sent.params.clientInfo.version).toBe(PLANE_VERSION)
  })
})

describe('a dual-mode server', () => {
  test('that takes the handshake stays sessionful, and is never asked to discover', async () => {
    const run = await negotiate({ initialize: initializeResult('2025-11-25'), 'server/discover': DISCOVER_RESULT })

    expect(run.outcome).toMatchObject({ ok: true, discipline: { model: 'sessionful' } })
    expect(run.asked.map((entry) => entry.tag)).toEqual(['initialize'])
  })
})

describe('a server that speaks only 2026-07-28', () => {
  test('answering the handshake with an error is asked to discover and becomes stateless', async () => {
    const run = await negotiate({ initialize: INITIALIZE_ERROR, 'server/discover': DISCOVER_RESULT })

    expect(run.outcome).toEqual({ ok: true, discipline: { model: 'stateless', protocolVersion: '2026-07-28' } })
    expect(run.asked.map((entry) => entry.tag)).toEqual(['initialize', 'server/discover'])
    expect(run.notified).toEqual([])
  })

  test('answering the handshake WITH 2026-07-28 is asked to discover too', async () => {
    const run = await negotiate({ initialize: initializeResult('2026-07-28'), 'server/discover': DISCOVER_RESULT })

    expect(run.outcome).toMatchObject({ ok: true, discipline: { model: 'stateless' } })
    expect(run.notified).toEqual([])
  })

  test('whose discover also fails did not come up', async () => {
    const run = await negotiate({ initialize: INITIALIZE_ERROR, 'server/discover': DISCOVER_ERROR })

    expect(run.outcome).toEqual({ ok: false, reason: 'handshake-failed' })
  })

  test('whose discover names no version the plane speaks did not come up', async () => {
    const reply = JSON.stringify({ jsonrpc: '2.0', id: 'plane-1', result: { capabilities: {} } })
    const run = await negotiate({ initialize: INITIALIZE_ERROR, 'server/discover': reply })

    expect(run.outcome).toEqual({ ok: false, reason: 'handshake-failed' })
  })
})

describe('the registry’s hint', () => {
  test('`sessionful-only` never falls back to discover', async () => {
    const run = await negotiate(
      { initialize: INITIALIZE_ERROR, 'server/discover': DISCOVER_RESULT },
      { hint: 'sessionful-only' },
    )

    expect(run.outcome).toEqual({ ok: false, reason: 'handshake-failed' })
    expect(run.asked.map((entry) => entry.tag)).toEqual(['initialize'])
  })

  test('`stateless-only` never sends an initialize', async () => {
    const run = await negotiate({ 'server/discover': DISCOVER_RESULT }, { hint: 'stateless-only' })

    expect(run.outcome).toMatchObject({ ok: true, discipline: { model: 'stateless' } })
    expect(run.asked.map((entry) => entry.tag)).toEqual(['server/discover'])
  })
})

describe('the one deadline (BU1)', () => {
  test('no answer by the deadline is `start-timeout`', async () => {
    const run = await negotiate({ initialize: null }, { deadline: 1000, clock: [0, 1000] })

    expect(run.outcome).toEqual({ ok: false, reason: 'start-timeout' })
  })

  test('no answer BEFORE the deadline is a failed handshake, not a timeout', async () => {
    const run = await negotiate({ initialize: null }, { deadline: 1000, clock: [0, 10] })

    expect(run.outcome).toEqual({ ok: false, reason: 'handshake-failed' })
  })

  test('the second step gets what is left, not a fresh budget', async () => {
    const run = await negotiate(
      { initialize: INITIALIZE_ERROR, 'server/discover': DISCOVER_RESULT },
      { deadline: 40_000, clock: [0, 30_000] },
    )

    expect(run.asked.map((entry) => entry.timeoutMs)).toEqual([40_000, 10_000])
  })

  test('garbage for a handshake is a failure, without a discover', async () => {
    const run = await negotiate({ initialize: 'not json at all', 'server/discover': DISCOVER_RESULT })

    expect(run.outcome).toEqual({ ok: false, reason: 'handshake-failed' })
    expect(run.asked.map((entry) => entry.tag)).toEqual(['initialize'])
  })
})

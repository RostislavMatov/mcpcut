import { describe, expect, test, vi } from 'vitest'
import { createPoolChildren, type OpenPoolChild, type PoolChildEvent } from '../../src/pool/children.js'
import { MAX_POOL_CHILD_SESSIONS } from '../../src/pool/constants.js'
import { serverMessage, type MessageSink, type MessageSource } from '../../src/transport/message.js'

/**
 * The live child sessions of one pool, over the phase-1 route table.
 *
 * What this module does NOT do is as load-bearing as what it does: it never
 * reads a registry or a vault, because `src/pool/**` may not import
 * `src/cli/**` (a mechanical test enforces it). Opening one child is an
 * injected effect — the pool decides WHAT is addressable, not where a server
 * comes from.
 */

interface FakeChild {
  readonly server: string
  readonly written: string[]
  emit(text: string): void
  end(): void
  isClosed(): boolean
}

interface Harness {
  readonly open: OpenPoolChild
  readonly opened: FakeChild[]
  readonly events: PoolChildEvent[]
  readonly messages: { server: string; text: string }[]
  refuse(server: string, reason: string): void
  /** What the opened child will report as its departure reason (DR1). */
  departWith(server: string, reason: string | undefined): void
}

function createHarness(): Harness {
  const opened: FakeChild[] = []
  const events: PoolChildEvent[] = []
  const messages: { server: string; text: string }[] = []
  const refusals = new Map<string, string>()
  const departures = new Map<string, string | undefined>()

  const open: OpenPoolChild = (server) => {
    const refusal = refusals.get(server)
    if (refusal !== undefined) {
      return Promise.resolve({ status: 'refused' as const, reason: refusal })
    }

    let onMessage: ((message: ReturnType<typeof serverMessage>) => void) | null = null
    let onEnd: (() => void) | null = null
    let closed = false
    const written: string[] = []

    const sink: MessageSink = {
      write: (message) => {
        written.push(message.bytes.toString('utf8'))
        return Promise.resolve()
      },
      dispose: () => undefined,
    }
    const source: MessageSource = {
      onMessage: (handler) => {
        onMessage = handler
      },
      onError: () => undefined,
      onEnd: (handler) => {
        onEnd = handler
      },
      dispose: () => undefined,
    }
    const fake: FakeChild = {
      server,
      written,
      emit: (text) => onMessage?.(serverMessage(Buffer.from(text, 'utf8'))),
      end: () => onEnd?.(),
      isClosed: () => closed,
    }
    opened.push(fake)

    const result = {
      status: 'opened' as const,
      child: {
        server,
        sessionId: `session-${server}`,
        sink,
        close: () => {
          closed = true
          return Promise.resolve()
        },
      },
      source,
      ...(departures.has(server) ? { departureReason: () => departures.get(server) } : {}),
    }
    return Promise.resolve(result)
  }

  return {
    open,
    opened,
    events,
    messages,
    refuse: (server, reason) => refusals.set(server, reason),
    departWith: (server, reason) => departures.set(server, reason),
  }
}

const CLIENT_INFO = { name: 'mcpcut-pool', version: '0.0.0' }

const SESSIONFUL = { ok: true, discipline: { model: 'sessionful', protocolVersion: '2025-11-25' } } as const

/** A claim that is always granted and costs nothing to give back. */
function freeSlot() {
  return { release: () => undefined }
}

function createChildren(
  harness: Harness,
  maxChildren = MAX_POOL_CHILD_SESSIONS,
  handshake: (child: { server: string }) => Promise<boolean> = () => Promise.resolve(true),
) {
  return createPoolChildren({
    openChild: harness.open,
    negotiate: async (child) =>
      (await handshake(child))
        ? { ok: true, discipline: { model: 'sessionful', protocolVersion: '2025-11-25' } }
        : { ok: false, reason: 'handshake-failed' },
    clientInfo: CLIENT_INFO,
    startTimeoutMs: 40_000,
    abandonStart: () => undefined,
    reserveChild: (held) => (held < maxChildren ? freeSlot() : null),
    onEvent: (event) => harness.events.push(event),
    onChildMessage: (server, message) =>
      harness.messages.push({ server, text: message.bytes.toString('utf8') }),
  })
}

describe('ensure', () => {
  test('opens nothing for an agent with no grants', async () => {
    // Arrange
    const harness = createHarness()
    const children = createChildren(harness)

    // Act
    await children.ensure([])

    // Assert
    expect(children.servers()).toEqual([])
    expect(harness.opened).toHaveLength(0)
  })

  test('opens one child per granted server and reports each attach', async () => {
    const harness = createHarness()
    const children = createChildren(harness)

    await children.ensure(['github', 'fs'])

    expect(children.servers()).toEqual(['fs', 'github'])
    expect(harness.events).toEqual(
      expect.arrayContaining([
        // `lifetime` is `pool` unless the opener says otherwise (ADR-0016, RS9).
        { event: 'attach', server: 'fs', childSessionId: 'session-fs', lifetime: 'pool' },
        { event: 'attach', server: 'github', childSessionId: 'session-github', lifetime: 'pool' },
      ]),
    )
  })

  test('opens the pool WITHOUT a server that refused (PE6)', async () => {
    const harness = createHarness()
    harness.refuse('db', 'protocol-mismatch')
    const children = createChildren(harness)

    await children.ensure(['github', 'db'])

    expect(children.servers()).toEqual(['github'])
    expect(harness.events).toContainEqual({
      event: 'attach-refused',
      server: 'db',
      reason: 'protocol-mismatch',
    })
  })

  test('treats a thrown open as a refusal rather than letting it escape', async () => {
    // A pool whose `ensure` rejected would take the agent's `tools/list` down
    // with it; a server that blew up is just a server that is not there.
    const children = createPoolChildren({
      openChild: () => Promise.reject(new Error('spawn failed')),
      negotiate: () => Promise.resolve(SESSIONFUL),
      clientInfo: CLIENT_INFO,
      startTimeoutMs: 40_000,
      abandonStart: () => undefined,
      reserveChild: () => freeSlot(),
      onEvent: () => undefined,
      onChildMessage: () => undefined,
    })

    await expect(children.ensure(['github'])).resolves.toBeUndefined()
    expect(children.servers()).toEqual([])
  })

  test('does not open the same server twice when called again', async () => {
    const harness = createHarness()
    const children = createChildren(harness)

    await children.ensure(['github'])
    await children.ensure(['github'])

    expect(harness.opened).toHaveLength(1)
  })

  test('does not open the same server twice when two calls overlap', async () => {
    // Two `tools/list` in flight at once is ordinary for a correlating
    // session — the second must join the first open, not start a rival one.
    const harness = createHarness()
    const children = createChildren(harness)

    await Promise.all([children.ensure(['github']), children.ensure(['github'])])

    expect(harness.opened).toHaveLength(1)
  })

  test('refuses past the per-pool ceiling instead of throwing', async () => {
    // PE6 again: a full pool is a pool with fewer servers, never a refusal.
    const harness = createHarness()
    const children = createChildren(harness, 2)

    await children.ensure(['a', 'b', 'c'])

    expect(children.servers()).toHaveLength(2)
    expect(harness.events).toContainEqual({ event: 'attach-refused', server: 'c', reason: 'pool-full' })
  })

  test('leaves a server that is no longer granted alone — removal is detach', async () => {
    // `ensure` only opens. Closing what left is the watch's decision, made
    // explicitly through `detach`, so a transient read error can never shrink
    // the pool by accident.
    const harness = createHarness()
    const children = createChildren(harness)

    await children.ensure(['github', 'fs'])
    await children.ensure(['github'])

    expect(children.servers()).toEqual(['fs', 'github'])
  })
})

describe('child traffic', () => {
  test('hands every child message to the injected handler, tagged with its server', async () => {
    const harness = createHarness()
    const children = createChildren(harness)
    await children.ensure(['github'])

    harness.opened[0]?.emit('{"jsonrpc":"2.0","id":1,"result":{}}')

    expect(harness.messages).toEqual([
      { server: 'github', text: '{"jsonrpc":"2.0","id":1,"result":{}}' },
    ])
  })

  test('registers its handlers before the open resolves', async () => {
    // The lesson of `bridge/pump.ts`: a handler registered after an await
    // silently loses whatever the source emitted in the meantime.
    const harness = createHarness()
    const children = createChildren(harness)

    const ensured = children.ensure(['github'])
    await ensured

    // Nothing was missed: the very first emission after open is delivered.
    harness.opened[0]?.emit('first')
    expect(harness.messages).toHaveLength(1)
  })

  test('detaches a child whose own session ended', async () => {
    const harness = createHarness()
    const children = createChildren(harness)
    await children.ensure(['github'])

    harness.opened[0]?.end()
    await vi.waitFor(() => expect(children.servers()).toEqual([]))

    expect(harness.events).toContainEqual({
      event: 'detach',
      server: 'github',
      reason: 'child-ended',
    })
  })

  test('a child whose own session was revoked leaves as `ungranted` (DR1)', async () => {
    // Arrange
    const harness = createHarness()
    harness.departWith('github', 'ungranted')
    const children = createChildren(harness)
    await children.ensure(['github'])

    // Act
    harness.opened[0]?.end()
    await vi.waitFor(() => expect(children.servers()).toEqual([]))

    // Assert
    expect(harness.events.filter((event) => event.event === 'detach')).toEqual([
      { event: 'detach', server: 'github', reason: 'ungranted' },
    ])
  })

  test('without a departure reason it leaves as `child-ended`', async () => {
    // Arrange
    const harness = createHarness()
    harness.departWith('github', undefined)
    const children = createChildren(harness)
    await children.ensure(['github'])

    // Act
    harness.opened[0]?.end()
    await vi.waitFor(() => expect(children.servers()).toEqual([]))

    // Assert
    expect(harness.events).toContainEqual({ event: 'detach', server: 'github', reason: 'child-ended' })
  })
})

describe('detach and closeAll', () => {
  test('closes the child and forgets the route', async () => {
    const harness = createHarness()
    const children = createChildren(harness)
    await children.ensure(['github', 'fs'])

    await children.detach('github', 'revoked')

    expect(children.servers()).toEqual(['fs'])
    expect(harness.opened.find((c) => c.server === 'github')?.isClosed()).toBe(true)
    expect(harness.events).toContainEqual({
      event: 'detach',
      server: 'github',
      reason: 'revoked',
    })
  })

  test('detaching a server that is not there changes nothing', async () => {
    const harness = createHarness()
    const children = createChildren(harness)
    await children.ensure(['github'])
    harness.events.length = 0

    await children.detach('absent', 'revoked')

    expect(children.servers()).toEqual(['github'])
    expect(harness.events).toEqual([])
  })

  test('closes everything, and closing twice is a no-op', async () => {
    const harness = createHarness()
    const children = createChildren(harness)
    await children.ensure(['github', 'fs'])

    await children.closeAll()
    await children.closeAll()

    expect(children.servers()).toEqual([])
    expect(harness.opened.every((child) => child.isClosed())).toBe(true)
  })

  test('opens nothing after closeAll', async () => {
    // A late `tools/list` racing the teardown must not resurrect an upstream
    // the session has already promised to let go of.
    const harness = createHarness()
    const children = createChildren(harness)

    await children.closeAll()
    await children.ensure(['github'])

    expect(harness.opened).toHaveLength(0)
    expect(children.servers()).toEqual([])
  })

  test('childOf answers only for a live route', async () => {
    const harness = createHarness()
    const children = createChildren(harness)
    await children.ensure(['github'])

    expect(children.childOf('github')?.sessionId).toBe('session-github')
    expect(children.childOf('fs')).toBeUndefined()
  })
})

describe('the upstream handshake', () => {
  test('a server that will not complete it does not become routable (PE6)', async () => {
    // The plane answers the AGENT's `initialize` itself (PE12), so it has to
    // introduce itself to each upstream. One that refuses is a server that did
    // not come up — the pool opens without it.
    const harness = createHarness()
    const children = createChildren(harness, MAX_POOL_CHILD_SESSIONS, (child) =>
      Promise.resolve(child.server !== 'db'),
    )

    await children.ensure(['github', 'db'])

    expect(children.servers()).toEqual(['github'])
    expect(harness.events).toContainEqual({
      event: 'attach-refused',
      server: 'db',
      reason: 'handshake-failed',
    })
  })

  test('closes the child it refused, rather than leaking the upstream', async () => {
    const harness = createHarness()
    const children = createChildren(harness, MAX_POOL_CHILD_SESSIONS, () => Promise.resolve(false))

    await children.ensure(['github'])

    expect(harness.opened[0]?.isClosed()).toBe(true)
  })

  test('runs BEFORE the child is routable, so no call can reach an uninitialized server', async () => {
    // Order, not timing: while the handshake is in flight `childOf` must be
    // undefined, or a `tools/call` could be routed to a server that has not
    // been introduced to.
    const harness = createHarness()
    let observedDuringHandshake: readonly string[] = ['unset']
    const children = createChildren(harness, MAX_POOL_CHILD_SESSIONS, () => {
      observedDuringHandshake = children.servers()
      return Promise.resolve(true)
    })

    await children.ensure(['github'])

    expect(observedDuringHandshake).toEqual([])
    expect(children.servers()).toEqual(['github'])
  })

  test('hears its own answer, because the message handler is registered first', async () => {
    // The handshake reply arrives by the ordinary child-message path, so a
    // handler attached after it would lose the answer and every server would
    // look like it timed out.
    const harness = createHarness()
    let sawReply = false
    const children = createChildren(harness, MAX_POOL_CHILD_SESSIONS, () => {
      harness.opened.at(-1)?.emit('{"jsonrpc":"2.0","id":"x","result":{}}')
      sawReply = harness.messages.length === 1
      return Promise.resolve(true)
    })

    await children.ensure(['github'])

    expect(sawReply).toBe(true)
  })
})

describe('the process-wide budget, not only the per-pool one', () => {
  test('a child is refused when the caller will not grant a slot', async () => {
    // Plan decision P5: a child costs an upstream exactly as a top-level
    // session does, but it is opened long AFTER this pool passed the front's
    // own admission check. A cap that looked only at the per-pool number let
    // one agent with many grants grow past the process ceiling in a single
    // `tools/list`, so the ceiling is claimed fresh for every child.
    const harness = createHarness()
    let hasRoom = true
    const children = createPoolChildren({
      openChild: harness.open,
      negotiate: () => Promise.resolve(SESSIONFUL),
      clientInfo: CLIENT_INFO,
      startTimeoutMs: 40_000,
      abandonStart: () => undefined,
      reserveChild: () => (hasRoom ? freeSlot() : null),
      onEvent: (event) => harness.events.push(event),
      onChildMessage: () => undefined,
    })

    await children.ensure(['first'])
    hasRoom = false
    await children.ensure(['second'])

    expect(children.servers()).toEqual(['first'])
    expect(harness.events).toContainEqual({
      event: 'attach-refused',
      server: 'second',
      reason: 'pool-full',
    })
  })

  test('claims with what the pool already holds AND what it is opening', async () => {
    // N parallel opens must not all pass a ceiling only one of them fits.
    const harness = createHarness()
    const claimed: number[] = []
    const children = createPoolChildren({
      openChild: harness.open,
      negotiate: () => Promise.resolve(SESSIONFUL),
      clientInfo: CLIENT_INFO,
      startTimeoutMs: 40_000,
      abandonStart: () => undefined,
      reserveChild: (held) => {
        claimed.push(held)
        return freeSlot()
      },
      onEvent: () => undefined,
      onChildMessage: () => undefined,
    })

    await children.ensure(['a', 'b', 'c'])

    expect(claimed).toEqual([0, 1, 2])
  })

  test('takes the claim BEFORE the open starts, so a second pool sees it', async () => {
    // The reason this is a reservation and not a predicate. `openChild` is
    // async and the caller counts a child only once its transport is up, so a
    // question asked here could only report finished opens: two pools growing
    // at once would each see room and both take the last slot.
    const harness = createHarness()
    const order: string[] = []
    let releaseOpen = (): void => undefined
    const children = createPoolChildren({
      openChild: async (server) => {
        order.push('open-started')
        await new Promise<void>((resolve) => {
          releaseOpen = resolve
        })
        return harness.open(server)
      },
      negotiate: () => Promise.resolve(SESSIONFUL),
      clientInfo: CLIENT_INFO,
      startTimeoutMs: 40_000,
      abandonStart: () => undefined,
      reserveChild: () => {
        order.push('claimed')
        return freeSlot()
      },
      onEvent: () => undefined,
      onChildMessage: () => undefined,
    })

    const ensured = children.ensure(['github'])
    await vi.waitFor(() => expect(order).toContain('open-started'))
    releaseOpen()
    await ensured

    expect(order).toEqual(['claimed', 'open-started'])
  })

  test('gives the claim back once the open returns, whatever it returned', async () => {
    // Held any longer and the slot would be counted twice: by this claim and
    // by the caller's own tally of the child it just got. A refusal has
    // nothing to count at all, so it must free the slot too.
    const harness = createHarness()
    const released: string[] = []
    const children = createPoolChildren({
      openChild: harness.open,
      negotiate: () => Promise.resolve(SESSIONFUL),
      clientInfo: CLIENT_INFO,
      startTimeoutMs: 40_000,
      abandonStart: () => undefined,
      reserveChild: (held) => ({ release: () => released.push(`slot-${held}`) }),
      onEvent: () => undefined,
      onChildMessage: () => undefined,
    })

    harness.refuse('broken', 'spawn-failed')
    await children.ensure(['github', 'broken'])

    expect(released.sort()).toEqual(['slot-0', 'slot-1'])
  })

  test('gives back the claim it took for a server already being opened', async () => {
    // Two overlapping `ensure` calls join one open; the loser's claim is dead
    // weight against the ceiling until it is handed back.
    const harness = createHarness()
    let live = 0
    const children = createPoolChildren({
      openChild: harness.open,
      negotiate: () => Promise.resolve(SESSIONFUL),
      clientInfo: CLIENT_INFO,
      startTimeoutMs: 40_000,
      abandonStart: () => undefined,
      reserveChild: () => {
        live += 1
        return {
          release: () => {
            live -= 1
          },
        }
      },
      onEvent: () => undefined,
      onChildMessage: () => undefined,
    })

    await Promise.all([children.ensure(['github']), children.ensure(['github'])])

    expect(children.servers()).toEqual(['github'])
    expect(live).toBe(0)
  })
})

describe('the start deadline (BU1-BU3)', () => {
  test('takes the deadline BEFORE the open, so the spawn counts against it', async () => {
    // Arrange
    const harness = createHarness()
    let clock = 1000
    let seenDeadline = 0
    const children = createPoolChildren({
      openChild: async (server) => {
        clock += 700
        return harness.open(server)
      },
      negotiate: (_child, start) => {
        seenDeadline = start.deadline
        return Promise.resolve(SESSIONFUL)
      },
      clientInfo: CLIENT_INFO,
      startTimeoutMs: 5000,
      now: () => clock,
      abandonStart: () => undefined,
      reserveChild: () => freeSlot(),
      onEvent: () => undefined,
      onChildMessage: () => undefined,
    })

    // Act
    await children.ensure(['github'])

    // Assert
    expect(seenDeadline).toBe(6000)
  })

  test('reports the reason the handshake gave', async () => {
    // Arrange
    const harness = createHarness()
    const children = createPoolChildren({
      openChild: harness.open,
      negotiate: () => Promise.resolve({ ok: false, reason: 'start-timeout' } as const),
      clientInfo: CLIENT_INFO,
      startTimeoutMs: 5000,
      abandonStart: () => undefined,
      reserveChild: () => freeSlot(),
      onEvent: (event) => harness.events.push(event),
      onChildMessage: () => undefined,
    })

    // Act
    await children.ensure(['github'])

    // Assert
    expect(harness.events).toEqual([{ event: 'attach-refused', server: 'github', reason: 'start-timeout' }])
    expect(harness.opened[0]?.isClosed()).toBe(true)
  })

  test('a child that dies mid-start is abandoned at once and refused as `ended-during-start`', async () => {
    // Arrange
    const harness = createHarness()
    const abandoned: string[] = []
    let finishHandshake: (outcome: { ok: false; reason: 'handshake-failed' }) => void = () => undefined
    const children = createPoolChildren({
      openChild: harness.open,
      negotiate: () =>
        new Promise((resolve) => {
          finishHandshake = resolve
        }),
      clientInfo: CLIENT_INFO,
      startTimeoutMs: 40_000,
      abandonStart: (server) => {
        abandoned.push(server)
        // What the real fan-out does: the wait ends now, with no answer.
        finishHandshake({ ok: false, reason: 'handshake-failed' })
      },
      reserveChild: () => freeSlot(),
      onEvent: (event) => harness.events.push(event),
      onChildMessage: () => undefined,
    })
    const ensured = children.ensure(['github'])
    await vi.waitFor(() => expect(harness.opened).toHaveLength(1))

    // Act
    harness.opened[0]?.end()
    await ensured

    // Assert
    expect(abandoned).toEqual(['github'])
    expect(harness.events).toEqual([
      { event: 'attach-refused', server: 'github', reason: 'ended-during-start' },
    ])
    expect(children.servers()).toEqual([])
  })

  test('a child that dies AFTER it was routed is a departure, not an abandoned start', async () => {
    // Arrange
    const harness = createHarness()
    const abandoned: string[] = []
    const children = createPoolChildren({
      openChild: harness.open,
      negotiate: () => Promise.resolve(SESSIONFUL),
      clientInfo: CLIENT_INFO,
      startTimeoutMs: 40_000,
      abandonStart: (server) => abandoned.push(server),
      reserveChild: () => freeSlot(),
      onEvent: (event) => harness.events.push(event),
      onChildMessage: () => undefined,
    })
    await children.ensure(['github'])

    // Act
    harness.opened[0]?.end()

    // Assert
    expect(abandoned).toEqual([])
    await vi.waitFor(() =>
      expect(harness.events).toContainEqual({ event: 'detach', server: 'github', reason: 'child-ended' }),
    )
  })
})

describe('members of either revision (RV3)', () => {
  function childrenNegotiating(harness: Harness, model: 'sessionful' | 'stateless', calls: string[] = []) {
    return createPoolChildren({
      openChild: harness.open,
      negotiate: (child) => {
        calls.push(child.server)
        return Promise.resolve(
          model === 'stateless'
            ? { ok: true, discipline: { model: 'stateless', protocolVersion: '2026-07-28' } }
            : SESSIONFUL,
        )
      },
      clientInfo: CLIENT_INFO,
      startTimeoutMs: 40_000,
      abandonStart: () => undefined,
      reserveChild: () => freeSlot(),
      onEvent: (event) => harness.events.push(event),
      onChildMessage: (server, message) =>
        harness.messages.push({ server, text: message.bytes.toString('utf8') }),
    })
  }

  const CALL = { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'echo' } }

  test('every write to a stateless member is stamped', async () => {
    // Arrange
    const harness = createHarness()
    const children = childrenNegotiating(harness, 'stateless')
    await children.ensure(['modern'])

    // Act
    await children.childOf('modern')?.sink.write(serverMessage(Buffer.from(JSON.stringify(CALL), 'utf8')))

    // Assert
    expect(harness.opened[0]?.written.at(-1)).toContain('io.modelcontextprotocol/protocolVersion')
  })

  test('a sessionful member is written to untouched', async () => {
    // Arrange
    const harness = createHarness()
    const children = childrenNegotiating(harness, 'sessionful')
    await children.ensure(['old'])

    // Act
    await children.childOf('old')?.sink.write(serverMessage(Buffer.from(JSON.stringify(CALL), 'utf8')))

    // Assert
    expect(harness.opened[0]?.written.at(-1)).toBe(JSON.stringify(CALL))
  })

  test('a child that arrives already negotiated is not negotiated again', async () => {
    // Arrange
    const harness = createHarness()
    const calls: string[] = []
    const children = createPoolChildren({
      openChild: async (server) => ({
        ...(await harness.open(server)),
        negotiated: { model: 'stateless', protocolVersion: '2026-07-28' },
      }) as never,
      negotiate: (child) => {
        calls.push(child.server)
        return Promise.resolve(SESSIONFUL)
      },
      clientInfo: CLIENT_INFO,
      startTimeoutMs: 40_000,
      abandonStart: () => undefined,
      reserveChild: () => freeSlot(),
      onEvent: (event) => harness.events.push(event),
      onChildMessage: () => undefined,
    })

    // Act
    await children.ensure(['held'])
    await children.childOf('held')?.sink.write(serverMessage(Buffer.from(JSON.stringify(CALL), 'utf8')))

    // Assert
    expect(calls).toEqual([])
    expect(children.servers()).toEqual(['held'])
    expect(harness.opened[0]?.written.at(-1)).toContain('io.modelcontextprotocol/protocolVersion')
  })

  test('a stateless predecessor’s late frame is still not read as its successor’s', async () => {
    // The wrapper is a NEW object; the instance lock must compare against it,
    // or every frame of a stateless member would be dropped — or worse, a
    // predecessor's would pass.
    const harness = createHarness()
    const children = childrenNegotiating(harness, 'stateless')
    await children.ensure(['modern'])
    const first = harness.opened[0]
    first?.emit('{"jsonrpc":"2.0","id":1,"result":{}}')
    await children.detach('modern', 'fanout-timeout')
    await children.ensure(['modern'])

    // Act
    first?.emit('{"jsonrpc":"2.0","id":2,"result":{}}')
    harness.opened[1]?.emit('{"jsonrpc":"2.0","id":3,"result":{}}')

    // Assert
    expect(harness.messages.map((entry) => entry.text)).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":3,"result":{}}',
    ])
  })
})

describe('dirty departures (ADR-0016, RS5)', () => {
  function childrenRecordingCloses(harness: Harness, closes: Array<{ server: string; dirty: boolean }>) {
    return createPoolChildren({
      openChild: async (server, start) => {
        const opened = await harness.open(server, start)
        if (opened.status !== 'opened') return opened
        return {
          ...opened,
          child: {
            ...opened.child,
            close: (options?: { readonly dirty?: boolean }) => {
              closes.push({ server, dirty: options?.dirty === true })
              return Promise.resolve()
            },
          },
        }
      },
      negotiate: () => Promise.resolve(SESSIONFUL),
      clientInfo: CLIENT_INFO,
      startTimeoutMs: 40_000,
      abandonStart: () => undefined,
      reserveChild: () => freeSlot(),
      onEvent: () => undefined,
      onChildMessage: () => undefined,
    })
  }

  test('detach hands `dirty` to the child it closes', async () => {
    const harness = createHarness()
    const closes: Array<{ server: string; dirty: boolean }> = []
    const children = childrenRecordingCloses(harness, closes)
    await children.ensure(['github', 'fs'])

    await children.detach('github', 'fanout-timeout', { dirty: true })
    await children.detach('fs', 'ungranted')

    expect(closes).toEqual([
      { server: 'github', dirty: true },
      { server: 'fs', dirty: false },
    ])
  })

  test('closeAll asks `dirtyOf` about each child', async () => {
    const harness = createHarness()
    const closes: Array<{ server: string; dirty: boolean }> = []
    const children = childrenRecordingCloses(harness, closes)
    await children.ensure(['github', 'fs'])

    await children.closeAll({ dirtyOf: (server) => server === 'fs' })

    expect(closes).toEqual(
      expect.arrayContaining([
        { server: 'github', dirty: false },
        { server: 'fs', dirty: true },
      ]),
    )
  })
})

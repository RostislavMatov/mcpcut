import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentRecord } from '../../src/agents/schema.js'
import type { OpenedChildSession } from '../../src/cli/serve-child.js'
import { createMemoryPipe } from '../../src/cli/serve-pipe.js'
import { createResidentSupervisor, type AcquireResult } from '../../src/cli/serve-residents.js'
import type { OpenStartResult } from '../../src/cli/serve-residents-start.js'
import type { ResidentPair } from '../../src/pool/residents.js'
import type { StdioServerRecord } from '../../src/registry/schema.js'
import type { SessionEndReason } from '../../src/session/core.js'

/**
 * The resident supervisor, transition by transition (ADR-0016, RS4-RS8),
 * over fake starts on REAL memory pipes. Each fake session ends the moment it
 * is closed — synchronously — so a supervisor that mistook its own close for a
 * crash would show it here.
 */

const CREATED = '2026-09-01T00:00:00.000Z'
const PAIR: ResidentPair = { agentName: 'bot', agentCreatedAt: CREATED, serverName: 'memory' }
const RECORD = { name: 'memory', transport: 'stdio', command: 'node', args: ['m.js'] } as StdioServerRecord
const FAR = Number.MAX_SAFE_INTEGER

/** When set, every session's close waits for `releaseCloses()` — a process slow to exit. */
let heldCloses: Array<() => void> | null = null

function releaseCloses(): void {
  for (const release of heldCloses?.splice(0) ?? []) release()
}

interface FakeSession {
  readonly opened: OpenedChildSession
  end(reason: SessionEndReason): void
  isClosed(): boolean
}

function fakeSession(id: string): FakeSession {
  const pipe = createMemoryPipe()
  let reason: SessionEndReason | null = null
  let closed = false
  return {
    opened: {
      sessionId: id,
      sink: pipe.front.sink,
      source: pipe.front.source,
      endReason: () => reason,
      close: () => {
        if (!closed) {
          closed = true
          reason ??= 'closed'
          pipe.endFrontSource()
        }
        const waiting = heldCloses
        return waiting === null ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve))
      },
    },
    end: (why) => {
      reason = why
      pipe.endFrontSource()
    },
    isClosed: () => closed,
  }
}

interface Harness {
  readonly supervisor: ReturnType<typeof createResidentSupervisor>
  readonly sessions: FakeSession[]
  readonly stderr: string[]
  secret: string
  failNext: string[]
  room: number
  agent: AgentRecord | undefined
}

function createHarness(options: { idleMs?: number; maxWarmIdle?: number } = {}): Harness {
  const harness: Harness = {
    sessions: [],
    stderr: [],
    secret: 'one',
    failNext: [],
    room: 100,
    agent: { name: 'bot', tokenHash: 'x', createdAt: CREATED, grants: { memory: { tools: '*' }, fs: { tools: '*' } } } as AgentRecord,
    supervisor: undefined as never,
  }
  const supervisor = createResidentSupervisor({
    openStart: (job): Promise<OpenStartResult> => {
      const failure = harness.failNext.shift()
      if (failure !== undefined) return Promise.resolve({ ok: false, reason: failure })
      const session = fakeSession(`${job.pair.serverName}-${harness.sessions.length + 1}`)
      harness.sessions.push(session)
      return Promise.resolve({
        ok: true,
        opened: session.opened,
        discipline: { model: 'sessionful', protocolVersion: '2025-11-25' },
        fingerprint: harness.secret,
        knownSecrets: [harness.secret],
      })
    },
    readAgent: () => Promise.resolve(harness.agent),
    resolveDeclared: () => Promise.resolve({ status: 'resolved', values: { SECRET: harness.secret } }),
    fingerprintOf: (_record, values) => values['SECRET'] ?? '',
    hasRoom: () => supervisor.processCount < harness.room,
    concurrency: 2,
    startTimeoutMs: 40_000,
    idleMs: options.idleMs ?? 600_000,
    maxWarmIdle: options.maxWarmIdle ?? 32,
    restartBaseMs: 1000,
    restartMaxMs: 60_000,
    maxFailures: 5,
    now: () => Date.now(),
    stderr: { write: (line: string) => harness.stderr.push(line) },
  })
  return Object.assign(harness, { supervisor })
}

function attachedOf(result: AcquireResult) {
  if (result.status !== 'attached') throw new Error(`expected attached, got ${JSON.stringify(result)}`)
  return result
}

async function flush(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve()
}

function residentNow(harness: Harness, pairs: readonly ResidentPair[] = [PAIR], overCap: readonly ResidentPair[] = []): void {
  harness.supervisor.applyDesired({ resident: pairs, overCap }, new Map([['memory', RECORD], ['fs', { ...RECORD, name: 'fs', args: ['f.js'] }]]))
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  releaseCloses()
  heldCloses = null
  vi.useRealTimers()
})

describe('acquire', () => {
  test('starts a warm server on demand and attaches the agent to it', async () => {
    const harness = createHarness()

    const result = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))

    expect(result.lifetime).toBe('warm')
    expect(result.knownSecrets).toEqual(['one'])
    expect(harness.sessions).toHaveLength(1)
    expect(harness.supervisor.processCount).toBe(1)
  })

  test('a second pool session of the same agent is told `busy`', async () => {
    const harness = createHarness()
    attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))

    expect(await harness.supervisor.acquire(PAIR, RECORD, FAR)).toEqual({ status: 'busy' })
  })

  test('another agent — or the same name created again — gets its own process (RS3)', async () => {
    const harness = createHarness()
    attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))
    harness.agent = { ...(harness.agent as AgentRecord), createdAt: '2026-09-02T00:00:00.000Z' }

    const again = attachedOf(
      await harness.supervisor.acquire({ ...PAIR, agentCreatedAt: '2026-09-02T00:00:00.000Z' }, RECORD, FAR),
    )

    expect(harness.sessions).toHaveLength(2)
    expect(again.attachment.child.sessionId).toBe('memory-2')
  })

  test('a failed start is refused with its own reason (BU3)', async () => {
    const harness = createHarness()
    harness.failNext.push('ended-during-start')

    expect(await harness.supervisor.acquire(PAIR, RECORD, FAR)).toEqual({ status: 'refused', reason: 'ended-during-start' })
    expect(harness.supervisor.processCount).toBe(0)
  })

  test('no room for a process is `pool-full`', async () => {
    const harness = createHarness()
    harness.room = 0

    expect(await harness.supervisor.acquire(PAIR, RECORD, FAR)).toEqual({ status: 'refused', reason: 'pool-full' })
  })

  test('a rotated secret restarts the server before the agent gets it (RS4)', async () => {
    // Arrange
    const harness = createHarness()
    residentNow(harness)
    await flush()
    harness.secret = 'two'

    // Act
    const result = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))

    // Assert
    expect(harness.sessions[0]?.isClosed()).toBe(true)
    expect(result.attachment.child.sessionId).toBe('memory-2')
    expect(result.knownSecrets).toEqual(['two'])
    expect(harness.supervisor.processCount).toBe(1)
  })
})

describe('release', () => {
  test('a clean release keeps a resident running, and the next attach gets the same session', async () => {
    const harness = createHarness()
    residentNow(harness)
    await flush()
    const first = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))

    await first.attachment.child.close()
    const second = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))

    expect(second.lifetime).toBe('resident')
    expect(second.attachment.child.sessionId).toBe(first.attachment.child.sessionId)
    expect(harness.sessions).toHaveLength(1)
  })

  test('a dirty release never hands that session out again: a resident comes back fresh (RS5)', async () => {
    const harness = createHarness()
    residentNow(harness)
    await flush()
    const first = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))

    await first.attachment.child.close({ dirty: true })
    await flush()

    expect(harness.sessions[0]?.isClosed()).toBe(true)
    expect(harness.sessions).toHaveLength(2)
    const second = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))
    expect(second.attachment.child.sessionId).toBe('memory-2')
    expect(harness.supervisor.processCount).toBe(1)
    // Its own close is not a crash: no pause, no failure counted.
    expect(harness.stderr.join('')).not.toContain('restarting in')
  })

  test('a dirty release of a warm server closes it for good', async () => {
    const harness = createHarness()
    const first = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))

    await first.attachment.child.close({ dirty: true })

    expect(harness.sessions[0]?.isClosed()).toBe(true)
    expect(harness.supervisor.processCount).toBe(0)
  })

  test('a warm server released dirty is not started again until the old process has exited (BU4)', async () => {
    // Arrange — the old process takes its time to exit.
    heldCloses = []
    const harness = createHarness()
    const first = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))
    void first.attachment.child.close({ dirty: true })
    await flush()

    // Act — the agent comes straight back.
    const again = harness.supervisor.acquire(PAIR, RECORD, FAR)
    await flush()
    const startedWhileExiting = harness.sessions.length
    releaseCloses()
    const result = attachedOf(await again)

    // Assert
    expect(startedWhileExiting).toBe(1)
    expect(result.attachment.child.sessionId).toBe('memory-2')
  })

  test('a warm server lives `idleMs` after its release, then goes', async () => {
    const harness = createHarness({ idleMs: 200 })
    const first = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))
    await first.attachment.child.close()

    await vi.advanceTimersByTimeAsync(150)
    const reused = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))
    await reused.attachment.child.close()
    await vi.advanceTimersByTimeAsync(250)

    expect(reused.attachment.child.sessionId).toBe('memory-1')
    expect(harness.sessions[0]?.isClosed()).toBe(true)
    expect(harness.supervisor.processCount).toBe(0)
  })

  test('with `idleMs` 0 a warm server closes at its release', async () => {
    const harness = createHarness({ idleMs: 0 })
    const first = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))

    await first.attachment.child.close()

    expect(harness.sessions[0]?.isClosed()).toBe(true)
    expect(harness.supervisor.processCount).toBe(0)
  })

  test('after `seal`, a release closes', async () => {
    const harness = createHarness()
    residentNow(harness)
    await flush()
    const first = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))

    harness.supervisor.seal()
    await first.attachment.child.close()

    expect(harness.sessions[0]?.isClosed()).toBe(true)
    expect(harness.supervisor.processCount).toBe(0)
  })
})

describe('reconcile', () => {
  test('a resident starts with no agent attached', async () => {
    const harness = createHarness()

    residentNow(harness)
    await flush()

    expect(harness.sessions).toHaveLength(1)
    expect(harness.stderr.join('')).toContain('[serve] resident bot/memory: ready (2025-11-25)')
  })

  test('a warm server that becomes resident is promoted, not restarted', async () => {
    const harness = createHarness({ idleMs: 200 })
    const first = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))
    await first.attachment.child.close()

    residentNow(harness)
    await vi.advanceTimersByTimeAsync(500)

    expect(harness.sessions).toHaveLength(1)
    expect(harness.sessions[0]?.isClosed()).toBe(false)
  })

  test('a grant withdrawn stops an idle resident', async () => {
    const harness = createHarness()
    residentNow(harness)
    await flush()

    residentNow(harness, [])
    await flush()

    expect(harness.sessions[0]?.isClosed()).toBe(true)
    expect(harness.supervisor.processCount).toBe(0)
  })

  test('a grant withdrawn while attached retires it: stopped at the release', async () => {
    const harness = createHarness()
    residentNow(harness)
    await flush()
    const first = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))

    residentNow(harness, [])
    expect(harness.sessions[0]?.isClosed()).toBe(false)
    await first.attachment.child.close()

    expect(harness.sessions[0]?.isClosed()).toBe(true)
    expect(harness.supervisor.processCount).toBe(0)
  })

  test('an edited record restarts an idle resident, and waits for an attached one', async () => {
    const harness = createHarness()
    residentNow(harness)
    await flush()
    const first = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))
    const edited = new Map([['memory', { ...RECORD, args: ['m.js', '--new'] }]])

    harness.supervisor.applyDesired({ resident: [PAIR], overCap: [] }, edited)
    expect(harness.sessions).toHaveLength(1)
    await first.attachment.child.close()
    await flush()

    expect(harness.sessions[0]?.isClosed()).toBe(true)
    expect(harness.sessions).toHaveLength(2)
  })
})

describe('ends and restarts (RS6)', () => {
  test('a resident that ends restarts after 1, 2, 4, 8 s, and gives up at the 5th failure in a row', async () => {
    // Arrange
    const harness = createHarness()
    residentNow(harness)
    await flush()
    harness.failNext.push('ended-during-start', 'ended-during-start', 'ended-during-start', 'ended-during-start')

    // Act
    harness.sessions[0]?.end('server-ended')
    await flush()
    for (const pause of [1000, 2000, 4000, 8000]) await vi.advanceTimersByTimeAsync(pause)

    // Assert
    const log = harness.stderr.join('')
    expect(log).toContain('restarting in 1 s')
    expect(log).toContain('restarting in 2 s')
    expect(log).toContain('restarting in 4 s')
    expect(log).toContain('restarting in 8 s')
    expect(log).toContain('gave up after 5 failures in a row (last: ended-during-start)')
    expect(await harness.supervisor.acquire(PAIR, RECORD, FAR)).toEqual({ status: 'refused', reason: 'start-failed' })
    expect(harness.supervisor.processCount).toBe(0)
  })

  test('a session its own watch revoked is not restarted', async () => {
    const harness = createHarness()
    residentNow(harness)
    await flush()

    harness.sessions[0]?.end('revoked')
    await vi.advanceTimersByTimeAsync(5000)

    expect(harness.sessions).toHaveLength(1)
    expect(harness.supervisor.processCount).toBe(0)
  })

  test('an attached resident that dies is restarted for the next attach', async () => {
    const harness = createHarness()
    residentNow(harness)
    await flush()
    const first = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))
    let ended = false
    first.attachment.source.onEnd(() => {
      ended = true
    })

    harness.sessions[0]?.end('server-ended')
    await vi.advanceTimersByTimeAsync(1000)

    expect(ended).toBe(true)
    expect(harness.sessions).toHaveLength(2)
  })
})

describe('the budget (RS7)', () => {
  test('an idle warm server yields to a new process; a resident and an attached one never do', async () => {
    // Arrange: one resident, one attached warm, one idle warm; room for 3.
    const harness = createHarness()
    harness.room = 3
    residentNow(harness)
    await flush()
    const idlePair = { ...PAIR, serverName: 'fs' }
    const idle = attachedOf(await harness.supervisor.acquire(idlePair, { ...RECORD, name: 'fs' }, FAR))
    await idle.attachment.child.close()
    const heldPair = { ...PAIR, agentName: 'other', serverName: 'memory' }
    harness.agent = { ...(harness.agent as AgentRecord), name: 'other' }
    attachedOf(await harness.supervisor.acquire(heldPair, RECORD, FAR))

    // Act
    const evicted = harness.supervisor.evictIdleWarm()
    const again = harness.supervisor.evictIdleWarm()

    // Assert
    expect(evicted).toBe(true)
    expect(again).toBe(false)
    expect(harness.sessions.map((session) => session.isClosed())).toEqual([false, true, false])
    expect(harness.supervisor.processCount).toBe(2)
  })

  test('past the idle-warm cap the longest idle goes', async () => {
    const harness = createHarness({ maxWarmIdle: 1 })
    const one = attachedOf(await harness.supervisor.acquire(PAIR, RECORD, FAR))
    const two = attachedOf(await harness.supervisor.acquire({ ...PAIR, serverName: 'fs' }, { ...RECORD, name: 'fs' }, FAR))

    await one.attachment.child.close()
    await vi.advanceTimersByTimeAsync(10)
    await two.attachment.child.close()

    expect(harness.sessions.map((session) => session.isClosed())).toEqual([true, false])
  })
})

describe('closeAll', () => {
  test('leaves no process behind', async () => {
    const harness = createHarness()
    residentNow(harness)
    await flush()
    attachedOf(await harness.supervisor.acquire({ ...PAIR, serverName: 'fs' }, { ...RECORD, name: 'fs' }, FAR))

    await harness.supervisor.closeAll()

    expect(harness.sessions.every((session) => session.isClosed())).toBe(true)
    expect(harness.supervisor.processCount).toBe(0)
    expect(await harness.supervisor.acquire(PAIR, RECORD, FAR)).toEqual({ status: 'refused', reason: 'pool-full' })
  })
})

import { describe, expect, test } from 'vitest'
import type { PoolRecordInfo } from '../../src/journal/pool-record.js'
import type { PoolCatalog } from '../../src/pool/catalog.js'
import type { PoolChild, PoolChildren } from '../../src/pool/children.js'
import { createPoolCorrelator } from '../../src/pool/correlator.js'
import type { PoolFanout } from '../../src/pool/fanout.js'
import { createPoolMultiplexer } from '../../src/pool/multiplexer.js'
import type { PoolWatch } from '../../src/pool/watch.js'

/**
 * Which departures are DIRTY (ADR-0016, RS5): a child let go while the pool
 * still had requests in flight there. A held session released dirty is never
 * attached again — so dirtiness must be measured BEFORE `releaseServer` forgets
 * the entries, and a pool that closes with calls out says so in its journal.
 */

interface Calls {
  readonly detached: Array<{ server: string; reason: string; dirty: boolean }>
  closedAllWith: ((server: string) => boolean) | undefined
}

function harness(servers: readonly string[]) {
  const correlator = createPoolCorrelator(100)
  const records: PoolRecordInfo[] = []
  const calls: Calls = { detached: [], closedAllWith: undefined }
  let routed = [...servers]
  const child = (server: string): PoolChild => ({
    server,
    sessionId: `s-${server}`,
    sink: { write: () => Promise.resolve(), dispose: () => undefined },
    close: () => Promise.resolve(),
  })
  const children: PoolChildren = {
    servers: () => routed,
    childOf: (server) => (routed.includes(server) ? child(server) : undefined),
    ensure: () => Promise.resolve(),
    detach: (server, reason, options) => {
      calls.detached.push({ server, reason, dirty: options?.dirty === true })
      routed = routed.filter((name) => name !== server)
      return Promise.resolve()
    },
    closeAll: (options) => {
      calls.closedAllWith = options?.dirtyOf
      return Promise.resolve()
    },
  }
  const watch: PoolWatch = { granted: servers, start: () => undefined, stop: () => undefined }
  const mux = createPoolMultiplexer({
    agentName: 'bot',
    planeVersion: '0.0.0',
    children,
    catalog: {} as PoolCatalog,
    correlator,
    fanout: {} as PoolFanout,
    watch,
    journal: (info) => records.push(info),
    toAgent: () => undefined,
    onError: (error) => {
      throw error
    },
  })
  return { mux, correlator, records, calls }
}

function call(id: number, name: string): Buffer {
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } }))
}

describe('an ungranted server', () => {
  test('with a call in flight leaves DIRTY — judged before the calls are released', async () => {
    // Arrange
    const { mux, calls } = harness(['fs', 'gh'])
    mux.handleAgentFrame(call(1, 'fs__read'))

    // Act
    await mux.onMembershipChanged(['gh'])

    // Assert
    expect(calls.detached).toEqual([{ server: 'fs', reason: 'ungranted', dirty: true }])
  })

  test('with nothing in flight leaves clean', async () => {
    const { mux, calls } = harness(['fs', 'gh'])
    mux.handleAgentFrame(call(1, 'gh__search'))

    await mux.onMembershipChanged(['gh'])

    expect(calls.detached).toEqual([{ server: 'fs', reason: 'ungranted', dirty: false }])
  })

  test('a plane request of its own in flight makes it dirty too', async () => {
    // A late `tools/list` reply would otherwise settle the next pool's own
    // request under the same plane-minted id.
    const { mux, correlator, calls } = harness(['fs', 'gh'])
    correlator.trackFanout('fs', 'list:tools')

    await mux.onMembershipChanged(['gh'])

    expect(calls.detached).toEqual([{ server: 'fs', reason: 'ungranted', dirty: true }])
  })
})

describe('closing the pool', () => {
  test('notes every server it still had calls in flight at, and closes those dirty', async () => {
    // Arrange
    const { mux, correlator, records, calls } = harness(['fs', 'gh'])
    mux.handleAgentFrame(call(1, 'fs__read'))

    // Act
    await mux.close()

    // Assert
    expect(records).toContainEqual({ agentName: 'bot', event: 'detach', serverName: 'fs', reason: 'in-flight-at-close' })
    expect(records.filter((record) => record.serverName === 'gh')).toEqual([])
    expect(calls.closedAllWith?.('fs')).toBe(true)
    expect(calls.closedAllWith?.('gh')).toBe(false)
    expect(correlator.hasPending('fs')).toBe(true)
  })
})

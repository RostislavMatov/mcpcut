import { afterEach, describe, expect, test } from 'vitest'
import { requestBudgetFor } from '../../src/cli/serve-budget.js'
import type { TenantSettings } from '../../src/tenant/settings.js'
import { disposeServeFixtures, startServe, type ServeFixture } from './serve-harness.js'

/**
 * `serve` decides whether its agent front has a request budget (plan
 * `hosted-path-and-ops`, P7): a tenant install gets one sized from its
 * `tenant` section, any other install gets none — the transport never reads
 * the install config itself (ADR-0001 layering).
 */

const T0 = Date.UTC(2026, 8, 27, 10, 0, 0)

function tenantWith(requestsPerSecond: number, requestsPerDay: number): TenantSettings {
  return {
    isTenant: true,
    stdioServers: 'refused',
    upstreams: 'public-https',
    limits: { servers: 5, agents: 5, groups: 2, requestsPerSecond, requestsPerDay },
  }
}

const SELF_HOSTED: TenantSettings = {
  isTenant: false,
  stdioServers: 'allowed',
  upstreams: 'any',
  limits: {
    servers: 200,
    agents: 200,
    groups: 100,
    requestsPerSecond: Number.POSITIVE_INFINITY,
    requestsPerDay: Number.POSITIVE_INFINITY,
  },
}

describe('requestBudgetFor', () => {
  test('not a tenant install: no budget at all', () => {
    expect(requestBudgetFor(SELF_HOSTED)).toBeUndefined()
  })

  test('a tenant install: a budget sized from the section (burst 2N, then refusal)', () => {
    const budget = requestBudgetFor(tenantWith(10, 10_000))
    if (budget === undefined) throw new Error('expected a budget')

    const admitted = Array.from({ length: 21 }, () => budget.take(T0).ok).filter(Boolean).length

    expect(admitted).toBe(20)
    expect(budget.take(T0)).toEqual({ ok: false, retryAfterSeconds: 1 })
  })

  test('each call builds a fresh budget: two fronts never share one', () => {
    const settings = tenantWith(1, 10_000)
    const first = requestBudgetFor(settings)
    first?.take(T0)
    first?.take(T0)

    expect(requestBudgetFor(settings)?.take(T0).ok).toBe(true)
  })
})

describe('runServe wires the budget into the agent front', () => {
  let fixture: ServeFixture | null = null

  afterEach(async () => {
    fixture = null
    await disposeServeFixtures()
  })

  async function statusesOf(front: ServeFixture, count: number): Promise<number[]> {
    const statuses: number[] = []
    for (let i = 0; i < count; i += 1) {
      const response = await front.post('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
      await response.arrayBuffer()
      statuses.push(response.status)
    }
    return statuses
  }

  test('tenant mode: past the burst the front answers 429 with Retry-After', async () => {
    fixture = await startServe({ serveOptions: { tenant: tenantWith(1, 10_000) } })

    const statuses = await statusesOf(fixture, 2)
    const refused = await fixture.post('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')

    expect(statuses).not.toContain(429)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('1')
  })

  test('not a tenant install: the same traffic is never refused 429', async () => {
    fixture = await startServe({ serveOptions: { tenant: SELF_HOSTED } })

    expect(await statusesOf(fixture, 5)).not.toContain(429)
  })
})

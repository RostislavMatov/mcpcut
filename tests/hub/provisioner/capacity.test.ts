import { describe, expect, test } from 'vitest'
import { errorOf, execKindOf, tenantObjects, useProvisioner } from './provisioner-harness.js'

/**
 * The tenant ceiling under concurrency (security review of the provisioner,
 * MEDIUM-1): creates of DIFFERENT subdomains run side by side, so the ceiling
 * cannot rest on the per-subdomain lock. The check and the reservation of a
 * slot are one step for the whole host; a create that fails gives its slot
 * back; an install still being built is counted once, whether or not its
 * container already exists.
 */

const ctx = useProvisioner()
const SUBDOMAINS = ['alice', 'bob', 'carol', 'dave', 'erin'] as const

/** Container creates for tenants — the harness's Caddy container is not one. */
function tenantContainerCreates(): number {
  return ctx
    .fake()
    .calls()
    .filter((call) => call.route === 'POST /containers/create' && call.query['name']?.startsWith('mcpcut-t-') === true).length
}

describe('the tenant ceiling holds for creates of different subdomains at once', () => {
  test('maxTenants 2, five creates at once → exactly two installs, three refused as capacity', async () => {
    const service = ctx.serviceWith({ maxTenants: 2 })

    const results = await Promise.allSettled(SUBDOMAINS.map((subdomain) => service.create({ subdomain, login: subdomain })))

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(fulfilled).toHaveLength(2)
    expect(refused.map((result) => (result.reason as { code?: string }).code)).toEqual(['capacity', 'capacity', 'capacity'])
    expect(tenantObjects(ctx.fake()).containers).toHaveLength(2)
    expect(tenantObjects(ctx.fake()).networks).toHaveLength(2)
    expect(tenantObjects(ctx.fake()).volumes).toHaveLength(2)
    expect(tenantContainerCreates()).toBe(2)
  })

  test('a create that fails gives its slot back', async () => {
    const service = ctx.serviceWith({ maxTenants: 1 })
    ctx.fake().failNext('POST /containers/create', 500, 'fake daemon failure')

    expect((await errorOf(service.create({ subdomain: 'alice', login: 'alice' }))).code).toBe('docker')
    await service.create({ subdomain: 'bob', login: 'bob' })

    expect(tenantObjects(ctx.fake()).containers).toEqual(['mcpcut-t-bob'])
  })

  test('a create that fails while others wait lets exactly one of them through', async () => {
    const service = ctx.serviceWith({ maxTenants: 1 })
    ctx.answer((argv, container) =>
      execKindOf(argv) === 'status' && container.name === 'mcpcut-t-alice' ? { exitCode: 0, stdout: '[]' } : undefined,
    )

    const first = await errorOf(service.create({ subdomain: 'alice', login: 'alice' }))
    const rest = await Promise.allSettled([
      service.create({ subdomain: 'bob', login: 'bob' }),
      service.create({ subdomain: 'carol', login: 'carol' }),
    ])

    expect(first.code).toBe('not-ready')
    expect(rest.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(tenantObjects(ctx.fake()).containers).toHaveLength(1)
  })

  test('an install still being built is counted once, even after its container exists', async () => {
    const service = ctx.serviceWith({ maxTenants: 2 })
    let second: Promise<unknown> | undefined
    ctx.answer((argv, container) => {
      // Alice's container exists and her create is still in flight: bob must still fit.
      if (execKindOf(argv) === 'status' && container.name === 'mcpcut-t-alice' && second === undefined) {
        second = service.create({ subdomain: 'bob', login: 'bob' })
      }
      return undefined
    })

    await service.create({ subdomain: 'alice', login: 'alice' })
    await second

    expect(tenantObjects(ctx.fake()).containers.sort()).toEqual(['mcpcut-t-alice', 'mcpcut-t-bob'])
  })

  test('the ceiling counts installs that were there before the provisioner started', async () => {
    await ctx.serviceWith({ maxTenants: 2 }).create({ subdomain: 'alice', login: 'alice' })
    const restarted = ctx.serviceWith({ maxTenants: 2 })

    const results = await Promise.allSettled(['bob', 'carol', 'dave'].map((subdomain) => restarted.create({ subdomain, login: subdomain })))

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(tenantObjects(ctx.fake()).containers).toHaveLength(2)
  })
})

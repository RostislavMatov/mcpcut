import { describe, expect, test } from 'vitest'
import { ProvisionerError } from '../../../hub/src/provisioner/errors.js'
import { containerSpec } from '../../../hub/src/provisioner/templates.js'
import {
  CADDY,
  errorOf,
  execKindOf,
  tenantObjects,
  useProvisioner,
} from './provisioner-harness.js'

/**
 * `service.ts` over the fake Docker Engine (plan `tenant-orchestrator`,
 * Task 4): the full create/rotate/remove/status, a rollback for a failure at
 * every step of create, idempotent removal, input refused before Docker,
 * another tenant's objects left alone, one-at-a-time per subdomain, and no
 * owner token in any log line or error.
 */

const ctx = useProvisioner()
const ALICE = { subdomain: 'alice', login: 'Alice', githubId: 1001 }
const TOKEN_PATTERN = /^mcpa_[A-Za-z0-9_-]{16,}$/

function caddyNetworks(): string[] {
  const caddy = ctx.fake().containers().find((c) => c.name === CADDY)
  return ctx
    .fake()
    .networks()
    .filter((network) => caddy !== undefined && network.containers.has(caddy.id))
    .map((network) => network.name)
}

describe('create', () => {
  test('builds network, volume and container from the templates, attaches Caddy, returns the owner token', async () => {
    const { ownerToken } = await ctx.service().create(ALICE)

    expect(ownerToken).toMatch(TOKEN_PATTERN)
    expect(ctx.tokens()).toEqual([ownerToken])
    expect(tenantObjects(ctx.fake())).toEqual({
      containers: ['mcpcut-t-alice'],
      networks: ['mcpcut-t-alice'],
      volumes: ['mcpcut-t-alice'],
    })
    const container = ctx.fake().containers().find((c) => c.name === 'mcpcut-t-alice')
    const expected = containerSpec({ ...ALICE, image: 'mcpcut-tenant:local', publicDomain: 'mcpcut.com' })
    expect(container?.spec).toEqual(JSON.parse(JSON.stringify(expected)))
    expect(container?.labels).toEqual({ 'mcpcut.tenant': 'alice', 'mcpcut.login': 'Alice', 'mcpcut.github-id': '1001' })
    expect(container?.running).toBe(true)
    expect(ctx.fake().networks()[0]?.labels).toEqual({ 'mcpcut.tenant': 'alice' })
    expect(ctx.fake().volumes()[0]?.labels).toEqual({ 'mcpcut.tenant': 'alice' })
    expect(caddyNetworks()).toEqual(['mcpcut-t-alice'])
  })

  test('waits for status, then mints the owner as the lowercased login, as user node', async () => {
    await ctx.service().create(ALICE)

    const argvs = ctx.execs()
    expect(argvs[0]).toEqual(['node', '/app/dist/cli.js', 'status', '--json'])
    expect(argvs.at(-1)).toEqual(['node', '/app/dist/cli.js', 'admin', 'add', 'alice', '--role', 'owner', '--json'])
    const execCreates = ctx.fake().calls().filter((call) => call.route === 'POST /containers/{id}/exec')
    expect(execCreates.every((call) => (call.body as { User?: string }).User === 'node')).toBe(true)
  })

  test('keeps polling until both services answer, accepting running as well as external, whatever the exit code', async () => {
    let polls = 0
    ctx.answer((argv) => {
      if (execKindOf(argv) !== 'status') return undefined
      polls += 1
      if (polls === 1) return { exitCode: 1, stderr: 'no config yet\n' }
      if (polls === 2) return { exitCode: 1, stdout: '[{"service":"ui","state":"external"},{"service":"serve","state":"stopped"}]' }
      if (polls === 3) return { exitCode: 0, stdout: JSON.stringify([{ service: 'ui', state: 'running' }]) }
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { service: 'ui', state: 'running' },
          { service: 'serve', state: 'external' },
        ]),
      }
    })

    await ctx.service().create(ALICE)

    expect(polls).toBe(4)
  })

  test('without a Caddy container configured, no network is connected', async () => {
    await ctx.serviceWith({ caddyContainer: undefined }).create(ALICE)

    expect(caddyNetworks()).toEqual([])
    expect(ctx.fake().calls().some((call) => call.route === 'POST /networks/{id}/connect')).toBe(false)
  })

  test('a tenant that already exists is refused and left intact', async () => {
    await ctx.service().create(ALICE)

    const error = await errorOf(ctx.service().create(ALICE))

    expect(error).toBeInstanceOf(ProvisionerError)
    expect(error.code).toBe('exists')
    expect(tenantObjects(ctx.fake()).containers).toEqual(['mcpcut-t-alice'])
    expect(ctx.fake().containers().find((c) => c.name === 'mcpcut-t-alice')?.running).toBe(true)
  })

  test('a leftover volume with the name is somebody’s data: refused, not reused', async () => {
    await ctx.docker().createVolume('mcpcut-t-alice', { 'mcpcut.tenant': 'alice' })

    const error = await errorOf(ctx.service().create(ALICE))

    expect(error.code).toBe('exists')
    expect(tenantObjects(ctx.fake())).toEqual({ containers: [], networks: [], volumes: ['mcpcut-t-alice'] })
  })

  test('a leftover network is a conflict; nothing this call did not create is removed', async () => {
    await ctx.docker().createNetwork('mcpcut-t-alice', {})

    const error = await errorOf(ctx.service().create(ALICE))

    expect(error.code).toBe('exists')
    expect(tenantObjects(ctx.fake())).toEqual({ containers: [], networks: ['mcpcut-t-alice'], volumes: [] })
  })

  test('two creates of one subdomain at once: one install, the other refused', async () => {
    const results = await Promise.allSettled([ctx.service().create(ALICE), ctx.service().create(ALICE)])

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((r) => r.status === 'rejected')
    expect((rejected as PromiseRejectedResult).reason.code).toBe('exists')
    expect(tenantObjects(ctx.fake()).containers).toEqual(['mcpcut-t-alice'])
  })

  test('creates of different subdomains run side by side', async () => {
    const [a, b] = await Promise.all([ctx.service().create(ALICE), ctx.service().create({ subdomain: 'bob', login: 'bob' })])

    expect(a.ownerToken).not.toBe(b.ownerToken)
    expect(tenantObjects(ctx.fake()).containers.sort()).toEqual(['mcpcut-t-alice', 'mcpcut-t-bob'])
  })

  test('at the tenant ceiling a new create is refused before anything is built', async () => {
    const service = ctx.serviceWith({ maxTenants: 1 })
    await service.create(ALICE)

    const error = await errorOf(service.create({ subdomain: 'bob', login: 'bob' }))

    expect(error.code).toBe('capacity')
    expect(tenantObjects(ctx.fake()).containers).toEqual(['mcpcut-t-alice'])
    expect(tenantObjects(ctx.fake()).networks).toEqual(['mcpcut-t-alice'])
  })
})

describe('create refuses bad input before any Docker call', () => {
  test.each([
    [{ subdomain: 'www', login: 'alice' }],
    [{ subdomain: 'Alice', login: 'alice' }],
    [{ subdomain: '../x', login: 'alice' }],
    [{ subdomain: 'x'.repeat(55), login: 'alice' }],
    [{ subdomain: 'alice', login: 'al ice' }],
    [{ subdomain: 'alice', login: '' }],
    [{ subdomain: 'alice', login: 'alice', githubId: 0 }],
    [{ subdomain: 'alice', login: 'alice', githubId: 1.5 }],
  ])('%j', async (input) => {
    const before = ctx.fake().calls().length

    const error = await errorOf(ctx.service().create(input))

    expect(error.code).toBe('invalid-input')
    expect(ctx.fake().calls().length).toBe(before)
  })

  test('rotate, remove and status refuse a bad subdomain the same way', async () => {
    const before = ctx.fake().calls().length

    for (const call of [
      () => ctx.service().rotateOwnerToken('www'),
      () => ctx.service().remove('a/b'),
      () => ctx.service().status(''),
    ]) {
      expect((await errorOf(Promise.resolve().then(call))).code).toBe('invalid-input')
    }
    expect(ctx.fake().calls().length).toBe(before)
  })
})

describe('create rolls back whatever it built when a step fails', () => {
  const EMPTY = { containers: [], networks: [], volumes: [] }

  test.each([
    ['POST /networks/create', 'docker'],
    ['POST /volumes/create', 'docker'],
    ['POST /containers/create', 'docker'],
    ['POST /containers/{id}/start', 'docker'],
    ['POST /networks/{id}/connect', 'docker'],
  ])('%s fails → nothing of the tenant is left', async (route, code) => {
    ctx.fake().failNext(route, 500, 'fake daemon failure')

    const error = await errorOf(ctx.service().create(ALICE))

    expect(error.code).toBe(code)
    expect(tenantObjects(ctx.fake())).toEqual(EMPTY)
    expect(caddyNetworks()).toEqual([])
    expect(ctx.logs().some((line) => line.includes('rolled back'))).toBe(true)
  })

  test('the install never comes up → not-ready, rolled back', async () => {
    ctx.answer((argv) => (execKindOf(argv) === 'status' ? { exitCode: 0, stdout: '[]' } : undefined))

    const error = await errorOf(ctx.service().create(ALICE))

    expect(error.code).toBe('not-ready')
    expect(tenantObjects(ctx.fake())).toEqual(EMPTY)
  })

  test('admin add fails after printing a token → bad-output, rolled back, the token is nowhere', async () => {
    const leaked = 'mcpa_THISSHOULDNEVERAPPEARANYWHERE000000'
    ctx.answer((argv) =>
      execKindOf(argv) === 'admin-add'
        ? { exitCode: 1, stdout: JSON.stringify({ admin: 'alice', role: 'owner', token: leaked }), stderr: leaked }
        : undefined,
    )

    const error = await errorOf(ctx.service().create(ALICE))

    expect(error.code).toBe('bad-output')
    expect(error.message).not.toContain(leaked)
    expect(ctx.logs().join('\n')).not.toContain(leaked)
    expect(tenantObjects(ctx.fake())).toEqual(EMPTY)
  })

  test.each([
    ['not JSON', 'token: mcpa_xxxxxxxxxxxxxxxxxxxxxxxx'],
    ['another admin', JSON.stringify({ admin: 'mallory', role: 'owner', token: 'mcpa_aaaaaaaaaaaaaaaaaaaaaaaa' })],
    ['a weaker role', JSON.stringify({ admin: 'alice', role: 'viewer', token: 'mcpa_aaaaaaaaaaaaaaaaaaaaaaaa' })],
    ['a malformed token', JSON.stringify({ admin: 'alice', role: 'owner', token: 'nope' })],
    ['an extra field', JSON.stringify({ admin: 'alice', role: 'owner', token: 'mcpa_aaaaaaaaaaaaaaaaaaaaaaaa', x: 1 })],
  ])('admin add prints %s → bad-output, rolled back', async (_label, stdout) => {
    ctx.answer((argv) => (execKindOf(argv) === 'admin-add' ? { exitCode: 0, stdout } : undefined))

    const error = await errorOf(ctx.service().create(ALICE))

    expect(error.code).toBe('bad-output')
    expect(error.message).not.toContain('mcpa_')
    expect(tenantObjects(ctx.fake())).toEqual(EMPTY)
  })

  test('a rollback step that fails is logged, and the first failure is what the caller sees', async () => {
    ctx.fake().failNext('POST /networks/{id}/connect', 500, 'connect failed')
    ctx.fake().failNext('DELETE /volumes/{name}', 500, 'volume busy')

    const error = await errorOf(ctx.service().create(ALICE))

    expect(error.message).toContain('network connect')
    expect(ctx.logs().some((line) => line.includes('could not undo the volume'))).toBe(true)
    expect(tenantObjects(ctx.fake())).toEqual({ containers: [], networks: [], volumes: ['mcpcut-t-alice'] })
  })
})

describe('rotateOwnerToken', () => {
  test('mints a new token with admin rotate --recover --json for the labelled login', async () => {
    const first = await ctx.service().create(ALICE)

    const second = await ctx.service().rotateOwnerToken('alice')

    expect(second.ownerToken).toMatch(TOKEN_PATTERN)
    expect(second.ownerToken).not.toBe(first.ownerToken)
    expect(ctx.execs().at(-1)).toEqual(['node', '/app/dist/cli.js', 'admin', 'rotate', 'alice', '--recover', '--json'])
  })

  test('no install → not-found', async () => {
    expect((await errorOf(ctx.service().rotateOwnerToken('alice'))).code).toBe('not-found')
  })

  test('a stopped install → not-ready, no exec', async () => {
    await ctx.service().create(ALICE)
    await ctx.docker().stopContainer('mcpcut-t-alice', 0)
    const before = ctx.execs().length

    expect((await errorOf(ctx.service().rotateOwnerToken('alice'))).code).toBe('not-ready')
    expect(ctx.execs().length).toBe(before)
  })

  test('a container without a login label → not-ours', async () => {
    const { id } = await ctx.docker().createContainer('mcpcut-t-alice', { Image: 'x', Labels: { 'mcpcut.tenant': 'alice' } })
    await ctx.docker().startContainer(id)

    expect((await errorOf(ctx.service().rotateOwnerToken('alice'))).code).toBe('not-ours')
  })

  test('a Docker failure is a docker error without output', async () => {
    await ctx.service().create(ALICE)
    ctx.fake().failNext('POST /containers/{id}/exec', 500, 'exec refused')

    expect((await errorOf(ctx.service().rotateOwnerToken('alice'))).code).toBe('docker')
  })
})

describe('remove', () => {
  test('detaches Caddy and removes the container, the volume and the network', async () => {
    await ctx.service().create(ALICE)

    await ctx.service().remove('alice')

    expect(tenantObjects(ctx.fake())).toEqual({ containers: [], networks: [], volumes: [] })
    expect(caddyNetworks()).toEqual([])
    expect(ctx.fake().containers().map((c) => c.name)).toEqual([CADDY])
  })

  test('is idempotent: twice, or for a tenant that never existed, is success', async () => {
    await ctx.service().create(ALICE)
    await ctx.service().remove('alice')

    await expect(ctx.service().remove('alice')).resolves.toBeUndefined()
    await expect(ctx.service().remove('nobody')).resolves.toBeUndefined()
  })

  test('finishes a half-removed tenant (container gone, network and volume left)', async () => {
    await ctx.service().create(ALICE)
    await ctx.docker().removeContainer('mcpcut-t-alice', { force: true })

    await ctx.service().remove('alice')

    expect(tenantObjects(ctx.fake())).toEqual({ containers: [], networks: [], volumes: [] })
  })

  test('another tenant’s container under the name is left alone', async () => {
    await ctx.docker().createContainer('mcpcut-t-alice', { Image: 'x', Labels: { 'mcpcut.tenant': 'eve' } })

    const error = await errorOf(ctx.service().remove('alice'))

    expect(error.code).toBe('not-ours')
    expect(tenantObjects(ctx.fake()).containers).toEqual(['mcpcut-t-alice'])
  })

  test('another tenant’s volume under the name is left alone', async () => {
    await ctx.docker().createVolume('mcpcut-t-alice', { 'mcpcut.tenant': 'eve' })

    expect((await errorOf(ctx.service().remove('alice'))).code).toBe('not-ours')
    expect(tenantObjects(ctx.fake()).volumes).toEqual(['mcpcut-t-alice'])
  })

  test('another tenant’s network under the name is left alone, Caddy stays attached', async () => {
    await ctx.docker().createNetwork('mcpcut-t-alice', { 'mcpcut.tenant': 'eve' })
    await ctx.docker().connectNetwork('mcpcut-t-alice', CADDY)

    expect((await errorOf(ctx.service().remove('alice'))).code).toBe('not-ours')
    expect(tenantObjects(ctx.fake()).networks).toEqual(['mcpcut-t-alice'])
    expect(caddyNetworks()).toEqual(['mcpcut-t-alice'])
  })

  test('a Docker failure surfaces as a docker error', async () => {
    await ctx.service().create(ALICE)
    ctx.fake().failNext('DELETE /volumes/{name}', 500, 'disk trouble')

    expect((await errorOf(ctx.service().remove('alice'))).code).toBe('docker')
  })

  test('a remove waits for a create of the same subdomain to finish', async () => {
    const created = ctx.service().create(ALICE)
    const removed = ctx.service().remove('alice')

    await created
    await removed

    expect(tenantObjects(ctx.fake())).toEqual({ containers: [], networks: [], volumes: [] })
  })
})

describe('status', () => {
  test('absent before create; the container state and the volume size after', async () => {
    expect(await ctx.service().status('alice')).toEqual({ state: 'absent', sizeBytes: null })

    await ctx.service().create(ALICE)
    expect(await ctx.service().status('alice')).toEqual({ state: 'running', sizeBytes: null })

    ctx.fake().setVolumeSize('mcpcut-t-alice', 4096)
    expect(await ctx.service().status('alice')).toEqual({ state: 'running', sizeBytes: 4096 })
  })

  test('another tenant’s container under the name → not-ours', async () => {
    await ctx.docker().createContainer('mcpcut-t-alice', { Image: 'x', Labels: { 'mcpcut.tenant': 'eve' } })

    expect((await errorOf(ctx.service().status('alice'))).code).toBe('not-ours')
  })
})

describe('secret hygiene', () => {
  test('no owner token appears in any log line, across create, rotate and remove', async () => {
    await ctx.service().create(ALICE)
    await ctx.service().rotateOwnerToken('alice')
    await ctx.service().remove('alice')

    const logs = ctx.logs().join('\n')
    expect(ctx.tokens()).toHaveLength(2)
    for (const token of ctx.tokens()) expect(logs).not.toContain(token)
    expect(logs).toContain('created alice')
    expect(logs).toContain('removed alice')
  })
})

import { describe, expect, test } from 'vitest'
import {
  DOCKER_API_VERSION,
  DOCKER_TIMEOUT_MS,
  createDockerClient,
  type ContainerSpec,
} from '../../../hub/src/provisioner/docker.js'
import { dockerErrorOf, runningContainer, useFakeDocker } from './docker-harness.js'

const ctx = useFakeDocker()

const SPEC: ContainerSpec = {
  Image: 'mcpcut-tenant:local',
  Env: ['MCPCUT_TENANT=1'],
  User: 'node',
  Labels: { 'mcpcut.tenant': 'alice', 'mcpcut.login': 'Alice' },
  HostConfig: {
    Memory: 256 * 1024 * 1024,
    NanoCpus: 250_000_000,
    PidsLimit: 128,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    ReadonlyRootfs: true,
    Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16m' },
    Mounts: [{ Type: 'volume', Source: 'mcpcut-t-alice', Target: '/data' }],
    RestartPolicy: { Name: 'unless-stopped' },
    NetworkMode: 'mcpcut-t-alice',
  },
}

describe('createDockerClient — configuration', () => {
  test('defaults: API v1.45, 30 s per request', () => {
    expect(DOCKER_API_VERSION).toBe('v1.45')
    expect(DOCKER_TIMEOUT_MS).toBe(30_000)
  })

  test.each([
    [{ socketPath: '' }, /socketPath/],
    [{ socketPath: 'relative.sock' }, /socketPath/],
    [{ socketPath: '/x.sock', apiVersion: '1.45' }, /apiVersion/],
    [{ socketPath: '/x.sock', apiVersion: 'v1.45/../' }, /apiVersion/],
    [{ socketPath: '/x.sock', timeoutMs: 0 }, /timeoutMs/],
    [{ socketPath: '/x.sock', timeoutMs: Number.NaN }, /timeoutMs/],
  ])('refuses a bad option %j', (options, message) => {
    expect(() => createDockerClient(options)).toThrow(message)
  })

  test('every call goes to the configured API version', async () => {
    await ctx.clientWith({ apiVersion: 'v1.47' }).listContainers({ label: 'mcpcut.tenant' })

    expect(ctx.fake().calls().map((call) => call.version)).toEqual(['v1.47'])
  })
})

describe('networks', () => {
  test('createNetwork makes a labelled bridge network and returns its id', async () => {
    const { id } = await ctx.client().createNetwork('mcpcut-t-alice', { 'mcpcut.tenant': 'alice' })

    const [network] = ctx.fake().networks()
    expect(network?.id).toBe(id)
    expect(network?.labels).toEqual({ 'mcpcut.tenant': 'alice' })
    const call = ctx.fake().calls()[0]
    expect(call?.contentType).toBe('application/json')
    expect(call?.body).toMatchObject({ Name: 'mcpcut-t-alice', Driver: 'bridge', Internal: false, Labels: { 'mcpcut.tenant': 'alice' } })
  })

  test('a duplicate name is a 409, not notFound', async () => {
    await ctx.client().createNetwork('n1', {})

    const error = await dockerErrorOf(ctx.client().createNetwork('n1', {}))

    expect(error.status).toBe(409)
    expect(error.notFound).toBe(false)
  })

  test('connect and disconnect a container, then remove the network', async () => {
    const client = ctx.client()
    await client.createNetwork('mcpcut-t-alice', {})
    const caddy = await runningContainer(client, 'caddy')

    await client.connectNetwork('mcpcut-t-alice', 'caddy')
    expect([...(ctx.fake().networks()[0]?.containers ?? [])]).toEqual([caddy])
    await client.disconnectNetwork('mcpcut-t-alice', 'caddy')
    expect(ctx.fake().networks()[0]?.containers.size).toBe(0)
    await client.removeNetwork('mcpcut-t-alice')

    expect(ctx.fake().networks()).toEqual([])
  })

  test('inspectNetwork reads the name and labels back; a missing network is notFound', async () => {
    const client = ctx.client()
    await client.createNetwork('mcpcut-t-alice', { 'mcpcut.tenant': 'alice' })

    expect(await client.inspectNetwork('mcpcut-t-alice')).toEqual({ name: 'mcpcut-t-alice', labels: { 'mcpcut.tenant': 'alice' } })
    expect(ctx.fake().calls().at(-1)).toMatchObject({ method: 'GET', path: '/networks/mcpcut-t-alice' })
    expect((await dockerErrorOf(client.inspectNetwork('mcpcut-t-ghost'))).notFound).toBe(true)
  })

  test('removing a missing network is notFound, so callers can treat it as done', async () => {
    const error = await dockerErrorOf(ctx.client().removeNetwork('mcpcut-t-ghost'))

    expect(error.status).toBe(404)
    expect(error.notFound).toBe(true)
    expect(error.failure).toBe('http-status')
  })

  test('connecting an unknown container is notFound; connecting twice is 403', async () => {
    const client = ctx.client()
    await client.createNetwork('n1', {})
    expect((await dockerErrorOf(client.connectNetwork('n1', 'ghost'))).notFound).toBe(true)
    await runningContainer(client, 'caddy')
    await client.connectNetwork('n1', 'caddy')

    const error = await dockerErrorOf(client.connectNetwork('n1', 'caddy'))

    expect(error.status).toBe(403)
    expect(error.notFound).toBe(false)
  })
})

describe('volumes', () => {
  test('createVolume makes a labelled local volume; inspectVolume reads it back', async () => {
    const client = ctx.client()

    const created = await client.createVolume('mcpcut-t-alice', { 'mcpcut.tenant': 'alice' })
    const inspected = await client.inspectVolume('mcpcut-t-alice')

    expect(created).toEqual({ name: 'mcpcut-t-alice', labels: { 'mcpcut.tenant': 'alice' }, sizeBytes: undefined })
    expect(inspected).toEqual(created)
    expect(ctx.fake().calls()[0]?.body).toMatchObject({ Name: 'mcpcut-t-alice', Driver: 'local' })
  })

  test('inspectVolume reports UsageData.Size when the daemon includes it', async () => {
    ctx.fake().replyNext('GET /volumes/{name}', {
      status: 200,
      body: JSON.stringify({ Name: 'v1', Labels: null, UsageData: { Size: 4096, RefCount: 1 } }),
    })

    expect(await ctx.client().inspectVolume('v1')).toEqual({ name: 'v1', labels: {}, sizeBytes: 4096 })
  })

  test('volumeSize reads /system/df (the only place Docker fills UsageData); -1 means unknown', async () => {
    const client = ctx.client()
    await client.createVolume('v1', {})
    await client.createVolume('v2', {})
    ctx.fake().setVolumeSize('v1', 123_456)

    expect(await client.volumeSize('v1')).toBe(123_456)
    expect(await client.volumeSize('v2')).toBeUndefined()
    expect(await client.volumeSize('v3')).toBeUndefined()
    expect(ctx.fake().calls().at(-1)?.query).toEqual({ type: 'volume' })
  })

  test('removeVolume deletes it; a missing volume is notFound; one in use is 409', async () => {
    const client = ctx.client()
    await client.createVolume('mcpcut-t-alice', {})
    const { id } = await client.createContainer('mcpcut-t-alice', SPEC)

    const inUse = await dockerErrorOf(client.removeVolume('mcpcut-t-alice'))
    await client.removeContainer(id, { force: true })
    await client.removeVolume('mcpcut-t-alice')
    const missing = await dockerErrorOf(client.removeVolume('mcpcut-t-alice'))

    expect(inUse.status).toBe(409)
    expect(ctx.fake().volumes()).toEqual([])
    expect(missing.notFound).toBe(true)
  })
})

describe('containers', () => {
  test('createContainer sends the spec verbatim under ?name= and returns the id', async () => {
    const { id, warnings } = await ctx.client().createContainer('mcpcut-t-alice', SPEC)

    const call = ctx.fake().calls()[0]
    expect(call?.route).toBe('POST /containers/create')
    expect(call?.query).toEqual({ name: 'mcpcut-t-alice' })
    expect(call?.body).toEqual(SPEC)
    expect(ctx.fake().containers()[0]?.id).toBe(id)
    expect(warnings).toEqual([])
  })

  test('a taken name is 409', async () => {
    await ctx.client().createContainer('c1', SPEC)

    expect((await dockerErrorOf(ctx.client().createContainer('c1', SPEC))).status).toBe(409)
  })

  test('start, stop (304 on repeat is success), inspect', async () => {
    const client = ctx.client()
    const { id } = await client.createContainer('mcpcut-t-alice', SPEC)

    await client.startContainer(id)
    await client.startContainer(id)
    const running = await client.inspectContainer('mcpcut-t-alice')
    await client.stopContainer(id, 10)
    await client.stopContainer(id, 10)
    const stopped = await client.inspectContainer(id)

    expect(running).toMatchObject({ id, name: 'mcpcut-t-alice', status: 'running', running: true, labels: SPEC.Labels })
    expect(stopped).toMatchObject({ status: 'exited', running: false })
    expect(ctx.fake().calls().find((call) => call.route === 'POST /containers/{id}/stop')?.query).toEqual({ t: '10' })
  })

  test.each([-1, 1.5, 601, Number.NaN])('stopContainer refuses timeoutS %d before any call', async (timeoutS) => {
    await expect(ctx.client().stopContainer('c1', timeoutS)).rejects.toThrow(RangeError)
    expect(ctx.fake().calls()).toEqual([])
  })

  test('inspectContainer lists the networks it is attached to', async () => {
    const client = ctx.client()
    await client.createNetwork('mcpcut-t-alice', {})
    await runningContainer(client, 'caddy')
    await client.connectNetwork('mcpcut-t-alice', 'caddy')

    expect((await client.inspectContainer('caddy')).networks).toEqual(['mcpcut-t-alice'])
  })

  test('removeContainer: running without force is 409, with force it goes; missing is notFound', async () => {
    const client = ctx.client()
    const id = await runningContainer(client)

    const refused = await dockerErrorOf(client.removeContainer(id, { force: false }))
    await client.removeContainer(id, { force: true })
    const missing = await dockerErrorOf(client.removeContainer(id, { force: true }))

    expect(refused.status).toBe(409)
    expect(ctx.fake().containers()).toEqual([])
    expect(missing.notFound).toBe(true)
    expect(ctx.fake().calls().filter((call) => call.route === 'DELETE /containers/{id}').map((call) => call.query)).toEqual([
      { force: 'false' },
      { force: 'true' },
      { force: 'true' },
    ])
  })

  test.each([
    ['startContainer', (c: ReturnType<typeof ctx.client>) => c.startContainer('ghost')],
    ['stopContainer', (c: ReturnType<typeof ctx.client>) => c.stopContainer('ghost', 1)],
    ['inspectContainer', (c: ReturnType<typeof ctx.client>) => c.inspectContainer('ghost')],
  ])('%s on a missing container is notFound', async (_name, act) => {
    expect((await dockerErrorOf(act(ctx.client()))).notFound).toBe(true)
  })

  test('listContainers filters by label (all states) and sends Docker filter JSON', async () => {
    const client = ctx.client()
    await runningContainer(client, 'mcpcut-t-alice')
    await client.createContainer('mcpcut-t-bob', { Image: 'img', Labels: { 'mcpcut.tenant': 'bob' } })
    await client.createContainer('other', { Image: 'img' })

    const tenants = await client.listContainers({ label: 'mcpcut.tenant' })
    const bob = await client.listContainers({ label: ['mcpcut.tenant=bob'] })

    expect(tenants.map((c) => [c.name, c.state]).sort()).toEqual([
      ['mcpcut-t-alice', 'running'],
      ['mcpcut-t-bob', 'created'],
    ])
    expect(bob.map((c) => c.labels)).toEqual([{ 'mcpcut.tenant': 'bob' }])
    const query = ctx.fake().calls().at(-1)?.query
    expect(query?.['all']).toBe('true')
    expect(JSON.parse(query?.['filters'] ?? '')).toEqual({ label: ['mcpcut.tenant=bob'] })
  })
})

describe('names never escape their path segment', () => {
  test.each(['', '../images', 'a/b', '.hidden', 'a b', 'a\nb', 'x'.repeat(256)])('refuses %j before any call', async (bad) => {
    const client = ctx.client()

    await expect(client.removeContainer(bad, { force: true })).rejects.toThrow(TypeError)
    await expect(client.inspectVolume(bad)).rejects.toThrow(TypeError)
    await expect(client.inspectNetwork(bad)).rejects.toThrow(TypeError)
    await expect(client.connectNetwork('n1', bad)).rejects.toThrow(TypeError)
    expect(ctx.fake().calls()).toEqual([])
  })

  test('refuses labels and label filters with control characters', async () => {
    await expect(ctx.client().createNetwork('n1', { 'a\nb': 'c' })).rejects.toThrow(TypeError)
    await expect(ctx.client().listContainers({ label: 'a=b\r\n' })).rejects.toThrow(TypeError)
    expect(ctx.fake().calls()).toEqual([])
  })
})

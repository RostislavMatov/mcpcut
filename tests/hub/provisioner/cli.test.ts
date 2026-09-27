import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runHubCli } from '../../../hub/src/cli.js'
import { loadProvisionerConfig } from '../../../hub/src/provisioner/config.js'
import { CADDY, tenantObjects, useProvisioner } from './provisioner-harness.js'

/**
 * `provision` and the operator's `provision-create|remove|status` through the
 * hub's entry point (plan `tenant-orchestrator`, Task 4), against the fake
 * Docker Engine named by `PROVISIONER_DOCKER_SOCKET`; and the provisioner's
 * env config.
 */

const ctx = useProvisioner()
const TOKEN = 't'.repeat(40)
let dir: string
let tokenFile: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-prov-cli-'))
  tokenFile = join(dir, 'token')
  await writeFile(tokenFile, `${TOKEN}\n`)
  await chmod(tokenFile, 0o600)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PROVISIONER_TOKEN_FILE: tokenFile,
    PROVISIONER_DOCKER_SOCKET: ctx.fake().socketPath,
    PROVISIONER_CADDY_CONTAINER: CADDY,
    PROVISIONER_PORT: '0',
    PROVISIONER_HOST: '127.0.0.1',
    ...overrides,
  }
}

async function run(argv: readonly string[], envVars = env()): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await runHubCli(argv, { env: envVars, stdout: (t) => (out += t), stderr: (t) => (err += t) })
  return { code, out, err }
}

describe('operator commands', () => {
  test('provision-create prints the owner token once, on stdout, with a warning on stderr', async () => {
    const result = await run(['provision-create', 'alice', 'Alice'])

    expect(result.code).toBe(0)
    const [token] = ctx.tokens()
    expect(result.out).toBe(`owner token for alice: ${token}\n`)
    expect(result.err).toContain('shown once and stored nowhere')
    expect(result.err).not.toContain(String(token))
    expect(tenantObjects(ctx.fake()).containers).toEqual(['mcpcut-t-alice'])
  })

  test('provision-status and provision-remove', async () => {
    await run(['provision-create', 'alice', 'alice'])

    expect((await run(['provision-status', 'alice'])).out).toBe('alice  running  -\n')
    ctx.fake().setVolumeSize('mcpcut-t-alice', 512)
    expect((await run(['provision-status', 'alice'])).out).toBe('alice  running  512 bytes\n')

    const removed = await run(['provision-remove', 'alice'])
    expect(removed).toMatchObject({ code: 0, out: 'removed alice\n' })
    expect(tenantObjects(ctx.fake())).toEqual({ containers: [], networks: [], volumes: [] })
    expect((await run(['provision-status', 'alice'])).out).toBe('alice  absent  -\n')
  })

  test('a refused subdomain fails with one line and exit 1', async () => {
    const result = await run(['provision-create', 'www', 'alice'])

    expect(result.code).toBe(1)
    expect(result.err).toBe('provisioner: ProvisionerError: subdomain: not a valid tenant subdomain\n')
  })

  test('the wrong number of arguments prints the usage and exits 2', async () => {
    for (const argv of [['provision-create', 'alice'], ['provision-remove'], ['provision', 'extra']]) {
      const result = await run(argv)
      expect(result.code).toBe(2)
      expect(result.err).toContain('provision-create <sub> <login>')
    }
  })

  test('a missing or bad environment lists every problem and exits 1', async () => {
    const result = await run(['provision-status', 'alice'], { PROVISIONER_DOCKER_SOCKET: 'relative.sock', PROVISIONER_PORT: 'x' })

    expect(result.code).toBe(1)
    expect(result.err).toContain('provisioner: PROVISIONER_TOKEN_FILE: is required')
    expect(result.err).toContain('PROVISIONER_DOCKER_SOCKET: must be an absolute path')
    expect(result.err).toContain('PROVISIONER_PORT: must be an integer between 0 and 65535')
  })
})

describe('provision (the daemon)', () => {
  test('listens, answers /healthz, warns when no Caddy is set, and stops on shutdown', async () => {
    let stop: () => void = () => undefined
    const shutdown = new Promise<void>((resolve) => (stop = resolve))
    let out = ''
    let err = ''
    const running = runHubCli(['provision'], {
      env: env({ PROVISIONER_CADDY_CONTAINER: '' }),
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      shutdown,
    })
    const port = await waitForPort(() => out)

    const status = await getStatus(port, '/healthz')
    const unauthorized = await getStatus(port, '/tenants/alice')
    stop()

    expect(status).toBe(200)
    expect(unauthorized).toBe(401)
    expect(await running).toBe(0)
    expect(err).toContain('PROVISIONER_CADDY_CONTAINER is not set')
    expect(`${out}${err}`).not.toContain(TOKEN)
  })
})

describe('loadProvisionerConfig', () => {
  test('defaults', () => {
    const load = loadProvisionerConfig({ env: { PROVISIONER_TOKEN_FILE: tokenFile } })
    if (load.kind !== 'ok') throw new Error(JSON.stringify(load))
    expect(load.config).toEqual({
      token: TOKEN,
      dockerSocket: '/var/run/docker.sock',
      image: 'mcpcut-tenant:local',
      caddyContainer: undefined,
      publicDomain: 'mcpcut.com',
      host: '0.0.0.0',
      port: 8093,
      maxTenants: 20,
    })
  })

  test('every knob', () => {
    const load = loadProvisionerConfig({
      env: env({ PROVISIONER_IMAGE: 'ghcr.io/x/mcpcut-tenant:0.2', PROVISIONER_PUBLIC_DOMAIN: 'example.org', PROVISIONER_MAX_TENANTS: '5' }),
    })
    if (load.kind !== 'ok') throw new Error(JSON.stringify(load))
    expect(load.config).toMatchObject({ image: 'ghcr.io/x/mcpcut-tenant:0.2', publicDomain: 'example.org', maxTenants: 5, caddyContainer: CADDY })
  })

  test.each([
    [{ PROVISIONER_IMAGE: 'evil image' }, 'PROVISIONER_IMAGE: must be an image reference'],
    [{ PROVISIONER_CADDY_CONTAINER: '../caddy' }, 'PROVISIONER_CADDY_CONTAINER: must be a container name'],
    [{ PROVISIONER_PUBLIC_DOMAIN: 'localhost' }, 'PROVISIONER_PUBLIC_DOMAIN: must be a domain name'],
    [{ PROVISIONER_MAX_TENANTS: '0' }, 'PROVISIONER_MAX_TENANTS: must be an integer between 1 and 1000'],
  ])('refuses %j', (overrides, problem) => {
    const load = loadProvisionerConfig({ env: env(overrides) })
    if (load.kind !== 'invalid') throw new Error('expected invalid')
    expect(load.problems.join('\n')).toContain(problem)
  })

  test('a world-readable or short token file is refused without quoting it', async () => {
    await chmod(tokenFile, 0o644)
    const wide = loadProvisionerConfig({ env: env() })
    await chmod(tokenFile, 0o600)
    await writeFile(tokenFile, 'short')
    const short = loadProvisionerConfig({ env: env() })

    expect(wide.kind === 'invalid' && wide.problems[0]).toMatch(/PROVISIONER_TOKEN_FILE: .*wider than the required 0600/)
    expect(short.kind === 'invalid' && short.problems[0]).toMatch(/PROVISIONER_TOKEN_FILE: .*must hold 32/)
    expect(JSON.stringify(short)).not.toContain('"short"')
  })
})

async function waitForPort(read: () => string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const match = /listening on http:\/\/[^:]+:(\d+)/.exec(read())
    if (match?.[1] !== undefined) return Number(match[1])
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`the provisioner never announced its port: ${read()}`)
}

function getStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

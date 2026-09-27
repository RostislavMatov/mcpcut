import { execFile } from 'node:child_process'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { asProvisionerError, ProvisionerError } from '../../../hub/src/provisioner/errors.js'
import { createKeyedLock } from '../../../hub/src/provisioner/keyed-lock.js'
import {
  isReadyProbe,
  ownerTokenFrom,
  READY_PROBE_SCRIPT,
  READY_PROBE_SERVE_PORT_ENV,
  READY_PROBE_UI_PORT_ENV,
  READY_TIMEOUT_MS,
  waitUntilReady,
} from '../../../hub/src/provisioner/tenant-exec.js'
import { execKindOf, useProvisioner } from './provisioner-harness.js'

/**
 * The pieces under `service.ts` (plan `tenant-orchestrator`, Task 4): the
 * readiness check and its deadline, the owner-token line parser, the
 * per-subdomain lock and the error mapping.
 */

const execFileAsync = promisify(execFile)
const ctx = useProvisioner()

describe('isReadyProbe', () => {
  test.each([
    ['both up', '{"ui":true,"serve":true}', true],
    ['ui down', '{"ui":false,"serve":true}', false],
    ['serve down', '{"ui":true,"serve":false}', false],
    ['both down', '{"ui":false,"serve":false}', false],
    ['not JSON', 'ui running', false],
    ['an array, the old `status --json` shape', '[{"service":"ui","state":"running"}]', false],
    ['an extra field', '{"ui":true,"serve":true,"extra":1}', false],
  ])('%s → %s', (_label, stdout, ready) => {
    expect(isReadyProbe(stdout)).toBe(ready)
  })
})

describe('READY_PROBE_SCRIPT run by a real node, against real local servers', () => {
  let ui: HttpServer | undefined
  let serve: NetServer | undefined

  afterEach(async () => {
    await Promise.all([
      new Promise<void>((resolve) => (ui === undefined ? resolve() : ui.close(() => resolve()))),
      new Promise<void>((resolve) => (serve === undefined ? resolve() : serve.close(() => resolve()))),
    ])
    ui = undefined
    serve = undefined
  })

  function listen(server: HttpServer | NetServer): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
  }

  async function runProbe(uiPort: number, servePort: number): Promise<{ ui: boolean; serve: boolean }> {
    const { stdout } = await execFileAsync('node', ['-e', READY_PROBE_SCRIPT], {
      env: { ...process.env, [READY_PROBE_UI_PORT_ENV]: String(uiPort), [READY_PROBE_SERVE_PORT_ENV]: String(servePort) },
    })
    return JSON.parse(stdout.trim()) as { ui: boolean; serve: boolean }
  }

  test('a 2xx login screen and an open port are both ready', async () => {
    ui = createHttpServer((_req, res) => res.writeHead(200).end('ok'))
    serve = createNetServer((socket) => socket.end())
    const uiPort = await listen(ui)
    const servePort = await listen(serve)

    expect(await runProbe(uiPort, servePort)).toEqual({ ui: true, serve: true })
  })

  test('a 303 to /setup (no owner yet) counts as the UI being ready', async () => {
    ui = createHttpServer((_req, res) => res.writeHead(303, { location: '/setup' }).end())
    const uiPort = await listen(ui)
    // A port briefly listened on, then closed: free, but nothing answers there — `serve` must read `false`, not throw.
    const probe = createNetServer()
    const servePort = await listen(probe)
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    expect(await runProbe(uiPort, servePort)).toEqual({ ui: true, serve: false })
  })

  test('a 303 to anywhere else is not the UI’s first-run state, so not ready', async () => {
    ui = createHttpServer((_req, res) => res.writeHead(303, { location: '/somewhere-else' }).end())
    serve = createNetServer((socket) => socket.end())
    const uiPort = await listen(ui)
    const servePort = await listen(serve)

    expect(await runProbe(uiPort, servePort)).toEqual({ ui: false, serve: true })
  })
})

describe('waitUntilReady', () => {
  test('gives up at the deadline measured by the injected clock, 60 s by default', async () => {
    expect(READY_TIMEOUT_MS).toBe(60_000)
    const { id } = await ctx.docker().createContainer('mcpcut-t-alice', { Image: 'x', Labels: { 'mcpcut.tenant': 'alice' } })
    await ctx.docker().startContainer(id)
    ctx.answer((argv) => (execKindOf(argv) === 'ready' ? { exitCode: 0, stdout: '[]' } : undefined))
    let now = 0
    const sleeps: number[] = []

    const failure = waitUntilReady(ctx.docker(), 'mcpcut-t-alice', {
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms)
        now += ms
      },
    })

    await expect(failure).rejects.toMatchObject({ code: 'not-ready', message: 'the install did not come up within 60 s' })
    expect(sleeps.every((ms) => ms === 1000)).toBe(true)
    expect(sleeps.length).toBe(59)
  })

  test('an exec that fails (the container is not running) is "not yet", not a failure', async () => {
    await ctx.docker().createContainer('mcpcut-t-alice', { Image: 'x' })
    let now = 0

    const failure = waitUntilReady(ctx.docker(), 'mcpcut-t-alice', {
      timeoutMs: 30,
      pollMs: 10,
      clock: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })

    await expect(failure).rejects.toMatchObject({ code: 'not-ready' })
  })
})

describe('ownerTokenFrom', () => {
  test('takes the token from the one JSON line, surrounding whitespace allowed', () => {
    const line = '{"admin":"alice","role":"owner","token":"mcpa_abcdefghijklmnopqrstuvwx"}\n'

    expect(ownerTokenFrom(line, 'alice', 'admin add')).toBe('mcpa_abcdefghijklmnopqrstuvwx')
  })
})

describe('createKeyedLock', () => {
  test('runs one task per key at a time and forgets a key once idle', async () => {
    const lock = createKeyedLock()
    const order: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))

    const first = lock.run('a', async () => {
      order.push('a1 start')
      await gate
      order.push('a1 end')
    })
    const second = lock.run('a', async () => {
      order.push('a2')
    })
    const other = lock.run('b', async () => {
      order.push('b')
    })
    await other
    expect(order).toEqual(['a1 start', 'b'])
    release()
    await Promise.all([first, second])

    expect(order).toEqual(['a1 start', 'b', 'a1 end', 'a2'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lock.size()).toBe(0)
  })

  test('a failed task releases the key for the next', async () => {
    const lock = createKeyedLock()

    await expect(lock.run('a', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(lock.run('a', async () => 'next')).resolves.toBe('next')
  })
})

describe('asProvisionerError', () => {
  test('passes a ProvisionerError through, hides anything else', () => {
    const own = new ProvisionerError('exists', 'x')

    expect(asProvisionerError(own, 'op')).toBe(own)
    const hidden = asProvisionerError(new Error('mcpa_secretsecretsecret'), 'create alice')
    expect(hidden).toMatchObject({ code: 'internal', message: 'create alice: failed unexpectedly' })
  })
})

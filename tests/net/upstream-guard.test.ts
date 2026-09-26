import type { LookupAddress, LookupOptions } from 'node:dns'
import { createServer, request, type Server } from 'node:http'
import { Agent as HttpsAgent, globalAgent as httpsGlobalAgent, request as httpsRequest } from 'node:https'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createUpstreamGuard,
  UpstreamAddressRefusedError,
  type ResolveAllFunction,
} from '../../src/net/upstream-guard.js'

/**
 * Tenant mode Task 4: the SSRF guard. `checkUrl` screens what `lookup` never
 * sees (the scheme and IP literals — Node skips `lookup` for a literal host);
 * `lookup` is the function the socket itself resolves through, so the address
 * that is checked is the address that is dialled (no DNS-rebinding window).
 */

type LookupOutcome = {
  readonly error: NodeJS.ErrnoException | null
  readonly address: string | readonly LookupAddress[] | undefined
  readonly family: number | undefined
}

/** A fake resolver answering from a fixed table and recording what it was asked. */
function fakeResolver(answers: Record<string, readonly LookupAddress[]>): {
  readonly resolve: ResolveAllFunction
  readonly calls: Array<{ hostname: string; options: LookupOptions }>
} {
  const calls: Array<{ hostname: string; options: LookupOptions }> = []
  const resolve: ResolveAllFunction = (hostname, options, callback) => {
    calls.push({ hostname, options })
    const answer = answers[hostname]
    if (answer === undefined) {
      const error: NodeJS.ErrnoException = Object.assign(
        new Error(`getaddrinfo ENOTFOUND ${hostname}`),
        { code: 'ENOTFOUND' },
      )
      callback(error, [])
      return
    }
    callback(null, answer)
  }
  return { resolve, calls }
}

function lookupThrough(
  resolve: ResolveAllFunction,
  hostname: string,
  options: LookupOptions & { all?: boolean },
): Promise<LookupOutcome> {
  const guard = createUpstreamGuard({ lookup: resolve })
  return new Promise((done) => {
    guard.lookup(hostname, options, (error, address, family) => {
      done({ error, address, family })
    })
  })
}

const v4 = (address: string): LookupAddress => ({ address, family: 4 })
const v6 = (address: string): LookupAddress => ({ address, family: 6 })

const ANSWERS: Record<string, readonly LookupAddress[]> = {
  'public.example': [v4('1.1.1.1'), v6('2606:4700::1111')],
  'internal.example': [v4('10.0.0.7')],
  'mixed.example': [v4('1.1.1.1'), v4('10.0.0.1')],
  'metadata.example': [v4('169.254.169.254')],
  'mapped.example': [v6('::ffff:7f00:1')],
  'localhost': [v4('127.0.0.1'), v6('::1')],
  'empty.example': [],
  'garbage.example': [{ address: 'not-an-ip', family: 0 }],
}

describe('createUpstreamGuard — lookup', () => {
  test('a public answer with all:true passes every address through', async () => {
    const { resolve } = fakeResolver(ANSWERS)
    const outcome = await lookupThrough(resolve, 'public.example', { all: true })
    expect(outcome.error).toBeNull()
    expect(outcome.address).toEqual([v4('1.1.1.1'), v6('2606:4700::1111')])
  })

  test('a public answer without all hands back the first address and its family', async () => {
    const { resolve } = fakeResolver(ANSWERS)
    const outcome = await lookupThrough(resolve, 'public.example', {})
    expect(outcome.error).toBeNull()
    expect(outcome.address).toBe('1.1.1.1')
    expect(outcome.family).toBe(4)
  })

  test('all:false behaves like an absent all', async () => {
    const { resolve } = fakeResolver(ANSWERS)
    const outcome = await lookupThrough(resolve, 'public.example', { all: false })
    expect(outcome.address).toBe('1.1.1.1')
    expect(outcome.family).toBe(4)
  })

  test('the resolver is always asked for every address, keeping the caller family', async () => {
    const { resolve, calls } = fakeResolver(ANSWERS)
    await lookupThrough(resolve, 'public.example', { family: 6, hints: 32 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.hostname).toBe('public.example')
    expect(calls[0]?.options).toMatchObject({ all: true, family: 6, hints: 32 })
  })

  test.each([
    ['internal.example', 'private'],
    ['metadata.example', 'link-local'],
    ['mapped.example', 'loopback'],
    ['localhost', 'loopback'],
  ])('%s is refused as %s', async (hostname, reason) => {
    const { resolve } = fakeResolver(ANSWERS)
    const outcome = await lookupThrough(resolve, hostname, { all: true })
    expect(outcome.error).toBeInstanceOf(UpstreamAddressRefusedError)
    expect(outcome.error).toMatchObject({ host: hostname, reason })
    expect(outcome.address).toEqual([])
  })

  test('a mixed answer is refused whole, even without all', async () => {
    const { resolve } = fakeResolver(ANSWERS)
    for (const options of [{ all: true }, {}]) {
      const outcome = await lookupThrough(resolve, 'mixed.example', options)
      expect(outcome.error).toBeInstanceOf(UpstreamAddressRefusedError)
      expect(outcome.error).toMatchObject({ reason: 'private' })
    }
  })

  test('an answer that is not an IP address is refused (fail closed)', async () => {
    const { resolve } = fakeResolver(ANSWERS)
    const outcome = await lookupThrough(resolve, 'garbage.example', { all: true })
    expect(outcome.error).toBeInstanceOf(UpstreamAddressRefusedError)
    expect(outcome.error).toMatchObject({ reason: 'reserved' })
  })

  test('the refusal names the host and the category but never the resolved address', async () => {
    const { resolve } = fakeResolver(ANSWERS)
    const outcome = await lookupThrough(resolve, 'internal.example', { all: true })
    const message = (outcome.error as Error).message
    expect(message).toBe(
      'refused to connect to internal.example: it resolves to a private address; ' +
        'this install reaches only public https servers (tenant mode)',
    )
    expect(message).not.toContain('10.0.0.7')
  })

  test('a resolver error is passed through as is, not turned into a refusal', async () => {
    const { resolve } = fakeResolver(ANSWERS)
    const outcome = await lookupThrough(resolve, 'nowhere.example', { all: true })
    expect(outcome.error).not.toBeInstanceOf(UpstreamAddressRefusedError)
    expect(outcome.error?.code).toBe('ENOTFOUND')
    expect(outcome.address).toEqual([])
  })

  test('an empty answer is a resolution failure (ENOTFOUND), not a refusal', async () => {
    const { resolve } = fakeResolver(ANSWERS)
    const outcome = await lookupThrough(resolve, 'empty.example', {})
    expect(outcome.error).not.toBeInstanceOf(UpstreamAddressRefusedError)
    expect(outcome.error?.code).toBe('ENOTFOUND')
  })

  test('a resolver that throws synchronously reaches the callback, not the caller', async () => {
    const throwing: ResolveAllFunction = () => {
      throw new Error('boom')
    }
    const outcome = await lookupThrough(throwing, 'public.example', {})
    expect(outcome.error?.message).toBe('boom')
  })

  test('a non-Error thrown by the resolver still reaches the callback as an Error', async () => {
    const throwing: ResolveAllFunction = () => {
      throw 'resolver exploded'
    }
    const outcome = await lookupThrough(throwing, 'public.example', {})
    expect(outcome.error).toBeInstanceOf(Error)
    expect(outcome.error?.message).toBe('resolver exploded')
  })

  test('the default resolver is the system one (a literal resolves to itself)', async () => {
    const guard = createUpstreamGuard()
    const outcome = await new Promise<LookupOutcome>((done) => {
      guard.lookup('127.0.0.1', {}, (error, address, family) => done({ error, address, family }))
    })
    expect(outcome.error).toBeInstanceOf(UpstreamAddressRefusedError)
    expect(outcome.error).toMatchObject({ reason: 'loopback' })
  })
})

describe('createUpstreamGuard — checkUrl', () => {
  const guard = createUpstreamGuard({ lookup: fakeResolver(ANSWERS).resolve })

  test('an https URL with a DNS name passes (the name is checked at connect time)', () => {
    expect(() => guard.checkUrl(new URL('https://internal.example/mcp'))).not.toThrow()
  })

  test('a public https literal passes', () => {
    expect(() => guard.checkUrl(new URL('https://1.1.1.1/mcp'))).not.toThrow()
    expect(() => guard.checkUrl(new URL('https://[2606:4700::1111]:8443/mcp'))).not.toThrow()
  })

  test.each(['http://public.example/mcp', 'http://1.1.1.1/', 'ws://public.example/', 'ftp://x/'])(
    '%s is refused for its scheme',
    (raw) => {
      const url = new URL(raw)
      let caught: unknown
      try {
        guard.checkUrl(url)
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toBeInstanceOf(UpstreamAddressRefusedError)
      expect(caught).toMatchObject({ reason: 'scheme', host: url.hostname })
      expect((caught as Error).message).toBe(
        `refused to connect to ${url.hostname}: ` +
          'this install reaches only https servers (tenant mode)',
      )
    },
  )

  test.each([
    ['https://127.0.0.1/mcp', 'loopback', '127.0.0.1'],
    ['https://0x7f000001/mcp', 'loopback', '127.0.0.1'],
    ['https://169.254.169.254/latest/meta-data/', 'link-local', '169.254.169.254'],
    ['https://10.0.0.5/', 'private', '10.0.0.5'],
    ['https://[::1]/', 'loopback', '::1'],
    ['https://[::ffff:127.0.0.1]/', 'loopback', '::ffff:7f00:1'],
    ['https://[::ffff:a9fe:a9fe]/', 'link-local', '::ffff:a9fe:a9fe'],
    ['https://[64:ff9b::a9fe:a9fe]/', 'link-local', '64:ff9b::a9fe:a9fe'],
    ['https://[fe80::1]/', 'link-local', 'fe80::1'],
    ['https://[fd00:ec2::254]/', 'private', 'fd00:ec2::254'],
    ['https://[::]/', 'unspecified', '::'],
  ])('literal %s is refused as %s', (raw, reason, host) => {
    let caught: unknown
    try {
      guard.checkUrl(new URL(raw))
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UpstreamAddressRefusedError)
    expect(caught).toMatchObject({ reason, host })
  })

  test('a literal refusal says the literal IS such an address', () => {
    expect(() => guard.checkUrl(new URL('https://10.0.0.5/'))).toThrow(
      'refused to connect to 10.0.0.5: it is a private address; ' +
        'this install reaches only public https servers (tenant mode)',
    )
  })

  test('"an" before a vowel-led category', () => {
    expect(() => guard.checkUrl(new URL('https://0.0.0.0/'))).toThrow(
      'refused to connect to 0.0.0.0: it is an unspecified address;',
    )
  })

  test('the path and query never reach the message (they may carry tokens)', () => {
    let caught: unknown
    try {
      guard.checkUrl(new URL('https://127.0.0.1/mcp?token=s3cret'))
    } catch (error: unknown) {
      caught = error
    }
    expect((caught as Error).message).not.toContain('s3cret')
    expect((caught as Error).message).not.toContain('/mcp')
  })
})

describe('UpstreamAddressRefusedError', () => {
  test('is an Error with a stable name and code', () => {
    const error = new UpstreamAddressRefusedError('x.example', 'private', 'resolved')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('UpstreamAddressRefusedError')
    expect(error.code).toBe('ERR_UPSTREAM_ADDRESS_REFUSED')
    expect(error.host).toBe('x.example')
    expect(error.reason).toBe('private')
  })

  test('the guard object and its methods are frozen', () => {
    const guard = createUpstreamGuard()
    expect(Object.isFrozen(guard)).toBe(true)
  })
})

describe('the guard lookup inside a real node:http request', () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise<void>((done) => (server === undefined ? done() : server.close(() => done())))
    server = undefined
  })

  /** A live server on loopback; the count proves whether a request ever arrived. */
  async function startCountingServer(): Promise<{ port: number; hits: () => number }> {
    let count = 0
    const started = createServer((_req, res) => {
      count += 1
      res.end('ok')
    })
    server = started
    await new Promise<void>((done) => started.listen(0, '127.0.0.1', done))
    return { port: (started.address() as AddressInfo).port, hits: () => count }
  }

  test.each([true, false])(
    'a name resolving to loopback never reaches the socket (autoSelectFamily %s)',
    async (autoSelectFamily) => {
      const { port, hits } = await startCountingServer()
      const guard = createUpstreamGuard({
        lookup: fakeResolver({ 'upstream.example': [v4('127.0.0.1')] }).resolve,
      })
      const error = await new Promise<unknown>((done) => {
        const req = request(
          { host: 'upstream.example', port, path: '/', lookup: guard.lookup, autoSelectFamily },
          () => done(new Error('unexpected response')),
        )
        req.on('error', done)
        req.end()
      })
      expect(error).toBeInstanceOf(UpstreamAddressRefusedError)
      expect(error).toMatchObject({ host: 'upstream.example', reason: 'loopback' })
      expect(hits()).toBe(0)
    },
  )
})

/**
 * Security review M1 (tenant mode): the guard owns its https socket pool. With
 * only a `lookup` on the request, a guarded request could be handed a socket
 * that the process-wide keep-alive `https.globalAgent` opened for some other,
 * unguarded client — and a pooled socket never resolves again.
 */
describe('createUpstreamGuard — its own https socket pool', () => {
  test('the agent is a keep-alive https.Agent of its own whose lookup is the guard lookup', () => {
    const guard = createUpstreamGuard()

    expect(guard.agent).toBeInstanceOf(HttpsAgent)
    expect(guard.agent).not.toBe(httpsGlobalAgent)
    expect(guard.agent.keepAlive).toBe(true)
    expect(guard.agent.options.lookup).toBe(guard.lookup)
  })

  test('two guards never share a pool', () => {
    expect(createUpstreamGuard().agent).not.toBe(createUpstreamGuard().agent)
  })

  test('a request carrying only the agent still resolves through the guard — nothing reaches the listener', async () => {
    let connections = 0
    const listener = createNetServer((socket) => {
      connections += 1
      socket.destroy()
    })
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done))
    const { port } = listener.address() as AddressInfo
    const guard = createUpstreamGuard({
      lookup: fakeResolver({ 'upstream.example': [v4('127.0.0.1')] }).resolve,
    })

    const error = await new Promise<unknown>((done) => {
      const req = httpsRequest({ host: 'upstream.example', port, path: '/', agent: guard.agent }, () =>
        done(new Error('unexpected response')),
      )
      req.on('error', done)
      req.end()
    })
    await new Promise<void>((done) => listener.close(() => done()))

    expect(error).toMatchObject({ host: 'upstream.example', reason: 'loopback' })
    expect(connections).toBe(0)
  })
})

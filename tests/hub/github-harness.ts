import http from 'node:http'
import { createServer } from 'node:net'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { GithubError, createGithubClient, type GithubClient, type GithubClientOptions } from '../../hub/src/github.js'
import { s256, startFakeGithub, type FakeGithub, type FakeProfile } from './fake-github.js'

/**
 * Shared set-up for the GitHub client tests (`github.test.ts`,
 * `github-profile.test.ts`): a fresh strict fake per test, clients pointed
 * at it and closed afterwards, and a few single-purpose servers for answers
 * the fake does not produce.
 */

/** The RFC 7636 Appendix B verifier; any valid verifier would do. */
export const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
export const SHORT_TIMEOUT_MS = 300

export interface GithubTestContext {
  fake(): FakeGithub
  clientFor(overrides?: Partial<GithubClientOptions>): GithubClient
  /** A real access token from the fake, via a code issued for `VERIFIER`. */
  tokenFor(client: GithubClient, profile?: FakeProfile): Promise<string>
}

/** Registers the per-test fake and client clean-up in the calling file. */
export function useFakeGithub(): GithubTestContext {
  let fake: FakeGithub | undefined
  let clients: GithubClient[] = []
  const current = (): FakeGithub => {
    if (fake === undefined) throw new Error('fake GitHub is not running (use inside a test)')
    return fake
  }

  beforeEach(async () => {
    fake = await startFakeGithub()
    clients = []
  })

  afterEach(async () => {
    for (const client of clients) client.close()
    await current().close()
    fake = undefined
    vi.restoreAllMocks()
  })

  return {
    fake: current,
    clientFor: (overrides = {}) => {
      const running = current()
      const client = createGithubClient({
        clientId: running.clientId,
        clientSecret: running.clientSecret,
        redirectUri: running.redirectUri,
        webBase: running.baseUrl,
        apiBase: running.baseUrl,
        ...overrides,
      })
      clients.push(client)
      return client
    },
    tokenFor: (client, profile) => {
      const code = current().issueCode(s256(VERIFIER), profile)
      return client.exchangeCode({ code, verifier: VERIFIER })
    },
  }
}

/** Runs `fn`, expecting a GithubError, and returns it. */
export async function githubErrorOf(fn: () => Promise<unknown>): Promise<GithubError> {
  const error = await fn().then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(GithubError)
  return error as GithubError
}

export interface TestServer {
  readonly base: string
  close(): Promise<void>
}

/** A base URL on 127.0.0.1 where nothing listens. */
export async function closedPortBase(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = portOf(server.address())
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

/** A server answering every request with one fixed JSON body. */
export function fixedAnswerServer(status: number, body: string): Promise<TestServer> {
  return listen((req, res) => {
    req.resume()
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body)
  })
}

/** A server streaming `bytes` of padding in chunks, with no Content-Length. */
export function streamingServer(bytes: number): Promise<TestServer> {
  const chunk = 'x'.repeat(4096)
  return listen((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    for (let sent = 0; sent < bytes; sent += chunk.length) res.write(chunk)
    res.end()
  })
}

async function listen(handler: http.RequestListener): Promise<TestServer> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${portOf(server.address())}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

function portOf(address: ReturnType<http.Server['address']>): number {
  return typeof address === 'object' && address !== null ? address.port : 0
}

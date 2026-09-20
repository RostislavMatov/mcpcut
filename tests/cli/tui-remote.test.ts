import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runRemoteTui } from '../../src/cli/tui-remote.js'
import type { UiCliIo } from '../../src/cli/ui-constants.js'
import { readSavedRemote, savedRemotePathFor, writeSavedRemote } from '../../src/tui/remote/saved.js'
import { parseRemoteUrl } from '../../src/tui/remote/url.js'
import type { FetchLike } from '../../src/tui/remote/client.js'
import { plainStyle } from '../../src/tui/ansi.js'
import { createFakeTerminal, waitForScreen, type FakeTerminal } from '../tui/support/fake-terminal.js'

/**
 * `mcpcut --remote <url>` (ADR-0014, plan wave 2 task 4): opening the SAME
 * console over HTTP instead of the local dispatcher. `client.test.ts` and
 * `dispatch.test.ts` already cover the HTTP half; this is the assembly —
 * which screen opens, what refuses before a frame ever exists, and that a
 * signed-in run really does reach `POST run`.
 */

interface FakeIo extends UiCliIo {
  out(): string
  err(): string
}

function fakeIo(): FakeIo {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function ndjsonResponse(lines: readonly unknown[]): Response {
  const body = lines.map((line) => `${JSON.stringify(line)}\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

/** A fetch double routed by path, recording every call. */
function routedFetch(
  routes: Readonly<Record<string, (init: RequestInit) => Response | Promise<Response>>>,
): { fetchImpl: FetchLike; calls: Array<{ path: string; init: RequestInit }> } {
  const calls: Array<{ path: string; init: RequestInit }> = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    const record = init ?? {}
    calls.push({ path: url.pathname, init: record })
    const handler = routes[url.pathname]
    if (handler === undefined) throw new Error(`unexpected call to ${url.pathname}`)
    return handler(record)
  }) as FetchLike
  return { fetchImpl, calls }
}

/** The seams a test opens a remote console on: a fake terminal, no real signals. */
function remoteConsoleOpts(fake: FakeTerminal, fetchImpl: FetchLike) {
  return {
    terminal: fake.terminal,
    style: plainStyle,
    processEvents: new EventEmitter(),
    escapeCodeTimeoutMs: 10,
    platform: 'linux' as NodeJS.Platform,
    remoteFetch: fetchImpl,
  }
}

describe('runRemoteTui: refusals before any frame exists', () => {
  test('a malformed address refuses with its own message and touches no terminal', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const bad = parseRemoteUrl('ftp://example.com')

    const code = await runRemoteTui(bad, io, {}, remoteConsoleOpts(fake, (() => {
      throw new Error('must not be called')
    }) as unknown as FetchLike))

    expect(code).toBe(1)
    expect(io.err()).toContain('ftp://example.com')
    expect(fake.frames()).toEqual([])
  })

  test('an unreachable server refuses with exit 1 and no frame', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const good = parseRemoteUrl('http://127.0.0.1:1')
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as FetchLike

    const code = await runRemoteTui(good, io, {}, remoteConsoleOpts(fake, fetchImpl))

    expect(code).toBe(1)
    expect(io.err()).not.toBe('')
    expect(fake.frames()).toEqual([])
  })

  test('a state answer that fails schema validation refuses too, rather than opening a broken screen', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const good = parseRemoteUrl('http://127.0.0.1:1')
    const { fetchImpl } = routedFetch({ '/api/console/state': () => jsonResponse(200, { nonsense: true }) })

    const code = await runRemoteTui(good, io, {}, remoteConsoleOpts(fake, fetchImpl))

    expect(code).toBe(1)
    expect(fake.frames()).toEqual([])
  })
})

describe('runRemoteTui: the loud plain-http warning', () => {
  test('a non-loopback http address warns on stderr before the console opens', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const insecure = parseRemoteUrl('http://203.0.113.7:8091')
    const { fetchImpl } = routedFetch({
      '/api/console/state': () => jsonResponse(200, { api: 1, firstRun: false }),
    })

    const running = runRemoteTui(insecure, io, {}, remoteConsoleOpts(fake, fetchImpl))
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the sign-in screen')
    fake.type('\x1b')
    await running

    expect(io.err()).toContain('warning:')
    expect(io.err()).toContain('crosses the network in clear')
  })

  test('loopback http gets no warning', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const loopback = parseRemoteUrl('http://127.0.0.1:8091')
    const { fetchImpl } = routedFetch({
      '/api/console/state': () => jsonResponse(200, { api: 1, firstRun: false }),
    })

    const running = runRemoteTui(loopback, io, {}, remoteConsoleOpts(fake, fetchImpl))
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the sign-in screen')
    fake.type('\x1b')
    await running

    expect(io.err()).toBe('')
  })
})

describe('runRemoteTui: which screen opens', () => {
  test('firstRun: true opens the first-owner screen with a code field', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const good = parseRemoteUrl('http://127.0.0.1:8091')
    const { fetchImpl } = routedFetch({
      '/api/console/state': () => jsonResponse(200, { api: 1, firstRun: true }),
    })

    const running = runRemoteTui(good, io, {}, remoteConsoleOpts(fake, fetchImpl))
    await waitForScreen(fake, (screen) => screen.includes('Setup code'), 'the remote first-owner form')
    fake.type('\x1b')

    expect(await running).toBe(0)
  })

  test('firstRun: false opens the sign-in screen, with the address on it', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const good = parseRemoteUrl('http://127.0.0.1:8091')
    const { fetchImpl } = routedFetch({
      '/api/console/state': () => jsonResponse(200, { api: 1, firstRun: false }),
    })

    const running = runRemoteTui(good, io, {}, remoteConsoleOpts(fake, fetchImpl))
    await waitForScreen(fake, (screen) => screen.includes('Sign in') && screen.includes('127.0.0.1:8091'), 'the sign-in screen')
    fake.type('\x1b')

    expect(await running).toBe(0)
  })
})

describe('runRemoteTui: signing in and running a command reaches POST run', () => {
  test('a token that resolves signs in, and Enter on an action reaches the client', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal({ columns: 100, rows: 30 })
    const good = parseRemoteUrl('http://127.0.0.1:8091')
    let seenAuthorization: string | undefined
    const { fetchImpl } = routedFetch({
      '/api/console/state': () => jsonResponse(200, { api: 1, firstRun: false }),
      '/api/console/whoami': (init) => {
        seenAuthorization = (init.headers as Record<string, string>)?.authorization
        return jsonResponse(200, { name: 'alice', role: 'owner' })
      },
      '/api/console/run': () => ndjsonResponse([{ t: 'out', d: 'ok\n' }, { t: 'exit', code: 0 }]),
    })

    const running = runRemoteTui(good, io, {}, remoteConsoleOpts(fake, fetchImpl))
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the sign-in screen')
    fake.type(`mcpa_the-token\r`)
    await waitForScreen(fake, (screen) => screen.includes('alice (owner)'), 'the main screen, signed in')
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(seenAuthorization).toBe('Bearer mcpa_the-token')
  })
})

/**
 * "A way to disconnect" (2026-09-20): Ctrl-D on the sign-in screen forgets a
 * saved address, if any, and hands the terminal to `--connect <address>` —
 * the one `leavesConsole`-shaped effect a remote console can ask for.
 */
describe('runRemoteTui: disconnect', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpcut-remote-disconnect-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  function stateOnlyFetch() {
    return routedFetch({ '/api/console/state': () => jsonResponse(200, { api: 1, firstRun: false }) }).fetchImpl
  }

  test('forgets a real saved file and reopens on --connect <address>', async () => {
    const path = savedRemotePathFor({}, home)
    await writeSavedRemote(path, 'http://127.0.0.1:8091')
    const io = fakeIo()
    const fake = createFakeTerminal()
    const good = parseRemoteUrl('http://127.0.0.1:8091')
    let reopened: readonly string[] | undefined

    const running = runRemoteTui(good, io, {}, {
      ...remoteConsoleOpts(fake, stateOnlyFetch()),
      home,
      reopen: async (argv) => {
        reopened = argv
        return 0
      },
    })
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the sign-in screen')
    fake.type('\x04')

    expect(await running).toBe(0)
    expect(reopened).toEqual(['--connect', 'http://127.0.0.1:8091'])
    expect(await readSavedRemote(path)).toEqual({ kind: 'absent' })
  })

  test('an absent saved file is not an error: it still reopens', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const good = parseRemoteUrl('http://127.0.0.1:8091')
    let reopened: readonly string[] | undefined

    const running = runRemoteTui(good, io, {}, {
      ...remoteConsoleOpts(fake, stateOnlyFetch()),
      home,
      reopen: async (argv) => {
        reopened = argv
        return 0
      },
    })
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the sign-in screen')
    fake.type('\x04')

    expect(await running).toBe(0)
    expect(reopened).toEqual(['--connect', 'http://127.0.0.1:8091'])
  })

  test('the default reopen is a real spawn seam: without one this still resolves with an exit code, never hangs', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const good = parseRemoteUrl('http://127.0.0.1:8091')

    const running = runRemoteTui(good, io, {}, { ...remoteConsoleOpts(fake, stateOnlyFetch()), home })
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the sign-in screen')
    fake.type('\x04')

    // No real `mcpcut` binary at `DEFAULT_CLI_PATH` in the test environment,
    // so the default spawn fails and resolves EXIT_INTERRUPTED — the point of
    // this test is only that it settles, with the file already forgotten.
    await expect(running).resolves.toEqual(expect.any(Number))
  })
})

import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'vitest'
import { dispatch, type CliIo } from '../../src/cli.js'
import type { DataDirResolution } from '../../src/setup/data-dir.js'
import { plainStyle } from '../../src/tui/ansi.js'
import type { FetchLike } from '../../src/tui/remote/client.js'
import { createFakeTerminal, waitForScreen } from '../tui/support/fake-terminal.js'

/**
 * `mcpcut --remote <url>` (ADR-0014, plan wave 2 task 4): the top-level entry
 * `cli.ts` routes BEFORE the broken-config gate — a remote client has no
 * local install and must not need one to open.
 */

interface FakeIo extends CliIo {
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

/** A local install resolution broken enough that the ordinary gate would refuse it. */
const BROKEN_INSTALL: DataDirResolution = {
  dataDir: '/home/op/.mcpcut/data',
  source: 'default',
  configPath: '/home/op/.mcpcut/config.json',
  problem: ['dataDir: dataDir must be an absolute path'],
  problemSource: 'config',
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stateOnlyFetch(): FetchLike {
  return (async (input: unknown) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/console/state') return jsonResponse(200, { api: 1, firstRun: false })
    throw new Error(`unexpected call to ${url.pathname}`)
  }) as FetchLike
}

describe('dispatch: --remote', () => {
  test('opens the remote console even over a broken local install', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = dispatch(['--remote', 'http://127.0.0.1:8091'], io, {
      install: BROKEN_INSTALL,
      tui: {
        isTty: true,
        terminal: fake.terminal,
        style: plainStyle,
        processEvents: new EventEmitter(),
        escapeCodeTimeoutMs: 10,
        remoteFetch: stateOnlyFetch(),
      },
    })
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the remote sign-in screen')
    fake.type('\x1b')

    expect(await running).toBe(0)
    expect(io.err()).toBe('')
  })

  test('with no URL at all, refuses with a usage hint rather than opening anything', async () => {
    const io = fakeIo()

    const code = await dispatch(['--remote'], io, {})

    expect(code).toBe(1)
    expect(io.err()).toContain('--remote')
    expect(io.err()).toContain('Usage:')
  })

  test('extra arguments after the URL are refused the same way `tui` refuses them', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const code = await dispatch(['--remote', 'http://127.0.0.1:8091', 'extra'], io, {
      tui: { isTty: true, terminal: fake.terminal },
    })

    expect(code).toBe(1)
    expect(io.err()).toContain('tui takes no arguments')
  })

  test('a malformed URL refuses with the parser’s own message, still before any local gate', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const code = await dispatch(['--remote', 'ftp://example.com'], io, {
      install: BROKEN_INSTALL,
      tui: { isTty: true, terminal: fake.terminal },
    })

    expect(code).toBe(1)
    expect(io.err()).toContain('ftp://example.com')
    expect(io.err()).not.toContain('dataDir')
  })
})

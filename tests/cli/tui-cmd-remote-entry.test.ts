import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'vitest'
import { runTui, type TuiCommandOptions } from '../../src/cli/tui-cmd.js'
import type { UiCliIo } from '../../src/cli/ui-constants.js'
import type { FetchLike } from '../../src/tui/remote/client.js'
import { plainStyle } from '../../src/tui/ansi.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import { createFakeTerminal, waitForScreen } from '../tui/support/fake-terminal.js'

/**
 * `runTui`'s remote entry (ADR-0014, plan wave 2 task 4): `--remote <url>`
 * and a bare/`tui` invocation with `MCPCUT_REMOTE` set both route to
 * `runRemoteTui` BEFORE the local install is even read — the case that
 * matters here is that a broken LOCAL config never gets in the way.
 *
 * The remote console's own screens, refusals and streaming are
 * `tests/cli/tui-remote.test.ts`'s job; this file only proves the routing.
 */

interface FakeIo extends UiCliIo {
  err(): string
}

function fakeIo(): FakeIo {
  const errChunks: string[] = []
  return {
    stdout: { write: () => undefined },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    err: () => errChunks.join(''),
  }
}

/** A local install config broken enough that the ordinary gate would refuse it. */
const BROKEN_INSTALL: InstallConfigLoad = {
  kind: 'invalid',
  path: '/home/op/.mcpcut/config.json',
  problems: ['dataDir: dataDir must be an absolute path'],
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

function baseOpts(fetchImpl: FetchLike): Partial<TuiCommandOptions> {
  const fake = createFakeTerminal()
  return {
    terminal: fake.terminal,
    style: plainStyle,
    processEvents: new EventEmitter(),
    escapeCodeTimeoutMs: 10,
    platform: 'linux',
    remoteFetch: fetchImpl,
    isTty: true,
    install: BROKEN_INSTALL,
  }
}

describe('runTui: --remote skips the local install entirely', () => {
  test('a --remote flag opens the remote console even over a broken local config', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, {
      ...baseOpts(stateOnlyFetch()),
      terminal: fake.terminal,
      env: {},
      entry: 'explicit',
      remoteFlag: 'http://127.0.0.1:8091',
    })
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the remote sign-in screen')
    fake.type('\x1b')

    expect(await running).toBe(0)
    expect(io.err()).toBe('')
  })

  test('MCPCUT_REMOTE on a bare invocation does the same', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, {
      ...baseOpts(stateOnlyFetch()),
      terminal: fake.terminal,
      env: { MCPCUT_REMOTE: 'http://127.0.0.1:8091' },
      entry: 'bare',
    })
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the remote sign-in screen')
    fake.type('\x1b')

    expect(await running).toBe(0)
  })

  test('MCPCUT_REMOTE on an explicit "tui" does the same', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, {
      ...baseOpts(stateOnlyFetch()),
      terminal: fake.terminal,
      env: { MCPCUT_REMOTE: 'http://127.0.0.1:8091' },
      entry: 'explicit',
    })
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the remote sign-in screen')
    fake.type('\x1b')

    expect(await running).toBe(0)
  })

  test('no --remote and no MCPCUT_REMOTE still hits the local gate (unaffected by wave 2)', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const code = await runTui([], io, {
      ...baseOpts(stateOnlyFetch()),
      terminal: fake.terminal,
      env: {},
      entry: 'bare',
      dispatch: async () => 0,
    })

    expect(code).toBe(1)
    expect(io.err()).toContain('dataDir')
  })

  test('the remote branch does not throw for a missing local dispatcher (none is needed remotely)', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, {
      ...baseOpts(stateOnlyFetch()),
      terminal: fake.terminal,
      env: {},
      entry: 'explicit',
      remoteFlag: 'http://127.0.0.1:8091',
      // Deliberately no `dispatch` at all.
    })
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the remote sign-in screen')
    fake.type('\x1b')

    expect(await running).toBe(0)
  })
})

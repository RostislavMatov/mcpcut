import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runTui, type TuiCommandOptions } from '../../src/cli/tui-cmd.js'
import type { UiCliIo } from '../../src/cli/ui-constants.js'
import { plainStyle } from '../../src/tui/ansi.js'
import { WELCOME_TITLE } from '../../src/tui/constants-live.js'
import { WIZARD_TITLE_FIRST_RUN } from '../../src/tui/constants.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import type { FetchLike } from '../../src/tui/remote/client.js'
import { savedRemotePathFor, writeSavedRemote } from '../../src/tui/remote/saved.js'
import { createFakeTerminal, waitForScreen, type FakeTerminal } from '../tui/support/fake-terminal.js'

/**
 * `mcpcut --connect [url]` (ADR-0014, owner request 2026-09-20): opens the
 * welcome screen's "connect" form directly — regardless of a local install,
 * `MCPCUT_REMOTE`, or a saved address — needs a TTY like every console entry,
 * and refuses a broken local config no more than `--remote` does.
 */

const CONFIG_PATH = '/home/op/.mcpcut/config.json'

const absentInstall: InstallConfigLoad = { kind: 'absent', path: CONFIG_PATH }
const okInstall: InstallConfigLoad = {
  kind: 'ok',
  path: CONFIG_PATH,
  config: defaultInstallConfig('/var/lib/mcpcut'),
}
const invalidInstall: InstallConfigLoad = {
  kind: 'invalid',
  path: CONFIG_PATH,
  problems: ['dataDir: dataDir must be an absolute path'],
}

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

function stateOnlyFetch(): FetchLike {
  return (async (input: unknown) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/console/state') return jsonResponse(200, { api: 1, firstRun: false })
    throw new Error(`unexpected call to ${url.pathname}`)
  }) as FetchLike
}

const quietDispatch = async (): Promise<number> => 0

/** A reopen seam that starts nothing: Esc over a local install asks for one. */
const stayPut = async (): Promise<number> => 0

function connectOpts(fake: FakeTerminal, install: InstallConfigLoad, patch: Partial<TuiCommandOptions> = {}): TuiCommandOptions {
  return {
    dispatch: quietDispatch,
    env: {},
    install,
    isTty: true,
    terminal: fake.terminal,
    style: plainStyle,
    processEvents: new EventEmitter(),
    escapeCodeTimeoutMs: 10,
    platform: 'linux',
    entry: 'connect',
    home: '/home/op',
    cwd: '/w',
    remoteFetch: stateOnlyFetch(),
    ...patch,
  }
}

describe('runTui: --connect opens the connect form directly', () => {
  test('with no argument, opens an empty form — never the "choose" screen', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, connectOpts(fake, absentInstall))
    await waitForScreen(fake, (screen) => screen.includes('Host:'), 'the connect form')
    const openedOnConnect = !fake.screen().includes(WELCOME_TITLE)
    fake.type('\x03')

    await running
    expect(openedOnConnect).toBe(true)
  })

  test('with a valid url argument, the form is prefilled', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, connectOpts(fake, absentInstall, { connectArg: 'https://box.example:8091' }))
    await waitForScreen(fake, (screen) => screen.includes('box.example'), 'the prefilled host')
    fake.type('\x03')

    await expect(running).resolves.toBe(0)
  })

  test('with an invalid url argument, opens anyway — a notice, not a refusal', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, connectOpts(fake, absentInstall, { connectArg: 'not a url' }))
    await waitForScreen(fake, (screen) => screen.includes('Host:'), 'the connect form')
    const screenText = fake.screen()
    fake.type('\x03')

    await expect(running).resolves.toBe(0)
    expect(screenText).toContain('not a url')
  })

  test('a successful connect reopens with ["--remote", url], same as the ordinary welcome path', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const reopened: string[][] = []

    const running = runTui([], io, connectOpts(fake, absentInstall, {
      rememberRemote: async () => undefined,
      reopen: async (argv) => {
        reopened.push([...argv])
        return 0
      },
    }))
    await waitForScreen(fake, (screen) => screen.includes('Host:'), 'the connect form')
    fake.type('box.example')
    fake.type('\t')
    fake.type('8091')
    fake.type('\r')

    expect(await running).toBe(0)
    expect(reopened).toEqual([['--remote', 'https://box.example:8091']])
  })

  test('needs a TTY like every other console entry', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const code = await runTui([], io, { ...connectOpts(fake, absentInstall), isTty: false })

    expect(code).toBe(1)
    expect(fake.frames()).toEqual([])
  })

  test('ignores MCPCUT_REMOTE: --connect always opens the form, never dials the variable\'s address', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, connectOpts(fake, absentInstall, { env: { MCPCUT_REMOTE: 'http://127.0.0.1:9' } }))
    await waitForScreen(fake, (screen) => screen.includes('Host:'), 'the connect form, not a remote sign-in')
    fake.type('\x03')

    await expect(running).resolves.toBe(0)
  })

  test('opens even over a broken local config: it needs no data directory', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const reopened: string[][] = []

    const running = runTui([], io, connectOpts(fake, invalidInstall, {
      reopen: async (argv) => {
        reopened.push([...argv])
        return 0
      },
    }))
    await waitForScreen(fake, (screen) => screen.includes('Host:'), 'the connect form')
    fake.type('\x1b')

    await expect(running).resolves.toBe(0)
    expect(io.err()).toBe('')
    // A broken config has no console to go back to: a bare `mcpcut` would only
    // print the config problem, so Esc quits here as it always did.
    expect(reopened).toEqual([])
  })

  describe('Esc: back to "choose", unless a local install already exists', () => {
    test('no local install: Esc goes back to "choose"', async () => {
      const io = fakeIo()
      const fake = createFakeTerminal()

      const running = runTui([], io, connectOpts(fake, absentInstall))
      await waitForScreen(fake, (screen) => screen.includes('Host:'), 'the connect form')
      fake.type('\x1b')
      await waitForScreen(fake, (screen) => screen.includes(WELCOME_TITLE), 'the choose screen')
      fake.type('\x1b')

      expect(await running).toBe(0)
    })

    test('a local install already exists: Esc goes back to it (a bare mcpcut), never offering "set up"', async () => {
      const io = fakeIo()
      const fake = createFakeTerminal()
      const reopened: string[][] = []

      const running = runTui([], io, connectOpts(fake, okInstall, {
        reopen: async (argv) => {
          reopened.push([...argv])
          return 0
        },
      }))
      await waitForScreen(fake, (screen) => screen.includes('Esc back to this machine'), 'the connect form')
      fake.type('\x1b')

      expect(await running).toBe(0)
      expect(reopened).toEqual([[]])
      expect(fake.frames().some((frame) => frame.includes(WIZARD_TITLE_FIRST_RUN))).toBe(false)
    })
  })
})

/**
 * `--connect` with no argument over a remembered address (2026-09-28): the
 * reopen a local console's Ctrl-O and Home ▸ connect ask for carries no
 * address, so the form offers the last service this machine connected to
 * instead of an empty Host. Only a prefill — nothing is dialed until Enter.
 */
describe('runTui: --connect with no argument offers the remembered address', () => {
  async function withHome(run: (home: string) => Promise<void>): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), 'mcpcut-connect-entry-'))
    try {
      await run(home)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }

  test('a saved address prefills the form and dials nothing by itself', async () => {
    await withHome(async (home) => {
      await writeSavedRemote(savedRemotePathFor({}, home), 'https://saved.example:8443')
      const io = fakeIo()
      const fake = createFakeTerminal()
      const dialed: string[] = []
      const countingFetch = (async (input: unknown) => {
        dialed.push(String(input))
        return jsonResponse(200, { api: 1, firstRun: false })
      }) as FetchLike

      const running = runTui([], io, connectOpts(fake, okInstall, { reopen: stayPut, home, remoteFetch: countingFetch }))
      await waitForScreen(fake, (screen) => screen.includes('saved.example'), 'the remembered host')
      const screenText = fake.screen()
      fake.type('\x1b')

      await expect(running).resolves.toBe(0)
      expect(screenText).toContain('8443')
      expect(dialed).toEqual([])
    })
  })

  test('an explicit address wins over the saved one', async () => {
    await withHome(async (home) => {
      await writeSavedRemote(savedRemotePathFor({}, home), 'https://saved.example:8443')
      const io = fakeIo()
      const fake = createFakeTerminal()

      const running = runTui([], io, connectOpts(fake, okInstall, { reopen: stayPut, home, connectArg: 'https://typed.example:8091' }))
      await waitForScreen(fake, (screen) => screen.includes('typed.example'), 'the typed host')
      const screenText = fake.screen()
      fake.type('\x1b')

      await expect(running).resolves.toBe(0)
      expect(screenText).not.toContain('saved.example')
    })
  })

  test('a corrupted saved file is one warning and an empty form, never a crash', async () => {
    await withHome(async (home) => {
      const path = savedRemotePathFor({}, home)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '{not json')
      const io = fakeIo()
      const fake = createFakeTerminal()

      const running = runTui([], io, connectOpts(fake, okInstall, { reopen: stayPut, home }))
      await waitForScreen(fake, (screen) => screen.includes('Host:'), 'the connect form')
      fake.type('\x1b')

      await expect(running).resolves.toBe(0)
      expect(io.err()).toContain('warning: saved remote address')
    })
  })
})

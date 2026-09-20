import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runTui, type TuiCommandOptions } from '../../src/cli/tui-cmd.js'
import type { UiCliIo } from '../../src/cli/ui-constants.js'
import { plainStyle } from '../../src/tui/ansi.js'
import { WELCOME_TITLE } from '../../src/tui/constants-live.js'
import { createAdminStore } from '../../src/admin/store.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import { readSavedRemote, savedRemotePathFor, writeSavedRemote } from '../../src/tui/remote/saved.js'
import type { FetchLike } from '../../src/tui/remote/client.js'
import { createFakeTerminal, waitForScreen, type FakeTerminal } from '../tui/support/fake-terminal.js'

/**
 * "Remember the last address" (2026-09-20, owner request): the bare-launch
 * precedence table's fourth rung, reached only when `--remote`/`MCPCUT_REMOTE`
 * are unset AND no local install exists (`entry: 'bare'`, `install.kind ===
 * 'absent'`) — everything above those in the table is `tui-cmd-remote-entry`'s
 * and `tui-cmd.test.ts`'s job.
 */

const CONFIG_PATH_OF = (home: string): string => join(home, '.mcpcut', 'config.json')

const absentInstallAt = (home: string): InstallConfigLoad => ({ kind: 'absent', path: CONFIG_PATH_OF(home) })

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A fetch double answering `GET state` with `ok` or refusing every call, to fake reachability. */
function fetchOf(reachable: boolean): FetchLike {
  return (async (input: unknown) => {
    const url = new URL(String(input))
    if (url.pathname !== '/api/console/state') throw new Error(`unexpected call to ${url.pathname}`)
    if (!reachable) throw new Error('ECONNREFUSED')
    return jsonResponse(200, { api: 1, firstRun: false })
  }) as FetchLike
}

const quietDispatch = async (): Promise<number> => 0

function baseOpts(fake: FakeTerminal, home: string, fetchImpl: FetchLike): TuiCommandOptions {
  return {
    dispatch: quietDispatch,
    env: {},
    install: absentInstallAt(home),
    isTty: true,
    terminal: fake.terminal,
    style: plainStyle,
    processEvents: new EventEmitter(),
    escapeCodeTimeoutMs: 10,
    platform: 'linux',
    entry: 'bare',
    home,
    cwd: '/w',
    remoteFetch: fetchImpl,
  }
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mcpcut-saved-remote-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('bare launch, no local install: a saved address that answers', () => {
  test('is dialed exactly like --remote, the ONE existing remote path', async () => {
    await writeSavedRemote(savedRemotePathFor({}, home), 'http://127.0.0.1:8091')
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, baseOpts(fake, home, fetchOf(true)))
    await waitForScreen(fake, (screen) => screen.includes('Sign in') && screen.includes('127.0.0.1:8091'), 'the remote sign-in screen')
    fake.type('\x1b')

    expect(await running).toBe(0)
    // Said BEFORE the dial: the probe may take the whole connect timeout, and
    // the terminal is not the console's yet — silence would look like a hang.
    expect(io.err()).toBe('connecting to http://127.0.0.1:8091 …\n')
  })
})

describe('bare launch over a LOCAL install with a saved address beside it', () => {
  test('opens the local console: the saved address neither wins nor is dialed nor is touched', async () => {
    const path = savedRemotePathFor({}, home)
    await writeSavedRemote(path, 'http://127.0.0.1:8091')
    const journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-saved-remote-local-'))
    await createAdminStore({ journalDir }).createAdmin('root', 'owner')
    const dialed: string[] = []
    const recordingFetch = (async (input: unknown) => {
      dialed.push(String(input))
      throw new Error('a local console must not dial anything')
    }) as FetchLike
    const io = fakeIo()
    const fake = createFakeTerminal()
    const localInstall: InstallConfigLoad = {
      kind: 'ok',
      path: CONFIG_PATH_OF(home),
      config: defaultInstallConfig(journalDir),
    }

    const running = runTui([], io, { ...baseOpts(fake, home, recordingFetch), install: localInstall, journalDir })
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the local sign-in screen')
    const screen = fake.screen()
    fake.type('\x1b')

    expect(await running).toBe(0)
    expect(screen).not.toContain('remote:')
    expect(dialed).toEqual([])
    expect(await readSavedRemote(path)).toEqual({ kind: 'ok', url: 'http://127.0.0.1:8091' })
    await rm(journalDir, { recursive: true, force: true })
  })
})

describe('bare launch, no local install: a saved address that does not answer', () => {
  test('opens the connect form directly, prefilled, with a notice — the file is kept', async () => {
    const path = savedRemotePathFor({}, home)
    await writeSavedRemote(path, 'http://127.0.0.1:8091')
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, baseOpts(fake, home, fetchOf(false)))
    await waitForScreen(fake, (screen) => screen.includes('127.0.0.1'), 'the prefilled connect form')
    expect(fake.screen()).not.toContain(WELCOME_TITLE)
    expect(fake.screen().toLowerCase()).toContain('did not answer')
    fake.type('\x03')

    expect(await running).toBe(0)
    // A server being down right now is not a reason to forget where it lives.
    expect(await readSavedRemote(path)).toEqual({ kind: 'ok', url: 'http://127.0.0.1:8091' })
  })

  test('Esc from this form goes back to "choose": there is still no local install', async () => {
    await writeSavedRemote(savedRemotePathFor({}, home), 'http://127.0.0.1:8091')
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, baseOpts(fake, home, fetchOf(false)))
    await waitForScreen(fake, (screen) => screen.includes('127.0.0.1'), 'the prefilled connect form')
    fake.type('\x1b')
    await waitForScreen(fake, (screen) => screen.includes(WELCOME_TITLE), 'the choose screen')
    fake.type('\x1b')

    expect(await running).toBe(0)
  })
})

describe('bare launch, no local install: no saved address at all', () => {
  test('opens the ordinary "choose" welcome screen', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, baseOpts(fake, home, fetchOf(true)))
    await waitForScreen(fake, (screen) => screen.includes(WELCOME_TITLE), 'the choose screen')
    fake.type('\x1b')

    expect(await running).toBe(0)
    expect(io.err()).toBe('')
  })
})

describe('bare launch, no local install: an invalid saved file', () => {
  test('warns once on stderr, names the file, and opens the ordinary welcome screen as if absent', async () => {
    const path = savedRemotePathFor({}, home)
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(home, '.mcpcut'), { recursive: true })
    await writeFile(path, 'not json at all', 'utf8')
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, baseOpts(fake, home, fetchOf(true)))
    await waitForScreen(fake, (screen) => screen.includes(WELCOME_TITLE), 'the choose screen')
    fake.type('\x1b')

    expect(await running).toBe(0)
    expect(io.err()).toContain(path)
    expect(io.err().split('\n').filter((line) => line.includes('warning'))).toHaveLength(1)
  })
})

import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'vitest'
import { dispatchOptionsFor, isInteractiveTerminal, runTui, type TuiCommandOptions } from '../../src/cli/tui-cmd.js'
import { TUI_USAGE } from '../../src/cli/operator-usage.js'
import {
  bareNoConfigHint,
  TUI_NOT_A_TTY,
  TUI_NOT_WIRED,
  TUI_NO_ARGUMENTS,
} from '../../src/cli/tui-constants.js'
import type { UiCliIo } from '../../src/cli/ui-constants.js'
import { plainStyle } from '../../src/tui/ansi.js'
import type { TuiOutput } from '../../src/tui/runtime.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import { createFakeTerminal, waitForScreen, type FakeTerminal } from '../tui/support/fake-terminal.js'

/**
 * The gates in front of the console (mcpcut phase 2, task 14).
 *
 * `runTui` is the whole of the decision "does a console open at all", and
 * every refusal it can print reaches a shell rather than a frame. So the
 * cases here are the ones where nothing is drawn — no terminal, arguments it
 * has no use for, an install config that is missing or unusable — plus the
 * one where something is: an interactive terminal, where the assertion is
 * that the first frame is the sign-in screen and that Ctrl-C gives the
 * terminal back.
 *
 * The environment is always `{}`: `loadInstallConfigSync` must never reach
 * the developer's own `~/.mcpcut/config.json`, and `MCP_ADMIN_TOKEN` must
 * never leak in from the shell running the suite.
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

/** A dispatcher that answers every command with success and records nothing. */
const quietDispatch = async (): Promise<number> => 0

/** The seams a console opened in a test runs on: a fake terminal, no signals of its own. */
function consoleOptions(fake: FakeTerminal, install: InstallConfigLoad): TuiCommandOptions {
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
  }
}

describe('runTui: arguments', () => {
  test('--help prints the tui usage on stdout and exits 0', async () => {
    const io = fakeIo()

    const exitCode = await runTui(['--help'], io, { env: {} })

    expect(exitCode).toBe(0)
    expect(io.out()).toBe(TUI_USAGE)
    expect(io.err()).toBe('')
  })

  test('-h is the same as --help', async () => {
    const io = fakeIo()

    const exitCode = await runTui(['-h'], io, { env: {} })

    expect(exitCode).toBe(0)
    expect(io.out()).toBe(TUI_USAGE)
  })

  test('refuses any other argument with the usage, before it looks at the terminal', async () => {
    const io = fakeIo()

    const exitCode = await runTui(['x'], io, { env: {}, isTty: true })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(TUI_NO_ARGUMENTS)
    expect(io.err()).toContain(TUI_USAGE)
    expect(io.out()).toBe('')
  })
})

describe('runTui: the terminal gate', () => {
  test('refuses outside a TTY and touches nothing', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const exitCode = await runTui([], io, {
      env: {},
      isTty: false,
      terminal: fake.terminal,
      dispatch: quietDispatch,
      install: okInstall,
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toBe(TUI_NOT_A_TTY)
    expect(fake.frames()).toEqual([])
    expect(fake.rawModeCalls).toEqual([])
  })
})

describe('runTui: the install config', () => {
  test('a bare invocation without a config points at setup instead of opening', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const exitCode = await runTui([], io, {
      ...consoleOptions(fake, absentInstall),
      entry: 'bare',
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toBe(bareNoConfigHint(CONFIG_PATH))
    expect(io.err()).toContain(CONFIG_PATH)
    expect(io.err()).toContain('setup --yes')
    expect(fake.frames()).toEqual([])
  })

  test('an explicit tui without a config opens over the default data directory', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, {
      ...consoleOptions(fake, absentInstall),
      entry: 'explicit',
    })
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the sign-in screen')
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(fake.restored()).toBe(true)
    expect(io.err()).toBe('')
  })

  test('refuses an unusable config with the same problems every command prints', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const exitCode = await runTui([], io, {
      ...consoleOptions(fake, invalidInstall),
      entry: 'explicit',
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(CONFIG_PATH)
    expect(io.err()).toContain('dataDir: dataDir must be an absolute path')
    expect(fake.frames()).toEqual([])
  })
})

describe('runTui: wiring', () => {
  test('rejects when the dispatcher was not injected', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    await expect(
      runTui([], io, {
        env: {},
        isTty: true,
        terminal: fake.terminal,
        install: okInstall,
        style: plainStyle,
        processEvents: new EventEmitter(),
        escapeCodeTimeoutMs: 10,
      }),
    ).rejects.toThrow(TUI_NOT_WIRED)
    expect(fake.frames()).toEqual([])
  })
})

describe('isInteractiveTerminal', () => {
  test('an explicit isTty answers on its own, whatever the terminal is', () => {
    const fake = createFakeTerminal()

    expect(isInteractiveTerminal({ isTty: false, terminal: fake.terminal })).toBe(false)
    expect(isInteractiveTerminal({ isTty: true })).toBe(true)
  })

  test('a terminal whose halves are both a TTY is interactive', () => {
    const fake = createFakeTerminal()

    expect(isInteractiveTerminal({ terminal: fake.terminal })).toBe(true)
  })

  test('one half that is not a TTY is enough to refuse', () => {
    const fake = createFakeTerminal()
    // A redirected stdout: the console reads keys from a terminal it cannot
    // draw on, which is not a console.
    const pipedOutput: TuiOutput = Object.assign(new EventEmitter(), {
      isTTY: false,
      write: (): boolean => true,
    })

    expect(
      isInteractiveTerminal({ terminal: { input: fake.terminal.input, output: pipedOutput } }),
    ).toBe(false)
  })

  test('no options at all falls back to the process streams', () => {
    // Whatever the suite runs on, the answer must be a boolean rather than a
    // throw: `dispatch` calls this on every bare invocation.
    expect(typeof isInteractiveTerminal()).toBe('boolean')
  })
})

describe('dispatchOptionsFor: one store for the session check and the admin commands', () => {
  test('hands the console journalDir to the admin seam', () => {
    expect(dispatchOptionsFor({ journalDir: '/x', dispatchOptions: {} })).toEqual({
      admin: { journalDir: '/x' },
    })
  })

  test('leaves an admin seam that already points somewhere alone', () => {
    const dispatchOptions = { admin: { journalDir: '/y' } }

    expect(dispatchOptionsFor({ journalDir: '/x', dispatchOptions })).toBe(dispatchOptions)
  })

  test('changes nothing when no journalDir was given', () => {
    const dispatchOptions = { journalDir: '/z' }

    expect(dispatchOptionsFor({ dispatchOptions })).toBe(dispatchOptions)
  })
})

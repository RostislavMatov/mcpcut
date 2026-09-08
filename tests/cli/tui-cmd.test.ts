import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'vitest'
import { dispatchOptionsFor, runTui, type TuiCommandOptions } from '../../src/cli/tui-cmd.js'
import { TUI_USAGE } from '../../src/cli/operator-usage.js'
import { TUI_NOT_A_TTY, TUI_NOT_WIRED, TUI_NO_ARGUMENTS } from '../../src/cli/tui-constants.js'
import type { UiCliIo } from '../../src/cli/ui-constants.js'
import { plainStyle } from '../../src/tui/ansi.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import { WIZARD_TITLE_EDIT, WIZARD_TITLE_FIRST_RUN } from '../../src/tui/constants.js'
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

/** A dispatcher that prints what `setup --yes` prints, so the wizard can read an owner out of it. */
const transcriptDispatch = async (
  argv: readonly string[],
  dispatchIo: UiCliIo,
): Promise<number> => {
  if (argv[0] === 'setup') dispatchIo.stdout.write('admin: owner\nrole: owner\ntoken: mcpa_x\n')
  return 0
}

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
  test('a bare invocation without a config opens the first-run wizard', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, {
      ...consoleOptions(fake, absentInstall),
      entry: 'bare',
      home: '/home/op',
      cwd: '/w',
    })
    await waitForScreen(
      fake,
      (screen) => screen.includes(WIZARD_TITLE_FIRST_RUN) && screen.includes('Data dir'),
      'the wizard form',
    )
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(fake.restored()).toBe(true)
    expect(io.err()).toBe('')
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

describe('runTui: the setup entry opens the wizard', () => {
  test('over a config, in edit mode, with that config in the fields', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, {
      ...consoleOptions(fake, okInstall),
      entry: 'setup',
      home: '/home/op',
      cwd: '/w',
    })
    await waitForScreen(
      fake,
      (screen) => screen.includes(WIZARD_TITLE_EDIT) && screen.includes('/var/lib/mcpcut'),
      'the wizard in edit mode',
    )
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(io.err()).toBe('')
  })

  test('an unusable config is refused by the same gate every command uses', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const exitCode = await runTui([], io, {
      ...consoleOptions(fake, invalidInstall),
      entry: 'setup',
      home: '/home/op',
      cwd: '/w',
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(CONFIG_PATH)
    expect(io.err()).toContain('--force')
    expect(fake.frames()).toEqual([])
  })

  test('the setup flags prefill the form', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, {
      ...consoleOptions(fake, absentInstall),
      entry: 'setup',
      home: '/home/op',
      cwd: '/w',
      setupArgs: { yes: false, force: false, start: false, noAdmin: false, uiPort: 18091 },
    })
    await waitForScreen(fake, (screen) => screen.includes('[18091'), 'the prefilled UI port')
    fake.type('\x03')

    expect(await running).toBe(0)
  })

  test('the reopen seam is asked for the console once the wizard is done', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const reopened: string[][] = []

    const running = runTui([], io, {
      ...consoleOptions(fake, absentInstall),
      dispatch: transcriptDispatch,
      entry: 'bare',
      home: '/home/op',
      cwd: '/w',
      reopen: async (argv) => {
        reopened.push([...argv])
        return 0
      },
    })
    await waitForScreen(fake, (screen) => screen.includes('Data dir'), 'the wizard form')
    // Services by external: both starts are somebody else's business, so the
    // ladder is one rung and the final screen arrives without a live manager.
    fake.type('\x1b[Z')
    fake.type('\x1b[D')
    await waitForScreen(fake, (screen) => screen.includes('external'), 'the external supervisor')
    fake.type('\r')
    await waitForScreen(fake, (screen) => screen.includes('Saved it?'), 'the final screen')
    fake.type('y')

    expect(await running).toBe(0)
    expect(reopened).toEqual([['tui']])
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

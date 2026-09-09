import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import type { CliWritable, DispatchFn } from '../../src/cli/dispatch-types.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import { ENTER_SCREEN, LEAVE_SCREEN, plainStyle, type Style } from '../../src/tui/ansi.js'
import type { SectionSpec } from '../../src/tui/catalogue/types.js'
import {
  ACTIVE_MARKER,
  DEFAULT_TUI_SIGNALS,
  EXIT_INTERRUPTED,
  EXIT_OK,
  SECRET_MASK_CHAR,
  SIGNIN_TITLE,
  WINDOWS_UNSUPPORTED_REASON,
  WIZARD_TITLE_FIRST_RUN,
} from '../../src/tui/constants.js'
import type { Model, Msg, Session, TerminalSize } from '../../src/tui/model.js'
import {
  createReopenCell,
  createTokenCell,
  createWizardOutcomeCell,
  type ReopenCell,
  type TokenCell,
} from '../../src/tui/runtime-effects.js'
import {
  createLoop,
  runConsole,
  type ConsoleDeps,
  type TuiTerminal,
} from '../../src/tui/runtime.js'
import { wizardScreenOf, type WizardPrefill } from '../../src/tui/wizard-fields.js'
import { createFakeTerminal, waitForScreen, type FakeTerminal } from './support/fake-terminal.js'

/**
 * The console's runtime (mcpcut phase 2, task 13): the only effectful module
 * of the console, and therefore the only one whose tests are about a terminal
 * rather than about a value.
 *
 * Three properties are pinned here, and they are the reasons this module
 * exists at all. The terminal is RESTORED on every exit path — a quit key, an
 * interrupt, a signal, an uncaught exception, a pty that died mid-frame —
 * because a console that leaves a shell in raw mode on the alternate screen
 * has broken the terminal it was handed. Nothing the runtime installs on the
 * process outlives it: the signal and crash listeners are removed in the same
 * `finally` that restores the screen. And the returned promise always
 * RESOLVES with an exit code, never rejects, because the caller is a CLI
 * command that has a terminal to restore of its own.
 *
 * The tests drive real bytes through a `PassThrough` (`support/fake-terminal.
 * ts`) so `readline.emitKeypressEvents` does the decoding it will do in
 * production — a chunk carrying two keys, an escape sequence split across two
 * chunks and a lone `Esc` that only resolves on a timeout are all things the
 * decoder, not the console, gets right or wrong.
 */

/** Short enough to keep the lone-`Esc` test quick; the console ships with 100. */
const ESCAPE_TIMEOUT_MS = 10

/** How long a quit waits for a command in flight here; the console ships with 2 s. */
const QUIT_DRAIN_TEST_MS = 100

/** The admin the sign-in tests resolve to, created in a temp store. */
const ADMIN_NAME = 'alice'
const ADMIN_ROLE = 'owner'
const SIGNED_IN_HEADER = `${ADMIN_NAME} (${ADMIN_ROLE})`

/** An action of the Admins section, and one of Home: what a frame is read for. */
const ADMINS_ACTION = 'rotate'
const ADMINS_SECTION_KEY = '2'

let journalDir: string

/** Every console started by a test, so none of them outlives it. */
const running: Array<{ readonly harness: Harness }> = []

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-runtime-'))
})

afterEach(async () => {
  for (const { harness } of running.splice(0)) {
    harness.processEvents.emit('SIGTERM')
    await harness.exit.catch(() => undefined)
  }
  await rm(journalDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface CapturedStderr extends CliWritable {
  text(): string
}

function captureStderr(): CapturedStderr {
  const chunks: string[] = []
  return {
    write: (chunk: string) => chunks.push(chunk),
    text: () => chunks.join(''),
  }
}

/** A `dispatch` that answers success and writes nothing. */
const quietDispatch: DispatchFn = async () => EXIT_OK

interface Harness {
  readonly fake: FakeTerminal
  readonly processEvents: EventEmitter
  readonly exit: Promise<number>
  errText(): string
}

interface StartOptions {
  readonly dispatch?: DispatchFn
  readonly terminal?: TuiTerminal
  readonly style?: Style
  readonly columns?: number
  readonly rows?: number
  /** The screen the console opens on; the sign-in screen when absent. */
  readonly initial?: (size: TerminalSize) => Model
  /** A session already in hand, for a console that opens past the sign-in screen. */
  readonly token?: TokenCell
  /** Where an action that leaves the console puts the argv to reopen with. */
  readonly reopen?: ReopenCell
}

/** The console's own environment: distinctive, so a seam carrying it is recognisable. */
const CONSOLE_ENV: NodeJS.ProcessEnv = { MCPCUT_CONFIG: '/home/alice/.mcpcut/config.json' }

function depsOf(
  terminal: TuiTerminal,
  processEvents: EventEmitter,
  stderr: CliWritable,
  dispatch: DispatchFn,
  style: Style = plainStyle,
  token: TokenCell = createTokenCell(),
  reopen?: ReopenCell,
): ConsoleDeps {
  return {
    terminal,
    style,
    stderr,
    effects: {
      dispatch,
      dispatchOptions: { admin: { journalDir } },
      env: CONSOLE_ENV,
      journalDir,
      token,
      ...(reopen === undefined ? {} : { reopen }),
    },
    processEvents,
    signals: DEFAULT_TUI_SIGNALS,
    escapeCodeTimeoutMs: ESCAPE_TIMEOUT_MS,
    quitDrainTimeoutMs: QUIT_DRAIN_TEST_MS,
    platform: 'linux',
  }
}

/** Starts a console and hands back everything a test needs to watch it. */
function startConsole(options: StartOptions = {}): Harness {
  const fake = createFakeTerminal({
    ...(options.columns !== undefined ? { columns: options.columns } : {}),
    ...(options.rows !== undefined ? { rows: options.rows } : {}),
  })
  const processEvents = new EventEmitter()
  const stderr = captureStderr()
  const exit = runConsole({
    ...depsOf(
      options.terminal ?? fake.terminal,
      processEvents,
      stderr,
      options.dispatch ?? quietDispatch,
      options.style ?? plainStyle,
      options.token ?? createTokenCell(),
      options.reopen,
    ),
    ...(options.initial !== undefined ? { initial: options.initial } : {}),
  })
  const harness: Harness = { fake, processEvents, exit, errText: () => stderr.text() }
  running.push({ harness })
  return harness
}

/** An admin in the temp store, with the one-time token the console signs in with. */
async function createTestAdmin(): Promise<string> {
  const created = await createAdminStore({ journalDir }).createAdmin(ADMIN_NAME, ADMIN_ROLE)
  return created.token
}

/** Starts a console and signs it in, leaving it on the main screen. */
async function signedInConsole(options: StartOptions = {}): Promise<{
  readonly harness: Harness
  readonly token: string
}> {
  const token = await createTestAdmin()
  const harness = startConsole(options)
  await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')
  harness.fake.type(`${token}\r`)
  await waitForScreen(
    harness.fake,
    (screen) => screen.includes(SIGNED_IN_HEADER),
    'the header of a signed-in console',
  )
  return { harness, token }
}

// ---------------------------------------------------------------------------
// Opening and leaving
// ---------------------------------------------------------------------------

describe('runConsole: the initial screen seam', () => {
  /** What `mcpcut` hands the wizard when no config exists yet. */
  function wizardPrefill(): WizardPrefill {
    return {
      mode: 'first-run',
      configPath: '/home/alice/.mcpcut/config.json',
      config: defaultInstallConfig('/var/lib/x'),
    }
  }

  test('opens on the screen the caller built, not on the sign-in screen', async () => {
    const prefill = wizardPrefill()
    const harness = startConsole({
      initial: (size) => ({ screen: wizardScreenOf(prefill), size }),
    })

    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(WIZARD_TITLE_FIRST_RUN),
      'the first-run wizard',
    )

    harness.fake.type('\x03')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
    expect(harness.fake.restored()).toBe(true)
  })

  test('is asked for the terminal size once, and the sign-in screen stands without it', async () => {
    const sizes: TerminalSize[] = []
    const harness = startConsole({
      columns: 100,
      rows: 30,
      initial: (size) => {
        sizes.push(size)
        return { screen: wizardScreenOf(wizardPrefill()), size }
      },
    })

    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(WIZARD_TITLE_FIRST_RUN),
      'the first-run wizard',
    )
    harness.fake.resize(120, 40)

    expect(sizes).toEqual([{ columns: 100, rows: 30 }])
    harness.fake.type('\x03')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
  })

  test('without the seam the console still opens on the sign-in screen', async () => {
    const harness = startConsole()

    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    expect(harness.fake.screen()).not.toContain(WIZARD_TITLE_FIRST_RUN)
    harness.fake.type('\x03')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
  })
})

// ---------------------------------------------------------------------------
// The effect queue
// ---------------------------------------------------------------------------

describe('the queue: what a settled console still owes the wizard', () => {
  /** An install whose services belong to Compose, so `setup` alone finishes the wizard. */
  function externalPrefill(): WizardPrefill {
    const config = defaultInstallConfig('/var/lib/x')

    return {
      mode: 'first-run',
      configPath: '/home/alice/.mcpcut/config.json',
      config: { ...config, supervisor: 'external' },
    }
  }

  /** A dispatcher that takes the command and never answers. */
  const neverAnswers: DispatchFn = () => new Promise<number>(() => undefined)

  const SETUP_STDOUT = 'admin: owner\nrole: owner\ntoken: mcpa_x\n'

  const ENTER: Msg = { kind: 'key', key: { kind: 'enter' } }
  const YES: Msg = { kind: 'key', key: { kind: 'char', char: 'y' } }
  const SETUP_DONE: Msg = {
    kind: 'wizard-run-result',
    step: 'setup',
    result: {
      argv: ['setup', '--yes'],
      display: ['setup', '--yes'],
      exitCode: EXIT_OK,
      stdout: SETUP_STDOUT,
      stderr: '',
    },
  }

  test('the wizard answer is left in the cell with a run still in flight', () => {
    // The queue is made busy on purpose: `setup` is dispatched and never
    // answers, so every later link of the chain is stuck behind it. The
    // wizard reaches its final screen anyway — the result is folded in from
    // outside — and the answer it hands back must not wait on the queue,
    // because the drain that follows a quit is bounded.
    const outcome = createWizardOutcomeCell()
    const fake = createFakeTerminal()
    const base = depsOf(fake.terminal, new EventEmitter(), captureStderr(), neverAnswers)
    const loop = createLoop({
      ...base,
      effects: { ...base.effects, wizard: { outcome } },
      initial: (size) => ({ screen: wizardScreenOf(externalPrefill()), size }),
    })

    loop.step(ENTER)
    loop.step(SETUP_DONE)
    loop.step(YES)

    expect(outcome.get()).toBe('sign-in')
    expect(loop.exitCode()).toBe(EXIT_OK)
  })

  test('the run that never answered is still the one the queue is stuck on', async () => {
    // Guards the guard: without a busy queue the test above would pass on a
    // `wizard-finish` that only runs when the chain drains.
    const dispatched: string[][] = []
    const fake = createFakeTerminal()
    const base = depsOf(fake.terminal, new EventEmitter(), captureStderr(), (argv) => {
      dispatched.push([...argv])
      return new Promise<number>(() => undefined)
    })
    const loop = createLoop({
      ...base,
      effects: { ...base.effects, wizard: { outcome: createWizardOutcomeCell() } },
      initial: (size) => ({ screen: wizardScreenOf(externalPrefill()), size }),
    })

    loop.step(ENTER)
    // The queue hands an effect to the dispatcher a microtask later.
    await new Promise((resolve) => setImmediate(resolve))

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.[0]).toBe('setup')
  })
})

describe('runConsole: opening the screen', () => {
  test('enters the alternate screen before it draws anything, on the sign-in screen', async () => {
    const harness = startConsole()

    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    expect(harness.fake.frames()[0]).toBe(ENTER_SCREEN)
    expect(harness.fake.rawModeCalls[0]).toBe(true)
    harness.fake.type('\x03')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
  })

  test('draws a frame of exactly as many lines as the terminal has rows', async () => {
    const harness = startConsole({ columns: 40, rows: 10 })

    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    const lines = harness.fake.screen().split('\n')
    expect(lines).toHaveLength(10)
    expect(lines.every((line) => line.length <= 40)).toBe(true)
  })

  test('falls back to 80x24 when the terminal reports no size at all', async () => {
    const chunks: string[] = []
    const input = new PassThrough()
    const output = Object.assign(new EventEmitter(), {
      write: (chunk: string) => chunks.push(chunk),
    })
    const harness = startConsole({ terminal: { input, output } })

    await waitForUntilTrue(() => chunks.some((chunk) => chunk.includes(SIGNIN_TITLE)))

    const frame = chunks.at(-1) ?? ''
    expect(frame.split('\r\n')).toHaveLength(24)
    input.write('\x03')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
  })

  test('refuses on Windows before it touches the terminal', async () => {
    const fake = createFakeTerminal()
    const stderr = captureStderr()

    const code = await runConsole({
      ...depsOf(fake.terminal, new EventEmitter(), stderr, quietDispatch),
      platform: 'win32',
    })

    expect(code).toBe(EXIT_INTERRUPTED)
    expect(stderr.text()).toContain(WINDOWS_UNSUPPORTED_REASON)
    expect(fake.frames()).toEqual([])
    expect(fake.rawModeCalls).toEqual([])
  })
})

describe('runConsole: the ways out', () => {
  test('Ctrl-C quits with 0 and restores the terminal', async () => {
    const harness = startConsole()
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    harness.fake.type('\x03')

    await expect(harness.exit).resolves.toBe(EXIT_OK)
    expect(harness.fake.restored()).toBe(true)
  })

  test('a lone Esc on the sign-in screen quits once the escape timeout is up', async () => {
    const harness = startConsole()
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    harness.fake.type('\x1b')

    await expect(harness.exit).resolves.toBe(EXIT_OK)
    expect(harness.fake.restored()).toBe(true)
  })

  test('q on a signed-in console quits with 0, and no frame ever held the token', async () => {
    const { harness, token } = await signedInConsole()

    harness.fake.type('q')

    await expect(harness.exit).resolves.toBe(EXIT_OK)
    expect(harness.fake.restored()).toBe(true)
    expect(harness.fake.frames().some((frame) => frame.includes(token))).toBe(false)
  })

  test('a signal ends the console with 1, restores it and leaves no listener behind', async () => {
    const harness = startConsole()
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    harness.processEvents.emit('SIGTERM')

    await expect(harness.exit).resolves.toBe(EXIT_INTERRUPTED)
    expect(harness.fake.restored()).toBe(true)
    for (const signal of DEFAULT_TUI_SIGNALS) {
      expect(harness.processEvents.listenerCount(signal)).toBe(0)
    }
    expect(harness.processEvents.listenerCount('uncaughtException')).toBe(0)
    expect(harness.processEvents.listenerCount('unhandledRejection')).toBe(0)
    expect(harness.fake.terminal.input.listenerCount('keypress')).toBe(0)
    expect(harness.fake.terminal.output.listenerCount('resize')).toBe(0)
  })

  test('a second signal during the exit changes nothing: the console leaves once', async () => {
    const harness = startConsole()
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    harness.processEvents.emit('SIGTERM')
    harness.processEvents.emit('SIGHUP')

    await expect(harness.exit).resolves.toBe(EXIT_INTERRUPTED)
    expect(harness.fake.frames().filter((frame) => frame.includes(LEAVE_SCREEN))).toHaveLength(1)
  })

  test('SIGHUP with a dead pty still resolves 1 instead of throwing out of the restore', async () => {
    const harness = startConsole()
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    harness.fake.failWrites()
    harness.processEvents.emit('SIGHUP')

    await expect(harness.exit).resolves.toBe(EXIT_INTERRUPTED)
  })

  test('a write that fails while drawing ends the console rather than throwing', async () => {
    const harness = startConsole()
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    harness.fake.failWrites()
    harness.fake.type('x')

    await expect(harness.exit).resolves.toBe(EXIT_INTERRUPTED)
  })

  test('a terminal already gone when the console opens is reported, and raw mode dropped', async () => {
    const fake = createFakeTerminal()
    fake.failWrites()
    const stderr = captureStderr()

    const code = await runConsole(
      depsOf(fake.terminal, new EventEmitter(), stderr, quietDispatch),
    )

    expect(code).toBe(EXIT_INTERRUPTED)
    expect(stderr.text()).toContain('EPIPE')
    expect(fake.rawModeCalls).toEqual([true, false])
  })

  test('a fault in the pure core is reported and ends the console with 1', async () => {
    let broken = false
    const brittleStyle: Style = {
      bold: (text) => {
        if (broken) throw new Error('the renderer blew up')
        return text
      },
      inverse: (text) => text,
      dim: (text) => text,
    }
    const harness = startConsole({ style: brittleStyle })
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    broken = true
    harness.fake.type('x')

    await expect(harness.exit).resolves.toBe(EXIT_INTERRUPTED)
    expect(harness.errText()).toContain('the renderer blew up')
    expect(harness.fake.restored()).toBe(true)
  })

  test('an uncaught exception ends the console with 1 and reports it on stderr', async () => {
    const harness = startConsole()
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    harness.processEvents.emit('uncaughtException', new Error('boom'))

    await expect(harness.exit).resolves.toBe(EXIT_INTERRUPTED)
    expect(harness.errText()).toContain('boom')
    expect(harness.fake.restored()).toBe(true)
  })

  test('an unhandled rejection of a value that is not an Error is reported too', async () => {
    const harness = startConsole()
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    harness.processEvents.emit('unhandledRejection', 'kaput')

    await expect(harness.exit).resolves.toBe(EXIT_INTERRUPTED)
    expect(harness.errText()).toContain('kaput')
  })

  test('Ctrl-C leaves within the drain bound even while a command never answers', async () => {
    // Everything but the header refresh: since phase 5 the sign-in screen asks
    // for `status` as it opens, and a dispatcher that hangs on THAT would
    // never let the console be signed in at all.
    const hung: DispatchFn = (argv) =>
      argv[0] === 'status' ? Promise.resolve(EXIT_OK) : new Promise<number>(() => undefined)
    const { harness } = await signedInConsole({ dispatch: hung })
    harness.fake.type('\r')
    await waitForScreen(harness.fake, (screen) => screen.includes('running:'), 'the busy line')

    harness.fake.type('\x03')

    await expect(harness.exit).resolves.toBe(EXIT_OK)
    expect(harness.fake.restored()).toBe(true)
  })

  test('the fault report reaches stderr only after the terminal is restored', async () => {
    const fake = createFakeTerminal()
    const processEvents = new EventEmitter()
    const restoredAtWrite: boolean[] = []
    const stderr: CliWritable = {
      write: (chunk: string) => {
        restoredAtWrite.push(fake.restored())
        return chunk
      },
    }
    const exit = runConsole(depsOf(fake.terminal, processEvents, stderr, quietDispatch))
    await waitForScreen(fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    processEvents.emit('uncaughtException', new Error('boom'))

    await expect(exit).resolves.toBe(EXIT_INTERRUPTED)
    expect(restoredAtWrite).toEqual([true])
  })

  test('the token cell is empty once the console has left', async () => {
    const token = await createTestAdmin()
    const cell = createTokenCell()
    const fake = createFakeTerminal()
    const processEvents = new EventEmitter()
    const exit = runConsole(
      depsOf(fake.terminal, processEvents, captureStderr(), quietDispatch, plainStyle, cell),
    )
    await waitForScreen(fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')
    fake.type(`${token}\r`)
    await waitForScreen(fake, (screen) => screen.includes(SIGNED_IN_HEADER), 'the signed-in header')
    expect(cell.get()).toBe(token)

    fake.type('q')

    await expect(exit).resolves.toBe(EXIT_OK)
    expect(cell.get()).toBeUndefined()
  })

  test("an 'error' event on the output ends the console quietly with 1", async () => {
    const harness = startConsole()
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    harness.fake.terminal.output.emit('error', new Error('EPIPE'))

    await expect(harness.exit).resolves.toBe(EXIT_INTERRUPTED)
    expect(harness.fake.restored()).toBe(true)
    expect(harness.errText()).toBe('')
  })

  test('a terminal with no setRawMode is driven and restored all the same', async () => {
    const chunks: string[] = []
    const input = new PassThrough()
    const output = Object.assign(new EventEmitter(), {
      isTTY: true,
      columns: 80,
      rows: 24,
      write: (chunk: string) => chunks.push(chunk),
    })
    const harness = startConsole({ terminal: { input, output } })

    await waitForUntilTrue(() => chunks.some((chunk) => chunk.includes(SIGNIN_TITLE)))
    input.write('\x03')

    await expect(harness.exit).resolves.toBe(EXIT_OK)
    expect(chunks.at(-1)).toBe(LEAVE_SCREEN)
  })
})

// ---------------------------------------------------------------------------
// Keys, as bytes
// ---------------------------------------------------------------------------

describe('runConsole: decoding what arrives', () => {
  test('two keys in one chunk are both folded in', async () => {
    const { harness } = await signedInConsole()
    harness.fake.type(ADMINS_SECTION_KEY)
    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(ADMINS_ACTION),
      'the actions of the Admins section',
    )

    harness.fake.type('jj')

    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(`${ACTIVE_MARKER}${ADMINS_ACTION}`),
      'the cursor two actions down',
    )
  })

  test('an escape sequence split across two chunks decodes as one arrow key', async () => {
    const { harness } = await signedInConsole()
    expect(harness.fake.screen()).not.toContain(ADMINS_ACTION)

    harness.fake.type('\x1b[')
    harness.fake.type('C')

    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(ADMINS_ACTION),
      'the next section, reached by a right arrow',
    )
  })

  test('what is typed into the token field never reaches the frame unmasked', async () => {
    const harness = startConsole()
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    harness.fake.type('ab')

    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(SECRET_MASK_CHAR.repeat(2)),
      'both typed characters, masked',
    )
    expect(harness.fake.screen()).not.toContain('ab')
  })

  test('a resize redraws at the size the terminal now reports', async () => {
    const harness = startConsole()
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    harness.fake.resize(40, 10)

    await waitForScreen(
      harness.fake,
      (screen) => screen.split('\n').length === 10,
      'a frame at the new size',
    )
    expect(harness.fake.screen().split('\n').every((line) => line.length <= 40)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

describe('runConsole: effects', () => {
  test('a command that throws becomes a failed run, and the console stays up', async () => {
    const failing: DispatchFn = async () => {
      throw new Error('the dispatcher blew up')
    }
    const { harness } = await signedInConsole({ dispatch: failing })

    harness.fake.type('\r')

    await waitForScreen(
      harness.fake,
      (screen) => screen.includes('exit 1'),
      'a failed run in the output pane',
    )
    harness.fake.type('q')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
    expect(harness.fake.restored()).toBe(true)
  })

  test('a signal while a command is in flight still leaves with the terminal restored', async () => {
    const slow: DispatchFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return EXIT_OK
    }
    const { harness } = await signedInConsole({ dispatch: slow })

    harness.fake.type('\r')
    harness.processEvents.emit('SIGTERM')

    await expect(harness.exit).resolves.toBe(EXIT_INTERRUPTED)
    expect(harness.fake.restored()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The subscription timer, `opened` and the effects nobody typed (phase 5)
// ---------------------------------------------------------------------------

/** How often the synthetic polled section re-reads itself. */
const POLL_INTERVAL_MS = 20

/** Longer than a keystroke takes to reach a frame, so "before the answer" is observable. */
const SLOW_POLL_MS = 300

/** What a quiet poll prints, so a frame can be asked whether its answer landed. */
const POLL_OUTPUT_MARK = 'queue-answered-here'

/**
 * How long an absence is watched for. Every OTHER wait in this file is a
 * predicate over the frame; these are the two assertions about something that
 * must NOT happen, and a window is the only shape they have.
 */
const ABSENCE_WINDOW_MS = 60

/** A tab that re-reads itself, standing in for Approvals without pinning its interval. */
const POLLED_SECTION: SectionSpec = {
  id: 'polled',
  title: 'Polled',
  minRole: 'viewer',
  intro: ['a tab that re-reads itself'],
  refreshActionId: 'list',
  autoRefreshMs: POLL_INTERVAL_MS,
  actions: [
    {
      id: 'list',
      title: 'list',
      minRole: 'viewer',
      command: 'approvals',
      subcommand: 'list',
      fields: [],
      argv: () => ['approvals', 'list'],
    },
  ],
}

/**
 * The action title the plain tab is recognised by. Its intro will not do: a
 * poll that has already answered leaves an output panel where the intro was,
 * and the panel outlives the tab switch.
 */
const PLAIN_ACTION_TITLE = 'noop'

/** The other half of the rule: a tab with nothing to poll takes the timer down. */
const PLAIN_SECTION: SectionSpec = {
  id: 'plain',
  title: 'Plain',
  minRole: 'viewer',
  intro: ['nothing to refresh here'],
  actions: [
    {
      id: 'noop',
      title: PLAIN_ACTION_TITLE,
      minRole: 'viewer',
      command: 'status',
      fields: [],
      argv: () => ['status'],
    },
  ],
}

/** An action that hands the terminal to a child instead of dispatching (`setup`). */
const REOPEN_SECTION: SectionSpec = {
  id: 'reopening',
  title: 'Reopening',
  minRole: 'viewer',
  intro: ['an action that leaves the console'],
  actions: [
    {
      id: 'setup',
      title: 'setup',
      minRole: 'viewer',
      command: 'setup',
      fields: [],
      argv: () => ['setup'],
      leavesConsole: true,
    },
  ],
}

const TEST_SESSION: Session = { adminName: ADMIN_NAME, role: ADMIN_ROLE }

/** A main screen over synthetic sections: these tests are about the runtime, not the catalogue. */
function mainModelOf(sections: readonly SectionSpec[], size: TerminalSize): Model {
  return {
    screen: {
      kind: 'main',
      session: TEST_SESSION,
      sections,
      sectionIndex: 0,
      actionIndex: 0,
      pane: { kind: 'actions' },
    },
    size,
  }
}

/** A cell holding a session the store really resolves, for a console that opens signed in. */
async function sessionCell(): Promise<TokenCell> {
  const cell = createTokenCell()
  cell.set(await createTestAdmin())
  return cell
}

interface CountingDispatch {
  readonly fn: DispatchFn
  /** Live, so a test can watch it. */
  readonly calls: readonly (readonly string[])[]
  countOf(command: string): number
}

/** A `dispatch` that counts what it was asked to run, and answers as told. */
function countingDispatch(answer: () => Promise<number> = async () => EXIT_OK): CountingDispatch {
  const calls: string[][] = []
  return {
    calls,
    countOf: (command: string) => calls.filter((argv) => argv[0] === command).length,
    fn: async (argv) => {
      calls.push([...argv])
      return answer()
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('runConsole: what opening the console asks for', () => {
  test('the sign-in screen asks for the service line before anybody has typed', async () => {
    const dispatch = countingDispatch()
    const harness = startConsole({ dispatch: dispatch.fn })

    await waitForUntilTrue(() => dispatch.calls.length > 0)

    expect(dispatch.calls[0]).toEqual(['status', '--json'])
    harness.fake.type('\x03')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
  })

  test("the status it asks for carries the console's own environment, and no session", async () => {
    const seen: (NodeJS.ProcessEnv | undefined)[] = []
    const harness = startConsole({
      dispatch: async (_argv, _io, opts) => {
        seen.push(opts?.services?.env)
        return EXIT_OK
      },
    })

    await waitForUntilTrue(() => seen.length > 0)

    expect(seen[0]).toEqual(CONSOLE_ENV)
    expect(seen[0]?.[ADMIN_TOKEN_ENV_VAR]).toBeUndefined()
    harness.fake.type('\x03')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
  })
})

describe('runConsole: the subscription timer', () => {
  test('a subscribed tab polls on its own, and stops when the tab is left', async () => {
    const dispatch = countingDispatch()
    const harness = startConsole({
      dispatch: dispatch.fn,
      token: await sessionCell(),
      initial: (size) => mainModelOf([POLLED_SECTION, PLAIN_SECTION], size),
    })

    await waitForUntilTrue(() => dispatch.countOf('approvals') >= 2)
    harness.fake.type('\t')
    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(PLAIN_ACTION_TITLE),
      'the plain tab, which subscribes to nothing',
    )

    // ABSENCE assertion: a window is the only way to watch for polls that must
    // never be asked for. Three times the interval the tab used to poll at.
    const settled = dispatch.countOf('approvals')
    await sleep(ABSENCE_WINDOW_MS)
    expect(dispatch.countOf('approvals')).toBe(settled)
    harness.fake.type('q')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
  })

  test('q takes the timer with it: nothing is dispatched once the console has left', async () => {
    const dispatch = countingDispatch()
    const harness = startConsole({
      dispatch: dispatch.fn,
      token: await sessionCell(),
      initial: (size) => mainModelOf([POLLED_SECTION, PLAIN_SECTION], size),
    })
    await waitForUntilTrue(() => dispatch.countOf('approvals') >= 1)

    harness.fake.type('q')
    await expect(harness.exit).resolves.toBe(EXIT_OK)

    // ABSENCE assertion: the timer is unref'd, so a leak would not hang the
    // worker — it would poll a settled console instead.
    const atExit = dispatch.countOf('approvals')
    await sleep(ABSENCE_WINDOW_MS)
    expect(dispatch.countOf('approvals')).toBe(atExit)
    expect(harness.fake.restored()).toBe(true)
  })

  test('a poll in flight never makes the keyboard deaf, and its answer stays on its own tab', async () => {
    let answered = 0
    const calls: string[][] = []
    const dispatch: DispatchFn = async (argv, io) => {
      calls.push([...argv])
      await sleep(SLOW_POLL_MS)
      io.stdout.write(`${POLL_OUTPUT_MARK}\n`)
      answered += 1
      return EXIT_OK
    }
    const harness = startConsole({
      dispatch,
      token: await sessionCell(),
      initial: (size) => mainModelOf([POLLED_SECTION, PLAIN_SECTION], size),
    })
    await waitForUntilTrue(() => calls.some((argv) => argv[0] === 'approvals'))

    harness.fake.type('\t')

    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(PLAIN_ACTION_TITLE),
      'the next tab, reached while the poll is still out',
    )
    expect(answered).toBe(0)

    // The answer now arrives on a tab that never asked for it. Nobody may see
    // another tab's command line and text appear under this one (F2).
    await waitForUntilTrue(() => answered >= 1)
    await sleep(ABSENCE_WINDOW_MS)
    expect(harness.fake.screen()).not.toContain(POLL_OUTPUT_MARK)
    expect(harness.fake.screen()).not.toContain('approvals list')
    expect(harness.fake.screen()).toContain(PLAIN_ACTION_TITLE)

    harness.fake.type('q')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
  })
})

describe('runConsole: an action that leaves the console', () => {
  test('a reopen ends the console with 0, leaves the argv in the cell and restores the terminal', async () => {
    const reopen = createReopenCell()
    const dispatch = countingDispatch()
    const harness = startConsole({
      dispatch: dispatch.fn,
      reopen,
      token: await sessionCell(),
      initial: (size) => mainModelOf([REOPEN_SECTION], size),
    })
    await waitForScreen(harness.fake, (screen) => screen.includes('setup'), 'the reopening tab')

    harness.fake.type('\r')

    await expect(harness.exit).resolves.toBe(EXIT_OK)
    expect(reopen.get()).toEqual(['setup'])
    expect(harness.fake.restored()).toBe(true)
    // Nothing was run from inside the console: the child gets the terminal.
    expect(dispatch.countOf('setup')).toBe(0)
  })
})

describe('createLoop: a fault after the console was already leaving', () => {
  test('a reopen is taken back when the runtime faults: nothing is spawned on a crashed console', async () => {
    // `finish` is first-call-wins, so a fault arriving after the reopen leaves
    // the exit code at 0 with the stack only on stderr — and `tui-cmd.ts` would
    // then hand the terminal to `mcpcut setup` from a console that crashed.
    const reopen = createReopenCell()
    const fake = createFakeTerminal()
    const stderr = captureStderr()
    const base = depsOf(
      fake.terminal,
      new EventEmitter(),
      stderr,
      quietDispatch,
      plainStyle,
      await sessionCell(),
      reopen,
    )
    const loop = createLoop({
      ...base,
      initial: (size) => mainModelOf([REOPEN_SECTION], size),
    })
    loop.step({ kind: 'key', key: { kind: 'enter' } })
    expect(reopen.get()).toEqual(['setup'])

    loop.fail(new Error('the pure core threw'))

    expect(reopen.get()).toBeUndefined()
    loop.reportFault()
    expect(stderr.text()).toContain('the pure core threw')
  })
})

/** The bare-terminal test has no `FakeTerminal` to read frames off. */
async function waitForUntilTrue(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the first frame')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

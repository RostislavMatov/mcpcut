import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { CliWritable, DispatchFn } from '../../src/cli/dispatch-types.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import { ENTER_SCREEN, LEAVE_SCREEN, plainStyle, type Style } from '../../src/tui/ansi.js'
import {
  DEFAULT_TUI_SIGNALS,
  EXIT_INTERRUPTED,
  EXIT_OK,
  SIGNIN_TITLE,
  WINDOWS_UNSUPPORTED_REASON,
  WIZARD_TITLE_FIRST_RUN,
} from '../../src/tui/constants.js'
import type { TerminalSize } from '../../src/tui/model.js'
import { createTokenCell } from '../../src/tui/runtime-effects.js'
import { runConsole } from '../../src/tui/runtime.js'
import { wizardScreenOf, type WizardPrefill } from '../../src/tui/wizard-fields.js'
import { createFakeTerminal, waitForScreen } from './support/fake-terminal.js'
import {
  SIGNED_IN_HEADER,
  captureStderr,
  closeRuntimeStand,
  createTestAdmin,
  depsOf,
  openRuntimeStand,
  quietDispatch,
  signedInConsole,
  startConsole,
  waitForUntilTrue,
} from './support/runtime-harness.js'

/**
 * The runtime's lifecycle: the screen it opens on, entering the alternate
 * screen before the first frame, and every way out. The terminal is RESTORED
 * on each of them — a quit key, an interrupt, a signal, an uncaught exception,
 * a pty that died mid-frame — nothing the runtime installs on the process
 * outlives it, and the returned promise always RESOLVES with an exit code.
 * Split out of `runtime.test.ts` (phase 6, task 9); the stand is
 * `support/runtime-harness.ts`.
 */

beforeEach(openRuntimeStand)
afterEach(closeRuntimeStand)

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

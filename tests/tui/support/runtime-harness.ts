import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdminStore } from '../../../src/admin/store.js'
import type { CliWritable, DispatchFn } from '../../../src/cli/dispatch-types.js'
import { plainStyle, type Style } from '../../../src/tui/ansi.js'
import { DEFAULT_TUI_SIGNALS, EXIT_OK, SIGNIN_TITLE } from '../../../src/tui/constants.js'
import type { Model, TerminalSize } from '../../../src/tui/model.js'
import { createTokenCell, type ReopenCell, type TokenCell } from '../../../src/tui/runtime-effects.js'
import { runConsole, type ConsoleDeps, type TuiTerminal } from '../../../src/tui/runtime.js'
import { createFakeTerminal, waitForScreen, type FakeTerminal } from './fake-terminal.js'

/**
 * The stand the runtime suites share: `runtime.test.ts` (the loop, keys as
 * bytes, effects, the subscription timer, reopen) and
 * `runtime-lifecycle.test.ts` (opening the screen, every way out, restore,
 * signals). Lifted out of `runtime.test.ts` when it was split (phase 6, task
 * 9, F9).
 *
 * A console started here is wired to a temp journal directory holding a real
 * admin store, and is remembered so that none outlives its test: a suite
 * calls `openRuntimeStand` in a `beforeEach` and `closeRuntimeStand` in an
 * `afterEach`, which signals every console still running and removes the
 * directory.
 */

/** Short enough to keep the lone-`Esc` test quick; the console ships with 100. */
export const ESCAPE_TIMEOUT_MS = 10

/** How long a quit waits for a command in flight here; the console ships with 2 s. */
export const QUIT_DRAIN_TEST_MS = 100

/** The admin the sign-in tests resolve to, created in a temp store. */
export const ADMIN_NAME = 'alice'
export const ADMIN_ROLE = 'owner'
export const SIGNED_IN_HEADER = `${ADMIN_NAME} (${ADMIN_ROLE})`

let journalDir: string | undefined

/** Every console started by a test, so none of them outlives it. */
const running: Array<{ readonly harness: Harness }> = []

/** Makes the temp journal directory the next test runs against; for a `beforeEach`. */
export async function openRuntimeStand(): Promise<void> {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-runtime-'))
}

/** Ends every console the test started and removes its directory; for an `afterEach`. */
export async function closeRuntimeStand(): Promise<void> {
  for (const { harness } of running.splice(0)) {
    harness.processEvents.emit('SIGTERM')
    await harness.exit.catch(() => undefined)
  }
  if (journalDir === undefined) return
  await rm(journalDir, { recursive: true, force: true })
  journalDir = undefined
}

/** The journal directory of the test that is running. */
function journalDirOf(): string {
  if (journalDir === undefined) {
    throw new Error('no journal directory: call openRuntimeStand() in a beforeEach')
  }
  return journalDir
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface CapturedStderr extends CliWritable {
  text(): string
}

export function captureStderr(): CapturedStderr {
  const chunks: string[] = []
  return {
    write: (chunk: string) => chunks.push(chunk),
    text: () => chunks.join(''),
  }
}

/** A `dispatch` that answers success and writes nothing. */
export const quietDispatch: DispatchFn = async () => EXIT_OK

export interface Harness {
  readonly fake: FakeTerminal
  readonly processEvents: EventEmitter
  readonly exit: Promise<number>
  errText(): string
}

export interface StartOptions {
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
  /** The `disconnect` effect's seam (2026-09-20): forgets a saved remote address. */
  readonly forgetRemote?: () => Promise<void>
}

/** The console's own environment: distinctive, so a seam carrying it is recognisable. */
export const CONSOLE_ENV: NodeJS.ProcessEnv = { MCPCUT_CONFIG: '/home/alice/.mcpcut/config.json' }

export function depsOf(
  terminal: TuiTerminal,
  processEvents: EventEmitter,
  stderr: CliWritable,
  dispatch: DispatchFn,
  style: Style = plainStyle,
  token: TokenCell = createTokenCell(),
  reopen?: ReopenCell,
  forgetRemote?: () => Promise<void>,
): ConsoleDeps {
  const dir = journalDirOf()
  return {
    terminal,
    style,
    stderr,
    effects: {
      dispatch,
      dispatchOptions: { admin: { journalDir: dir } },
      env: CONSOLE_ENV,
      journalDir: dir,
      // Wired here exactly as production wires it (`tui-cmd.ts`'s
      // `consoleDepsOf`): a warning an effect writes (the setup code file, a
      // failed `forgetRemote`) belongs on the SAME stderr a test reads back
      // with `errText()`.
      stderr,
      token,
      ...(reopen === undefined ? {} : { reopen }),
      ...(forgetRemote === undefined ? {} : { forgetRemote }),
    },
    processEvents,
    signals: DEFAULT_TUI_SIGNALS,
    escapeCodeTimeoutMs: ESCAPE_TIMEOUT_MS,
    quitDrainTimeoutMs: QUIT_DRAIN_TEST_MS,
    platform: 'linux',
  }
}

/** Starts a console and hands back everything a test needs to watch it. */
export function startConsole(options: StartOptions = {}): Harness {
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
      options.forgetRemote,
    ),
    ...(options.initial !== undefined ? { initial: options.initial } : {}),
  })
  const harness: Harness = { fake, processEvents, exit, errText: () => stderr.text() }
  running.push({ harness })
  return harness
}

/** An admin in the temp store, with the one-time token the console signs in with. */
export async function createTestAdmin(): Promise<string> {
  const created = await createAdminStore({ journalDir: journalDirOf() }).createAdmin(ADMIN_NAME, ADMIN_ROLE)
  return created.token
}

/** Starts a console and signs it in, leaving it on the main screen. */
export async function signedInConsole(options: StartOptions = {}): Promise<{
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

/** The bare-terminal test has no `FakeTerminal` to read frames off. */
export async function waitForUntilTrue(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the first frame')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  CLEAR_BELOW,
  CLEAR_TO_LINE_END,
  CURSOR_HOME,
  LEAVE_SCREEN,
} from '../../../src/tui/ansi.js'
import type { TuiTerminal } from '../../../src/tui/runtime.js'

/**
 * A terminal the tests can drive (mcpcut phase 2, task 13).
 *
 * The console's runtime is the one effectful module of the console, and the
 * things it must get right — the alternate screen, raw mode, the bytes a key
 * arrives as, the restoration on every exit path — are exactly the things a
 * unit test cannot observe on a real TTY. So the runtime takes its terminal as
 * a seam and this is what the tests pass it: an input that is a `PassThrough`
 * (so `readline.emitKeypressEvents` decodes REAL bytes, escape sequences and
 * all, rather than the tests handing over ready-made key events) and an output
 * that keeps every chunk instead of painting it.
 *
 * Shared by `runtime.test.ts`, `console-e2e.test.ts` and `tui-cmd.test.ts`.
 */

const DEFAULT_FAKE_COLUMNS = 80
const DEFAULT_FAKE_ROWS = 24

/** How often `waitForScreen` looks again, and how long it looks for. */
const POLL_INTERVAL_MS = 5
const WAIT_TIMEOUT_MS = 2_000

/** What a write to a terminal whose pty is gone fails with. */
const DEAD_PTY_MESSAGE = 'write EPIPE'

export interface FakeTerminalOptions {
  readonly columns?: number
  readonly rows?: number
}

export interface FakeTerminal {
  /** What `runConsole` is handed. */
  readonly terminal: TuiTerminal
  /** Feeds raw bytes to the input, the way a terminal would. */
  type(text: string): void
  /** Every chunk written to the output, in order, exactly as written. */
  frames(): readonly string[]
  /** The last frame, with the cursor and erase sequences taken out of it. */
  screen(): string
  /** Every `setRawMode` argument, in order; live, so a test can watch it. */
  readonly rawModeCalls: readonly boolean[]
  /** Changes the reported size and emits `resize`, as a terminal does. */
  resize(columns: number, rows: number): void
  /** Whether the last thing that happened was leaving the screen and raw mode. */
  restored(): boolean
  /** Makes every later write throw, standing in for a pty that is already gone. */
  failWrites(message?: string): void
}

export function createFakeTerminal(options: FakeTerminalOptions = {}): FakeTerminal {
  const rawModeCalls: boolean[] = []
  const chunks: string[] = []
  let writeFailure: Error | undefined

  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (mode: boolean): void => {
      rawModeCalls.push(mode)
    },
  })

  const output = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: options.columns ?? DEFAULT_FAKE_COLUMNS,
    rows: options.rows ?? DEFAULT_FAKE_ROWS,
    write: (chunk: string): boolean => {
      if (writeFailure !== undefined) throw writeFailure
      chunks.push(chunk)
      return true
    },
  })

  return {
    terminal: { input, output },
    type: (text: string) => {
      input.write(text)
    },
    frames: () => [...chunks],
    screen: () => screenOf(chunks),
    rawModeCalls,
    resize: (columns: number, rows: number) => {
      output.columns = columns
      output.rows = rows
      output.emit('resize')
    },
    restored: () =>
      chunks.at(-1)?.includes(LEAVE_SCREEN) === true && rawModeCalls.at(-1) === false,
    failWrites: (message = DEAD_PTY_MESSAGE) => {
      writeFailure = new Error(message)
    },
  }
}

/**
 * The last frame as text.
 *
 * Frames are picked out by their leading `CURSOR_HOME` so that the sequences
 * written on the way in and out (`ENTER_SCREEN`, `LEAVE_SCREEN`) are never
 * mistaken for one. The erase sequences come out because they are plumbing,
 * and the carriage returns with them: `frameOf` ends every line with `\r\n`
 * because a raw-mode terminal needs both, which leaves a stray `\r` on the
 * end of every line for anyone splitting the text on newlines.
 */
function screenOf(chunks: readonly string[]): string {
  const frame = [...chunks].reverse().find((chunk) => chunk.startsWith(CURSOR_HOME))
  if (frame === undefined) return ''

  return frame
    .replaceAll(CURSOR_HOME, '')
    .replaceAll(CLEAR_TO_LINE_END, '')
    .replaceAll(CLEAR_BELOW, '')
    .replaceAll('\r\n', '\n')
}

/**
 * Waits for the console to draw a screen the predicate accepts.
 *
 * Every assertion about a running console goes through here rather than
 * through a sleep: a keystroke becomes a frame after a decode, a reducer step
 * and — for anything that runs a command — a promise, and a fixed wait would
 * be either flaky or slow. The failure names what was being waited for and
 * shows the frame that was on screen instead.
 *
 * `timeoutMs` is a parameter rather than the constant because the first-run
 * wizard waits on WHOLE commands: a refused `setup` spends a probe timeout on
 * the port it could not bind, which is already the default deadline.
 */
export async function waitForScreen(
  fake: FakeTerminal,
  predicate: (screen: string) => boolean,
  what: string,
  timeoutMs: number = WAIT_TIMEOUT_MS,
): Promise<void> {
  await waitUntil(
    () => predicate(fake.screen()),
    () => `${what}; the last frame was:\n${fake.screen()}`,
    timeoutMs,
  )
}

async function waitUntil(
  predicate: () => boolean,
  describe: () => string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe()}`)
    await sleep(POLL_INTERVAL_MS)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

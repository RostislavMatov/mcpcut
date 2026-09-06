import { emitKeypressEvents, type Interface } from 'node:readline'
import { ENTER_SCREEN, LEAVE_SCREEN } from './ansi.js'
import { DEFAULT_COLUMNS, DEFAULT_ROWS } from './constants.js'
import type { ReadlineKey } from './keys.js'
import type { TerminalSize } from './model.js'

/**
 * The terminal seam of the console (mcpcut phase 2, task 13): what a terminal
 * is, as far as `runtime.ts` is concerned, and the three things it does to
 * one — take it over, measure it, give it back.
 *
 * Split out of `runtime.ts` for the file-size budget, and it splits cleanly:
 * nothing here knows about the model, the reducer or an effect. It is the
 * whole of the console's dependency on `node:readline` and on the shape of
 * `process.stdin`/`process.stdout`.
 *
 * The shapes are declared STRUCTURALLY rather than as `tty.ReadStream` and
 * `tty.WriteStream`. That is what lets a test drive the console with a
 * `PassThrough` and a recording emitter — and driving it with real bytes is
 * the only way to test the part that matters, because the decoding of a
 * keystroke into a key is exactly what this seam hands to readline.
 */

/**
 * What the console needs from an input, and no more.
 *
 * `setRawMode` and `pause` are optional because only a real TTY has the
 * first; both are therefore called with `?.` at every call site.
 */
export interface TuiInput extends NodeJS.EventEmitter {
  readonly isTTY?: boolean
  setRawMode?(mode: boolean): unknown
  pause?(): unknown
  on(
    event: 'keypress',
    listener: (str: string | undefined, key: ReadlineKey | undefined) => void,
  ): this
}

/**
 * What the console needs from an output. `columns`/`rows` are absent outside
 * a TTY, which is why `sizeOf` has a default to fall back to.
 */
export interface TuiOutput extends NodeJS.EventEmitter {
  readonly isTTY?: boolean
  readonly columns?: number
  readonly rows?: number
  write(chunk: string): unknown
}

export interface TuiTerminal {
  readonly input: TuiInput
  readonly output: TuiOutput
}

/** Takes the terminal over: raw mode, the alternate screen, the key decoder. */
export function enterTerminal(terminal: TuiTerminal, escapeCodeTimeoutMs: number): void {
  terminal.input.setRawMode?.(true)
  terminal.output.write(ENTER_SCREEN)
  attachKeyDecoder(terminal.input, escapeCodeTimeoutMs)
}

/**
 * Puts readline's key decoder on the input.
 *
 * The two assertions here are the only ones in the console, and they are in
 * one place for that reason. `emitKeypressEvents` is typed for a full
 * `ReadableStream` and a full `Interface`, but it only ever adds listeners to
 * the first and reads `escapeCodeTimeout` off the second — and that one field
 * is the whole reason the second argument is passed at all: it is how long a
 * lone `Esc` waits before it is reported as a key rather than as the start of
 * a sequence, and there is no other way to set it.
 */
function attachKeyDecoder(input: TuiInput, escapeCodeTimeoutMs: number): void {
  emitKeypressEvents(input as unknown as NodeJS.ReadableStream, {
    escapeCodeTimeout: escapeCodeTimeoutMs,
  } as unknown as Interface)
}

/**
 * Gives the terminal back.
 *
 * Each step stands in its own `try`: when a pty dies (`SIGHUP`) every write to
 * it throws, and raw mode still has to be dropped — and the other way round.
 * A failure here is never reportable either, since stderr may be the same
 * dead pty, so it is deliberately silent.
 */
export function restoreTerminal(terminal: TuiTerminal): void {
  // Stopping the flowing read is part of the deal, not a nicety: an input
  // still emitting data keeps the event loop alive and `mcpcut` never exits.
  attempt(() => terminal.input.pause?.())
  attempt(() => terminal.input.setRawMode?.(false))
  attempt(() => terminal.output.write(LEAVE_SCREEN))
}

/** The size the terminal reports, or the one every emulator starts at. */
export function sizeOf(output: TuiOutput): TerminalSize {
  return {
    columns: output.columns ?? DEFAULT_COLUMNS,
    rows: output.rows ?? DEFAULT_ROWS,
  }
}

/** Runs one step of teardown, which must never stop the steps after it. */
export function attempt(action: () => unknown): void {
  try {
    action()
  } catch {
    // Deliberately silent: see `restoreTerminal`.
  }
}

/** What a thrown value says for itself, whether or not it is an `Error`. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

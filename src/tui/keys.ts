/**
 * Keyboard vocabulary of the console (mcpcut phase 2, Task 3).
 *
 * `readline.emitKeypressEvents` decodes bytes into `keypress(str, key)` pairs
 * whose shape is generous — a name, a raw sequence, three modifier flags, and
 * plenty of combinations we have no use for. This leaf module narrows that to
 * the handful of events the reducers actually branch on, and answers
 * `undefined` for everything else: a key we cannot name must not slip through
 * as text and end up inside a form field.
 *
 * Deliberately a leaf with no imports, and `ReadlineKey` is declared
 * structurally rather than imported from `node:readline` — the pure core
 * stays independent of the effectful module that feeds it, and the fake
 * terminal in the tests can hand these pairs over directly.
 */

/** A key we name rather than read as text. */
export type NamedKey =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'escape'
  | 'tab'
  | 'backtab'
  | 'backspace'
  | 'delete'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'

/**
 * One keystroke as the console understands it.
 *
 * `char` carries the WHOLE `str` rather than a single code unit, so a
 * character that takes two of them (an emoji) is never torn in half.
 */
export type KeyEvent =
  /** A printable character, space included — no Ctrl, no Meta. */
  | { readonly kind: 'char'; readonly char: string }
  /** A Ctrl combination with a single-letter name: 'c', 'd', 'l' … (lowercase). */
  | { readonly kind: 'ctrl'; readonly char: string }
  | { readonly kind: NamedKey }

/**
 * Exactly the fields of a readline key object that are read here. Declared
 * structurally on purpose: `readline.Key` would drag the whole module into
 * the pure core for four optional properties.
 */
export interface ReadlineKey {
  readonly name?: string
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
  readonly sequence?: string
}

/**
 * Names readline gives that we translate one-to-one. `space` is absent on
 * purpose — it is a printable character and reaches text fields as one.
 */
const NAMED_KEYS: Readonly<Record<string, NamedKey>> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  return: 'enter',
  enter: 'enter',
  escape: 'escape',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
}

/** Shift-Tab as a raw sequence: some terminals send it without a key name. */
const BACKTAB_SEQUENCE = '\x1b[Z'

/** First printable code point; everything below it is a C0 control byte. */
const FIRST_PRINTABLE_CODE = 0x20
/** The 8-bit C1 controls: a paste can carry them, a keyboard never does. */
const FIRST_C1_CODE = 0x80
const LAST_C1_CODE = 0x9f

/** DEL: printable-range arithmetic misses it, so it is excluded by name. */
const DELETE_CODE = 0x7f

/**
 * Normalizes a readline `keypress(str, key)` pair, or answers `undefined`
 * when the keystroke is none of the console's business.
 */
export function keyEventOf(str: string | undefined, key: ReadlineKey | undefined): KeyEvent | undefined {
  return namedEventOf(key) ?? printableEventOf(str, key)
}

/** The Ctrl and named-key branches, in the order they may claim a keystroke. */
function namedEventOf(key: ReadlineKey | undefined): KeyEvent | undefined {
  if (key === undefined) return undefined

  const { name } = key
  // A Ctrl letter first: terminals may report a readable `str` beside it, and
  // Ctrl-R must never reach a text field as the letter "r".
  if (key.ctrl === true && name !== undefined && name.length === 1) {
    return { kind: 'ctrl', char: name }
  }
  if (key.sequence === BACKTAB_SEQUENCE || (name === 'tab' && key.shift === true)) {
    return { kind: 'backtab' }
  }
  // Alt-Up is not Up: nothing is bound to it, so it must not act as the bare
  // key. A lone Esc is the exception: readline reports it with `meta` set.
  if (key.meta === true && name !== 'escape') return undefined
  if (name === undefined) return undefined

  const named = NAMED_KEYS[name]
  return named === undefined ? undefined : { kind: named }
}

/** The text branch: a printable `str` with no modifier that changes its meaning. */
function printableEventOf(str: string | undefined, key: ReadlineKey | undefined): KeyEvent | undefined {
  if (str === undefined || str.length === 0) return undefined
  if (key?.ctrl === true || key?.meta === true) return undefined

  const code = str.charCodeAt(0)
  if (code < FIRST_PRINTABLE_CODE || code === DELETE_CODE) return undefined
  if (code >= FIRST_C1_CODE && code <= LAST_C1_CODE) return undefined

  return { kind: 'char', char: str }
}

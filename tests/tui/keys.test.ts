import { describe, expect, test } from 'vitest'
import { keyEventOf, type KeyEvent, type ReadlineKey } from '../../src/tui/keys.js'

/**
 * `keyEventOf` (phase 2, Task 3): the one place that turns a readline
 * `keypress(str, key)` pair into the console's own vocabulary. Everything
 * downstream (`update.ts`, `form.ts`) reasons about `KeyEvent` only, so the
 * table below is the whole contract — including what deliberately produces
 * NOTHING, because a key we cannot name must not be mistaken for a printable
 * character that would end up inside a form field.
 */

interface KeyCase {
  readonly what: string
  readonly str: string | undefined
  readonly key: ReadlineKey | undefined
  readonly expected: KeyEvent | undefined
}

const RECOGNISED: readonly KeyCase[] = [
  {
    what: 'Ctrl-C is a plain key in raw mode, not a signal',
    str: '\x03',
    key: { name: 'c', ctrl: true, sequence: '\x03' },
    expected: { kind: 'ctrl', char: 'c' },
  },
  {
    what: 'Ctrl-D',
    str: '\x04',
    key: { name: 'd', ctrl: true, sequence: '\x04' },
    expected: { kind: 'ctrl', char: 'd' },
  },
  {
    what: 'Ctrl-L',
    str: '\x0c',
    key: { name: 'l', ctrl: true, sequence: '\x0c' },
    expected: { kind: 'ctrl', char: 'l' },
  },
  {
    what: 'Shift-Tab reported by name',
    str: '\t',
    key: { name: 'tab', shift: true, sequence: '\x1b[Z' },
    expected: { kind: 'backtab' },
  },
  {
    what: 'Shift-Tab reported only as the CSI Z sequence',
    str: '\x1b[Z',
    key: { sequence: '\x1b[Z' },
    expected: { kind: 'backtab' },
  },
  {
    what: 'plain Tab',
    str: '\t',
    key: { name: 'tab', sequence: '\t' },
    expected: { kind: 'tab' },
  },
  {
    what: 'Enter in raw mode arrives as a carriage return',
    str: '\r',
    key: { name: 'return', sequence: '\r' },
    expected: { kind: 'enter' },
  },
  {
    what: 'a line feed named enter',
    str: '\n',
    key: { name: 'enter', sequence: '\n' },
    expected: { kind: 'enter' },
  },
  {
    what: 'Escape',
    str: '\x1b',
    key: { name: 'escape', sequence: '\x1b' },
    expected: { kind: 'escape' },
  },
  {
    what: 'Backspace',
    str: '\x7f',
    key: { name: 'backspace', sequence: '\x7f' },
    expected: { kind: 'backspace' },
  },
  {
    what: 'Delete',
    str: '\x1b[3~',
    key: { name: 'delete', sequence: '\x1b[3~' },
    expected: { kind: 'delete' },
  },
  {
    what: 'Home',
    str: '\x1b[H',
    key: { name: 'home', sequence: '\x1b[H' },
    expected: { kind: 'home' },
  },
  {
    what: 'End',
    str: '\x1b[F',
    key: { name: 'end', sequence: '\x1b[F' },
    expected: { kind: 'end' },
  },
  {
    what: 'PageUp',
    str: '\x1b[5~',
    key: { name: 'pageup', sequence: '\x1b[5~' },
    expected: { kind: 'pageup' },
  },
  {
    what: 'PageDown',
    str: '\x1b[6~',
    key: { name: 'pagedown', sequence: '\x1b[6~' },
    expected: { kind: 'pagedown' },
  },
  {
    what: 'arrow up',
    str: '\x1b[A',
    key: { name: 'up', sequence: '\x1b[A' },
    expected: { kind: 'up' },
  },
  {
    what: 'arrow down',
    str: '\x1b[B',
    key: { name: 'down', sequence: '\x1b[B' },
    expected: { kind: 'down' },
  },
  {
    what: 'arrow right',
    str: '\x1b[C',
    key: { name: 'right', sequence: '\x1b[C' },
    expected: { kind: 'right' },
  },
  {
    what: 'arrow left',
    str: '\x1b[D',
    key: { name: 'left', sequence: '\x1b[D' },
    expected: { kind: 'left' },
  },
  {
    what: 'space arrives named, and is a printable character all the same',
    str: ' ',
    key: { name: 'space', sequence: ' ' },
    expected: { kind: 'char', char: ' ' },
  },
  {
    what: 'a letter',
    str: 'a',
    key: { name: 'a', sequence: 'a' },
    expected: { kind: 'char', char: 'a' },
  },
  {
    what: 'a shifted letter keeps the character, not the key name',
    str: 'A',
    key: { name: 'a', shift: true, sequence: 'A' },
    expected: { kind: 'char', char: 'A' },
  },
  {
    what: 'a digit',
    str: '2',
    key: { name: '2', sequence: '2' },
    expected: { kind: 'char', char: '2' },
  },
  {
    what: 'a non-ASCII letter readline cannot name',
    str: 'é',
    key: { sequence: 'é' },
    expected: { kind: 'char', char: 'é' },
  },
  {
    what: 'a character of two code units is not torn apart',
    str: '🙂',
    key: { sequence: '🙂' },
    expected: { kind: 'char', char: '🙂' },
  },
  {
    what: 'a character without any key object at all',
    str: 'z',
    key: undefined,
    expected: { kind: 'char', char: 'z' },
  },
]

const IGNORED: readonly KeyCase[] = [
  {
    what: 'Meta-a (the escape prefix is not text)',
    str: '\x1ba',
    key: { name: 'a', meta: true, sequence: '\x1ba' },
    expected: undefined,
  },
  {
    what: 'Meta-x',
    str: '\x1bx',
    key: { name: 'x', meta: true, sequence: '\x1bx' },
    expected: undefined,
  },
  {
    what: 'an empty str with an unnamed key',
    str: '',
    key: {},
    expected: undefined,
  },
  {
    what: 'a function key we have no use for',
    str: '\x1bOP',
    key: { name: 'f1', sequence: '\x1bOP' },
    expected: undefined,
  },
  {
    what: 'a control byte that carries no name',
    str: '\x00',
    key: undefined,
    expected: undefined,
  },
  {
    what: 'a bare DEL byte that carries no name',
    str: '\x7f',
    key: undefined,
    expected: undefined,
  },
  {
    what: 'a Ctrl combination readline could not name',
    str: '\x1f',
    key: { ctrl: true, sequence: '\x1f' },
    expected: undefined,
  },
  {
    what: 'nothing at all',
    str: undefined,
    key: undefined,
    expected: undefined,
  },
]

describe('keyEventOf', () => {
  test.each(RECOGNISED)('recognises $what', ({ str, key, expected }) => {
    // Act
    const event = keyEventOf(str, key)

    // Assert
    expect(event).toEqual(expected)
  })

  test.each(IGNORED)('ignores $what', ({ str, key }) => {
    // Act
    const event = keyEventOf(str, key)

    // Assert
    expect(event).toBeUndefined()
  })

  test('a Ctrl letter wins over the printable character it would otherwise be', () => {
    // Arrange — some terminals send a readable `str` alongside a Ctrl name
    const key: ReadlineKey = { name: 'r', ctrl: true, sequence: '\x12' }

    // Act
    const event = keyEventOf('r', key)

    // Assert — a Ctrl-R must never reach a text field as the letter "r"
    expect(event).toEqual({ kind: 'ctrl', char: 'r' })
  })
})

describe('keyEventOf: what a paste can smuggle in', () => {
  test('an 8-bit C1 control code unit is not a printable character', () => {
    expect(keyEventOf('\u009b', {})).toBeUndefined()
  })

  test('a named key with Meta held is not the bare key', () => {
    expect(keyEventOf(undefined, { name: 'up', meta: true })).toBeUndefined()
  })

  test('a lone Esc, which readline reports with Meta set, is still Esc', () => {
    expect(keyEventOf('\x1b', { name: 'escape', meta: true, sequence: '\x1b' })).toEqual({
      kind: 'escape',
    })
  })
})

import { describe, expect, test } from 'vitest'
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  ansiStyle,
  CLEAR_BELOW,
  CLEAR_TO_LINE_END,
  CURSOR_HIDE,
  CURSOR_HOME,
  CURSOR_SHOW,
  ENTER_SCREEN,
  fitWidth,
  frameOf,
  LEAVE_SCREEN,
  padRight,
  plainStyle,
  sanitizeLine,
} from '../../src/tui/ansi.js'

/**
 * The output pane prints text a command wrote, and a command's text can come
 * from an MCP server we do not trust. Raw escape sequences there would move
 * the console's cursor, repaint its frame or hide output, so every line that
 * reaches the screen goes through `sanitizeLine` first.
 */
describe('sanitizeLine', () => {
  test('passes plain text through unchanged', () => {
    expect(sanitizeLine('admin add bob --role operator')).toBe('admin add bob --role operator')
  })

  test('removes a CSI sequence whole and only then replaces the remaining control characters', () => {
    expect(sanitizeLine('a\x1b[2Kb\x07c')).toBe('ab?c')
  })

  test('removes an SGR colour sequence without leaving its parameters behind', () => {
    const result = sanitizeLine('\x1b[31mred\x1b[0m')

    expect(result).toBe('red')
  })

  test('removes a cursor-movement sequence with intermediate bytes', () => {
    expect(sanitizeLine('before\x1b[?25lafter')).toBe('beforeafter')
  })

  test('removes a BEL-terminated OSC window-title sequence entirely', () => {
    expect(sanitizeLine('a\x1b]0;pwned\x07b')).toBe('ab')
  })

  test('removes a ST-terminated OSC window-title sequence entirely', () => {
    expect(sanitizeLine('a\x1b]0;pwned\x1b\\b')).toBe('ab')
  })

  test('replaces every C0 control character with a placeholder', () => {
    const controls = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join('')

    expect(sanitizeLine(controls)).toBe('?'.repeat(0x20))
  })

  test('replaces DEL (0x7f)', () => {
    expect(sanitizeLine('a\x7fb')).toBe('a?b')
  })

  test('replaces a lone escape that starts no recognised sequence', () => {
    expect(sanitizeLine('a\x1bb')).toBe('a?b')
  })

  test('does not cap long lines: width is the renderer\'s business', () => {
    const long = 'x'.repeat(500)

    expect(sanitizeLine(long)).toBe(long)
  })

  test('leaves the input string untouched', () => {
    const line = 'a\x1b[2Kb'

    sanitizeLine(line)

    expect(line).toBe('a\x1b[2Kb')
  })
})

describe('fitWidth', () => {
  test('cuts a longer text and marks the cut with an ellipsis', () => {
    expect(fitWidth('abcdef', 4)).toBe('abc…')
  })

  test('keeps a text of exactly the width unchanged', () => {
    expect(fitWidth('abcd', 4)).toBe('abcd')
  })

  test('keeps a shorter text unchanged, without padding', () => {
    expect(fitWidth('ab', 4)).toBe('ab')
  })

  test('returns just the ellipsis when the width is one', () => {
    expect(fitWidth('abcdef', 1)).toBe('…')
  })

  test('returns an empty string for width zero', () => {
    expect(fitWidth('abcdef', 0)).toBe('')
  })

  test('returns an empty string for a negative width', () => {
    expect(fitWidth('abcdef', -3)).toBe('')
  })

  test('returns an empty string for an empty text', () => {
    expect(fitWidth('', 4)).toBe('')
  })
})

describe('padRight', () => {
  test('pads a shorter text to the full width', () => {
    expect(padRight('ab', 5)).toBe('ab   ')
  })

  test('cuts a longer text to exactly the width', () => {
    const result = padRight('abcdef', 4)

    expect(result).toBe('abc…')
    expect(result).toHaveLength(4)
  })

  test('leaves a text of exactly the width unchanged', () => {
    expect(padRight('abcd', 4)).toBe('abcd')
  })

  test('returns an empty string for width zero', () => {
    expect(padRight('ab', 0)).toBe('')
  })
})

describe('frameOf', () => {
  test('writes one frame that overwrites the previous one line by line', () => {
    expect(frameOf(['a', 'b'])).toBe(`${CURSOR_HOME}a${CLEAR_TO_LINE_END}\r\nb${CLEAR_TO_LINE_END}${CLEAR_BELOW}`)
  })

  test('clears the screen below even when there are no lines', () => {
    expect(frameOf([])).toBe(`${CURSOR_HOME}${CLEAR_TO_LINE_END}${CLEAR_BELOW}`)
  })

  test('ends every line with the clear-to-line-end sequence', () => {
    const frame = frameOf(['one', 'two', 'three'])

    expect(frame.split('\r\n')).toHaveLength(3)
    expect(frame.endsWith(`${CLEAR_TO_LINE_END}${CLEAR_BELOW}`)).toBe(true)
  })
})

describe('screen sequences', () => {
  test('entering the screen switches to the alternate buffer and hides the cursor', () => {
    expect(ENTER_SCREEN).toBe(ALT_SCREEN_ON + CURSOR_HIDE)
  })

  test('leaving the screen shows the cursor and returns to the primary buffer', () => {
    expect(LEAVE_SCREEN).toBe(CURSOR_SHOW + ALT_SCREEN_OFF)
  })

  test('the alternate-screen sequences are the xterm 1049 pair', () => {
    expect(ALT_SCREEN_ON).toBe('\x1b[?1049h')
    expect(ALT_SCREEN_OFF).toBe('\x1b[?1049l')
  })
})

describe('plainStyle', () => {
  test('is the identity on every attribute, so a frame can be compared as text', () => {
    expect(plainStyle.bold('x')).toBe('x')
    expect(plainStyle.inverse('x')).toBe('x')
    expect(plainStyle.dim('x')).toBe('x')
  })
})

describe('ansiStyle', () => {
  test('wraps bold text in SGR 1 and turns it off with 22', () => {
    expect(ansiStyle.bold('x')).toBe('\x1b[1mx\x1b[22m')
  })

  test('wraps inverse text in SGR 7 and turns it off with 27', () => {
    expect(ansiStyle.inverse('x')).toBe('\x1b[7mx\x1b[27m')
  })

  test('wraps dim text in SGR 2 and turns it off with 22', () => {
    expect(ansiStyle.dim('x')).toBe('\x1b[2mx\x1b[22m')
  })

  test('adds nothing a sanitized frame would keep', () => {
    expect(sanitizeLine(ansiStyle.bold('x'))).toBe('x')
  })
})

describe('sanitizeLine: 8-bit and invisible code points', () => {
  test.each([
    ['8-bit CSI', '\u009b2J\u009b1;1H', ''],
    ['8-bit OSC 52 clipboard write', '\u009d52;c;cHduZWQ=\u009c', ''],
    ['8-bit OSC 0 title', '\u009d0;PWNED\u009c', ''],
    ['8-bit OSC 8 hyperlink', '\u009d8;;http://evil\u009ctext\u009d8;;\u009c', 'text'],
    ['8-bit DCS', '\u0090q#0\u009c', ''],
    ['8-bit APC', '\u009fGf=1\u009c', ''],
    ['an 8-bit CSI ends at its final byte, like its 7-bit twin', 'ok\u009b31m red', 'ok red'],
    ['an unterminated 8-bit string runs to the end of the line', 'ok\u009d0;title red', 'ok'],
    ['a stray C1 control with nothing to introduce', 'a\u0085b', 'a?b'],
    ['a bidi override', 'safe\u202egnp.exe', 'safegnp.exe'],
    ['a zero-width space', 'ad\u200bmin', 'admin'],
  ])('%s is neutralised', (_label, input, expected) => {
    expect(sanitizeLine(input)).toBe(expected)
  })

  test('accented text and the console glyphs survive untouched', () => {
    const text = 'café · über ▸ ● ○ ◐ … ▏'

    expect(sanitizeLine(text)).toBe(text)
  })
})

describe('padRight: every cell of a frame is sanitised', () => {
  test('strips an 8-bit CSI out of a cell before padding it', () => {
    expect(padRight('bo\u009b2Jb', 6)).toBe('bob   ')
  })

  test('strips a bidi override out of a cell', () => {
    expect(padRight('safe\u202egnp', 8)).toBe('safegnp ')
  })
})

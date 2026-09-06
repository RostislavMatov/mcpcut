import { describe, expect, test } from 'vitest'
import { TOKEN_ONCE_NOTICE } from '../../src/cli/ui-constants.js'
import { CLI_NAME } from '../../src/setup/constants.js'
import { OUTPUT_MAX_LINES, OUTPUT_MAX_LINE_CHARS, truncatedNote } from '../../src/tui/constants.js'
import {
  outputPanelOf,
  type RunResult,
  scrollOutput,
  scrollToEnd,
  scrollToStart,
  STDERR_SEPARATOR,
} from '../../src/tui/output.js'

/**
 * The output pane is what an operator reads after every action, and its text
 * is the text a command printed -- which may itself have come from a proxied
 * MCP server. So the panel is built by pure functions over a finished run:
 * sanitised, bounded, and carrying the one fact `q` needs to ask before it
 * takes the screen away (a one-time token is on it).
 */

function runResultOf(overrides: Partial<RunResult> = {}): RunResult {
  return {
    argv: ['admin', 'list'],
    display: ['admin', 'list'],
    exitCode: 0,
    stdout: '',
    stderr: '',
    ...overrides,
  }
}

describe('outputPanelOf: the command line', () => {
  test('shows the display argv, not the argv that was dispatched', () => {
    const panel = outputPanelOf(
      runResultOf({
        argv: ['vault', 'set', 'github', 'ghp_secret'],
        display: ['vault', 'set', 'github', '***'],
      }),
    )

    expect(panel.command).toBe(`$ ${CLI_NAME} vault set github ***`)
    expect(panel.command).not.toContain('ghp_secret')
  })

  test('carries the exit code and starts unscrolled', () => {
    const panel = outputPanelOf(runResultOf({ exitCode: 2 }))

    expect(panel.exitCode).toBe(2)
    expect(panel.scroll).toBe(0)
  })
})

describe('outputPanelOf: the lines', () => {
  test('splits stdout into lines and drops the trailing empty one', () => {
    const panel = outputPanelOf(runResultOf({ stdout: 'alice owner\nbob operator\n' }))

    expect(panel.lines).toEqual(['alice owner', 'bob operator'])
  })

  test('puts stderr after stdout behind a separator', () => {
    const panel = outputPanelOf(
      runResultOf({ stdout: 'partial\n', stderr: 'unknown admin "bob"\n', exitCode: 1 }),
    )

    expect(panel.lines).toEqual(['partial', STDERR_SEPARATOR, 'unknown admin "bob"'])
  })

  test('omits the separator when the command wrote nothing to stderr', () => {
    const panel = outputPanelOf(runResultOf({ stdout: 'ok\n' }))

    expect(panel.lines).not.toContain(STDERR_SEPARATOR)
  })

  test('yields no lines for an empty stdout, keeping the command and the exit code', () => {
    const panel = outputPanelOf(runResultOf({ stdout: '', exitCode: 0 }))

    expect(panel.lines).toEqual([])
    expect(panel.command).toBe(`$ ${CLI_NAME} admin list`)
    expect(panel.exitCode).toBe(0)
  })

  test('sanitises escape sequences and control characters out of both streams', () => {
    const panel = outputPanelOf(
      runResultOf({ stdout: 'a\x1b[2Kb\x07\n', stderr: '\x1b[31mred\x1b[0m\n' }),
    )

    expect(panel.lines).toEqual(['ab?', STDERR_SEPARATOR, 'red'])
  })
})

describe('outputPanelOf: the cap on kept lines', () => {
  function stdoutOf(count: number): string {
    return `${Array.from({ length: count }, (_, index) => `line ${index}`).join('\n')}\n`
  }

  test('keeps the head and notes what it dropped past the cap', () => {
    const panel = outputPanelOf(runResultOf({ stdout: stdoutOf(OUTPUT_MAX_LINES + 1) }))

    expect(panel.truncated).toBe(true)
    expect(panel.lines).toHaveLength(OUTPUT_MAX_LINES + 1)
    expect(panel.lines[0]).toBe('line 0')
    expect(panel.lines[OUTPUT_MAX_LINES - 1]).toBe(`line ${OUTPUT_MAX_LINES - 1}`)
    expect(panel.lines[OUTPUT_MAX_LINES]).toBe(truncatedNote(1))
  })

  test('keeps exactly the cap untouched', () => {
    const panel = outputPanelOf(runResultOf({ stdout: stdoutOf(OUTPUT_MAX_LINES) }))

    expect(panel.truncated).toBe(false)
    expect(panel.lines).toHaveLength(OUTPUT_MAX_LINES)
    expect(panel.lines.at(-1)).toBe(`line ${OUTPUT_MAX_LINES - 1}`)
  })
})

describe('outputPanelOf: the one-time token marker', () => {
  test('is set when the command printed the notice on stdout', () => {
    const panel = outputPanelOf(
      runResultOf({ stdout: `token: mcpa_abc\n${TOKEN_ONCE_NOTICE}` }),
    )

    expect(panel.holdsOneTimeToken).toBe(true)
  })

  test('is clear for ordinary output', () => {
    const panel = outputPanelOf(runResultOf({ stdout: 'alice owner\n' }))

    expect(panel.holdsOneTimeToken).toBe(false)
  })

  test('is clear when only stderr mentions the notice, which is not where a token is printed', () => {
    const panel = outputPanelOf(runResultOf({ stdout: '', stderr: TOKEN_ONCE_NOTICE }))

    expect(panel.holdsOneTimeToken).toBe(false)
  })
})

describe('scrolling the panel', () => {
  const PAGE_ROWS = 10

  function panelOfLines(count: number) {
    return outputPanelOf(
      runResultOf({
        stdout: `${Array.from({ length: count }, (_, index) => `line ${index}`).join('\n')}\n`,
      }),
    )
  }

  test('moves by the delta within the scrollable range', () => {
    const scrolled = scrollOutput(panelOfLines(30), 5, PAGE_ROWS)

    expect(scrolled.scroll).toBe(5)
  })

  test('clamps at the last page rather than scrolling past the end', () => {
    const scrolled = scrollOutput(panelOfLines(30), 999, PAGE_ROWS)

    expect(scrolled.scroll).toBe(30 - PAGE_ROWS)
  })

  test('clamps at the first line rather than scrolling above it', () => {
    const scrolled = scrollOutput(scrollOutput(panelOfLines(30), 5, PAGE_ROWS), -999, PAGE_ROWS)

    expect(scrolled.scroll).toBe(0)
  })

  test('does not scroll output that already fits on one page', () => {
    const scrolled = scrollOutput(panelOfLines(4), 3, PAGE_ROWS)

    expect(scrolled.scroll).toBe(0)
  })

  test('scrollToEnd goes to the last page and scrollToStart back to the first', () => {
    const atEnd = scrollToEnd(panelOfLines(30), PAGE_ROWS)

    expect(atEnd.scroll).toBe(30 - PAGE_ROWS)
    expect(scrollToStart(atEnd).scroll).toBe(0)
  })

  test('leaves the panel it was given untouched', () => {
    const panel = panelOfLines(30)

    const scrolled = scrollOutput(panel, 5, PAGE_ROWS)

    expect(panel.scroll).toBe(0)
    expect(scrolled).not.toBe(panel)
    expect(scrolled.lines).toEqual(panel.lines)
  })
})

describe('immutability', () => {
  test('outputPanelOf does not touch the run result it was given', () => {
    const result = runResultOf({ argv: ['admin', 'list'], stdout: 'alice owner\n' })
    const before = { ...result, argv: [...result.argv], display: [...result.display] }

    outputPanelOf(result)

    expect(result).toEqual(before)
  })
})

describe('outputPanelOf: a monster line', () => {
  test('is cut to OUTPUT_MAX_LINE_CHARS before it is sanitised', () => {
    const panel = outputPanelOf(runResultOf({ stdout: `${'a'.repeat(OUTPUT_MAX_LINE_CHARS + 500)}\n` }))

    expect(panel.lines[0]).toHaveLength(OUTPUT_MAX_LINE_CHARS)
  })
})

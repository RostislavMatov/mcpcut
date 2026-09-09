import { describe, expect, test } from 'vitest'
import { TOKEN_ONCE_NOTICE } from '../../src/cli/ui-constants.js'
import { CLI_NAME } from '../../src/setup/constants.js'
import { OUTPUT_MAX_LINES, OUTPUT_MAX_LINE_CHARS, truncatedNote } from '../../src/tui/constants.js'
import {
  acknowledgeToken,
  needsTokenHold,
  type OutputPanel,
  outputPanelOf,
  OUTPUT_HSCROLL_STEP,
  replacedOutput,
  type RunResult,
  scrollOutput,
  scrollOutputSideways,
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
  test('is set when a minting command printed the notice on stdout', () => {
    const panel = outputPanelOf(
      runResultOf({ mintsToken: true, stdout: `token: mcpa_abc\n${TOKEN_ONCE_NOTICE}` }),
    )

    expect(panel.holdsOneTimeToken).toBe(true)
  })

  test('is clear when a command that mints nothing printed the very same sentence', () => {
    // The sentence is attacker-influenced text on most tabs: `approvals list`
    // prints the arguments an agent chose, `journal show` and `logs` print
    // upstream bytes. Minting is a property of the ACTION, not of the output.
    const panel = outputPanelOf(
      runResultOf({ stdout: `args={"note":"${TOKEN_ONCE_NOTICE.trimEnd()}"}\n` }),
    )

    expect(panel.holdsOneTimeToken).toBe(false)
  })

  test('is clear when a minting command failed before it printed a token', () => {
    const panel = outputPanelOf(
      runResultOf({ mintsToken: true, exitCode: 1, stdout: '', stderr: 'admin "alice" exists\n' }),
    )

    expect(panel.holdsOneTimeToken).toBe(false)
  })

  test('is clear for ordinary output', () => {
    const panel = outputPanelOf(runResultOf({ stdout: 'alice owner\n' }))

    expect(panel.holdsOneTimeToken).toBe(false)
  })

  test('is clear when only stderr mentions the notice, which is not where a token is printed', () => {
    const panel = outputPanelOf(
      runResultOf({ mintsToken: true, stdout: '', stderr: TOKEN_ONCE_NOTICE }),
    )

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

/**
 * The one-time token, phase 5. `holdsOneTimeToken` says a token is on the
 * panel; `tokenAcknowledged` says the operator has told the console they saved
 * it. Only the pair answers "may this screen be taken away".
 */
describe('the one-time token hold', () => {
  const TOKEN_STDOUT = `${TOKEN_ONCE_NOTICE}\ntoken: mcpa_abc\n`

  /** A run of an action that really mints — the only kind that may hold the pane. */
  function mintedRun(): RunResult {
    return runResultOf({ mintsToken: true, stdout: TOKEN_STDOUT })
  }

  test('a fresh panel has not been acknowledged, whatever it holds', () => {
    expect(outputPanelOf(mintedRun()).tokenAcknowledged).toBe(false)
    expect(outputPanelOf(runResultOf({ stdout: 'alice owner\n' })).tokenAcknowledged).toBe(false)
  })

  test('acknowledgeToken answers a new panel and leaves the old one alone', () => {
    const panel = outputPanelOf(mintedRun())

    const acknowledged = acknowledgeToken(panel)

    expect(acknowledged.tokenAcknowledged).toBe(true)
    expect(acknowledged).not.toBe(panel)
    expect(panel.tokenAcknowledged).toBe(false)
    expect(acknowledged.lines).toEqual(panel.lines)
  })

  test('needsTokenHold is false when there is no panel at all', () => {
    expect(needsTokenHold(undefined)).toBe(false)
  })

  test('needsTokenHold is true while a token is on screen unacknowledged', () => {
    expect(needsTokenHold(outputPanelOf(mintedRun()))).toBe(true)
  })

  test('needsTokenHold is false once the operator has said they saved it', () => {
    const held = acknowledgeToken(outputPanelOf(mintedRun()))

    expect(needsTokenHold(held)).toBe(false)
  })

  test('needsTokenHold is false for ordinary output', () => {
    expect(needsTokenHold(outputPanelOf(runResultOf({ stdout: 'alice owner\n' })))).toBe(false)
  })
})

/**
 * P9: a quiet poll refreshes the pane, but it must not wipe an error the
 * operator has not read yet, nor throw away where they had scrolled to.
 */
describe('replacedOutput: what a quiet poll may replace', () => {
  const PAGE_ROWS = 10
  const PANE_WIDTH = 54

  function panelOf(command: readonly string[], exitCode: number, lineCount = 30): OutputPanel {
    return outputPanelOf(
      runResultOf({
        argv: [...command],
        display: [...command],
        exitCode,
        stdout: `${Array.from({ length: lineCount }, (_, index) => `line ${index}`).join('\n')}\n`,
      }),
    )
  }

  test('a failed run of ANOTHER command is kept: the operator has not read it yet', () => {
    const previous = panelOf(['server', 'add'], 1)
    const next = panelOf(['approvals', 'list'], 0)

    expect(replacedOutput(previous, next, PAGE_ROWS, PANE_WIDTH)).toBe(previous)
  })

  test('the same command keeps where the reader was, clamped to the new output', () => {
    const previous = scrollOutputSideways(
      scrollOutput(panelOf(['approvals', 'list'], 0), 5, PAGE_ROWS),
      2,
      PANE_WIDTH,
    )
    const next = panelOf(['approvals', 'list'], 0)

    const replaced = replacedOutput(previous, next, PAGE_ROWS, PANE_WIDTH)

    expect(replaced.scroll).toBe(previous.scroll)
    expect(replaced.hScroll).toBe(previous.hScroll)
    expect(replaced.hScroll % OUTPUT_HSCROLL_STEP).toBe(0)
    expect(replaced.lines).toEqual(next.lines)
  })

  test('a scroll past the end of the shorter new output is clamped, not carried', () => {
    const previous = scrollOutput(panelOf(['approvals', 'list'], 0, 60), 40, PAGE_ROWS)
    const next = panelOf(['approvals', 'list'], 0, 12)

    expect(replacedOutput(previous, next, PAGE_ROWS, PANE_WIDTH).scroll).toBe(12 - PAGE_ROWS)
  })

  test('a failed run of the SAME command is replaced: the poll re-ran it', () => {
    const previous = panelOf(['approvals', 'list'], 1)
    const next = panelOf(['approvals', 'list'], 0)

    const replaced = replacedOutput(previous, next, PAGE_ROWS, PANE_WIDTH)

    expect(replaced.exitCode).toBe(0)
    expect(replaced.command).toBe(next.command)
  })

  test('with nothing on the pane the next panel is taken as it is', () => {
    const next = panelOf(['approvals', 'list'], 0)

    expect(replacedOutput(undefined, next, PAGE_ROWS, PANE_WIDTH)).toBe(next)
  })

  test('a successful run of another command is replaced, so the pane stays live', () => {
    const previous = panelOf(['server', 'list'], 0)
    const next = panelOf(['approvals', 'list'], 0)

    expect(replacedOutput(previous, next, PAGE_ROWS, PANE_WIDTH)).toBe(next)
  })
})

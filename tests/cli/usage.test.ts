import { describe, expect, test } from 'vitest'
import {
  SERVICE_SYNOPSIS_LINES,
  SERVICE_USAGE,
  SETUP_SYNOPSIS_LINES,
  SETUP_USAGE,
  TUI_SYNOPSIS_LINES,
  TUI_USAGE,
  USAGE_DESCRIPTION_COLUMN,
} from '../../src/cli/operator-usage.js'
import { USAGE } from '../../src/cli/usage.js'

/**
 * One source of truth for the operator commands' synopsis (phase-1 follow-up).
 *
 * `mcpcut setup` and `mcpcut start|stop|status|logs` are each described in two
 * places: the global `--help` block, and the usage a refusal from the command
 * itself prints. They used to be two hand-written copies, and they had already
 * drifted — the global block knew where the pid and log files live, the local
 * one knew the `--lines` default, and neither knew what the other knew. This
 * suite is what keeps them one text: the local usage is nothing but the shared
 * synopsis lines under a header, and every one of those lines is in the global
 * block, contiguously and exactly once.
 */

/** Non-overlapping occurrences of `needle`; `String#split` counts them without a regex escape. */
function occurrencesOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const BLOCKS = [
  ['setup', SETUP_USAGE, SETUP_SYNOPSIS_LINES],
  ['start|stop|status|logs', SERVICE_USAGE, SERVICE_SYNOPSIS_LINES],
  ['tui', TUI_USAGE, TUI_SYNOPSIS_LINES],
] as const

describe.each(BLOCKS)('the %s synopsis', (_name, usage, lines) => {
  test('is not vacuous: real lines, none of them blank', () => {
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.trim()).not.toBe('')
  })

  test("the command's own usage is those lines under one header, nothing else", () => {
    expect(usage).toBe(`Usage:\n${lines.join('\n')}\n`)
  })

  test('every line of it appears in the global usage block exactly once', () => {
    for (const line of lines) {
      expect(occurrencesOf(USAGE, line), `not exactly once in USAGE: ${line}`).toBe(1)
    }
  })

  test('the whole block appears in the global usage block, unbroken and exactly once', () => {
    expect(occurrencesOf(USAGE, lines.join('\n'))).toBe(1)
  })
})

describe('the global usage block stays one aligned table', () => {
  test('every description in it starts in the same column', () => {
    const described = USAGE.split('\n').filter((line) =>
      line.startsWith(' '.repeat(USAGE_DESCRIPTION_COLUMN)),
    )

    // Sanity: the filter really does select rows, so the loop below is not empty.
    expect(described.length).toBeGreaterThan(SETUP_SYNOPSIS_LINES.length)
    for (const line of described) {
      expect(line[USAGE_DESCRIPTION_COLUMN], `description not at the column: ${line}`).not.toBe(' ')
    }
  })
})

describe('the --behind-tls note lives in the synopsis, once', () => {
  test('names the flag that takes it back', () => {
    expect(SETUP_USAGE).toContain('--no-behind-tls')
    expect(occurrencesOf(USAGE, '--no-behind-tls takes it back')).toBe(1)
  })
})

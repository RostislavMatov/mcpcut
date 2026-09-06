import { describe, expect, test } from 'vitest'
import { TOKEN_ONCE_NOTICE } from '../../src/cli/ui-constants.js'
import { bareNoConfigHint, TUI_NOT_A_TTY } from '../../src/cli/tui-constants.js'
import {
  DEFAULT_TUI_SIGNALS,
  exitLine,
  ONE_TIME_TOKEN_MARKER,
  truncatedNote,
} from '../../src/tui/constants.js'
import { CLI_NAME } from '../../src/setup/constants.js'

/**
 * The console's words, pinned where they are shared (plan phase 2, task 2).
 *
 * Only the constants another module reads BACK are asserted here: the one-time
 * token marker (`output.ts` searches a command's stdout for it), the two
 * formatters, the signal list `runtime.ts` installs listeners for, and the
 * refusals `tui-cmd.ts` prints. The purely cosmetic strings are pinned by the
 * render tests that put them on a screen.
 */

describe('the one-time token marker', () => {
  test('is the CLI notice without its trailing newline, so a stdout scan finds it', () => {
    expect(ONE_TIME_TOKEN_MARKER).toBe(TOKEN_ONCE_NOTICE.trimEnd())
    expect(ONE_TIME_TOKEN_MARKER).not.toBe('')
  })
})

describe('the output-panel notes', () => {
  test('the truncation note names how many lines were dropped', () => {
    expect(truncatedNote(3)).toContain('3')
  })

  test('the exit line is the shell-like word and the code', () => {
    expect(exitLine(0)).toBe('exit 0')
  })
})

describe('the signals the console listens for', () => {
  test('are frozen and cover interrupt, terminate and hangup', () => {
    expect(Object.isFrozen(DEFAULT_TUI_SIGNALS)).toBe(true)
    expect([...DEFAULT_TUI_SIGNALS]).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP'])
  })
})

describe("the command's refusals", () => {
  test('the hint for a bare run with no install config names the path and the way out', () => {
    const hint = bareNoConfigHint('/x/config.json')

    expect(hint).toContain('/x/config.json')
    expect(hint).toContain('setup --yes')
    expect(hint).toContain(CLI_NAME)
  })

  test('the not-a-TTY refusal ends with a newline, like every other stderr line', () => {
    expect(TUI_NOT_A_TTY.endsWith('\n')).toBe(true)
  })
})

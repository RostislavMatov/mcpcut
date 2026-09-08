import { describe, expect, test } from 'vitest'
import { TOKEN_ONCE_NOTICE } from '../../src/cli/ui-constants.js'
import { TUI_NOT_A_TTY } from '../../src/cli/tui-constants.js'
import {
  DEFAULT_COLUMNS,
  DEFAULT_TUI_SIGNALS,
  DEPLOY_EXTERNAL_DETAIL,
  DEPLOY_INTRO,
  DEPLOY_MARKERS,
  DEPLOY_SETUP_DONE_DETAIL,
  DEPLOY_SETUP_DONE_WITH_OWNER_DETAIL,
  DEPLOY_STEP_TITLES,
  DEPLOY_TITLE_WIDTH,
  deployExitDetail,
  deployWaitingDetail,
  exitLine,
  HEADER_SEPARATOR,
  mintedAdminLine,
  ONE_TIME_TOKEN_MARKER,
  RULE_CHAR,
  truncatedNote,
  WIZARD_DONE_EXTERNAL_LINES,
  WIZARD_NO_ADMIN_LINES,
  WIZARD_DONE_FOOTER,
  WIZARD_DONE_LINES,
  WIZARD_DONE_PARTIAL_LINES,
  WIZARD_EXPOSURE_FOOTER,
  WIZARD_EXPOSURE_INTRO,
  WIZARD_EXPOSURE_QUESTION,
  WIZARD_FAILED_FOOTER,
  WIZARD_FORM_FOOTER,
  WIZARD_RUNNING_FOOTER,
  WIZARD_TITLE_EDIT,
  WIZARD_TITLE_FIRST_RUN,
  WIZARD_TOKEN_FOOTER,
  WIZARD_TOKEN_QUESTION,
  wizardFailedNotice,
  wizardIntroLines,
} from '../../src/tui/constants.js'
import { START_READY_TIMEOUT_MS } from '../../src/services/constants.js'

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
  test('the not-a-TTY refusal ends with a newline, like every other stderr line', () => {
    expect(TUI_NOT_A_TTY.endsWith('\n')).toBe(true)
  })
})

describe('the first-run wizard: its words fit the smallest supported line', () => {
  /**
   * The lesson of phase 2: `padRight` cuts at the terminal's width, so a
   * sentence longer than the 80 columns every emulator still starts at is
   * silently truncated on screen. Every wizard string is pinned here rather
   * than discovered by an operator with a clipped footer.
   */
  const WIZARD_STRINGS: readonly string[] = [
    HEADER_SEPARATOR,
    RULE_CHAR,
    WIZARD_TITLE_FIRST_RUN,
    WIZARD_TITLE_EDIT,
    WIZARD_FORM_FOOTER,
    WIZARD_EXPOSURE_INTRO,
    WIZARD_EXPOSURE_QUESTION,
    WIZARD_EXPOSURE_FOOTER,
    DEPLOY_INTRO,
    DEPLOY_SETUP_DONE_DETAIL,
    DEPLOY_SETUP_DONE_WITH_OWNER_DETAIL,
    DEPLOY_EXTERNAL_DETAIL,
    WIZARD_RUNNING_FOOTER,
    WIZARD_FAILED_FOOTER,
    WIZARD_TOKEN_QUESTION,
    WIZARD_TOKEN_FOOTER,
    WIZARD_DONE_FOOTER,
    ...WIZARD_DONE_LINES,
    ...WIZARD_DONE_PARTIAL_LINES,
    ...WIZARD_DONE_EXTERNAL_LINES,
    ...WIZARD_NO_ADMIN_LINES,
    ...Object.values(DEPLOY_STEP_TITLES),
    ...Object.values(DEPLOY_MARKERS),
    // Measured with no path: the config path is the operator's, and a deep
    // one is cut by `padRight` at render time. What is pinned here is OUR
    // half of the sentence.
    ...wizardIntroLines('first-run', ''),
    ...wizardIntroLines('edit', ''),
    deployWaitingDetail(START_READY_TIMEOUT_MS),
    deployExitDetail(1),
    wizardFailedNotice(1),
    mintedAdminLine('owner'),
  ]

  test.each(WIZARD_STRINGS)('"%s" is at most 80 columns wide', (line) => {
    expect(line.length).toBeLessThanOrEqual(DEFAULT_COLUMNS)
  })

  test('no string is empty, so nothing above passes by being missing', () => {
    expect(WIZARD_STRINGS.length).toBeGreaterThan(20)
    for (const line of WIZARD_STRINGS) expect(line).not.toBe('')
  })
})

describe('the deploy ladder markers', () => {
  test('are one column each, so the titles of the five states line up', () => {
    for (const marker of Object.values(DEPLOY_MARKERS)) {
      expect(marker).toHaveLength(1)
    }
  })

  test('cover every state exactly once and every step has a title', () => {
    expect(Object.keys(DEPLOY_MARKERS)).toEqual([
      'pending',
      'running',
      'done',
      'failed',
      'skipped',
    ])
    expect(Object.keys(DEPLOY_STEP_TITLES)).toEqual(['setup', 'start-ui', 'start-serve'])
  })

  test('the widest title fits the column the ladder reserves for it', () => {
    for (const title of Object.values(DEPLOY_STEP_TITLES)) {
      expect(title.length).toBeLessThanOrEqual(DEPLOY_TITLE_WIDTH)
    }
  })
})

describe('the wizard intro', () => {
  test('names the config path on a first run and on an edit', () => {
    const [firstRun] = wizardIntroLines('first-run', '/x/config.json')
    const [edit] = wizardIntroLines('edit', '/x/config.json')

    expect(firstRun).toContain('/x/config.json')
    expect(edit).toContain('/x/config.json')
    expect(firstRun).not.toBe(edit)
  })

  test('closes with the same sentence on both modes, so the promise never changes', () => {
    expect(wizardIntroLines('first-run', '/x')[1]).toBe(wizardIntroLines('edit', '/x')[1])
  })
})

describe('the deploy details', () => {
  test('the waiting line names the timeout in whole seconds', () => {
    expect(deployWaitingDetail(15_000)).toContain('15 s')
  })

  test('the exit detail is the shell-like word and the code', () => {
    expect(deployExitDetail(2)).toBe('exit 2')
  })

  test('the failure notice names the exit code and the way forward', () => {
    const notice = wizardFailedNotice(3)

    expect(notice).toContain('3')
    expect(notice).toContain('Enter')
  })

  test('the minted-admin line names the admin and ends ready for the token', () => {
    const line = mintedAdminLine('owner')

    expect(line).toContain('owner')
    expect(line.endsWith(' ')).toBe(true)
  })
})

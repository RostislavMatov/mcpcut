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
  HELP_LINES,
  deployExitDetail,
  deployWaitingDetail,
  exitLine,
  HEADER_SEPARATOR,
  mintedAdminLine,
  ONE_TIME_TOKEN_MARKER,
  RULE_CHAR,
  savedPartiallyLine,
  savedToLine,
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
import {
  APPROVALS_POLL_INTERVAL_MS,
  autoRefreshIntroLine,
  EXTERNAL_GLYPH,
  HELP_CLOSE_LINE,
  HELP_KEY_COLUMN,
  HELP_WRAP_INDENT,
  MS_PER_SECOND,
  NARROW_COLUMNS,
  PENDING_KEYS_MAX,
  STACKED_ACTION_ROWS_SHARE,
  SIGNIN_BOOTSTRAP_PREFIX,
  SIGNIN_SERVICES_DOWN_HINT,
  SIGNIN_SERVICES_EXTERNAL_HINT,
  SIGNIN_SERVICES_PREFIX,
  TOKEN_HOLD_BANNER,
  TOKEN_HOLD_BANNER_MAX_LINES,
  TOKEN_HOLD_BANNER_SHORT,
  TOKEN_HOLD_FOOTER,
  WIZARD_STOPWATCH_INTERVAL_MS,
} from '../../src/tui/constants-live.js'
import { START_READY_TIMEOUT_MS } from '../../src/services/constants.js'
import { RUNNING_HELP_FOOTER } from '../../src/tui/render-main.js'
import { paneWidthOf } from '../../src/tui/layout.js'

/** Where the description of every `?` line starts, counted from the phase-2 lines. */
const HELP_KEY_COLUMN_WIDTH = 24

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

describe('the help panel', () => {
  /**
   * Owner tail Q24 added the sideways-scroll line. The `?` panel is drawn in
   * the 54-column pane, so its key column has to stay the width every other
   * line uses, and the whole line has to fit the 80 columns a terminal starts
   * at — the phase-2 lesson about `padRight` cutting silently.
   */
  const HSCROLL_HELP_LINE = HELP_LINES.find((line) => line.startsWith('['))

  test('names the two keys that move the output pane sideways', () => {
    expect(HSCROLL_HELP_LINE).toBeDefined()
    expect(HSCROLL_HELP_LINE).toContain(']')
  })

  test('keeps the key column of every other line and fits 80 columns', () => {
    expect(HSCROLL_HELP_LINE?.indexOf('scroll')).toBe(HELP_KEY_COLUMN_WIDTH)
    expect(HSCROLL_HELP_LINE?.length).toBeLessThanOrEqual(DEFAULT_COLUMNS)
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

describe('the words of the full catalogue', () => {
  test('the saved-output line names the byte count and the path it wrote', () => {
    expect(savedToLine('/tmp/report.jsonl', 42)).toBe('wrote 42 bytes to /tmp/report.jsonl')
  })

  test('an empty file is still reported, so a run that wrote nothing is not silent', () => {
    expect(savedToLine('/tmp/empty.jsonl', 0)).toBe('wrote 0 bytes to /tmp/empty.jsonl')
  })

  test('a file that could not be finished says so, and does not read as a success', () => {
    const line = savedPartiallyLine('/tmp/report.jsonl', 42)

    expect(line).toBe('wrote 42 bytes to /tmp/report.jsonl before failing')
    expect(line).not.toBe(savedToLine('/tmp/report.jsonl', 42))
  })
})

/**
 * Phase 5's words live in `constants-live.ts` (the file budget of
 * `constants.ts`), and the same 80-column rule applies to every one of them:
 * `padRight` cuts silently, so a banner an operator cannot finish reading is
 * a banner that fails here instead.
 */
describe('the live-queue and token-hold words fit the smallest supported line', () => {
  const LIVE_STRINGS: readonly string[] = [
    TOKEN_HOLD_BANNER,
    TOKEN_HOLD_FOOTER,
    SIGNIN_SERVICES_PREFIX,
    SIGNIN_SERVICES_DOWN_HINT,
    SIGNIN_SERVICES_EXTERNAL_HINT,
    EXTERNAL_GLYPH,
    autoRefreshIntroLine(APPROVALS_POLL_INTERVAL_MS),
  ]

  test.each(LIVE_STRINGS)('"%s" is at most 80 columns wide', (line) => {
    expect(line.length).toBeLessThanOrEqual(DEFAULT_COLUMNS)
  })

  test('no string is empty, so nothing above passes by being missing', () => {
    for (const line of LIVE_STRINGS) expect(line).not.toBe('')
  })

  test('the external glyph is one column, like the three the header already draws', () => {
    expect(EXTERNAL_GLYPH).toHaveLength(1)
  })

  test('the poll interval is whole seconds, which is what the intro line says', () => {
    expect(MS_PER_SECOND).toBe(1000)
    expect(APPROVALS_POLL_INTERVAL_MS % MS_PER_SECOND).toBe(0)
    expect(autoRefreshIntroLine(APPROVALS_POLL_INTERVAL_MS)).toContain(
      `${APPROVALS_POLL_INTERVAL_MS / MS_PER_SECOND} s`,
    )
  })
})

describe('the help panel after phase 5', () => {
  test('every line still fits 80 columns', () => {
    for (const line of HELP_LINES) expect(line.length).toBeLessThanOrEqual(DEFAULT_COLUMNS)
  })

  test('the confirmation line also says that y saves a token, in the same key column', () => {
    const line = HELP_LINES.find((each) => each.startsWith('y / n'))

    expect(line).toBeDefined()
    expect(line).toContain('token')
    expect(line?.indexOf('answer')).toBe(HELP_KEY_COLUMN_WIDTH)
  })
})

/**
 * Phase 6's words and numbers (F1, F3, F4, F5, F8). The `?` overlay splits a
 * line that no longer fits at `HELP_KEY_COLUMN`, so every help line has to
 * have a space there — or be shorter than the column altogether.
 */
describe('the words and numbers of phase 6', () => {
  const PHASE_6_STRINGS: readonly string[] = [
    HELP_CLOSE_LINE,
    TOKEN_HOLD_BANNER_SHORT,
    RUNNING_HELP_FOOTER,
    SIGNIN_BOOTSTRAP_PREFIX,
    deployWaitingDetail(START_READY_TIMEOUT_MS, 3),
  ]

  test.each(PHASE_6_STRINGS)('"%s" is at most 80 columns wide and not empty', (line) => {
    expect(line.length).toBeLessThanOrEqual(DEFAULT_COLUMNS)
    expect(line).not.toBe('')
  })

  test('every help line is shorter than the key column or has a space just before it', () => {
    expect(HELP_KEY_COLUMN).toBe(HELP_KEY_COLUMN_WIDTH)
    for (const line of HELP_LINES) {
      const splittable = line.length < HELP_KEY_COLUMN || line[HELP_KEY_COLUMN - 1] === ' '
      expect(splittable, `"${line}"`).toBe(true)
    }
  })

  test('the wrapped description is indented by less than the key column', () => {
    expect(HELP_WRAP_INDENT).toBe(2)
    expect(HELP_WRAP_INDENT).toBeLessThan(HELP_KEY_COLUMN)
  })

  test('the closing line of the overlay says what any key does', () => {
    expect(HELP_CLOSE_LINE).toBe('any key closes this help')
  })

  test('the short token banner fits the two-column pane of the default terminal on one line', () => {
    expect(TOKEN_HOLD_BANNER_SHORT).toBe('One-time token on screen: copy it, then press y.')
    expect(TOKEN_HOLD_BANNER_SHORT.length).toBeLessThanOrEqual(paneWidthOf(DEFAULT_COLUMNS))
    expect(TOKEN_HOLD_BANNER_MAX_LINES).toBe(2)
  })

  test('the running footer says keys are queued, not ignored, and still names Ctrl-C', () => {
    expect(RUNNING_HELP_FOOTER).toBe(
      'running… · keys are queued until it finishes · Ctrl-C aborts',
    )
  })

  test('the key buffer has a fixed ceiling', () => {
    expect(PENDING_KEYS_MAX).toBe(32)
  })

  test('the stacked layout threshold and share are the numbers of F1', () => {
    expect(NARROW_COLUMNS).toBe(60)
    expect(STACKED_ACTION_ROWS_SHARE).toBe(3)
  })

  test('the wizard stopwatch ticks in whole seconds', () => {
    expect(WIZARD_STOPWATCH_INTERVAL_MS).toBe(1_000)
    expect(WIZARD_STOPWATCH_INTERVAL_MS % MS_PER_SECOND).toBe(0)
  })

  test('the waiting line without seconds is the phase-3 sentence, byte for byte', () => {
    expect(deployWaitingDetail(15_000)).toBe('waiting for the service to answer (up to 15 s)')
    expect(deployWaitingDetail(15_000, 0)).toBe(deployWaitingDetail(15_000))
  })

  test('the waiting line with seconds counts them against the timeout', () => {
    expect(deployWaitingDetail(15_000, 3)).toBe(
      'waiting for the service to answer (3 s of up to 15 s)',
    )
  })
})

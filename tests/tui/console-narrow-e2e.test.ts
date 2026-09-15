import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore } from '../../src/admin/store.js'
import { CLI_NAME } from '../../src/setup/constants.js'
import {
  ACTION_COLUMN_WIDTH,
  ACTIVE_MARKER,
  COLUMN_GAP,
  FOOTER_ROWS,
  HEADER_ROWS,
} from '../../src/tui/constants.js'
import { HELP_CLOSE_LINE, NARROW_COLUMNS } from '../../src/tui/constants-live.js'
import { helpLines } from '../../src/tui/render-help.js'
import {
  closeConsoles,
  openConsole,
  runAction,
  screenLines,
  signIn,
  SPACE,
  waitForFinishedRun,
  type RunningConsole,
} from './support/console-harness.js'
import { waitForScreen } from './support/fake-terminal.js'

/**
 * The narrow console end to end (mcpcut phase 6, F1 and F3): a 40-column
 * terminal, the real dispatcher behind it, and the frames an operator sees.
 *
 * `render-narrow.test.ts` proves the stacked shape line by line from a model.
 * What only a running console can show is the RESIZE: the same output pane,
 * drawn stacked at 40 columns, in two columns at 80, and stacked again — with
 * nothing re-run — and the `?` overlay taking the whole width at any size.
 *
 * The Admins section is entered with its digit and a wait on the band's first
 * row rather than through `goToSection`: at 40×12 the band is two rows (a
 * third of the body), so a section of five actions is never on screen whole,
 * which is the layout working as designed and not a section that failed to
 * open. `runAction` still works — the cursor is on `list`, the first action.
 */

const OWNER_NAME = 'root'

/** A phone-sized terminal: below `NARROW_COLUMNS`, and short enough to window the band. */
const NARROW = { columns: 40, rows: 12 } as const

/** The harness's default, where the body is two columns again. */
const WIDE = { columns: 80, rows: 24 } as const

/**
 * Tall enough for the whole `?` overlay at 40 columns. The overlay does not
 * scroll (`render-help.ts`), so on 12 rows its closing line is honestly off
 * the bottom; the close-line assertion needs the rows to show it.
 */
const TALL_NARROW = { columns: 40, rows: 60 } as const

/** The digit of the Admins section for an owner (`console-e2e.test.ts`). */
const ADMINS_KEY = '2'

const LIST_COMMAND = 'admin list'
const LIST_LINE = `$ ${CLI_NAME} ${LIST_COMMAND}`

/** Where the pane's command line starts in the two-column layout. */
const TWO_COLUMN_PANE_START = ACTION_COLUMN_WIDTH + COLUMN_GAP

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-narrow-e2e-'))
})

afterEach(async () => {
  await closeConsoles()
  await rm(journalDir, { recursive: true, force: true })
})

/** The column the `$ mcpcut admin list` line starts at, or `-1` when it is not on screen. */
function listLineColumnOf(app: RunningConsole): number {
  const line = screenLines(app.fake).find((each) => each.includes(LIST_LINE))
  return line === undefined ? -1 : line.indexOf(LIST_LINE)
}

/** Opens a narrow console, signs the owner in and runs `admin list` from the Admins band. */
async function narrowConsoleAfterList(): Promise<RunningConsole> {
  const { token } = await createAdminStore({ journalDir }).createAdmin(OWNER_NAME, 'owner')
  const app = openConsole(journalDir, { size: NARROW })
  await signIn(app, token, OWNER_NAME, 'owner')

  app.fake.type(ADMINS_KEY)
  await waitForScreen(
    app.fake,
    (screen) => screen.split('\n')[HEADER_ROWS]?.startsWith(`${ACTIVE_MARKER}list`) === true,
    'the Admins band with list on its first row',
  )
  await runAction(app, { title: 'list', command: LIST_COMMAND })

  return app
}

describe('the narrow console end to end', () => {
  test('the threshold these sizes sit either side of is the layout\'s own', () => {
    expect(NARROW.columns).toBeLessThan(NARROW_COLUMNS)
    expect(WIDE.columns).toBeGreaterThanOrEqual(NARROW_COLUMNS)
  })

  test('stacked at 40, two columns at 80, stacked again — the same run throughout', async () => {
    const app = await narrowConsoleAfterList()
    const { fake } = app

    // Stacked: the pane is the whole width, so the command line starts at 0.
    expect(listLineColumnOf(app)).toBe(0)
    const runsBefore = app.argvCalls().filter((argv) => argv[0] === 'admin').length

    fake.resize(WIDE.columns, WIDE.rows)
    await waitForScreen(
      fake,
      () => listLineColumnOf(app) === TWO_COLUMN_PANE_START,
      'the two-column layout with the run in the right-hand pane',
    )
    await waitForFinishedRun(app, LIST_COMMAND)
    expect(fake.screen()).toContain(OWNER_NAME)

    fake.resize(NARROW.columns, NARROW.rows)
    await waitForScreen(fake, () => listLineColumnOf(app) === 0, 'the stacked layout again')
    await waitForFinishedRun(app, LIST_COMMAND)

    // A resize redraws; it never re-runs.
    expect(app.argvCalls().filter((argv) => argv[0] === 'admin')).toHaveLength(runsBefore)
    expect(screenLines(fake)).toHaveLength(NARROW.rows)
    expect(screenLines(fake).every((line) => line.length === NARROW.columns)).toBe(true)
  })

  test('? is a full-width overlay at 40 columns, and any key closes it', async () => {
    const app = await narrowConsoleAfterList()
    const { fake } = app
    const bodyRows = NARROW.rows - HEADER_ROWS - FOOTER_ROWS

    fake.type('?')
    const overlay = helpLines(NARROW.columns, bodyRows)
    await waitForScreen(
      fake,
      (screen) => screen.split('\n').slice(HEADER_ROWS, HEADER_ROWS + bodyRows).join('\n') === overlay.join('\n'),
      'the help overlay across the whole body',
    )

    // Taller: the overlay is redrawn for the new size and its last line arrives.
    fake.resize(TALL_NARROW.columns, TALL_NARROW.rows)
    await waitForScreen(fake, (screen) => screen.includes(HELP_CLOSE_LINE), 'the closing line of the help')

    fake.type(SPACE)
    await waitForScreen(
      fake,
      (screen) => !screen.includes(HELP_CLOSE_LINE) && screen.includes(LIST_LINE),
      'the pane back under the band',
    )
    expect(listLineColumnOf(app)).toBe(0)
  })
})

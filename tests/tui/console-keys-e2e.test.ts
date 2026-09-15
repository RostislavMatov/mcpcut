import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore } from '../../src/admin/store.js'
import { dispatch } from '../../src/cli.js'
import type { DispatchFn } from '../../src/cli/dispatch-types.js'
import { visibleActions, visibleSections } from '../../src/tui/catalogue/index.js'
import { RUNNING_HELP_FOOTER } from '../../src/tui/render-main.js'
import {
  acknowledgeToken,
  actionTitlesIn,
  closeConsoles,
  goToSection,
  openConsole,
  submitAction,
  tabsLineOf,
  TAB,
  TOKEN_HOLD_BANNER_HEAD,
  type RunningConsole,
  signIn,
  waitForFinishedRun,
  YES_KEY,
} from './support/console-harness.js'
import { waitForScreen } from './support/fake-terminal.js'

/**
 * The key queue end to end (mcpcut phase 6, F5 / Q30): keys pressed while a
 * command runs are replayed after it answers — except onto a one-time token.
 *
 * `update-keys.test.ts` proves the reducer's buffer. What only a running
 * console can show is the TIMING: the keys arrive as bytes while the real
 * dispatcher is still inside `admin list`, and the reducer sees them as
 * presses during `busy`. The dispatcher is the real one behind a delay on
 * every `admin` command — long enough for two keystrokes to land, short
 * enough not to wait on.
 *
 * The section the replay lands on is read off the action list and the tab
 * bar, never off the tab's inverse: the harness renders with `plainStyle`,
 * where the active tab has no attribute to look for.
 */

const OWNER_NAME = 'root'
const NEW_ADMIN_NAME = 'alice'

/** Long enough for two keys typed on the running frame to arrive before the answer. */
const SLOW_ADMIN_MS = 300

/** Approvals is the ninth section of an owner; one Tab past it is Journal. */
const APPROVALS_KEY = '9'
const JOURNAL_INDEX = 9

/** The real dispatcher, made slow on `admin` commands only. */
const slowAdminDispatch: DispatchFn = async (argv, io, options) => {
  if (argv[0] === 'admin') await sleep(SLOW_ADMIN_MS)
  return dispatch(argv, io, options)
}

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-keys-e2e-'))
})

afterEach(async () => {
  await closeConsoles()
  await rm(journalDir, { recursive: true, force: true })
})

/** A console over the slow dispatcher, signed in and on the Admins section. */
async function adminsConsole(): Promise<RunningConsole> {
  const { token } = await createAdminStore({ journalDir }).createAdmin(OWNER_NAME, 'owner')
  const app = openConsole(journalDir, { dispatch: slowAdminDispatch })
  await signIn(app, token, OWNER_NAME, 'owner')
  await goToSection(app, 'admins', 'owner')

  return app
}

/** The titles the Journal section shows an owner. */
function journalTitles(): readonly string[] {
  const section = visibleSections('owner')[JOURNAL_INDEX]
  if (section?.id !== 'journal') throw new Error(`section ${JOURNAL_INDEX} is not journal`)

  return visibleActions(section, 'owner').map((action) => action.title)
}

describe('keys pressed during a run', () => {
  test('are replayed after it answers, and run nothing twice', async () => {
    const app = await adminsConsole()
    const { fake } = app

    await submitAction(app, { title: 'list', command: 'admin list' })
    await waitForScreen(fake, (screen) => screen.includes(RUNNING_HELP_FOOTER), 'the running footer')
    fake.type(APPROVALS_KEY)
    fake.type(TAB)

    await waitForFinishedRun(app, 'admin list')
    await waitForScreen(
      fake,
      (screen) => actionTitlesIn(screen).join('\n') === journalTitles().join('\n'),
      'the Journal section, reached by the replayed 9 and Tab',
    )

    expect(tabsLineOf(fake)).toContain(`${JOURNAL_INDEX + 1} Journal`)
    expect(app.argvCalls().filter((argv) => argv.join(' ') === 'admin list')).toHaveLength(1)
  })

  test('are dropped when the answer holds a one-time token', async () => {
    const app = await adminsConsole()
    const { fake } = app

    await submitAction(app, { title: 'add', values: [NEW_ADMIN_NAME], command: 'admin add' })
    await waitForScreen(fake, (screen) => screen.includes(RUNNING_HELP_FOOTER), 'the running footer')
    // A blind `y` — the one key the token hold must never take from a buffer.
    fake.type(YES_KEY)

    await waitForFinishedRun(app, `admin add ${NEW_ADMIN_NAME} --role owner`)

    expect(fake.screen()).toContain(TOKEN_HOLD_BANNER_HEAD)
    await acknowledgeToken(app)
    expect(fake.screen()).not.toContain(TOKEN_HOLD_BANNER_HEAD)
  })
})

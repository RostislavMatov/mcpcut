import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_PREFIX } from '../../src/admin/constants.js'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { CLI_NAME } from '../../src/setup/constants.js'
import {
  ACTIVE_MARKER,
  EXIT_OK,
  SESSION_LOST_NOTICE,
  SIGNIN_TITLE,
  SIGNIN_UNKNOWN_TOKEN_NOTICE,
} from '../../src/tui/constants.js'
import {
  accessRecords,
  acknowledgeToken,
  closeConsoles,
  DOWN_KEY,
  ENTER,
  INTERRUPT,
  NO_KEY,
  openConsole,
  QUIT_KEY,
  REFRESH_KEY,
  RIGHT_ARROW,
  signIn,
  storeBytes,
  TAB,
  tabsLineOf,
  YES_KEY,
} from './support/console-harness.js'
import { waitForScreen } from './support/fake-terminal.js'

/**
 * The console end to end (mcpcut phase 2, task 17): a real terminal's worth of
 * bytes in, the REAL `dispatch` in the middle, a real admin store on disk, and
 * frames out — no subprocess and no stubbed command.
 *
 * Everything else in `tests/tui` asserts one layer. This file exists for the
 * three promises that only hold across all of them at once.
 *
 * The path works: a token typed at the sign-in screen resolves through the
 * same store the web UI uses, the Admins section builds `admin add alice
 * --role operator` out of a form, the CLI runs it for real, and `admin list`
 * afterwards shows the admin the console just created.
 *
 * The token stays out of sight: the session token that signed the operator in
 * appears in NO frame the console ever drew and in NO argv it ever
 * dispatched — it reaches the commands through the environment seam alone —
 * and no plaintext token of any kind is left behind on disk.
 *
 * The token bought ATTRIBUTION: the `admin add` the console ran is in the
 * journal as an `admin.add` record naming the operator who ran it (owner
 * decision 2026-09-06). That is the whole reason `admin` is on
 * `SESSION_ENV_SEAMS` — without the seam the command would have refused.
 *
 * The terminal comes back: whichever way the console is left — `q` with a
 * one-time token on screen, `q` without one, `Ctrl-C` — the promise resolves
 * with an exit code and the alternate screen and raw mode are given up.
 *
 * Every assertion is reached through `waitForScreen` rather than a sleep: a
 * keystroke becomes a frame only after a decode, a reducer step and, for
 * anything that runs a command, a whole CLI invocation.
 *
 * The stand is `./support/console-harness.js`, shared with the phase-4 suites
 * (phase-4 test-hygiene tail). It was extracted FROM this file; the keys
 * pressed below are the same keys, now named in one place. Unlike those
 * suites, the steps here are spelled out key by key rather than driven through
 * `goToSection`/`runAction`: what this file asserts IS the keystroke-to-frame
 * path, so a helper that waited for the right frame on its own would be
 * assuming the thing under test.
 */

/**
 * The default size a terminal reports nothing for. The right-hand pane owns
 * `columns - ACTION_COLUMN_WIDTH - COLUMN_GAP` = 54 columns at the harness's
 * 80, so the quit question wraps onto two lines — which is why the waits below
 * look for its last words rather than the whole sentence.
 */
const QUIT_QUESTION_TAIL = 'Quit anyway? [y/N]'

/** The owner every test signs in as, and the admin it creates through the UI. */
const OWNER_NAME = 'root'
const NEW_ADMIN_NAME = 'alice'
const NEW_ADMIN_ROLE = 'operator'

/** Well-formed, and belongs to nobody: what a rotated token looks like later. */
const BOGUS_TOKEN = `${ADMIN_TOKEN_PREFIX}Yki8n0tArEa1t0k3n_atAll-nope0000000000000000`

/**
 * The role field of the add form at its default, `ADMIN_ROLES[0]`. Waits use
 * this rather than a field LABEL: "Name" is also a substring of the section's
 * own introduction, so it would say the form was open before it was.
 */
const ROLE_CHOICE_WIDGET = '‹ owner ›'

/**
 * The second tab. Under an owner that is Admins; under a role that cannot see
 * Admins the same digit lands on Servers, which is exactly what one of the
 * tests below is about — so it is ONE constant, not two spellings of `'2'`.
 */
const SECOND_SECTION_KEY = '2'

let journalDir: string
let store: AdminStore

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-console-e2e-'))
  store = createAdminStore({ journalDir })
})

afterEach(async () => {
  await closeConsoles()
  await rm(journalDir, { recursive: true, force: true })
})

describe('console end to end: sign in, add an admin, list, quit', () => {
  test('runs the whole path through the real dispatcher', async () => {
    const { token } = await store.createAdmin(OWNER_NAME, 'owner')
    const app = openConsole(journalDir)
    const { fake } = app

    await signIn(app, token, OWNER_NAME, 'owner')
    // The header's service line comes from `status --json` through the same
    // dispatcher: the console is a client of the service manager, not a copy.
    await waitForScreen(fake, (screen) => screen.includes('ui ●'), 'the services header')

    fake.type(SECOND_SECTION_KEY)
    await waitForScreen(
      fake,
      (screen) => screen.includes(`${ACTIVE_MARKER}list`),
      'the Admins section',
    )
    // Eleven owner sections do not fit 80 columns, so the bar is a window
    // (`tabs.ts`): it holds the tab that was just opened and marks each side
    // it scrolled past. Admins is the second of eleven, so `1 Home` is behind
    // the left marker and the window runs rightwards from the active tab.
    expect(tabsLineOf(fake)).toMatch(/^‹ ▸2 Admins {2}3 Servers/)
    expect(tabsLineOf(fake)).toContain('8 Quarantine')

    fake.type(DOWN_KEY)
    await waitForScreen(fake, (screen) => screen.includes(`${ACTIVE_MARKER}add`), 'the add action')

    fake.type(ENTER)
    await waitForScreen(fake, (screen) => screen.includes(ROLE_CHOICE_WIDGET), 'the add form')

    fake.type(`${NEW_ADMIN_NAME}${TAB}`)
    fake.type(RIGHT_ARROW)
    await waitForScreen(
      fake,
      (screen) => screen.includes(NEW_ADMIN_NAME) && screen.includes(`‹ ${NEW_ADMIN_ROLE} ›`),
      'the filled-in form',
    )

    fake.type(ENTER)
    await waitForScreen(
      fake,
      (screen) => screen.includes(`token: ${ADMIN_TOKEN_PREFIX}`),
      "the new admin's one-time token",
    )

    // The command the panel shows is the command that ran.
    expect(fake.screen()).toContain(
      `$ ${CLI_NAME} admin add ${NEW_ADMIN_NAME} --role ${NEW_ADMIN_ROLE}`,
    )
    expect(app.argvCalls()).toContainEqual([
      'admin',
      'add',
      NEW_ADMIN_NAME,
      '--role',
      NEW_ADMIN_ROLE,
    ])

    // The session token bought attribution and nothing else: it never reached
    // a frame, never reached an argv, and no plaintext token reached disk.
    expect(fake.frames().every((frame) => !frame.includes(token))).toBe(true)
    expect(app.argvCalls().flat().every((argument) => !argument.includes(token))).toBe(true)
    const onDisk = await storeBytes(journalDir)
    // Guard the guard: a scan that read nothing would pass the next line for
    // the wrong reason, so first prove it found the record it is scanning.
    expect(onDisk).toContain(NEW_ADMIN_NAME)
    expect(onDisk).not.toContain(ADMIN_TOKEN_PREFIX)

    // ...and what it DID buy: the journal names the operator who ran the add.
    expect(await accessRecords(journalDir)).toEqual([
      {
        actor: { adminName: OWNER_NAME, role: 'owner', via: 'cli' },
        action: 'admin.add',
        admin: NEW_ADMIN_NAME,
        targetRole: NEW_ADMIN_ROLE,
      },
    ])

    // `q` while the one-time token is still on the screen asks first, because
    // the alternate screen takes the token with it (PRD C6).
    fake.type(QUIT_KEY)
    await waitForScreen(
      fake,
      (screen) => screen.includes(QUIT_QUESTION_TAIL),
      'the quit confirmation',
    )
    fake.type(NO_KEY)
    await waitForScreen(
      fake,
      (screen) =>
        !screen.includes(QUIT_QUESTION_TAIL) &&
        screen.includes(`token: ${ADMIN_TOKEN_PREFIX}`),
      'the output panel again',
    )

    // Saying no to the quit question puts the token BACK behind its hold
    // (phase 5, plan P2): until the operator says they copied it, `r` is one
    // of the keys the pane ignores, so the refresh below would draw nothing.
    await acknowledgeToken(app)

    fake.type(REFRESH_KEY)
    // The run in flight puts `running: $ mcpcut admin list` on the pane before
    // the command has answered, so the wait is for the panel that REPLACED the
    // one holding the token, not merely for the command line to appear.
    await waitForScreen(
      fake,
      (screen) =>
        screen.includes(`$ ${CLI_NAME} admin list`) &&
        !screen.includes(`token: ${ADMIN_TOKEN_PREFIX}`),
      'the admin list',
    )
    expect(fake.screen()).toContain(NEW_ADMIN_NAME)
    expect(fake.screen()).toContain(NEW_ADMIN_ROLE)

    // The token left the screen with the panel that held it, so this `q` has
    // nothing to warn about and leaves at once.
    fake.type(QUIT_KEY)

    expect(await app.exit).toBe(EXIT_OK)
    expect(fake.restored()).toBe(true)
    expect(app.errText()).toBe('')
  })

  test('answering the quit question with y leaves and restores the terminal', async () => {
    const { token } = await store.createAdmin(OWNER_NAME, 'owner')
    const app = openConsole(journalDir)
    const { fake } = app

    await signIn(app, token, OWNER_NAME, 'owner')
    fake.type(SECOND_SECTION_KEY)
    await waitForScreen(
      fake,
      (screen) => screen.includes(`${ACTIVE_MARKER}list`),
      'the Admins section',
    )
    fake.type(DOWN_KEY)
    await waitForScreen(fake, (screen) => screen.includes(`${ACTIVE_MARKER}add`), 'the add action')
    fake.type(ENTER)
    await waitForScreen(fake, (screen) => screen.includes(ROLE_CHOICE_WIDGET), 'the add form')
    fake.type(`${NEW_ADMIN_NAME}${ENTER}`)
    await waitForScreen(
      fake,
      (screen) => screen.includes(`token: ${ADMIN_TOKEN_PREFIX}`),
      "the new admin's one-time token",
    )

    fake.type(QUIT_KEY)
    await waitForScreen(
      fake,
      (screen) => screen.includes(QUIT_QUESTION_TAIL),
      'the quit confirmation',
    )
    fake.type(YES_KEY)

    expect(await app.exit).toBe(EXIT_OK)
    expect(fake.restored()).toBe(true)
  })
})

describe('console end to end: session freshness', () => {
  test('a token rotated from outside ends the session at the next action', async () => {
    const { token } = await store.createAdmin(OWNER_NAME, 'owner')
    const app = openConsole(journalDir)
    const { fake } = app

    await signIn(app, token, OWNER_NAME, 'owner')
    await waitForScreen(fake, (screen) => screen.includes('ui ●'), 'the services header')

    // The shell that rotates a token is the whole point of re-checking: the
    // console is already open and must stop working the moment it happens.
    await store.rotateAdmin(OWNER_NAME)

    fake.type(ENTER)
    await waitForScreen(
      fake,
      (screen) => screen.includes(SESSION_LOST_NOTICE),
      'the lost-session notice',
    )
    expect(fake.screen()).toContain(SIGNIN_TITLE)

    fake.type(INTERRUPT)

    expect(await app.exit).toBe(EXIT_OK)
    expect(fake.restored()).toBe(true)
  })
})

describe('console end to end: role', () => {
  test('a viewer gets the reading sections, never Admins, and 2 opens Servers', async () => {
    const { token } = await store.createAdmin('watcher', 'viewer')
    const app = openConsole(journalDir)
    const { fake } = app

    await signIn(app, token, 'watcher', 'viewer')
    await waitForScreen(
      fake,
      (screen) => screen.includes(`${ACTIVE_MARKER}status`),
      'the Home section',
    )
    // The owner-only sections are not merely refused to a viewer: the tab bar
    // never numbers them, so this role's digit 2 is Servers, not Admins.
    expect(tabsLineOf(fake)).toMatch(/^▸1 Home {2}2 Servers {2}3 Agents/)
    expect(tabsLineOf(fake)).not.toContain('Admins')
    expect(tabsLineOf(fake)).not.toContain('Vault')

    fake.type(SECOND_SECTION_KEY)
    await waitForScreen(
      fake,
      (screen) => screen.includes(`${ACTIVE_MARKER}list`),
      'the Servers section',
    )

    expect(tabsLineOf(fake)).not.toContain('Admins')
    expect(app.argvCalls().every((argv) => argv[0] !== 'admin')).toBe(true)

    fake.type(INTERRUPT)

    expect(await app.exit).toBe(EXIT_OK)
    expect(fake.restored()).toBe(true)
  })
})

describe('console end to end: sign-in failures', () => {
  test('a token belonging to nobody is refused and the console stays open', async () => {
    const { token } = await store.createAdmin(OWNER_NAME, 'owner')
    const app = openConsole(journalDir)
    const { fake } = app

    await waitForScreen(fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')
    fake.type(`${BOGUS_TOKEN}${ENTER}`)
    await waitForScreen(
      fake,
      (screen) => screen.includes(SIGNIN_UNKNOWN_TOKEN_NOTICE),
      'the unknown-token notice',
    )
    expect(fake.frames().every((frame) => !frame.includes(BOGUS_TOKEN))).toBe(true)

    // Still alive: the right token signs in on the same screen.
    fake.type(`${token}${ENTER}`)
    await waitForScreen(
      fake,
      (screen) => screen.includes(`${OWNER_NAME} (owner)`),
      'the header naming the owner',
    )

    fake.type(INTERRUPT)

    expect(await app.exit).toBe(EXIT_OK)
    expect(fake.restored()).toBe(true)
  })
})

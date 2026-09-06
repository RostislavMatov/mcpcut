import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_PREFIX } from '../../src/admin/constants.js'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { dispatch } from '../../src/cli.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import type { CliIo, DispatchOptions } from '../../src/cli/dispatch-types.js'
import { runTui } from '../../src/cli/tui-cmd.js'
import type { UiCliIo } from '../../src/cli/ui-constants.js'
import type { ServiceName } from '../../src/services/constants.js'
import type {
  ServiceManager,
  ServiceStatus,
  StartResult,
  StopResult,
} from '../../src/services/manager.js'
import { CLI_NAME } from '../../src/setup/constants.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import { plainStyle } from '../../src/tui/ansi.js'
import {
  ACTIVE_MARKER,
  EXIT_OK,
  QUIT_WITH_TOKEN_QUESTION,
  SESSION_LOST_NOTICE,
  SIGNIN_TITLE,
  SIGNIN_UNKNOWN_TOKEN_NOTICE,
} from '../../src/tui/constants.js'
import { readJournalRecords } from '../support/journal-rows.js'
import { createFakeTerminal, waitForScreen, type FakeTerminal } from './support/fake-terminal.js'

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
 */

/**
 * The default size a terminal reports nothing for. The right-hand pane owns
 * `columns - ACTION_COLUMN_WIDTH - COLUMN_GAP` = 54 columns here, so the quit
 * question wraps onto two lines — which is why the waits below look for its
 * last words rather than the whole sentence.
 */
const CONSOLE_COLUMNS = 80
const CONSOLE_ROWS = 24

/** The tail of `QUIT_WITH_TOKEN_QUESTION`, which survives wrapping intact. */
const QUIT_QUESTION_TAIL = 'Quit anyway? [y/N]'

/** Short enough to keep a lone `Esc` quick; the console ships with 100. */
const ESCAPE_TIMEOUT_MS = 10

/** How long a test waits for a console it asked to close. */
const CLOSE_TIMEOUT_MS = 2_000

/** Where the install config would live; nothing reads the file itself here. */
const CONFIG_PATH = '/home/op/.mcpcut/config.json'

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

/** The keys the tests press, named so the steps read as steps. */
const ENTER = '\r'
const INTERRUPT = '\x03'
const RIGHT_ARROW = '\x1b[C'
const TAB = '\t'
const ADMINS_SECTION_KEY = '2'
const DOWN_KEY = 'j'
const REFRESH_KEY = 'r'
const QUIT_KEY = 'q'
const YES_KEY = 'y'
const NO_KEY = 'n'

let journalDir: string
let store: AdminStore

/** Every console a test opened, so none of them outlives it. */
const opened: RunningConsole[] = []

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-console-e2e-'))
  store = createAdminStore({ journalDir })
})

afterEach(async () => {
  for (const app of opened.splice(0)) await app.close()
  await rm(journalDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeIo extends UiCliIo {
  err(): string
}

function fakeIo(): FakeIo {
  const errChunks: string[] = []
  return {
    stdout: { write: () => undefined },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    err: () => errChunks.join(''),
  }
}

/** A service manager that reports both services up, as `dispatch.test.ts` does. */
function runningManager(): ServiceManager {
  const statusOf = (service: ServiceName): ServiceStatus => ({
    service,
    state: 'running',
    host: '127.0.0.1',
    port: service === 'ui' ? 8091 : 8090,
    pid: 42,
    logPath: `${journalDir}/run/${service}.log`,
  })

  return {
    start: async (service): Promise<StartResult> => ({
      kind: 'already-running',
      status: statusOf(service),
    }),
    stop: async (): Promise<StopResult> => ({ kind: 'not-running' }),
    status: async (service) => statusOf(service),
    logs: async () => ['a log line'],
  }
}

interface RunningConsole {
  readonly fake: FakeTerminal
  /** Resolves with the console's exit code; never rejects. */
  readonly exit: Promise<number>
  /** Every argv the console handed the dispatcher, in order. */
  argvCalls(): readonly (readonly string[])[]
  errText(): string
  /** Asks the console to leave and waits for it, however the test ended. */
  close(): Promise<void>
}

/**
 * Opens a console over the temp journal directory, wired to the real
 * dispatcher through a wrapper that records what it was asked to run — the
 * only way to assert that a secret never travelled in argv is to keep every
 * argv there was.
 */
function openConsole(): RunningConsole {
  const fake = createFakeTerminal({ columns: CONSOLE_COLUMNS, rows: CONSOLE_ROWS })
  const processEvents = new EventEmitter()
  const io = fakeIo()
  const calls: Array<readonly string[]> = []

  const install: InstallConfigLoad = {
    kind: 'ok',
    path: CONFIG_PATH,
    config: defaultInstallConfig(journalDir),
  }

  const recordingDispatch = async (
    argv: readonly string[],
    commandIo: CliIo,
    options?: DispatchOptions,
  ): Promise<number> => {
    calls.push([...argv])
    return dispatch(argv, commandIo, options)
  }

  const exit = runTui([], io, {
    entry: 'explicit',
    isTty: true,
    terminal: fake.terminal,
    style: plainStyle,
    processEvents,
    escapeCodeTimeoutMs: ESCAPE_TIMEOUT_MS,
    install,
    journalDir,
    env: {},
    dispatch: recordingDispatch,
    dispatchOptions: {
      admin: { journalDir },
      services: { manager: runningManager(), install },
    },
  })

  const running: RunningConsole = {
    fake,
    exit,
    argvCalls: () => calls.map((argv) => [...argv]),
    errText: () => io.err(),
    close: async () => {
      fake.type(INTERRUPT)
      if (await settledWithin(exit, CLOSE_TIMEOUT_MS)) return
      // A console wedged mid-effect still has to let go of the test runner.
      processEvents.emit('SIGTERM')
      await exit.catch(() => undefined)
    },
  }
  opened.push(running)
  return running
}

/** Whether a promise settled inside the deadline, without rejecting the wait. */
async function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref()
  })

  try {
    return await Promise.race([promise.then(() => true, () => true), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The current frame as lines, so a test can read the tab bar by its row. */
function screenLines(fake: FakeTerminal): readonly string[] {
  return fake.screen().split('\n')
}

/** The tab bar: the second row of the main screen, without its padding. */
function tabsLineOf(fake: FakeTerminal): string {
  return (screenLines(fake)[1] ?? '').trimEnd()
}

/** Signs in with `token` and waits for the header that says who is signed in. */
async function signIn(
  app: RunningConsole,
  token: string,
  name: string,
  role: string,
): Promise<void> {
  const { fake } = app
  await waitForScreen(fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')
  fake.type(`${token}${ENTER}`)
  await waitForScreen(
    fake,
    (screen) => screen.includes(`${name} (${role})`),
    `the header naming ${name}`,
  )
}

/** The `access-edit` records the console's commands left, in commit order. */
async function accessRecords(): Promise<Array<Record<string, unknown>>> {
  const records = await readJournalRecords(journalDir, ACCESS_EDIT_SESSION_ID)
  return records.map((record) => record.payload as Record<string, unknown>)
}

/** Everything on disk under the journal directory, as bytes a search can scan. */
async function storeBytes(): Promise<string> {
  const entries = await readdir(journalDir, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  const contents = await Promise.all(
    files.map((entry) => readFile(join(entry.parentPath, entry.name), 'latin1')),
  )

  return contents.join('\n')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('console end to end: sign in, add an admin, list, quit', () => {
  test('runs the whole path through the real dispatcher', async () => {
    const { token } = await store.createAdmin(OWNER_NAME, 'owner')
    const app = openConsole()
    const { fake } = app

    await signIn(app, token, OWNER_NAME, 'owner')
    // The header's service line comes from `status --json` through the same
    // dispatcher: the console is a client of the service manager, not a copy.
    await waitForScreen(fake, (screen) => screen.includes('ui ●'), 'the services header')

    fake.type(ADMINS_SECTION_KEY)
    await waitForScreen(
      fake,
      (screen) => screen.includes(`${ACTIVE_MARKER}list`),
      'the Admins section',
    )
    expect(tabsLineOf(fake)).toBe('1 Home  2 Admins')

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
    const onDisk = await storeBytes()
    // Guard the guard: a scan that read nothing would pass the next line for
    // the wrong reason, so first prove it found the record it is scanning.
    expect(onDisk).toContain(NEW_ADMIN_NAME)
    expect(onDisk).not.toContain(ADMIN_TOKEN_PREFIX)

    // ...and what it DID buy: the journal names the operator who ran the add.
    expect(await accessRecords()).toEqual([
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
    const app = openConsole()
    const { fake } = app

    await signIn(app, token, OWNER_NAME, 'owner')
    fake.type(ADMINS_SECTION_KEY)
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
    const app = openConsole()
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
  test('a viewer sees only Home, and the Admins key does nothing', async () => {
    const { token } = await store.createAdmin('watcher', 'viewer')
    const app = openConsole()
    const { fake } = app

    await signIn(app, token, 'watcher', 'viewer')
    await waitForScreen(
      fake,
      (screen) => screen.includes(`${ACTIVE_MARKER}status`),
      'the Home section',
    )
    expect(tabsLineOf(fake)).toBe('1 Home')

    const framesBefore = fake.frames().length
    const screenBefore = fake.screen()
    fake.type(ADMINS_SECTION_KEY)
    // The keystroke is answered — a frame is drawn — but it names no section
    // this role can see, so the frame is the same one.
    await waitForScreen(fake, () => fake.frames().length > framesBefore, 'the next frame')

    expect(fake.screen()).toBe(screenBefore)
    expect(tabsLineOf(fake)).toBe('1 Home')

    fake.type(INTERRUPT)

    expect(await app.exit).toBe(EXIT_OK)
    expect(fake.restored()).toBe(true)
  })
})

describe('console end to end: sign-in failures', () => {
  test('a token belonging to nobody is refused and the console stays open', async () => {
    const { token } = await store.createAdmin(OWNER_NAME, 'owner')
    const app = openConsole()
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

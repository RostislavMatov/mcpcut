import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMINS_FILE_NAME } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { dispatchOptionsFor, runTui, type TuiCommandOptions } from '../../src/cli/tui-cmd.js'
import { TUI_USAGE } from '../../src/cli/operator-usage.js'
import { TUI_NOT_A_TTY, TUI_NOT_WIRED, TUI_NO_ARGUMENTS } from '../../src/cli/tui-constants.js'
import type { UiCliIo } from '../../src/cli/ui-constants.js'
import { plainStyle } from '../../src/tui/ansi.js'
import { SECTIONS, visibleActions, visibleSections } from '../../src/tui/catalogue/index.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import { SIGNIN_TITLE, WIZARD_TITLE_EDIT, WIZARD_TITLE_FIRST_RUN } from '../../src/tui/constants.js'
import { FIRST_OWNER_TITLE, WELCOME_TITLE } from '../../src/tui/constants-live.js'
import type { InstallFacts } from '../../src/tui/model.js'
import type { FetchLike } from '../../src/tui/remote/client.js'
import { activeActionIndexIn, actionTitlesIn } from '../tui/support/console-harness-navigate.js'
import { createFakeTerminal, waitForScreen, type FakeTerminal } from '../tui/support/fake-terminal.js'

/**
 * The gates in front of the console (mcpcut phase 2, task 14).
 *
 * `runTui` is the whole of the decision "does a console open at all", and
 * every refusal it can print reaches a shell rather than a frame. So the
 * cases here are the ones where nothing is drawn — no terminal, arguments it
 * has no use for, an install config that is missing or unusable — plus the
 * one where something is: an interactive terminal, where the assertion is
 * that the first frame is the sign-in screen and that Ctrl-C gives the
 * terminal back.
 *
 * The environment is always `{}`: `loadInstallConfigSync` must never reach
 * the developer's own `~/.mcpcut/config.json`, and `MCP_ADMIN_TOKEN` must
 * never leak in from the shell running the suite.
 */

const CONFIG_PATH = '/home/op/.mcpcut/config.json'

const absentInstall: InstallConfigLoad = { kind: 'absent', path: CONFIG_PATH }

const okInstall: InstallConfigLoad = {
  kind: 'ok',
  path: CONFIG_PATH,
  config: defaultInstallConfig('/var/lib/mcpcut'),
}

const invalidInstall: InstallConfigLoad = {
  kind: 'invalid',
  path: CONFIG_PATH,
  problems: ['dataDir: dataDir must be an absolute path'],
}

interface FakeIo extends UiCliIo {
  out(): string
  err(): string
}

function fakeIo(): FakeIo {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A fetch double that answers `GET state` only — enough for the welcome screen's probe. */
function stateOnlyFetch(body: unknown = { api: 1, firstRun: false }): FetchLike {
  return (async (input: unknown) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/console/state') return jsonResponse(200, body)
    throw new Error(`unexpected call to ${url.pathname}`)
  }) as FetchLike
}

/** A dispatcher that answers every command with success and records nothing. */
const quietDispatch = async (): Promise<number> => 0

/** A dispatcher that prints what `setup --yes` prints, so the wizard can read an owner out of it. */
const transcriptDispatch = async (
  argv: readonly string[],
  dispatchIo: UiCliIo,
): Promise<number> => {
  if (argv[0] === 'setup') dispatchIo.stdout.write('admin: owner\nrole: owner\ntoken: mcpa_x\n')
  return 0
}

/** The seams a console opened in a test runs on: a fake terminal, no signals of its own. */
function consoleOptions(fake: FakeTerminal, install: InstallConfigLoad): TuiCommandOptions {
  return {
    dispatch: quietDispatch,
    env: {},
    install,
    isTty: true,
    terminal: fake.terminal,
    style: plainStyle,
    processEvents: new EventEmitter(),
    escapeCodeTimeoutMs: 10,
    platform: 'linux',
  }
}

describe('runTui: arguments', () => {
  test('--help prints the tui usage on stdout and exits 0', async () => {
    const io = fakeIo()

    const exitCode = await runTui(['--help'], io, { env: {} })

    expect(exitCode).toBe(0)
    expect(io.out()).toBe(TUI_USAGE)
    expect(io.err()).toBe('')
  })

  test('-h is the same as --help', async () => {
    const io = fakeIo()

    const exitCode = await runTui(['-h'], io, { env: {} })

    expect(exitCode).toBe(0)
    expect(io.out()).toBe(TUI_USAGE)
  })

  test('refuses any other argument with the usage, before it looks at the terminal', async () => {
    const io = fakeIo()

    const exitCode = await runTui(['x'], io, { env: {}, isTty: true })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(TUI_NO_ARGUMENTS)
    expect(io.err()).toContain(TUI_USAGE)
    expect(io.out()).toBe('')
  })
})

describe('runTui: the terminal gate', () => {
  test('refuses outside a TTY and touches nothing', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const exitCode = await runTui([], io, {
      env: {},
      isTty: false,
      terminal: fake.terminal,
      dispatch: quietDispatch,
      install: okInstall,
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toBe(TUI_NOT_A_TTY)
    expect(fake.frames()).toEqual([])
    expect(fake.rawModeCalls).toEqual([])
  })
})

describe('runTui: the install config', () => {
  test('a bare invocation without a config opens the welcome screen, not the wizard directly', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, {
      ...consoleOptions(fake, absentInstall),
      entry: 'bare',
      home: '/home/op',
      cwd: '/w',
    })
    await waitForScreen(
      fake,
      (screen) => screen.includes(WELCOME_TITLE) && screen.includes('Set up a service on this machine'),
      'the welcome screen',
    )
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(fake.restored()).toBe(true)
    expect(io.err()).toBe('')
  })

  test('choosing "set up" on the welcome screen opens the very wizard form the old bare entry did', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, {
      ...consoleOptions(fake, absentInstall),
      entry: 'bare',
      home: '/home/op',
      cwd: '/w',
    })
    await waitForScreen(fake, (screen) => screen.includes(WELCOME_TITLE), 'the welcome screen')
    fake.type('1')
    await waitForScreen(
      fake,
      (screen) => screen.includes(WIZARD_TITLE_FIRST_RUN) && screen.includes('Data dir'),
      'the wizard form',
    )
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(fake.restored()).toBe(true)
    expect(io.err()).toBe('')
  })

  test('choosing "connect" and a successful probe reopens with ["--remote", url]', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const reopened: string[][] = []
    const remembered: string[] = []

    const running = runTui([], io, {
      ...consoleOptions(fake, absentInstall),
      entry: 'bare',
      home: '/home/op',
      cwd: '/w',
      remoteFetch: stateOnlyFetch(),
      // A successful connect writes `~/.mcpcut/remote.json` (2026-09-20) —
      // faked here, like `dispatch`, so this test never touches a real path.
      rememberRemote: async (url) => void remembered.push(url),
      reopen: async (argv) => {
        reopened.push([...argv])
        return 0
      },
    })
    await waitForScreen(fake, (screen) => screen.includes(WELCOME_TITLE), 'the welcome screen')
    fake.type('2')
    await waitForScreen(fake, (screen) => screen.includes('Host:'), 'the connect form')
    fake.type('box.example')
    fake.type('\t')
    fake.type('8091')
    fake.type('\r')

    expect(await running).toBe(0)
    expect(reopened).toEqual([['--remote', 'https://box.example:8091']])
    expect(remembered).toEqual(['https://box.example:8091'])
  })

  test('an explicit tui without a config opens over the default data directory', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, {
      ...consoleOptions(fake, absentInstall),
      entry: 'explicit',
    })
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the sign-in screen')
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(fake.restored()).toBe(true)
    expect(io.err()).toBe('')
  })

  test('refuses an unusable config with the same problems every command prints', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const exitCode = await runTui([], io, {
      ...consoleOptions(fake, invalidInstall),
      entry: 'explicit',
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(CONFIG_PATH)
    expect(io.err()).toContain('dataDir: dataDir must be an absolute path')
    expect(fake.frames()).toEqual([])
  })
})

describe('runTui: the setup entry opens the wizard', () => {
  test('over a config, in edit mode, with that config in the fields', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, {
      ...consoleOptions(fake, okInstall),
      entry: 'setup',
      home: '/home/op',
      cwd: '/w',
    })
    await waitForScreen(
      fake,
      (screen) => screen.includes(WIZARD_TITLE_EDIT) && screen.includes('/var/lib/mcpcut'),
      'the wizard in edit mode',
    )
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(io.err()).toBe('')
  })

  test('an unusable config is refused by the same gate every command uses', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const exitCode = await runTui([], io, {
      ...consoleOptions(fake, invalidInstall),
      entry: 'setup',
      home: '/home/op',
      cwd: '/w',
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(CONFIG_PATH)
    expect(io.err()).toContain('--force')
    expect(fake.frames()).toEqual([])
  })

  test('the setup flags prefill the form', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = runTui([], io, {
      ...consoleOptions(fake, absentInstall),
      entry: 'setup',
      home: '/home/op',
      cwd: '/w',
      setupArgs: { yes: false, force: false, start: false, noAdmin: false, uiPort: 18091 },
    })
    await waitForScreen(fake, (screen) => screen.includes('[18091'), 'the prefilled UI port')
    fake.type('\x03')

    expect(await running).toBe(0)
  })

  test('the reopen seam is asked for the console once the wizard is done', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const reopened: string[][] = []

    const running = runTui([], io, {
      ...consoleOptions(fake, absentInstall),
      dispatch: transcriptDispatch,
      entry: 'bare',
      home: '/home/op',
      cwd: '/w',
      reopen: async (argv) => {
        reopened.push([...argv])
        return 0
      },
    })
    // A bare, absent-install entry opens the welcome screen first; "1" chooses
    // "set up a service", which swaps straight to the wizard form.
    await waitForScreen(fake, (screen) => screen.includes(WELCOME_TITLE), 'the welcome screen')
    fake.type('1')
    await waitForScreen(fake, (screen) => screen.includes('Data dir'), 'the wizard form')
    // Services by external: both starts are somebody else's business, so the
    // ladder is one rung and the final screen arrives without a live manager.
    fake.type('\x1b[Z')
    fake.type('\x1b[D')
    await waitForScreen(fake, (screen) => screen.includes('external'), 'the external supervisor')
    fake.type('\r')
    await waitForScreen(fake, (screen) => screen.includes('Saved it?'), 'the final screen')
    fake.type('y')

    expect(await running).toBe(0)
    expect(reopened).toEqual([['tui']])
  })
})

describe('runTui: wiring', () => {
  test('rejects when the dispatcher was not injected', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    await expect(
      runTui([], io, {
        env: {},
        isTty: true,
        terminal: fake.terminal,
        install: okInstall,
        style: plainStyle,
        processEvents: new EventEmitter(),
        escapeCodeTimeoutMs: 10,
      }),
    ).rejects.toThrow(TUI_NOT_WIRED)
    expect(fake.frames()).toEqual([])
  })
})

/**
 * The fourth way out of the console (mcpcut phase 5, Task 8).
 *
 * Services ▸ `setup` is the one action of the catalogue that is not
 * dispatched: it ends the console and hands the terminal to `mcpcut setup`.
 * These cases assert what only this module can answer — that the argv reaches
 * the seam the wizard's own restart uses, that it is asked for exactly once
 * and only after the console has resolved, and that an install somebody else
 * supervises never offers the two verbs it cannot honour.
 */

const OWNER_NAME = 'root'

/** A fragment of the Services intro; it says which section is on screen. */
const SERVICES_INTRO = 'ui and serve as the manager sees them'

/** The tail of the question `setup` asks before it gives the terminal away. */
const SETUP_QUESTION = 'Leave the console for the setup screen?'

/** The highest section a digit can name (`1`–`9` in `update-main.ts`). */
const LAST_DIGIT_INDEX = 8

const TAB = '\t'
const ENTER = '\r'
const DOWN_KEY = 'j'
const QUIT_KEY = 'q'

/** A dispatcher that answers the header's `status --json` and nothing else. */
const statusDispatch = async (
  argv: readonly string[],
  dispatchIo: UiCliIo,
): Promise<number> => {
  if (argv[0] === 'status') dispatchIo.stdout.write('[]\n')
  return 0
}

/** A console an owner has signed into, and the argv its reopen seam was asked for. */
interface SignedInConsole {
  readonly fake: FakeTerminal
  readonly running: Promise<number>
  readonly reopened: string[][]
}

/** Opens a console over `journalDir` and signs a fresh owner in. */
async function ownerConsole(
  journalDir: string,
  install: InstallConfigLoad,
): Promise<SignedInConsole> {
  const { token } = await createAdminStore({ journalDir }).createAdmin(OWNER_NAME, 'owner')
  const fake = createFakeTerminal()
  const reopened: string[][] = []

  const running = runTui([], fakeIo(), {
    ...consoleOptions(fake, install),
    dispatch: statusDispatch,
    entry: 'explicit',
    journalDir,
    reopen: async (argv) => {
      reopened.push([...argv])
      return 0
    },
  })

  await waitForScreen(fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')
  fake.type(`${token}${ENTER}`)
  await waitForScreen(
    fake,
    (screen) => screen.includes(`${OWNER_NAME} (owner)`),
    'the header naming the owner',
  )

  return { fake, running, reopened }
}

/** The Services section as this install offers it to an owner. */
function servicesActionTitles(facts: InstallFacts): readonly string[] {
  const sections = visibleSections('owner', SECTIONS, facts)
  const section = sections.find((each) => each.id === 'services')
  if (section === undefined) throw new Error('an owner has no Services section')

  return visibleActions(section, 'owner').map((action) => action.title)
}

/** Opens Services the way an operator does: a digit for the ninth tab, then Tab. */
async function goToServices(fake: FakeTerminal, facts: InstallFacts): Promise<void> {
  const index = visibleSections('owner', SECTIONS, facts).findIndex(
    (section) => section.id === 'services',
  )
  fake.type(String(LAST_DIGIT_INDEX + 1))
  for (let step = LAST_DIGIT_INDEX; step < index; step += 1) fake.type(TAB)

  await waitForScreen(fake, (screen) => screen.includes(SERVICES_INTRO), 'the Services section')
}

/** Moves onto `setup` and opens it, which is the confirmation and not a run. */
async function openSetup(fake: FakeTerminal, facts: InstallFacts): Promise<void> {
  const target = servicesActionTitles(facts).indexOf('setup')
  for (let step = 0; step < target; step += 1) fake.type(DOWN_KEY)
  await waitForScreen(
    fake,
    (screen) => activeActionIndexIn(screen) === target,
    'the setup action to be selected',
  )
  fake.type(ENTER)
}

describe('runTui: Services leaves the console', () => {
  let journalDir: string

  beforeEach(async () => {
    journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-tui-cmd-'))
  })

  afterEach(async () => {
    await rm(journalDir, { recursive: true, force: true })
  })

  test('Services ▸ setup leaves the console and asks the reopen seam for setup', async () => {
    const install: InstallConfigLoad = {
      kind: 'ok',
      path: CONFIG_PATH,
      config: defaultInstallConfig(journalDir),
    }
    const { fake, running, reopened } = await ownerConsole(journalDir, install)

    await goToServices(fake, { supervisor: 'mcpcut' })
    await openSetup(fake, { supervisor: 'mcpcut' })
    await waitForScreen(fake, (screen) => screen.includes(SETUP_QUESTION), 'the setup question')
    fake.type('y')

    expect(await running).toBe(0)
    expect(reopened).toEqual([['setup']])
    expect(fake.restored()).toBe(true)
  })

  test('a console whose install is supervised externally never offers start or stop', async () => {
    const install: InstallConfigLoad = {
      kind: 'ok',
      path: CONFIG_PATH,
      config: { ...defaultInstallConfig(journalDir), supervisor: 'external' },
    }
    const { fake, running, reopened } = await ownerConsole(journalDir, install)

    await goToServices(fake, { supervisor: 'external' })
    const titles = actionTitlesIn(fake.screen())
    fake.type('\x03')

    expect(titles).toEqual(['status', 'logs', 'setup'])
    expect(await running).toBe(0)
    expect(reopened).toEqual([])
  })

  test('q without a reopen request calls nobody', async () => {
    const install: InstallConfigLoad = {
      kind: 'ok',
      path: CONFIG_PATH,
      config: defaultInstallConfig(journalDir),
    }
    const { fake, running, reopened } = await ownerConsole(journalDir, install)

    fake.type(QUIT_KEY)

    expect(await running).toBe(0)
    expect(reopened).toEqual([])
  })
})

describe('dispatchOptionsFor: one store for the session check and the admin commands', () => {
  test('hands the console journalDir to the admin seam', () => {
    expect(dispatchOptionsFor({ journalDir: '/x', dispatchOptions: {} })).toEqual({
      admin: { journalDir: '/x' },
    })
  })

  test('leaves an admin seam that already points somewhere alone', () => {
    const dispatchOptions = { admin: { journalDir: '/y' } }

    expect(dispatchOptionsFor({ journalDir: '/x', dispatchOptions })).toBe(dispatchOptions)
  })

  test('changes nothing when no journalDir was given', () => {
    const dispatchOptions = { journalDir: '/z' }

    expect(dispatchOptionsFor({ dispatchOptions })).toBe(dispatchOptions)
  })
})

/**
 * Two host facts the console reads on its way in (mcpcut phase 6).
 *
 * The style (F2): with no `style` seam the console asks the ENVIRONMENT, and
 * `NO_COLOR` or a dumb `TERM` means no attribute reaches the terminal at all
 * — the assertion walks every frame drawn, since the sign-in screen is the
 * one place a bold title would slip through. The seam still wins when a test
 * passes one, which every other case in this file relies on.
 *
 * The setup code file (F6b): while it exists the sign-in screen names it,
 * read once from the SAME directory the console's stores use. The dispatcher
 * here is the quiet one — nothing signs in, so the file is never consumed and
 * the question is only whether the first frame knew about it.
 */

/** The attributes `ansiStyle` emits; a plain frame carries none of them. */
const SGR_BOLD = '\x1b[1m'
const SGR_INVERSE = '\x1b[7m'
const SGR_DIM = '\x1b[2m'

/** A wide terminal, so a temp-dir path fits on the sign-in line uncut. */
const WIDE_COLUMNS = 200

/** The seams of `consoleOptions` without the style, so the environment decides it. */
function unstyledOptions(fake: FakeTerminal, journalDir: string): TuiCommandOptions {
  const { style: _style, ...rest } = consoleOptions(fake, okInstall)
  return { ...rest, entry: 'explicit', journalDir }
}

describe('runTui: the style comes from the environment', () => {
  let journalDir: string

  beforeEach(async () => {
    journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-tui-cmd-style-'))
    // An admin, so the console opens on the sign-in screen these frames are about.
    await createAdminStore({ journalDir }).createAdmin('root', 'owner')
  })

  afterEach(async () => {
    await rm(journalDir, { recursive: true, force: true })
  })

  /** Every frame the console drew up to Ctrl-C, under `env` and no style seam. */
  async function framesUnder(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
    const fake = createFakeTerminal()
    const running = runTui([], fakeIo(), { ...unstyledOptions(fake, journalDir), env })
    await waitForScreen(fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')
    fake.type('\x03')
    expect(await running).toBe(0)

    return fake.frames()
  }

  test.each([{ NO_COLOR: '1' }, { TERM: 'dumb' }])(
    'under %o no frame carries an attribute',
    async (env) => {
      const frames = await framesUnder(env)

      expect(frames.length).toBeGreaterThan(0)
      for (const frame of frames) {
        expect(frame).not.toContain(SGR_BOLD)
        expect(frame).not.toContain(SGR_INVERSE)
        expect(frame).not.toContain(SGR_DIM)
      }
    },
  )

  test('under an empty environment the title of the first frame is bold', async () => {
    const frames = await framesUnder({})

    expect(frames.some((frame) => frame.includes(SGR_BOLD))).toBe(true)
  })
})

describe('runTui: which screen the console opens on', () => {
  let journalDir: string

  beforeEach(async () => {
    journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-tui-cmd-first-screen-'))
  })

  afterEach(async () => {
    await rm(journalDir, { recursive: true, force: true })
  })

  /** The first settled frame of a console over `journalDir`, then Ctrl-C. */
  async function firstFrame(): Promise<string> {
    const fake = createFakeTerminal({ columns: WIDE_COLUMNS })
    const running = runTui([], fakeIo(), {
      ...consoleOptions(fake, okInstall),
      entry: 'explicit',
      journalDir,
    })
    await waitForScreen(
      fake,
      (screen) => screen.includes(SIGNIN_TITLE) || screen.includes(FIRST_OWNER_TITLE),
      'the opening screen',
    )
    const frame = fake.screen()
    fake.type('\x03')
    expect(await running).toBe(0)

    return frame
  }

  test('no admin in the store: the first-owner form, not a sign-in nobody holds a token for', async () => {
    const frame = await firstFrame()

    expect(frame).toContain(FIRST_OWNER_TITLE)
    expect(frame).not.toContain(SIGNIN_TITLE)
  })

  test('an admin in the store: the sign-in screen', async () => {
    await createAdminStore({ journalDir }).createAdmin('root', 'owner')

    const frame = await firstFrame()

    expect(frame).toContain(SIGNIN_TITLE)
    expect(frame).not.toContain(FIRST_OWNER_TITLE)
  })

  test('a store that cannot be read: the sign-in screen — no owner is offered beside unreadable records', async () => {
    await writeFile(join(journalDir, ADMINS_FILE_NAME), '{ not json', 'utf8')

    const frame = await firstFrame()

    expect(frame).toContain(SIGNIN_TITLE)
    expect(frame).not.toContain(FIRST_OWNER_TITLE)
  })
})

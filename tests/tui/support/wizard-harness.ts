import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatch } from '../../../src/cli.js'
import type { CliIo, DispatchOptions } from '../../../src/cli/dispatch-types.js'
import { runServiceCommand } from '../../../src/cli/service-cmd.js'
import { runTui } from '../../../src/cli/tui-cmd.js'
import type { UiCliIo } from '../../../src/cli/ui-constants.js'
import {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  CONFIG_PATH_ENV_VAR,
} from '../../../src/setup/constants.js'
import { loadInstallConfigSync } from '../../../src/setup/load.js'
import { plainStyle } from '../../../src/tui/ansi.js'
import { EXIT_OK, WIZARD_FORM_FOOTER } from '../../../src/tui/constants.js'
import { createFakeTerminal, waitForScreen, type FakeTerminal } from './fake-terminal.js'

/**
 * The stand the first-run wizard is driven on end to end (mcpcut phase 3,
 * Task 15).
 *
 * It lives beside `fake-terminal.ts` rather than in the test file because the
 * scenarios are the interesting part and this is the plumbing under them: two
 * temp directories, two free ports, an environment carrying nothing but the
 * config path, and a console opened over the REAL dispatcher with both
 * process-spawning seams pointed at `fake-service.mjs`.
 *
 * One thing here is a decision rather than plumbing. `reopen` stays a seam:
 * the real one spawns a child on the inherited terminal, which in a test
 * runner is the runner's own stdin.
 */

export const FAKE_SERVICE_PATH = fileURLToPath(
  new URL('../../fixtures/fake-service.mjs', import.meta.url),
)

/** Wide and tall enough for the ladder, its transcript and the whole form. */
const WIZARD_COLUMNS = 100
const WIZARD_ROWS = 34

/** Short enough to keep a lone `Esc` quick; the console ships with 100. */
const ESCAPE_TIMEOUT_MS = 10

/** Long enough for a node boot on a loaded box, short enough to fail a test fast. */
const READY_TIMEOUT_MS = 5_000
const KILL_ESCALATION_MS = 500

/**
 * How long a scenario waits for a frame. Far longer than the console's own
 * default: the wizard waits on WHOLE commands, and a refused `setup` spends a
 * probe timeout on the port it could not bind before it says so.
 */
export const DEPLOY_WAIT_TIMEOUT_MS = 10_000

/** The keys the scenarios press, named so their steps read as steps. */
export const ENTER = '\r'
export const TAB = '\t'
export const ESCAPE = '\x1b'
export const LEFT_ARROW = '\x1b[D'
export const YES_KEY = 'y'
export const NO_KEY = 'n'
const INTERRUPT = '\x03'

/** How long a stand waits for a console it asked to leave. */
const CLOSE_TIMEOUT_MS = 5_000
/** `readline` decodes DEL as `backspace`; longer than any prefilled value. */
const ERASE = '\x7f'.repeat(256)

export interface FakeIo extends UiCliIo {
  err(): string
}

export function fakeIo(): FakeIo {
  const errChunks: string[] = []
  return {
    stdout: { write: () => undefined },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    err: () => errChunks.join(''),
  }
}

/**
 * A port nothing holds: bind an ephemeral one, learn its number, give it back.
 *
 * One retry, because the answer is a guess by construction — the port is free
 * when it is handed over and anything on the box may take it in between.
 */
export async function freePort(): Promise<number> {
  try {
    return await bindEphemeralPort()
  } catch {
    return await bindEphemeralPort()
  }
}

function bindEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

/**
 * Holds `port` until the returned dispose is called, so a bind check has
 * something to trip over. Every accepted socket is destroyed on the way out:
 * `net.Server#close` waits for open connections, and a probe that opened one
 * and never got an answer would otherwise hang the suite.
 *
 * Both binds here reject on `'error'` rather than waiting for a callback that
 * a failed `listen` never makes: an `EADDRINUSE` used to leave the promise
 * pending, so a stand that could not take its port hung to the scenario's
 * whole timeout instead of saying which port was taken.
 */
export async function holdPort(port: number): Promise<() => Promise<void>> {
  const sockets: Socket[] = []
  const server = createNetServer((socket) => sockets.push(socket))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })

  return async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** One test's install: where it lives, what it binds, and the environment it sees. */
export interface WizardStand {
  readonly home: string
  readonly dataDir: string
  /** Empty but for the config path: no `MCP_ADMIN_TOKEN`, no `MCPCUT_DATA_DIR`. */
  readonly env: NodeJS.ProcessEnv
  readonly uiPort: number
  readonly servePort: number
}

export async function createWizardStand(): Promise<WizardStand> {
  const home = await mkdtemp(join(tmpdir(), 'mcpcut-wizard-home-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'mcpcut-wizard-data-'))

  return {
    home,
    dataDir,
    env: { [CONFIG_PATH_ENV_VAR]: configPathOf(home) },
    uiPort: await freePort(),
    servePort: await freePort(),
  }
}

export function configPathOf(home: string): string {
  return join(home, CONFIG_DIR_NAME, CONFIG_FILE_NAME)
}

/**
 * Closes every console the test opened, stops whatever it left running, and
 * removes both temp directories.
 *
 * The consoles go first and on purpose: a scenario that failed mid-deploy has
 * a `start` still in flight, and a `stop` racing it would look for a pid file
 * the daemon has not written yet — the one way a fake service outlives its
 * test.
 */
export async function disposeWizardStand(stand: WizardStand): Promise<void> {
  for (const wizard of opened.splice(0)) await wizard.close()
  await runServiceCommand('stop', [], fakeIo(), {
    env: stand.env,
    managerDeps: { cliPath: FAKE_SERVICE_PATH, killEscalationMs: KILL_ESCALATION_MS },
  }).catch(() => undefined)
  await rm(stand.home, { recursive: true, force: true })
  await rm(stand.dataDir, { recursive: true, force: true })
}

export interface RunningWizard {
  readonly fake: FakeTerminal
  readonly exit: Promise<number>
  /** Every argv the wizard handed the dispatcher, in order. */
  argvCalls(): readonly (readonly string[])[]
  /** Every argv the wizard asked the process to reopen itself with. */
  reopened(): readonly (readonly string[])[]
  /** Asks the console to leave and waits for it, however the test ended. */
  close(): Promise<void>
}

/** Every console a test opened, so none of them outlives it. */
const opened: RunningWizard[] = []

/**
 * Opens the wizard the way a bare `mcpcut` on a host with no install config
 * does, over a REAL dispatcher wrapped in a recorder — the only way to assert
 * that the token never travelled in argv is to keep every argv there was.
 *
 * `managerEnv` is the environment the STARTED daemons get; a test that needs a
 * start to fail sets `FAKE_EXIT_CODE` there.
 */
export function openWizard(stand: WizardStand, managerEnv?: NodeJS.ProcessEnv): RunningWizard {
  const fake = createFakeTerminal({ columns: WIZARD_COLUMNS, rows: WIZARD_ROWS })
  const calls: Array<readonly string[]> = []
  const reopens: Array<readonly string[]> = []

  const recordingDispatch = async (
    argv: readonly string[],
    commandIo: CliIo,
    options?: DispatchOptions,
  ): Promise<number> => {
    calls.push([...argv])
    return dispatch(argv, commandIo, options)
  }

  const exit = runTui([], fakeIo(), {
    entry: 'bare',
    isTty: true,
    terminal: fake.terminal,
    style: plainStyle,
    processEvents: new EventEmitter(),
    escapeCodeTimeoutMs: ESCAPE_TIMEOUT_MS,
    install: loadInstallConfigSync({ env: stand.env }),
    env: stand.env,
    home: stand.home,
    cwd: stand.home,
    dispatch: recordingDispatch,
    reopen: async (argv) => {
      reopens.push([...argv])
      return EXIT_OK
    },
    dispatchOptions: dispatchOptionsOf(stand, managerEnv),
  })

  const running: RunningWizard = {
    fake,
    exit,
    argvCalls: () => calls.map((argv) => [...argv]),
    reopened: () => reopens.map((argv) => [...argv]),
    close: async () => {
      fake.type(INTERRUPT)
      await Promise.race([exit.catch(() => undefined), afterDelay(CLOSE_TIMEOUT_MS)])
    },
  }
  opened.push(running)

  return running
}

/** Resolves after `ms`, without holding the process open on its own. */
function afterDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

/** Both seams the wizard dispatches through, pointed at the fake service. */
function dispatchOptionsOf(
  stand: WizardStand,
  managerEnv: NodeJS.ProcessEnv | undefined,
): DispatchOptions {
  return {
    setup: {
      env: stand.env,
      home: stand.home,
      managerDeps: { cliPath: FAKE_SERVICE_PATH, readyTimeoutMs: READY_TIMEOUT_MS },
    },
    services: {
      env: stand.env,
      managerDeps: {
        cliPath: FAKE_SERVICE_PATH,
        readyTimeoutMs: READY_TIMEOUT_MS,
        killEscalationMs: KILL_ESCALATION_MS,
        ...(managerEnv !== undefined ? { env: managerEnv } : {}),
      },
    },
  }
}

/** The answers one run gives; everything not named keeps its prefilled value. */
export interface FormAnswers {
  readonly uiHost?: string
  readonly external?: boolean
}

/**
 * Types the whole form and submits it: the temp data directory, both free
 * ports, and — where a test asks for one — a bind the network can reach or an
 * external supervisor. Every prefilled value is erased first, since a text
 * field appends what is typed.
 */
/** `waitForScreen` with the deadline a wizard scenario needs. */
export function waitForFrame(
  fake: FakeTerminal,
  predicate: (screen: string) => boolean,
  what: string,
): Promise<void> {
  return waitForScreen(fake, predicate, what, DEPLOY_WAIT_TIMEOUT_MS)
}

export async function answerForm(
  stand: WizardStand,
  fake: FakeTerminal,
  answers: FormAnswers = {},
): Promise<void> {
  await waitForFrame(fake, (screen) => screen.includes(WIZARD_FORM_FOOTER), 'the wizard form')

  fake.type(`${ERASE}${stand.dataDir}${TAB}`)
  // Field 2 is `UI host`: retyped only by the test about the exposure question.
  fake.type(answers.uiHost === undefined ? '' : `${ERASE}${answers.uiHost}`)
  fake.type(`${TAB}${ERASE}${stand.uiPort}`)
  fake.type(`${TAB}${TAB}${TAB}${ERASE}${stand.servePort}`)
  fake.type(`${TAB}${TAB}`)
  if (answers.external === true) fake.type(LEFT_ARROW)
  fake.type(ENTER)
}

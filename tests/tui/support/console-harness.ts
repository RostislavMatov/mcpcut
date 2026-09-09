import { EventEmitter } from 'node:events'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dispatch } from '../../../src/cli.js'
import type { CliIo, DispatchOptions } from '../../../src/cli/dispatch-types.js'
import { runTui } from '../../../src/cli/tui-cmd.js'
import type { UiCliIo } from '../../../src/cli/ui-constants.js'
import { ACCESS_EDIT_SESSION_ID } from '../../../src/journal/access-edit-record.js'
import type { ProbeResult } from '../../../src/probe/engine.js'
import type { ServiceName } from '../../../src/services/constants.js'
import type {
  ServiceManager,
  ServiceStatus,
  StartResult,
  StopResult,
} from '../../../src/services/manager.js'
import { defaultInstallConfig } from '../../../src/setup/defaults.js'
import type { InstallConfigLoad } from '../../../src/setup/load.js'
import type { InstallConfig } from '../../../src/setup/schema.js'
import { plainStyle } from '../../../src/tui/ansi.js'
import { readJournalRecords } from '../../support/journal-rows.js'
import {
  CONSOLE_COLUMNS,
  CONSOLE_ROWS,
  INTERRUPT,
  type RunningConsole,
} from './console-harness-navigate.js'
import { createFakeTerminal } from './fake-terminal.js'

/**
 * The console harness the end-to-end suites drive (mcpcut phase 4, Task 11).
 *
 * Derived from `console-e2e.test.ts`, which proved one path through the
 * console with a real `dispatch` behind it, and adopted BY it in turn (phase-4
 * test-hygiene tail): there is one console stand in `tests/tui`, not two. The
 * catalogue's nine new sections need the same treatment several times over — a
 * vault secret, an onboarding from empty registry to granted agent, an export
 * to a file, the audit commands, two roles — so the wiring lives here and each
 * suite reads as the steps an operator would take.
 *
 * This file is the STAND: a console wired to one temp directory, and the seams
 * it is wired through. The keys a suite presses and the frames it waits for
 * live in `console-harness-navigate.ts`, which this one re-exports whole, so a
 * suite imports this module alone.
 *
 * The thing it does that a test must not do by hand: `openConsole` isolates
 * EVERY dispatch seam on the temp journal directory. A seam left out would
 * reach the developer's own installation: `server add` probes, `policy set`
 * writes a file, `prune` deletes journal rows. The probe engine is stubbed for
 * the same reason — the real one spawns the registered command, and a
 * `server add echo --command node` would sit waiting on a `node` REPL until
 * the suite timed out.
 */

export * from './console-harness-navigate.js'

/** Short enough to keep a lone `Esc` quick; the console ships with 100. */
const ESCAPE_TIMEOUT_MS = 10

/** How long a test waits for a console it asked to close. */
const CLOSE_TIMEOUT_MS = 2_000

/** Where the install config would live; nothing reads the file itself here. */
export const CONFIG_PATH = '/home/op/.mcpcut/config.json'

/** A probe that says the server answered, as `tests/cli/server-cmd.test.ts` does. */
export const ALIVE_PROBE: ProbeResult = {
  status: 'alive',
  initializeLatencyMs: 34,
  probedVia: 'initialize',
}

interface FakeIo extends UiCliIo {
  err(): string
}

/** Captures stderr; stdout of the console itself is the terminal, not this. */
export function fakeIo(): FakeIo {
  const errChunks: string[] = []
  return {
    stdout: { write: () => undefined },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    err: () => errChunks.join(''),
  }
}

/** A service manager that reports both services up, as `dispatch.test.ts` does. */
export function runningManager(journalDir: string): ServiceManager {
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

/**
 * Every seam of the dispatcher, pointed at one temp directory.
 *
 * `policy` gets `cwd` as well as `journalDir` so that both the file `policy
 * set` writes and the file `policy show` resolves are inside the temp
 * directory: the project-level candidate is `<cwd>/.mcp-journal/policy.json`
 * and the home-level one is `<journalDir>/policy.json` (ADR-0005).
 */
export function consoleDispatchOptions(
  journalDir: string,
  install: InstallConfigLoad,
): DispatchOptions {
  return {
    journalDir,
    admin: { journalDir },
    vault: { journalDir },
    agent: { journalDir },
    group: { journalDir },
    server: { journalDir, probes: { runProbe: async () => ALIVE_PROBE } },
    policy: { journalDir, cwd: journalDir },
    quarantine: { storePath: join(journalDir, 'tool-inventory.json') },
    approvals: { baseDir: join(journalDir, 'approvals'), journalDir },
    export: { journalDir },
    verify: { journalDir },
    keygen: { journalDir },
    backup: { journalDir },
    prune: { journalDir },
    migrate: { journalDir },
    services: { manager: runningManager(journalDir), install },
  }
}

/** Every console a suite opened, so none of them outlives its test. */
const opened: RunningConsole[] = []

/** Closes every console opened since the last call; for an `afterEach`. */
export async function closeConsoles(): Promise<void> {
  for (const app of opened.splice(0)) await app.close()
}

/**
 * What a suite may put in place of the stand's own defaults.
 *
 * Two overrides rather than one, because they answer to different owners.
 * `install` is what the CONSOLE is told about this installation — the ports
 * and the supervisor it renders and gates on — while `dispatchOptions`
 * replaces seams of the DISPATCHER underneath it. A suite that runs real
 * daemons needs both to agree, and passing the same config twice is how they
 * do (`console-services-e2e.test.ts`).
 *
 * The spread is one level deep: an override REPLACES a seam whole rather than
 * merging into it. Anything else would let a half-overridden `services` keep
 * the fake manager's `stop` beside a real `start`.
 */
export interface ConsoleOverrides {
  readonly install?: InstallConfig
  readonly dispatchOptions?: Partial<DispatchOptions>
}

/**
 * Opens a console over `journalDir`, wired to the real dispatcher through a
 * wrapper that records what it was asked to run — the only way to assert that
 * a secret never travelled in argv is to keep every argv there was.
 */
export function openConsole(
  journalDir: string,
  overrides: ConsoleOverrides = {},
): RunningConsole {
  const fake = createFakeTerminal({ columns: CONSOLE_COLUMNS, rows: CONSOLE_ROWS })
  const processEvents = new EventEmitter()
  const io = fakeIo()
  const calls: Array<readonly string[]> = []

  const install: InstallConfigLoad = {
    kind: 'ok',
    path: CONFIG_PATH,
    config: overrides.install ?? defaultInstallConfig(journalDir),
  }

  const recordingDispatch = async (
    argv: readonly string[],
    commandIo: CliIo,
    options?: DispatchOptions,
  ): Promise<number> => {
    calls.push([...argv])
    return dispatch(argv, commandIo, options)
  }

  const dispatchOptions: DispatchOptions = {
    ...consoleDispatchOptions(journalDir, install),
    ...overrides.dispatchOptions,
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
    dispatchOptions,
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
export async function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
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

/** The `access-edit` records the console's commands left, in commit order. */
export async function accessRecords(journalDir: string): Promise<Array<Record<string, unknown>>> {
  const records = await readJournalRecords(journalDir, ACCESS_EDIT_SESSION_ID)
  return records.map((record) => record.payload as Record<string, unknown>)
}

/** Everything on disk under the journal directory, as bytes a search can scan. */
export async function storeBytes(journalDir: string): Promise<string> {
  const entries = await readdir(journalDir, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  const contents = await Promise.all(
    files.map((entry) => readFile(join(entry.parentPath, entry.name), 'latin1')),
  )

  return contents.join('\n')
}

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { createServiceManager, type ServiceManager } from '../../src/services/manager.js'
import { probeService } from '../../src/services/probe.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfig } from '../../src/setup/schema.js'
import { EXIT_OK } from '../../src/tui/constants.js'
import {
  closeConsoles,
  CONFIG_PATH,
  goToSection,
  NO_KEY,
  openConsole,
  REFRESH_KEY,
  RIGHT_ARROW,
  runAction,
  signIn,
  submitAction,
  waitForFinishedRun,
  waitForText,
  YES_KEY,
  type RunningConsole,
} from './support/console-harness.js'
import { FAKE_SERVICE_PATH, freePort } from './support/wizard-harness.js'
import { waitForScreen } from './support/fake-terminal.js'

/**
 * The Services section end to end (mcpcut phase 5, Task 9), and the success
 * signal the PRD names for this phase: an operator starts and stops the two
 * daemons from the console, on ports nothing else holds, and `q` leaves them
 * running.
 *
 * Real processes throughout. Everywhere else in `tests/tui` the manager is
 * `runningManager` — a fake that answers `running` and starts nothing —
 * because those suites are about frames. This one is about the opposite: that
 * the keystroke reaches a `spawn`, that the child outlives the console that
 * asked for it, and that a `stop` from the console reaches the pid. A manager
 * that only said so would prove none of it, so the daemons here are
 * `fake-service.mjs`, the same stand-in `tests/services/manager.test.ts` and
 * the wizard's own end-to-end suite use.
 *
 * Two ports are taken from the ephemeral range per test (`freePort`), and the
 * SAME install config is handed to the console and to the manager under it:
 * the console renders the ports it was told about, and a config that
 * disagreed with the manager's would draw a green header over a daemon
 * listening somewhere else.
 */

/** Long enough for two node boots on a loaded box; the wizard suite's number. */
const DEPLOY_WAIT_TIMEOUT_MS = 10_000

/** Whole-test budgets: a start, a probe and a stop are all real waiting. */
const START_TEST_TIMEOUT_MS = 20_000
const SERVICE_TEST_TIMEOUT_MS = 15_000

/** Short escalation so a stop that has to force one does not wait out production's. */
const KILL_ESCALATION_MS = 500

/** Long enough for a node boot, short enough to fail a test fast. */
const READY_TIMEOUT_MS = 5_000

/** The owner every test signs in as. */
const OWNER_NAME = 'root'

/** The loopback both daemons bind, as `defaultInstallConfig` already has it. */
const HOST = '127.0.0.1'

/** How many `--lines` the log tail is asked for: enough to hold the boot line. */
const LOG_TAIL_LINES = '5'

let journalDir: string
let store: AdminStore
let install: InstallConfig
let manager: ServiceManager

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-services-e2e-'))
  store = createAdminStore({ journalDir })
  install = {
    ...defaultInstallConfig(journalDir),
    ui: { host: HOST, port: await freePort() },
    serve: { host: HOST, port: await freePort() },
  }
  manager = createServiceManager({
    dataDir: journalDir,
    config: install,
    cliPath: FAKE_SERVICE_PATH,
    readyTimeoutMs: READY_TIMEOUT_MS,
    killEscalationMs: KILL_ESCALATION_MS,
  })
})

/** The order the daemons are taken down in on the way out, as the CLI stops them. */
const CLEANUP_STOP_ORDER = ['serve', 'ui'] as const

/**
 * Consoles first, then the daemons, then the directory.
 *
 * The order is the lesson `wizard-harness.ts` records: a test that failed
 * mid-start has a `start` still in flight, and a `stop` racing it would look
 * for a pid file the daemon has not written yet — the one way a fake service
 * outlives its test.
 */
afterEach(async () => {
  try {
    // Closing the consoles is INSIDE the try for the same reason each stop is
    // isolated: a close that rejects must not skip the daemon stops and the
    // rm below, which is the one way a fake service outlives its suite.
    await closeConsoles()
    // The order is kept (serve, then ui) and each failure is isolated: a stop
    // that rejects must not leave the OTHER daemon running past the test that
    // started it.
    for (const service of CLEANUP_STOP_ORDER) {
      await manager.stop(service).catch(() => undefined)
    }
  } finally {
    await rm(journalDir, { recursive: true, force: true })
  }
})

/** Signs a fresh owner into a console wired to the REAL manager above. */
async function ownerConsole(): Promise<RunningConsole> {
  const { token } = await store.createAdmin(OWNER_NAME, 'owner')
  const app = openConsole(journalDir, {
    install,
    dispatchOptions: {
      services: { manager, install: { kind: 'ok', path: CONFIG_PATH, config: install } },
    },
  })
  await signIn(app, token, OWNER_NAME, 'owner')
  return app
}

/** Whether both daemons answer on the ports this install config names. */
async function bothAnswer(): Promise<readonly [boolean, boolean]> {
  return [
    await probeService('ui', install.ui.host, install.ui.port),
    await probeService('serve', install.serve.host, install.serve.port),
  ]
}

describe('console end to end: starting the services', () => {
  test(
    'starts both daemons, shows them running, and leaves them up on quit',
    async () => {
      // Arrange: an owner in the Services section of a console over two free ports.
      const app = await ownerConsole()
      const { fake } = app
      await goToSection(app, 'services', 'owner')

      // Act: `start` with the choice left on `both`.
      await runAction(app, {
        title: 'start',
        values: [],
        command: 'start',
        timeoutMs: DEPLOY_WAIT_TIMEOUT_MS,
      })

      // Assert: two spawned pids on the pane, and two ports that answer.
      expect(fake.screen()).toContain('ui:')
      expect(fake.screen()).toContain('serve:')
      expect(fake.screen().split('started pid').length - 1).toBe(2)
      expect(await bothAnswer()).toEqual([true, true])

      // ...and the console agrees when it asks again: `r` re-runs `status`,
      // which is where the header's own glyphs come from too.
      fake.type(REFRESH_KEY)
      await waitForFinishedRun(app, 'status', EXIT_OK, DEPLOY_WAIT_TIMEOUT_MS)
      expect(fake.screen().split('running').length - 1).toBeGreaterThanOrEqual(2)
      await waitForScreen(fake, (screen) => screen.includes('ui ●'), 'the services header')

      // The daemons are not the console's children in any sense that matters:
      // quitting must not take them with it (PRD phase 5 success signal).
      fake.type('q')
      expect(await app.exit).toBe(EXIT_OK)
      expect(await bothAnswer()).toEqual([true, true])
    },
    START_TEST_TIMEOUT_MS,
  )
})

describe('console end to end: stopping a service', () => {
  test(
    'asks before stopping, keeps the daemon on no, and really stops it on yes',
    async () => {
      // Arrange: one daemon up, started outside the console.
      await manager.start('ui')
      expect(await probeService('ui', install.ui.host, install.ui.port)).toBe(true)

      const app = await ownerConsole()
      const { fake } = app
      await goToSection(app, 'services', 'owner')

      // Act: pick `ui` out of `both · serve · ui` and submit — which asks first.
      await submitAction(app, {
        title: 'stop',
        values: [`${RIGHT_ARROW}${RIGHT_ARROW}`],
        command: 'stop ui',
      })
      await waitForText(app, 'Stop ui?', 'the stop confirmation')

      // Assert: `n` is an answer, not a delay — the daemon is untouched.
      fake.type(NO_KEY)
      await waitForScreen(fake, (screen) => !screen.includes('Stop ui?'), 'the question dismissed')
      expect(await probeService('ui', install.ui.host, install.ui.port)).toBe(true)
      expect(app.argvCalls()).not.toContainEqual(['stop', 'ui'])

      // Act again, and say yes this time.
      await submitAction(app, {
        title: 'stop',
        values: [`${RIGHT_ARROW}${RIGHT_ARROW}`],
        command: 'stop ui',
      })
      await waitForText(app, 'Stop ui?', 'the stop confirmation again')
      fake.type(YES_KEY)

      await waitForFinishedRun(app, 'stop ui', EXIT_OK, DEPLOY_WAIT_TIMEOUT_MS)
      expect(fake.screen()).toContain('stopped pid')
      expect(await probeService('ui', install.ui.host, install.ui.port)).toBe(false)
    },
    SERVICE_TEST_TIMEOUT_MS,
  )
})

describe('console end to end: reading a daemon log', () => {
  test(
    "tails the daemon's own boot line",
    async () => {
      // Arrange: a daemon that has written its listening line to `run/ui.log`.
      await manager.start('ui')
      const app = await ownerConsole()
      await goToSection(app, 'services', 'owner')

      // Act: the log tail of `ui`, five lines of it.
      await runAction(app, {
        title: 'logs',
        values: ['', LOG_TAIL_LINES],
        command: `logs ui --lines ${LOG_TAIL_LINES}`,
        timeoutMs: DEPLOY_WAIT_TIMEOUT_MS,
      })

      // Assert: what the pane shows is what the DAEMON wrote, not a summary
      // the manager made up about it.
      expect(app.fake.screen()).toContain('listening on')
    },
    SERVICE_TEST_TIMEOUT_MS,
  )
})

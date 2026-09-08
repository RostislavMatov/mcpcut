import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR, ADMIN_TOKEN_PREFIX } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { adminFromEnv } from '../../src/cli/admin-token.js'
import { REOPEN_ARGV } from '../../src/cli/tui-wizard.js'
import { BOOTSTRAP_ADMIN_NAME } from '../../src/cli/ui-constants.js'
import { probeService } from '../../src/services/probe.js'
import { installConfigSchema, type InstallConfig } from '../../src/setup/schema.js'
import {
  EXIT_OK,
  WIZARD_DONE_LINES,
  WIZARD_DONE_PARTIAL_LINES,
  WIZARD_FORM_FOOTER,
  wizardFailedNotice,
} from '../../src/tui/constants.js'
import { VAULT_KEY_FILE_NAME } from '../../src/vault/constants.js'
import type { FakeTerminal } from './support/fake-terminal.js'
import {
  answerForm,
  configPathOf,
  createWizardStand,
  disposeWizardStand,
  ENTER,
  ESCAPE,
  holdPort,
  NO_KEY,
  openWizard,
  waitForFrame,
  YES_KEY,
  type WizardStand,
} from './support/wizard-harness.js'

/**
 * The first-run wizard end to end (mcpcut phase 3, Task 15): real keystrokes
 * in, the REAL `dispatch` in the middle, a real install on a real disk and two
 * real daemons at the end — the phase's success signal in one place.
 *
 * Nothing is stubbed but the terminal and the restart. `setup --yes` runs for
 * real, so the config, the vault, the signing key and the owner it makes are
 * the ones an operator gets; `start ui`/`start serve` run for real against
 * `fake-service.mjs`, which answers `/login` with a 200, so the readiness
 * probe the ladder waits on is the production probe answering a production
 * question.
 *
 * Two promises hold only across all of it at once. The ladder SHOWS progress:
 * a frame exists in which `setup` is already ✓ while `ui` is still …, so the
 * screen is not a spinner that resolves into a result. And the one-time owner
 * token is minted by `setup`, reaches the final screen, and reaches NO argv
 * the wizard ever dispatched.
 *
 * Every wait goes through `waitForFrame` (`waitForScreen` with the deadline a
 * whole CLI run needs) rather than a sleep: a keystroke becomes a frame only
 * after a decode, a reducer step and, here, an entire command.
 */

/** Real processes and real ports: these are not unit-test quick. */
const PROCESS_TEST_TIMEOUT_MS = 20_000

/** What a minted owner token looks like on a frame. */
const TOKEN_PATTERN = new RegExp(`${ADMIN_TOKEN_PREFIX}[A-Za-z0-9_-]+`)

/** The exit code `setup` refuses a failed check with. */
const SETUP_REFUSED_EXIT_CODE = 1
/** What the fake service is told to die with when a start must fail. */
const FAILING_SERVICE_ENV: NodeJS.ProcessEnv = { FAKE_EXIT_CODE: '3' }

let stand: WizardStand
const cleanups: Array<() => Promise<void>> = []

beforeEach(async () => {
  stand = await createWizardStand()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
  await disposeWizardStand(stand)
})

/** Waits for the ladder to show `setup` done while `ui` is still being started. */
async function waitForProgress(fake: FakeTerminal): Promise<void> {
  await waitForFrame(
    fake,
    (screen) => screen.includes('✓ Checks and config') && screen.includes('… Starting ui'),
    'the ladder with setup done and ui starting',
  )
}

/** Waits for the final screen of a deploy in which everything came up. */
async function waitForDone(fake: FakeTerminal): Promise<void> {
  await waitForFrame(
    fake,
    (screen) => screen.includes('✓ Starting serve') && screen.includes(WIZARD_DONE_LINES[0] ?? ''),
    'the final screen',
  )
}

/** The config as written, parsed by the schema every command reads it with. */
async function readWrittenConfig(): Promise<InstallConfig> {
  return installConfigSchema.parse(JSON.parse(await readFile(configPathOf(stand.home), 'utf8')))
}

function configWritten(): boolean {
  return existsSync(configPathOf(stand.home))
}

/** The token on the frame in front of us, which is the only copy that exists. */
function tokenOnScreen(fake: FakeTerminal): string {
  const match = TOKEN_PATTERN.exec(fake.screen())
  expect(match, `a token on:\n${fake.screen()}`).not.toBeNull()
  return match?.[0] ?? ''
}

describe('the first-run wizard, end to end', () => {
  test(
    'green path with mcpcut services shows progress and asks for the token',
    async () => {
      const wizard = openWizard(stand)
      const { fake } = wizard

      await answerForm(stand, fake)
      await waitForProgress(fake)
      await waitForDone(fake)

      const token = tokenOnScreen(fake)
      fake.type(YES_KEY)
      expect(await wizard.exit).toBe(EXIT_OK)
      expect(wizard.reopened()).toEqual([[...REOPEN_ARGV]])
      expect(fake.restored()).toBe(true)

      const config = await readWrittenConfig()
      expect(config.dataDir).toBe(stand.dataDir)
      expect(config.ui.port).toBe(stand.uiPort)
      expect(config.serve.port).toBe(stand.servePort)
      expect(config.supervisor).toBe('mcpcut')

      const admins = await createAdminStore({ journalDir: stand.dataDir }).listAdmins()
      expect(admins.map((admin) => [admin.name, admin.role])).toEqual([
        [BOOTSTRAP_ADMIN_NAME, 'owner'],
      ])
      // The token on the frame is the token this install answers to.
      expect(
        await adminFromEnv({ env: { [ADMIN_TOKEN_ENV_VAR]: token }, journalDir: stand.dataDir }),
      ).toEqual({ kind: 'ok', name: BOOTSTRAP_ADMIN_NAME, role: 'owner' })
      expect(existsSync(join(stand.dataDir, VAULT_KEY_FILE_NAME))).toBe(true)

      // Both daemons are up and answering, which is what the ladder claimed.
      expect(await probeService('ui', '127.0.0.1', stand.uiPort)).toBe(true)
      expect(await probeService('serve', '127.0.0.1', stand.servePort)).toBe(true)

      const calls = wizard.argvCalls()
      expect(calls).toHaveLength(3)
      expect(calls[0]?.slice(0, 2)).toEqual(['setup', '--yes'])
      expect(calls[1]).toEqual(['start', 'ui'])
      expect(calls[2]).toEqual(['start', 'serve'])
      for (const argv of calls) expect(argv.join(' ')).not.toContain(ADMIN_TOKEN_PREFIX)
    },
    PROCESS_TEST_TIMEOUT_MS,
  )

  /**
   * The regression this file found (phase 3, Task 15).
   *
   * `render-wizard.ts` promises that only the `done` stage draws the owner
   * token, and `render-wizard.test.ts` pins that for `stage.admin` — but the
   * `deploying` stage also draws `setup`'s TRANSCRIPT, and `setup` writes
   * `token: mcpa_…` to its stdout. The token therefore sat under the ladder
   * for the whole of both service starts on any terminal tall enough to draw
   * 23 transcript lines (`transcriptRows = rows - 9`, so 32 rows and up),
   * which is exactly the window the final screen's confirmation exists to
   * close. `update-wizard-deploy.ts` now masks it out of the panel.
   *
   * Only an end-to-end run can see it: it takes a REAL `setup` transcript to
   * put a REAL token in the panel, so no unit test of either half was wrong.
   */
  test(
    'the one-time token reaches no frame before the final one',
    async () => {
      const wizard = openWizard(stand)
      const { fake } = wizard

      await answerForm(stand, fake)
      await waitForDone(fake)
      const token = tokenOnScreen(fake)

      // Every frame that ever carried the token must be a final one.
      for (const frame of fake.frames().filter((each) => each.includes(token))) {
        expect(frame).toContain(WIZARD_DONE_LINES[0])
      }

      fake.type(YES_KEY)
      await wizard.exit
    },
    PROCESS_TEST_TIMEOUT_MS,
  )

  test(
    'an external supervisor skips both starts',
    async () => {
      const wizard = openWizard(stand)
      const { fake } = wizard

      await answerForm(stand, fake, { external: true })
      await waitForFrame(
        fake,
        (screen) =>
          screen.includes('supervisor: external') &&
          screen.includes('– Starting ui') &&
          screen.includes('– Starting serve'),
        'the final screen with both starts skipped',
      )

      fake.type(YES_KEY)
      expect(await wizard.exit).toBe(EXIT_OK)
      expect(wizard.reopened()).toEqual([[...REOPEN_ARGV]])

      expect((await readWrittenConfig()).supervisor).toBe('external')
      expect(wizard.argvCalls().filter((argv) => argv[0] === 'start')).toEqual([])
    },
    PROCESS_TEST_TIMEOUT_MS,
  )

  test(
    'a failed check returns to the form with the values kept',
    async () => {
      cleanups.push(await holdPort(stand.uiPort))
      const wizard = openWizard(stand)
      const { fake } = wizard

      await answerForm(stand, fake)
      await waitForFrame(
        fake,
        (screen) =>
          screen.includes('✗ Checks and config') &&
          screen.includes('check  ui bind') &&
          screen.includes('fail') &&
          screen.includes(wizardFailedNotice(SETUP_REFUSED_EXIT_CODE)),
        'the transcript of the refused setup',
      )

      fake.type(ENTER)
      await waitForFrame(
        fake,
        (screen) => screen.includes(WIZARD_FORM_FOOTER) && screen.includes(`[${stand.uiPort}`),
        'the form with the port still in it',
      )

      // The checks come before the write: a refused run leaves NOTHING behind.
      expect(configWritten()).toBe(false)
      expect(await createAdminStore({ journalDir: stand.dataDir }).listAdmins()).toEqual([])

      // The other half of the token-leak promise, on the path where `setup`
      // FAILED: the `setup-failed` stage is the one that draws the whole
      // transcript, scrolled to its end, so nothing that looks like a token
      // may reach a frame of it — whether or not the transcript parsed.
      for (const frame of fake.frames()) expect(frame).not.toContain(ADMIN_TOKEN_PREFIX)

      fake.type(ESCAPE)
      expect(await wizard.exit).toBe(EXIT_OK)
      expect(wizard.reopened()).toEqual([])
    },
    PROCESS_TEST_TIMEOUT_MS,
  )

  test(
    'a non-loopback bind is asked about before anything is written',
    async () => {
      const wizard = openWizard(stand)
      const { fake } = wizard

      await answerForm(stand, fake, { uiHost: '0.0.0.0' })
      await waitForFrame(
        fake,
        (screen) => screen.includes('ADR-0004') && screen.includes('[y/N]'),
        'the exposure question',
      )
      expect(configWritten()).toBe(false)

      fake.type(NO_KEY)
      await waitForFrame(fake, (screen) => screen.includes(WIZARD_FORM_FOOTER), 'the form again')
      expect(configWritten()).toBe(false)
      expect(wizard.argvCalls()).toEqual([])

      fake.type(ESCAPE)
      expect(await wizard.exit).toBe(EXIT_OK)
    },
    PROCESS_TEST_TIMEOUT_MS,
  )

  test(
    'a service that fails to start does not block the sign-in',
    async () => {
      const wizard = openWizard(stand, FAILING_SERVICE_ENV)
      const { fake } = wizard

      await answerForm(stand, fake)
      await waitForFrame(
        fake,
        (screen) =>
          screen.includes('✗ Starting ui') &&
          screen.includes('✗ Starting serve') &&
          screen.includes(WIZARD_DONE_PARTIAL_LINES[0] ?? ''),
        'the final screen after two failed starts',
      )
      // The install exists even though neither service does, so there is a
      // token to save and a console to sign into.
      expect(tokenOnScreen(fake)).toContain(ADMIN_TOKEN_PREFIX)

      fake.type(YES_KEY)
      expect(await wizard.exit).toBe(EXIT_OK)
      expect(wizard.reopened()).toEqual([[...REOPEN_ARGV]])
    },
    PROCESS_TEST_TIMEOUT_MS,
  )
})

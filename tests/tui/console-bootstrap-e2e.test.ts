import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { bootstrapTokenPathFor, writeBootstrapTokenFile } from '../../src/admin/bootstrap-file.js'
import { createAdminStore } from '../../src/admin/store.js'
import { JOURNAL_FILE_MODE } from '../../src/config.js'
import { errnoCodeOf } from '../../src/errno.js'
import { SIGNIN_TITLE, SIGNIN_UNKNOWN_TOKEN_NOTICE } from '../../src/tui/constants.js'
import { SIGNIN_BOOTSTRAP_PREFIX } from '../../src/tui/constants-live.js'
import { BOOTSTRAP_FILE_WARNING_PREFIX } from '../../src/tui/runtime-signin.js'
import { closeConsoles, openConsole, signIn, type RunningConsole } from './support/console-harness.js'
import { waitForScreen } from './support/fake-terminal.js'

/**
 * The bootstrap token file through the console (mcpcut phase 6, F6 / F6b):
 * the sign-in screen names it while it exists, the first sign-in removes it,
 * and the screen after that is silent about it.
 *
 * The file is written the way `ui` writes it (`writeBootstrapTokenFile`, the
 * same 0600 create) with the token of an owner created directly in the store,
 * rather than by booting the real `ui` — `tests/cli/ui-cmd.test.ts` already
 * proves that boot writes exactly this file, and a second HTTP server here
 * would buy nothing but a port and a second of wall clock.
 *
 * The consoles are wide, so a temp-dir path fits on the sign-in line uncut
 * and the assertion can be the whole path rather than a prefix of it.
 */

const FIRST_OWNER = 'root'
const SECOND_ADMIN = 'alice'

const WIDE = { columns: 200, rows: 24 } as const

/** The permission bits of a file mode. */
const MODE_BITS = 0o777

let journalDir: string
let tokenPath: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-bootstrap-e2e-'))
  tokenPath = bootstrapTokenPathFor(journalDir)
})

afterEach(async () => {
  await closeConsoles()
  await rm(journalDir, { recursive: true, force: true })
})

/** Whether the file is there; `ENOENT` is the one absence that counts. */
async function fileExists(): Promise<boolean> {
  try {
    await stat(tokenPath)
    return true
  } catch (error: unknown) {
    if (errnoCodeOf(error) === 'ENOENT') return false
    throw error
  }
}

/** Opens a wide console and waits for its sign-in screen. */
async function openAtSignin(): Promise<RunningConsole> {
  const app = openConsole(journalDir, { size: WIDE })
  await waitForScreen(app.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

  return app
}

describe('the bootstrap token file through the console', () => {
  test('is named on the sign-in screen, removed by the first sign-in, and gone from the next', async () => {
    const store = createAdminStore({ journalDir })
    const { token } = await store.createAdmin(FIRST_OWNER, 'owner')
    await writeBootstrapTokenFile(tokenPath, token)
    expect((await stat(tokenPath)).mode & MODE_BITS).toBe(JOURNAL_FILE_MODE)

    const first = await openAtSignin()
    expect(first.fake.screen()).toContain(`${SIGNIN_BOOTSTRAP_PREFIX}${tokenPath}`)

    await signIn(first, token, FIRST_OWNER, 'owner')
    expect(await fileExists()).toBe(false)
    expect(first.errText()).not.toContain(BOOTSTRAP_FILE_WARNING_PREFIX)
    await first.close()

    const second = await openAtSignin()
    expect(second.fake.screen()).not.toContain(SIGNIN_BOOTSTRAP_PREFIX)

    // Another admin's sign-in finds nothing to remove and says nothing.
    const other = await store.createAdmin(SECOND_ADMIN, 'operator')
    await signIn(second, other.token, SECOND_ADMIN, 'operator')
    expect(await fileExists()).toBe(false)
    expect(second.errText()).toBe('')
  })

  test('a refused token leaves the file, and the screen keeps naming it', async () => {
    const { token } = await createAdminStore({ journalDir }).createAdmin(FIRST_OWNER, 'owner')
    await writeBootstrapTokenFile(tokenPath, token)

    const app = await openAtSignin()
    app.fake.type('mcpa_not-the-owner\r')
    await waitForScreen(
      app.fake,
      (screen) => screen.includes(SIGNIN_UNKNOWN_TOKEN_NOTICE),
      'the sign-in screen after the refusal',
    )

    expect(await fileExists()).toBe(true)
    expect(app.fake.screen()).toContain(`${SIGNIN_BOOTSTRAP_PREFIX}${tokenPath}`)
  })
})

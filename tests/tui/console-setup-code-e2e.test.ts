import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { setupCodePathFor, writeSetupCodeFile } from '../../src/admin/setup-code-file.js'
import { createAdminStore } from '../../src/admin/store.js'
import { JOURNAL_FILE_MODE } from '../../src/config.js'
import { errnoCodeOf } from '../../src/errno.js'
import { SIGNIN_TITLE, SIGNIN_UNKNOWN_TOKEN_NOTICE } from '../../src/tui/constants.js'
import { SETUP_CODE_FILE_WARNING_PREFIX } from '../../src/tui/runtime-signin.js'
import { closeConsoles, openConsole, signIn, type RunningConsole } from './support/console-harness.js'
import { waitForScreen } from './support/fake-terminal.js'

/**
 * The setup code file through the console: a sign-in removes it, a refused
 * token leaves it. With an admin in the store the file can only be a leftover
 * of a first run that something else finished (`admin add` in a shell while
 * `ui` was serving `/setup`), which is why nothing on the sign-in screen names
 * it any more — an install with NO admin opens on the first-owner screen
 * instead (`console-first-owner-e2e.test.ts`).
 *
 * The file is written the way `ui` writes it (`writeSetupCodeFile`, the same
 * 0600 create) rather than by booting the real `ui` — `tests/cli/ui-cmd.test.ts`
 * already proves that boot writes exactly this file.
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
  tokenPath = setupCodePathFor(journalDir)
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

describe('the setup code file through the console', () => {
  test('is removed by the first sign-in, and later sign-ins find nothing and say nothing', async () => {
    const store = createAdminStore({ journalDir })
    const { token } = await store.createAdmin(FIRST_OWNER, 'owner')
    await writeSetupCodeFile(tokenPath, token)
    expect((await stat(tokenPath)).mode & MODE_BITS).toBe(JOURNAL_FILE_MODE)

    const first = await openAtSignin()

    await signIn(first, token, FIRST_OWNER, 'owner')
    expect(await fileExists()).toBe(false)
    expect(first.errText()).not.toContain(SETUP_CODE_FILE_WARNING_PREFIX)
    await first.close()

    const second = await openAtSignin()

    // Another admin's sign-in finds nothing to remove and says nothing.
    const other = await store.createAdmin(SECOND_ADMIN, 'operator')
    await signIn(second, other.token, SECOND_ADMIN, 'operator')
    expect(await fileExists()).toBe(false)
    expect(second.errText()).toBe('')
  })

  test('a refused token leaves the file', async () => {
    const { token } = await createAdminStore({ journalDir }).createAdmin(FIRST_OWNER, 'owner')
    await writeSetupCodeFile(tokenPath, token)

    const app = await openAtSignin()
    app.fake.type('mcpa_not-the-owner\r')
    await waitForScreen(
      app.fake,
      (screen) => screen.includes(SIGNIN_UNKNOWN_TOKEN_NOTICE),
      'the sign-in screen after the refusal',
    )

    expect(await fileExists()).toBe(true)
  })
})

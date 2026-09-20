import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { setupCodePathFor, writeSetupCodeFile } from '../../src/admin/setup-code-file.js'
import { createAdminStore } from '../../src/admin/store.js'
import { SIGNIN_TITLE } from '../../src/tui/constants.js'
import { FIRST_OWNER_TITLE } from '../../src/tui/constants-live.js'
import { accessRecords, closeConsoles, openConsole, storeBytes } from './support/console-harness.js'
import { waitForScreen } from './support/fake-terminal.js'

/**
 * The console over an install with no admin (2026-09-19): it offers to create
 * the owner itself — it runs under the service's uid, so it needs no setup
 * code (ADR-0012 §19) — holds the token, and signs in with it.
 */

const WIDE = { columns: 120, rows: 30 } as const
const TOKEN_PATTERN = /mcpa_[A-Za-z0-9_-]+/

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-first-owner-e2e-'))
})

afterEach(async () => {
  await closeConsoles()
  await rm(journalDir, { recursive: true, force: true })
})

describe('the console over an install with no admin', () => {
  test('creates the owner by name, shows the token once, signs in, and leaves a record', async () => {
    await writeSetupCodeFile(setupCodePathFor(journalDir), 'mcps_left-by-ui')
    const app = openConsole(journalDir, { size: WIDE })
    await waitForScreen(app.fake, (screen) => screen.includes(FIRST_OWNER_TITLE), 'the first-owner screen')
    expect(app.fake.screen()).not.toContain(SIGNIN_TITLE)

    app.fake.type('alice\r')
    await waitForScreen(app.fake, (screen) => TOKEN_PATTERN.test(screen), 'the token on screen')
    const token = TOKEN_PATTERN.exec(app.fake.screen())?.[0] ?? ''
    expect(app.argvCalls()).toContainEqual(['admin', 'add', 'alice', '--role', 'owner'])

    app.fake.type('y')
    await waitForScreen(app.fake, (screen) => screen.includes('alice') && !TOKEN_PATTERN.test(screen), 'the main screen')

    const admin = await createAdminStore({ journalDir }).findAdminByToken(token)
    expect([admin?.name, admin?.role]).toEqual(['alice', 'owner'])
    // The sign-in that followed is a sign-in like any other: the leftover web code is gone.
    await expect(stat(setupCodePathFor(journalDir))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await accessRecords(journalDir)).toEqual([
      expect.objectContaining({ action: 'admin.add', admin: 'alice', targetRole: 'owner' }),
    ])
    expect(await storeBytes(journalDir)).not.toContain(token)
  })

  test('an install that has an admin opens on the sign-in screen as before', async () => {
    await createAdminStore({ journalDir }).createAdmin('root', 'owner')

    const app = openConsole(journalDir, { size: WIDE })
    await waitForScreen(app.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    expect(app.fake.screen()).not.toContain(FIRST_OWNER_TITLE)
  })
})

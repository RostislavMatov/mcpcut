import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore } from '../../src/admin/store.js'
import { runTui, type TuiCommandOptions } from '../../src/cli/tui-cmd.js'
import type { UiCliIo } from '../../src/cli/ui-constants.js'
import { plainStyle } from '../../src/tui/ansi.js'
import { SIGNIN_TITLE } from '../../src/tui/constants.js'
import { FIRST_OWNER_TITLE } from '../../src/tui/constants-live.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import { activeActionIndexIn } from '../tui/support/console-harness-navigate.js'
import { createFakeTerminal, waitForScreen, type FakeTerminal } from '../tui/support/fake-terminal.js'

/**
 * A LOCAL console reaches the connect form without any flag (2026-09-28,
 * owner complaint: with a local install there was nowhere inside the console
 * to type a remote address). End to end over `runTui`: the keystroke or the
 * menu item ends the console, and its reopen seam is asked for the bare
 * `--connect` — the same child `mcpcut --connect` a shell would start.
 */

const OWNER_NAME = 'root'
const CTRL_O = '\x0f'
const ENTER = '\r'
const DOWN_KEY = 'j'
const CONNECT_ARGV = ['--connect']

/** A dispatcher that answers the header's `status --json` and nothing else. */
const statusDispatch = async (argv: readonly string[], io: UiCliIo): Promise<number> => {
  if (argv[0] === 'status') io.stdout.write('[]\n')
  return 0
}

const quietIo: UiCliIo = { stdout: { write: () => true }, stderr: { write: () => true } }

interface LocalConsole {
  readonly fake: FakeTerminal
  readonly running: Promise<number>
  readonly reopened: string[][]
}

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-connect-local-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function openLocal(): LocalConsole {
  const fake = createFakeTerminal()
  const reopened: string[][] = []
  const install: InstallConfigLoad = { kind: 'ok', path: '/home/op/.mcpcut/config.json', config: defaultInstallConfig(journalDir) }
  const opts: TuiCommandOptions = {
    dispatch: statusDispatch,
    env: {},
    install,
    isTty: true,
    terminal: fake.terminal,
    style: plainStyle,
    processEvents: new EventEmitter(),
    escapeCodeTimeoutMs: 10,
    platform: 'linux',
    entry: 'explicit',
    home: '/home/op',
    cwd: '/w',
    journalDir,
    reopen: async (argv) => {
      reopened.push([...argv])
      return 0
    },
  }

  return { fake, running: runTui([], quietIo, opts), reopened }
}

describe('runTui over a local install: the way to another service', () => {
  test('Ctrl-O on the sign-in screen reopens on --connect', async () => {
    await createAdminStore({ journalDir }).createAdmin(OWNER_NAME, 'owner')
    const { fake, running, reopened } = openLocal()

    await waitForScreen(fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')
    fake.type(CTRL_O)

    expect(await running).toBe(0)
    expect(reopened).toEqual([CONNECT_ARGV])
    expect(fake.restored()).toBe(true)
  })

  test('Ctrl-O on the first-owner screen reopens on --connect, creating nobody', async () => {
    const { fake, running, reopened } = openLocal()

    await waitForScreen(fake, (screen) => screen.includes(FIRST_OWNER_TITLE), 'the first-owner screen')
    fake.type(CTRL_O)

    expect(await running).toBe(0)
    expect(reopened).toEqual([CONNECT_ARGV])
    expect(await createAdminStore({ journalDir }).listAdmins()).toEqual([])
  })

  test('Home ▸ connect, signed in, reopens on --connect without a question', async () => {
    const { token } = await createAdminStore({ journalDir }).createAdmin(OWNER_NAME, 'owner')
    const { fake, running, reopened } = openLocal()

    await waitForScreen(fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')
    fake.type(`${token}${ENTER}`)
    await waitForScreen(fake, (screen) => screen.includes(`${OWNER_NAME} (owner)`), 'the signed-in header')
    fake.type(DOWN_KEY)
    await waitForScreen(fake, (screen) => activeActionIndexIn(screen) === 1, 'Home ▸ connect selected')
    fake.type(ENTER)

    expect(await running).toBe(0)
    expect(reopened).toEqual([CONNECT_ARGV])
  })
})

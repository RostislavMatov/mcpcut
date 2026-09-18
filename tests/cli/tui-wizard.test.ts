import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { CliIo, DispatchOptions } from '../../src/cli/dispatch-types.js'
import { REOPEN_SIGNAL_NOTICE, reopenFailedNotice } from '../../src/cli/tui-constants.js'
import {
  defaultReopen,
  REOPEN_ARGV,
  runWizard,
  wizardPrefillOf,
  type ReopenChild,
} from '../../src/cli/tui-wizard.js'
import { plainStyle } from '../../src/tui/ansi.js'
import { createTokenCell } from '../../src/tui/runtime-effects.js'
import type { ConsoleDeps } from '../../src/tui/runtime.js'
import { DEFAULT_CLI_PATH } from '../../src/services/manager-types.js'
import { DEFAULT_DATA_DIR_NAME } from '../../src/setup/constants.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import { createFakeTerminal, waitForScreen, type FakeTerminal } from '../tui/support/fake-terminal.js'

/**
 * What opens the first-run wizard and what happens after it (mcpcut phase 3,
 * task 9).
 *
 * Two halves, and they are tested apart because only one of them draws.
 * `wizardPrefillOf` is a pure answer to "what should the form say before the
 * operator touches it" — the same env > config > default ranking every command
 * gives, with the `setup` flags laid over it. `runWizard` is the round trip:
 * the console runs, and ONLY when it ended on the sign-in request does the
 * process reopen itself.
 *
 * `defaultReopen` is here too, but never with a real child: the spawn is a
 * seam, so what is tested is what the operator is left with when the reopen
 * does not happen — a spawn that never started, and a console killed by a
 * signal, both of which used to leave a bare exit 1 and a silent shell.
 */

const HOME = '/home/op'
const CONFIG_PATH = '/home/op/.mcpcut/config.json'

const absentInstall: InstallConfigLoad = { kind: 'absent', path: CONFIG_PATH }

const okInstall: InstallConfigLoad = {
  kind: 'ok',
  path: CONFIG_PATH,
  config: {
    ...defaultInstallConfig('/var/lib/mcpcut'),
    ui: { host: '10.0.0.5', port: 9091 },
    serve: { host: '127.0.0.1', port: 9090 },
  },
}

describe('wizardPrefillOf: what the form says before anything is typed', () => {
  test('an install with no config opens in first-run mode over the default data dir', () => {
    const prefill = wizardPrefillOf({ install: absentInstall, env: {}, home: HOME, cwd: '/w' })

    expect(prefill.mode).toBe('first-run')
    expect(prefill.configPath).toBe(CONFIG_PATH)
    expect(prefill.config.dataDir).toBe(join(HOME, DEFAULT_DATA_DIR_NAME))
    expect(prefill.config.ui.port).toBe(8091)
    expect(prefill.config.serve.port).toBe(8090)
    expect(prefill.admin).toBeUndefined()
  })

  test('an install with a config opens in edit mode with that config in the fields', () => {
    const prefill = wizardPrefillOf({ install: okInstall, env: {}, home: HOME, cwd: '/w' })

    expect(prefill.mode).toBe('edit')
    expect(prefill.config.dataDir).toBe('/var/lib/mcpcut')
    expect(prefill.config.ui.host).toBe('10.0.0.5')
    expect(prefill.config.ui.port).toBe(9091)
    expect(prefill.config.serve.port).toBe(9090)
  })

  test('MCPCUT_DATA_DIR outranks the config, exactly as every command ranks it', () => {
    const prefill = wizardPrefillOf({
      install: okInstall,
      env: { MCPCUT_DATA_DIR: '/srv/x' },
      home: HOME,
      cwd: '/w',
    })

    expect(prefill.config.dataDir).toBe('/srv/x')
    // Everything the environment does not answer still comes from the config.
    expect(prefill.config.ui.host).toBe('10.0.0.5')
  })

  test('a relative --data-dir is resolved against the working directory', () => {
    const prefill = wizardPrefillOf({
      install: absentInstall,
      env: {},
      home: HOME,
      cwd: '/w',
      args: { yes: false, force: false, start: false, noAdmin: false, dataDir: 'rel' },
    })

    expect(prefill.config.dataDir).toBe('/w/rel')
  })

  test('--admin prefills the first-admin field and the rest of the flags land in the config', () => {
    const prefill = wizardPrefillOf({
      install: absentInstall,
      env: {},
      home: HOME,
      cwd: '/w',
      args: {
        yes: false,
        force: false,
        start: false,
        noAdmin: false,
        admin: 'root',
        uiPort: 18091,
      },
    })

    expect(prefill.admin).toBe('root')
    expect(prefill.config.ui.port).toBe(18091)
  })
})

/** A recorded call the assertions read back, argv and all. */
interface DispatchCall {
  readonly argv: readonly string[]
}

interface ScriptedDispatch {
  readonly dispatch: (
    argv: readonly string[],
    io: CliIo,
    opts?: DispatchOptions,
  ) => Promise<number>
  calls(): readonly DispatchCall[]
}

/**
 * A dispatcher that answers the three rungs of the ladder with the transcripts
 * the real commands print — the two lines the wizard reads its owner out of,
 * and the one line a start answers with.
 */
function scriptedDispatch(): ScriptedDispatch {
  const calls: DispatchCall[] = []
  return {
    dispatch: async (argv, io) => {
      calls.push({ argv: [...argv] })
      if (argv[0] === 'setup') {
        io.stdout.write('admin: owner\nrole: owner\ntoken: mcpa_x\n')
      } else {
        io.stdout.write('ui:    started pid 1 on http://127.0.0.1:8091/ (log /x)\n')
      }
      return 0
    },
    calls: () => [...calls],
  }
}

function consoleDeps(fake: FakeTerminal, dispatch: ScriptedDispatch['dispatch']): Omit<ConsoleDeps, 'initial'> {
  return {
    terminal: fake.terminal,
    style: plainStyle,
    stderr: { write: () => undefined },
    effects: { dispatch, dispatchOptions: {}, env: {}, token: createTokenCell() },
    processEvents: new EventEmitter(),
    signals: [],
    escapeCodeTimeoutMs: 10,
    platform: 'linux',
  }
}

describe('runWizard: the console, then the restart', () => {
  test('Ctrl-C leaves with 0 and reopens nothing', async () => {
    const fake = createFakeTerminal()
    const reopened: string[][] = []
    const prefill = wizardPrefillOf({ install: absentInstall, env: {}, home: HOME, cwd: '/w' })

    const running = runWizard({
      console: consoleDeps(fake, scriptedDispatch().dispatch),
      prefill,
      reopen: async (argv) => {
        reopened.push([...argv])
        return 7
      },
    })
    await waitForScreen(fake, (screen) => screen.includes('Data dir'), 'the wizard form')
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(reopened).toEqual([])
    expect(fake.restored()).toBe(true)
  })

  test('the full path ends in a reopen, and answers with the child exit code', async () => {
    const fake = createFakeTerminal()
    const scripted = scriptedDispatch()
    const reopened: string[][] = []
    const prefill = wizardPrefillOf({ install: absentInstall, env: {}, home: HOME, cwd: '/w' })

    const running = runWizard({
      console: consoleDeps(fake, scripted.dispatch),
      prefill,
      reopen: async (argv) => {
        reopened.push([...argv])
        return 7
      },
    })
    await waitForScreen(fake, (screen) => screen.includes('Data dir'), 'the wizard form')
    fake.type('\r')
    await waitForScreen(fake, (screen) => screen.includes('Saved it?'), 'the final screen')
    fake.type('y')

    expect(await running).toBe(7)
    expect(reopened).toEqual([[...REOPEN_ARGV]])
    expect(REOPEN_ARGV).toEqual(['tui'])
    expect(scripted.calls().map((call) => call.argv[0])).toEqual(['setup', 'start', 'start'])
    // The token the wizard showed was minted by `setup`; nothing carried it in.
    for (const call of scripted.calls()) {
      expect(call.argv.join(' ')).not.toContain('mcpa_')
    }
  })
})

/** What one `defaultReopen` wrote, in the writable shape the commands use. */
function recordingStderr(): { write(chunk: string): unknown; text(): string } {
  const chunks: string[] = []
  return { write: (chunk: string) => chunks.push(chunk), text: () => chunks.join('') }
}

/**
 * The spawned child, without a child: `defaultReopen` attaches its two
 * listeners inside the promise executor, so a test can emit on this the moment
 * the call returns.
 */
function fakeChild(): ReopenChild & EventEmitter {
  return new EventEmitter() as ReopenChild & EventEmitter
}

describe('defaultReopen: the console in a new process, and what it says when there is none', () => {
  test('the child is this build asked for the console, and carries nothing else', async () => {
    const child = fakeChild()
    const spawned: Array<readonly [string, readonly string[]]> = []

    const running = defaultReopen(REOPEN_ARGV, recordingStderr(), (command, args) => {
      spawned.push([command, [...args]])
      return child
    })
    child.emit('exit', 0)

    expect(await running).toBe(0)
    expect(spawned).toEqual([[process.execPath, [DEFAULT_CLI_PATH, 'tui']]])
  })

  test('a spawn that never started says why, once, and answers interrupted', async () => {
    const child = fakeChild()
    const stderr = recordingStderr()

    const running = defaultReopen(REOPEN_ARGV, stderr, () => child)
    child.emit('error', new Error('spawn ENOENT'))

    expect(await running).toBe(1)
    expect(stderr.text()).toBe(reopenFailedNotice('spawn ENOENT'))
    // One line, no stack, and nothing about where the build lives.
    expect(stderr.text().split('\n').filter(Boolean)).toHaveLength(1)
    expect(stderr.text()).toContain('Run: mcpcut')
    expect(stderr.text()).not.toContain(DEFAULT_CLI_PATH)
  })

  test("a child's exit code is the wizard's, and says nothing", async () => {
    const child = fakeChild()
    const stderr = recordingStderr()

    const running = defaultReopen(REOPEN_ARGV, stderr, () => child)
    child.emit('exit', 7)

    expect(await running).toBe(7)
    expect(stderr.text()).toBe('')
  })

  test('a console killed by a signal reports interrupted and says so', async () => {
    const child = fakeChild()
    const stderr = recordingStderr()

    const running = defaultReopen(REOPEN_ARGV, stderr, () => child)
    child.emit('exit', null, 'SIGKILL')

    expect(await running).toBe(1)
    expect(stderr.text()).toBe(REOPEN_SIGNAL_NOTICE)
    expect(stderr.text()).toContain('Run: mcpcut')
  })
})

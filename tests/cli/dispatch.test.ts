import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { dispatch, type CliIo } from '../../src/cli.js'
import type {
  ServiceManager,
  ServiceStatus,
  StartResult,
  StopResult,
} from '../../src/services/manager.js'
import type { ServiceName } from '../../src/services/constants.js'
import type { DataDirResolution } from '../../src/setup/data-dir.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { TUI_NOT_A_TTY } from '../../src/cli/tui-constants.js'
import { plainStyle } from '../../src/tui/ansi.js'
import { WIZARD_TITLE_FIRST_RUN } from '../../src/tui/constants.js'
import { createClientHarness } from '../proxy/harness.js'
import { createFakeTerminal, waitForScreen } from '../tui/support/fake-terminal.js'

/**
 * Dispatcher-level routing tests: every subcommand is driven through
 * `dispatch()` directly (no subprocess), each isolated from real disk state
 * via the per-command test seams in `DispatchOptions`.
 */

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-dispatch-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** Captures stdout/stderr writes for assertions instead of touching the real streams. */
function fakeIo(): CliIo & { readonly out: () => string; readonly err: () => string } {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

describe('dispatch: unknown command', () => {
  test('prints usage to stderr and returns 1', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['bogus'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Unknown command: bogus')
    expect(io.err()).toContain('Usage:')
  })
})

describe('dispatch: policy validate', () => {
  test('routes to policy-cmd and returns 0 for a valid file', async () => {
    const io = fakeIo()
    const path = join(tempDir, 'policy.json')
    await writeFile(path, JSON.stringify({ version: 1, defaultDecision: 'allow' }), 'utf8')

    const exitCode = await dispatch(['policy', 'validate', path], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('OK')
  })
})

describe('dispatch: quarantine list', () => {
  test('routes to quarantine-cmd with an isolated store', async () => {
    const io = fakeIo()
    const storePath = join(tempDir, 'tool-inventory.json')

    const exitCode = await dispatch(['quarantine', 'list'], io, { quarantine: { storePath } })

    expect(exitCode).toBe(0)
    expect(io.out()).toBe('no quarantined tools\n')
  })
})

describe('dispatch: approvals list', () => {
  test('routes to approvals-cmd with an isolated queue', async () => {
    const io = fakeIo()
    const baseDir = join(tempDir, 'approvals')

    const exitCode = await dispatch(['approvals', 'list'], io, { approvals: { baseDir } })

    expect(exitCode).toBe(0)
    expect(io.out()).toBe('no pending approvals\n')
  })
})

describe('dispatch: wrap', () => {
  test('unknown flag before "--" fails fast with exit 1', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['wrap', '--unknown-flag', '--', 'node', '-e', 'process.exit(0)'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })

  test('--no-policy runs mode A and returns the child exit code', async () => {
    const io = fakeIo()
    const harness = createClientHarness()

    const exitCode = await dispatch(['wrap', '--no-policy', '--', 'node', '-e', 'process.exit(0)'], io, {
      wrap: {
        runWrap: {
          dir: tempDir,
          stdin: harness.clientOutbox,
          stdout: harness.clientStdout,
          stderr: harness.clientStderr,
        },
      },
    })

    expect(exitCode).toBe(0)
  })

  test('a broken --policy file fails fast with exit 1, without spawning the child', async () => {
    const io = fakeIo()
    const harness = createClientHarness()
    const brokenPath = join(tempDir, 'broken.json')
    await writeFile(brokenPath, '{ not json', 'utf8')

    const exitCode = await dispatch(
      ['wrap', '--policy', brokenPath, '--', 'node', '-e', 'process.exit(1)'],
      io,
      {
        wrap: {
          runWrap: {
            dir: tempDir,
            stdin: harness.clientOutbox,
            stdout: harness.clientStdout,
            stderr: harness.clientStderr,
          },
        },
      },
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(brokenPath)
    // The child was never spawned: its exit code (1) never determined the outcome, the
    // policy load failure did (also 1) -- assert on the message instead, which only the
    // policy-load path writes.
    expect(io.err()).not.toContain('policy: loaded')
  })
})

describe('dispatch: show (regression)', () => {
  test('--kind decision still filters and prints readable records', async () => {
    const io = fakeIo()
    const sessionId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const decisionRecord = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      ts: '2026-08-05T00:00:00.000Z',
      sessionId,
      direction: 'client→server',
      kind: 'decision',
      method: 'tools/call',
      payload: {},
      decision: {
        outcome: 'deny',
        rule: 'servers.github.tools.delete_*',
        serverName: 'github',
        toolName: 'delete_repo',
        toolClass: 'destructive',
        quarantineState: 'known',
        argsHash: 'abc123',
      },
    }
    const requestRecord = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
      ts: '2026-08-05T00:00:01.000Z',
      sessionId,
      direction: 'client→server',
      kind: 'request',
      method: 'tools/list',
      payload: {},
    }
    // Through the real sink: `journal.db` is the only read carrier since the
    // M4.5 wave-5 cutover, so a hand-written `*.jsonl` would show nothing.
    const sink = createJournalSink(sessionId, { dir: tempDir })
    sink.write(decisionRecord as JournalRecord)
    sink.write(requestRecord as JournalRecord)
    await sink.close()

    const exitCode = await dispatch(['show', sessionId, '--kind', 'decision'], io, { journalDir: tempDir })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('delete_repo')
    expect(io.out()).not.toContain('tools/list')
  })
})

describe('dispatch: M3 commands route to their modules', () => {
  test('--help lists every M3 command', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['--help'], io)

    expect(exitCode).toBe(0)
    for (const name of ['connect', 'serve', 'server add', 'vault init', 'agent create', 'group create']) {
      expect(io.out()).toContain(name)
    }
  })

  test('server: missing subcommand prints usage with exit 1', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['server'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Missing server subcommand.')
  })

  test('server list routes with an isolated registry', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['server', 'list'], io, { server: { journalDir: tempDir } })

    expect(exitCode).toBe(0)
    expect(io.out().toLowerCase()).toContain('no servers')
  })

  test('vault list without init reports not-initialized with a hint', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['vault', 'list'], io, { vault: { journalDir: tempDir } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('vault init')
  })

  test('agent list routes with an isolated store', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['agent', 'list'], io, { agent: { journalDir: tempDir } })

    expect(exitCode).toBe(0)
  })

  test('group list routes with an isolated store', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['group', 'list'], io, { group: { journalDir: tempDir, env: {} } })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('(no groups)')
  })

  test('group: an unknown subcommand prints the group usage with exit 1', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['group', 'bogus'], io, { group: { journalDir: tempDir, env: {} } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('group create <name>')
  })

  test('connect without MCP_AGENT_TOKEN refuses before any traffic', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['connect', 'github', '--agent', 'bot'], io, {
      connect: { env: {}, journalDir: tempDir },
    })

    expect(exitCode).not.toBe(0)
    expect(io.err()).toContain('MCP_AGENT_TOKEN')
  })

  test('serve with an invalid port refuses to start', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['serve', '--port', 'not-a-port'], io, {
      serve: { journalDir: tempDir },
    })

    expect(exitCode).not.toBe(0)
  })
})

describe('dispatch: migrate', () => {
  test('routes to migrate-cmd with an isolated journalDir', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['migrate'], io, { migrate: { journalDir: tempDir } })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('no file')
    expect(io.out()).toContain('Migrated 0 store(s).')
  })
})

describe('dispatch: export', () => {
  test('routes to export-cmd with an isolated journalDir', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['export'], io, { export: { journalDir: tempDir } })

    expect(exitCode).toBe(0)
    expect(io.out()).toBe('')
  })
})

describe('dispatch: backup', () => {
  test('routes to backup-cmd with an isolated journalDir', async () => {
    const io = fakeIo()
    const destDir = join(tempDir, 'backup-dest')

    const exitCode = await dispatch(['backup', destDir], io, { backup: { journalDir: tempDir } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('No databases to back up.')
  })
})

describe('dispatch: verify', () => {
  test('routes to verify-cmd with an isolated journalDir', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['verify'], io, { verify: { journalDir: tempDir } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('No journal database found')
  })
})

describe('dispatch: prune', () => {
  test('routes to prune-cmd with an isolated journalDir', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['prune', '--older-than', '90d'], io, { prune: { journalDir: tempDir } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('No journal database found')
  })

  test('a prune with no --older-than never reaches the journal', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['prune'], io, { prune: { journalDir: tempDir } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('--older-than')
  })
})

describe('dispatch: keygen', () => {
  test('routes to keygen-cmd with an isolated journalDir', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['keygen'], io, { keygen: { journalDir: join(tempDir, 'keygen') } })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('-----BEGIN PUBLIC KEY-----')
  })
})

/**
 * An unusable install config (phase 1, task 4): every command refuses with the
 * path and the faults, rather than falling back to `$HOME` and quietly working
 * on a directory the operator did not choose. `--help` and `setup` are the two
 * exemptions — they are how the operator finds out what to do about it.
 */
describe('dispatch: an unusable install config', () => {
  const BROKEN_CONFIG_PATH = '/home/op/.mcpcut/config.json'

  const broken: DataDirResolution = {
    dataDir: '/home/op/.mcpcut/data',
    source: 'default',
    configPath: BROKEN_CONFIG_PATH,
    problem: ['dataDir: dataDir must be an absolute path'],
  }

  test('refuses an ordinary command with the config path and the fault', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['server', 'list'], io, { install: broken })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(BROKEN_CONFIG_PATH)
    expect(io.err()).toContain('dataDir: dataDir must be an absolute path')
    expect(io.out()).toBe('')
  })

  test('still prints usage for --help, which is where the operator looks next', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['--help'], io, { install: broken })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('Usage:')
    expect(io.err()).toBe('')
  })

  test('does not block setup, the command that rewrites the broken file', async () => {
    const io = fakeIo()

    // No `--yes`: the cheapest path through the real command, and one that
    // never touches disk — the seams keep even the config lookup off `$HOME`.
    const exitCode = await dispatch(['setup'], io, {
      install: broken,
      tui: { isTty: false },
      setup: { env: {}, home: tempDir, cwd: tempDir },
    })

    expect(exitCode).toBe(1)
    expect(io.err()).not.toContain('is unusable')
    expect(io.err()).toContain('needs a terminal')
    expect(io.err()).toContain('mcpcut setup --yes')
  })

  test('a usable resolution routes as before', async () => {
    const io = fakeIo()
    const usable: DataDirResolution = {
      dataDir: '/home/op/.mcpcut/data',
      source: 'default',
      configPath: BROKEN_CONFIG_PATH,
    }

    const exitCode = await dispatch(['server', 'list'], io, {
      install: usable,
      server: { journalDir: join(tempDir, 'registry') },
    })

    expect(exitCode).toBe(0)
  })
})

/**
 * The service verbs (phase 1, task 12) are four top-level commands rather than
 * one `service` sub-router: `mcpcut start` is what an operator types, and a
 * sub-router would have made it `mcpcut service start`.
 */
describe('dispatch: start|stop|status|logs', () => {
  const SERVICE_CONFIG_PATH = '/home/op/.mcpcut/config.json'

  const install: InstallConfigLoad = {
    kind: 'ok',
    path: SERVICE_CONFIG_PATH,
    config: defaultInstallConfig('/var/lib/mcpcut'),
  }

  interface RoutingManager extends ServiceManager {
    readonly calls: readonly string[]
  }

  /** Answers every verb the same way, and records which one was asked. */
  function routingManager(): RoutingManager {
    const calls: string[] = []
    const statusOf = (service: ServiceName): ServiceStatus => ({
      service,
      state: 'running',
      host: '127.0.0.1',
      port: service === 'ui' ? 8091 : 8090,
      pid: 42,
      logPath: `/var/lib/mcpcut/run/${service}.log`,
    })
    return {
      calls,
      start: async (service): Promise<StartResult> => {
        calls.push(`start ${service}`)
        return { kind: 'already-running', status: statusOf(service) }
      },
      stop: async (service): Promise<StopResult> => {
        calls.push(`stop ${service}`)
        return { kind: 'not-running' }
      },
      status: async (service) => {
        calls.push(`status ${service}`)
        return statusOf(service)
      },
      logs: async (service, lines) => {
        calls.push(`logs ${service} ${String(lines)}`)
        return ['a log line']
      },
    }
  }

  test('routes start to the service manager, ui first', async () => {
    const io = fakeIo()
    const manager = routingManager()

    const exitCode = await dispatch(['start'], io, { services: { manager, install } })

    expect(exitCode).toBe(0)
    expect(manager.calls).toEqual(['start ui', 'start serve'])
    expect(io.out()).toContain('already running pid 42')
  })

  test('routes stop to the service manager, serve first', async () => {
    const io = fakeIo()
    const manager = routingManager()

    const exitCode = await dispatch(['stop'], io, { services: { manager, install } })

    expect(exitCode).toBe(0)
    expect(manager.calls).toEqual(['stop serve', 'stop ui'])
    expect(io.out()).toContain('not running')
  })

  test('routes status, passing --json through', async () => {
    const io = fakeIo()
    const manager = routingManager()

    const exitCode = await dispatch(['status', '--json'], io, { services: { manager, install } })

    expect(exitCode).toBe(0)
    expect(manager.calls).toEqual(['status ui', 'status serve'])
    expect(JSON.parse(io.out())).toHaveLength(2)
  })

  test('routes logs with its service name and --lines', async () => {
    const io = fakeIo()
    const manager = routingManager()

    const exitCode = await dispatch(['logs', 'serve', '--lines', '7'], io, {
      services: { manager, install },
    })

    expect(exitCode).toBe(0)
    expect(manager.calls).toEqual(['logs serve 7'])
    expect(io.out()).toBe('a log line\n')
  })
})

/**
 * A bare `mcpcut` (phase 2, task 15) means one of four things, and the
 * difference is what it is being typed into.
 *
 * In a pipe, a script or CI it is what it has always been: the usage, exit 0,
 * ahead of every gate — nothing that runs unattended may start depending on a
 * config file it never needed. On a terminal it is a request for the console,
 * and that request goes through the same broken-config gate every other
 * command does: a console opened over the wrong data directory is worse than
 * a refusal that names the file.
 */
describe('dispatch: a bare invocation', () => {
  const CONFIG_PATH = '/home/op/.mcpcut/config.json'

  const broken: DataDirResolution = {
    dataDir: '/home/op/.mcpcut/data',
    source: 'default',
    configPath: CONFIG_PATH,
    problem: ['dataDir: dataDir must be an absolute path'],
  }

  test('prints usage outside a terminal, as it always has', async () => {
    const io = fakeIo()

    const exitCode = await dispatch([], io, { tui: { isTty: false } })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('Usage:')
    expect(io.err()).toBe('')
  })

  test('prints usage outside a terminal even when the install config is broken', async () => {
    const io = fakeIo()

    const exitCode = await dispatch([], io, { install: broken, tui: { isTty: false } })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('Usage:')
    expect(io.err()).toBe('')
  })

  test('on a terminal without a config, opens the first-run wizard', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = dispatch([], io, {
      tui: {
        isTty: true,
        env: {},
        install: { kind: 'absent', path: CONFIG_PATH },
        home: tempDir,
        cwd: tempDir,
        terminal: fake.terminal,
        style: plainStyle,
        processEvents: new EventEmitter(),
        escapeCodeTimeoutMs: 10,
      },
    })
    await waitForScreen(fake, (screen) => screen.includes('Data dir'), 'the wizard form')
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(fake.restored()).toBe(true)
    expect(io.err()).toBe('')
  })

  test('on a terminal with a broken config, refuses like every other command', async () => {
    const io = fakeIo()

    const exitCode = await dispatch([], io, { install: broken, tui: { isTty: true, env: {} } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(CONFIG_PATH)
    expect(io.err()).toContain('dataDir: dataDir must be an absolute path')
    expect(io.out()).toBe('')
  })

  test('on a terminal with a usable config, opens the console', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()
    const usable: DataDirResolution = {
      dataDir: '/home/op/.mcpcut/data',
      source: 'config',
      configPath: CONFIG_PATH,
    }
    const install: InstallConfigLoad = {
      kind: 'ok',
      path: CONFIG_PATH,
      config: defaultInstallConfig('/var/lib/mcpcut'),
    }

    const running = dispatch([], io, {
      install: usable,
      tui: {
        isTty: true,
        env: {},
        install,
        terminal: fake.terminal,
        style: plainStyle,
        processEvents: new EventEmitter(),
        escapeCodeTimeoutMs: 10,
      },
    })
    await waitForScreen(fake, (screen) => screen.includes('Sign in'), 'the sign-in screen')
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(fake.restored()).toBe(true)
  })
})

describe('dispatch: setup without --yes on a terminal', () => {
  test('opens the wizard the CLI entry point wires in', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = dispatch(['setup'], io, {
      tui: {
        isTty: true,
        env: {},
        install: { kind: 'absent', path: join(tempDir, 'config.json') },
        home: tempDir,
        cwd: tempDir,
        terminal: fake.terminal,
        style: plainStyle,
        processEvents: new EventEmitter(),
        escapeCodeTimeoutMs: 10,
      },
      setup: { env: {}, home: tempDir },
    })
    await waitForScreen(
      fake,
      (screen) => screen.includes(WIZARD_TITLE_FIRST_RUN),
      'the first-run wizard',
    )
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(io.err()).toBe('')
  })
})

describe('dispatch: tui', () => {
  test('refuses outside a terminal, pointing back at the commands', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['tui'], io, { tui: { isTty: false } })

    expect(exitCode).toBe(1)
    expect(io.err()).toBe(TUI_NOT_A_TTY)
  })

  test('routes --help through to the tui usage', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['tui', '--help'], io, { tui: { isTty: false } })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('tui')
    expect(io.out()).toContain('Usage:')
  })

  test('a top-level --help still prints the full usage over a broken config', async () => {
    const io = fakeIo()
    const broken: DataDirResolution = {
      dataDir: '/home/op/.mcpcut/data',
      source: 'default',
      configPath: '/home/op/.mcpcut/config.json',
      problem: ['dataDir: dataDir must be an absolute path'],
    }

    const exitCode = await dispatch(['--help'], io, { install: broken })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('Usage:')
    expect(io.err()).toBe('')
  })
})

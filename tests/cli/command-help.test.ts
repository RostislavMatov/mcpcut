import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createClientHarness } from '../proxy/harness.js'
import { dispatch, type CliIo } from '../../src/cli.js'
import { commandUsage, wantsCommandHelp } from '../../src/cli/command-help.js'
import { START_HERE } from '../../src/cli/start-here.js'
import { USAGE } from '../../src/cli/usage.js'
import { cliCommand } from '../../src/cli/next-step.js'

/**
 * `mcpcut <command> --help` is the first thing a newcomer types after a
 * command (stranger run of 0.2.3, 2026-09-30): it used to answer "Unknown
 * option '--help'". It now prints that command's rows of the global usage.
 */

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-help-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

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

describe('wantsCommandHelp', () => {
  test.each([['--help'], ['-h'], ['x', '--help'], ['--session', 's1', '-h']])('%j asks for help', (...args) => {
    expect(wantsCommandHelp(args)).toBe(true)
  })

  test('nothing after "--" counts: it belongs to the wrapped command', () => {
    expect(wantsCommandHelp(['--server', 'fs', '--', 'some-server', '--help'])).toBe(false)
    expect(wantsCommandHelp(['--', '-h'])).toBe(false)
  })

  test('no help flag, no help', () => {
    expect(wantsCommandHelp([])).toBe(false)
    expect(wantsCommandHelp(['abc123'])).toBe(false)
  })
})

describe('commandUsage', () => {
  test('keeps the multi-line row of the command, and only its rows', () => {
    const text = commandUsage('show')
    expect(text).toContain('mcpcut show <sessionId> [--method X]')
    expect(text).toContain('Print one session')
    expect(text).not.toContain('mcpcut sessions')
    expect(text).not.toContain('mcpcut policy')
  })

  test('start|stop|status|logs rows are found by each verb', () => {
    expect(commandUsage('status')).toContain('Show whether each service runs')
    expect(commandUsage('stop')).toContain('Start/stop the services')
  })

  test('groups every row of a command family', () => {
    const text = commandUsage('approvals')
    expect(text).toContain('approvals list')
    expect(text).toContain('approvals deny')
  })

  test('an unknown command has none', () => {
    expect(commandUsage('nope')).toBeUndefined()
  })
})

describe('dispatch: <command> --help', () => {
  test.each([
    ['show', 'Print one session'],
    ['sessions', 'List journaled sessions'],
    ['approvals', 'approvals list'],
    ['export', 'Export journal records'],
    ['verify', 'Recompute the record hash chain'],
    ['keygen', 'Generate this installation'],
    ['server', 'server add'],
    ['status', 'Show whether each service runs'],
  ])('%s --help and -h print its usage on stdout and exit 0', async (command, fragment) => {
    for (const flag of ['--help', '-h']) {
      const io = fakeIo()

      const exitCode = await dispatch([command, flag], io)

      expect(exitCode).toBe(0)
      expect(io.out()).toContain(fragment)
      expect(io.out()).toContain(`${cliCommand()} --help`)
      expect(io.err()).toBe('')
    }
  })

  test('a flag later in the arguments works too', async () => {
    const io = fakeIo()

    expect(await dispatch(['server', 'add', '--help'], io)).toBe(0)
    expect(io.out()).toContain('server add <name>')
  })

  test('after "--" the flag belongs to the wrapped command and reaches it untouched', async () => {
    const io = fakeIo()
    const harness = createClientHarness()
    // Exits 5 only when the wrapped process itself received `--help` as its argument.
    const probe = "process.exit(process.argv[1] === '--help' ? 5 : 0)"

    const exitCode = await dispatch(['wrap', '--no-policy', '--', 'node', '-e', probe, '--', '--help'], io, {
      wrap: {
        runWrap: {
          dir: tempDir,
          stdin: harness.clientOutbox,
          stdout: harness.clientStdout,
          stderr: harness.clientStderr,
        },
      },
    })

    expect(exitCode).toBe(5)
    expect(io.out()).not.toContain('Usage:')
  })
})

describe('the Start here block', () => {
  test('opens the global usage and names the five first commands', () => {
    expect(USAGE.startsWith(START_HERE)).toBe(true)
    const c = cliCommand()
    for (const row of [
      `${c} wrap`,
      `${c} sessions`,
      `${c} show <id>`,
      `${c} approvals list`,
      `${c} approvals approve <id>`,
      `${c} export --report`,
      `${c} verify --report`,
    ]) {
      expect(START_HERE).toContain(row)
    }
  })

  test('is followed by the full list, still starting at "Usage:"', () => {
    expect(USAGE).toContain('\nUsage:\n  mcpcut adopt')
  })
})

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  installWarningFilter,
  isSqliteExperimentalWarning,
  type WarningHost,
  type WarningListener,
} from '../../src/cli/warning-filter.js'

/**
 * The two stderr lines every single command printed (user-journey smoke
 * 2026-09-18, UX-7):
 *
 *     (node:1390) ExperimentalWarning: SQLite is an experimental feature …
 *     (Use `node --trace-warnings ...` to show where the warning was created)
 *
 * They are Node's, about a module ADR-0006 chose deliberately, and they also
 * landed in `run/ui.log` / `run/serve.log`, where they are the first thing an
 * operator reads when looking for a real problem. Exactly this one warning is
 * suppressed — anything else Node has to say still reaches stderr.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../..')
const CLI_PATH = join(REPO_ROOT, 'dist/cli.js')
const FIXTURE_PATH = join(__dirname, 'fixtures/warning-filter-child.mjs')
const SPAWN_TIMEOUT_MS = 20_000

/** Node's own text, verbatim, as of v24–v25.6. */
const SQLITE_WARNING_TEXT = 'SQLite is an experimental feature and might change at any time'

interface ChildResult {
  readonly code: number | null
  readonly stderr: string
}

function runNode(args: readonly string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr }))
  })
}

describe('isSqliteExperimentalWarning', () => {
  test('matches the warning node:sqlite emits, in both of its call shapes', () => {
    expect(isSqliteExperimentalWarning(SQLITE_WARNING_TEXT, 'ExperimentalWarning')).toBe(true)
    expect(
      isSqliteExperimentalWarning(SQLITE_WARNING_TEXT, { type: 'ExperimentalWarning' }),
    ).toBe(true)
    const asError = new Error(SQLITE_WARNING_TEXT)
    asError.name = 'ExperimentalWarning'
    expect(isSqliteExperimentalWarning(asError)).toBe(true)
  })

  test('leaves every other warning alone, including other experimental ones', () => {
    expect(isSqliteExperimentalWarning('Type stripping is an experimental feature', 'ExperimentalWarning')).toBe(false)
    expect(isSqliteExperimentalWarning(SQLITE_WARNING_TEXT, 'DeprecationWarning')).toBe(false)
    expect(isSqliteExperimentalWarning(SQLITE_WARNING_TEXT)).toBe(false)
    expect(isSqliteExperimentalWarning('a bare string')).toBe(false)
  })
})

/** A `process`-shaped stand-in for the three members the filter touches. */
function fakeHost(printed: Error[]): WarningHost & { emit: (warning: Error) => void } {
  let listeners: WarningListener[] = [(warning) => printed.push(warning)]
  return {
    listeners: () => [...listeners],
    removeAllListeners: () => {
      listeners = []
    },
    on: (_event, listener) => {
      listeners = [...listeners, listener]
    },
    emit: (warning) => {
      for (const listener of listeners) listener(warning)
    },
  }
}

function warningOf(message: string, name: string): Error {
  const warning = new Error(message)
  warning.name = name
  return warning
}

describe('installWarningFilter', () => {
  test("drops the one warning and hands every other to Node's own printer", () => {
    const printed: Error[] = []
    const host = fakeHost(printed)

    installWarningFilter(host)
    host.emit(warningOf(SQLITE_WARNING_TEXT, 'ExperimentalWarning'))
    const other = warningOf('Type stripping is an experimental feature', 'ExperimentalWarning')
    host.emit(other)
    const deprecation = warningOf('fs.f() is deprecated', 'DeprecationWarning')
    host.emit(deprecation)

    expect(printed).toEqual([other, deprecation])
  })

  test('is idempotent: installing twice neither doubles the output nor captures its own filter', () => {
    const printed: Error[] = []
    const host = fakeHost(printed)

    installWarningFilter(host)
    installWarningFilter(host)
    host.emit(warningOf(SQLITE_WARNING_TEXT, 'ExperimentalWarning'))
    const other = warningOf('something else', 'DeprecationWarning')
    host.emit(other)

    expect(printed).toEqual([other])
  })
})

describe('the built CLI, spawned as an operator runs it', () => {
  test(
    'no command carries the SQLite warning on stderr any more',
    async () => {
      const result = await runNode([CLI_PATH, '--help'])

      expect(result.code).toBe(0)
      expect(result.stderr).not.toContain('ExperimentalWarning')
      expect(result.stderr).not.toContain('trace-warnings')
      expect(result.stderr).toBe('')
    },
    SPAWN_TIMEOUT_MS,
  )

  test(
    'a different warning still reaches stderr, so the filter is not a global mute',
    async () => {
      const result = await runNode([FIXTURE_PATH])

      expect(result.code).toBe(0)
      expect(result.stderr).not.toContain(SQLITE_WARNING_TEXT)
      expect(result.stderr).toContain('a warning nobody suppressed')
      expect(result.stderr).toContain('DeprecationWarning')
    },
    SPAWN_TIMEOUT_MS,
  )
})

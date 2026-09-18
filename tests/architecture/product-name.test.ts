import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { PROJECT_POLICY_SUBDIR } from '../../src/policy/load.js'
import { CONFIG_DIR_NAME, DEFAULT_DATA_DIR_NAME } from '../../src/setup/constants.js'

/**
 * ADR-0013: the product has one name, `mcpcut`. The working name it grew up
 * under is gone from everything an operator runs, reads or deploys — no second
 * `bin`, no fallback directory, no aliased environment variable. A fallback
 * would bring back the finding the decision came from: an install silently
 * landing on a store its operator did not know was there.
 *
 * Historical records (ADRs, smoke protocols, the pitch track) keep the old
 * name on purpose and are not scanned; the CHANGELOG and ADR-0013 name it once
 * to say it is gone.
 */

const PROJECT_ROOT = process.cwd()

/** Spelled in pieces so this file does not trip its own scan. */
const RETIRED_NAME = new RegExp(['mcp', 'journal'].join('[-_]'), 'i')

const SCANNED_DIRS: readonly string[] = ['src', 'docker', 'docs/deploy']

const SCANNED_FILES: readonly string[] = [
  'package.json',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  'README.md',
  'NOTICE',
  'SECURITY.md',
  'CONTRIBUTING.md',
]

function filesUnder(dir: string): readonly string[] {
  return readdirSync(join(PROJECT_ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

function offendersIn(paths: readonly string[]): readonly string[] {
  return paths.filter((path) => RETIRED_NAME.test(readFileSync(path, 'utf8')))
}

describe('the product name (ADR-0013)', () => {
  test('the package is named mcpcut and ships exactly one bin, mcpcut', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'))

    expect(manifest).toMatchObject({ name: 'mcpcut', bin: { mcpcut: './dist/cli.js' } })
    expect(Object.keys((manifest as { bin: Record<string, string> }).bin)).toEqual(['mcpcut'])
  })

  test('the bin name is written once in the manifest text, not merely once after parsing', () => {
    // `JSON.parse` collapses a duplicate key silently, so the parsed object
    // above cannot see one; the scripted rename left exactly that behind.
    const text = readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')

    expect(text.match(/"mcpcut": "\.\/dist\/cli\.js"/g)).toHaveLength(1)
  })

  test('the project-level policy directory can never be the install directory', () => {
    // With one name for everything, `<cwd>/.mcpcut/policy.json` typed in $HOME
    // would sit next to `config.json` and silently outrank the real policy in
    // `~/.mcpcut/data` (first found wins, ADR-0005). The names must differ.
    expect(PROJECT_POLICY_SUBDIR).not.toBe(CONFIG_DIR_NAME)
    expect(join('/home/op', PROJECT_POLICY_SUBDIR).startsWith(join('/home/op', CONFIG_DIR_NAME) + '/')).toBe(false)
    expect(join('/home/op', DEFAULT_DATA_DIR_NAME).startsWith(join('/home/op', PROJECT_POLICY_SUBDIR) + '/')).toBe(false)
  })

  test.each(SCANNED_DIRS)('nothing under %s mentions the retired name', (dir) => {
    expect(offendersIn(filesUnder(dir))).toEqual([])
  })

  test('the packaging and the living documents do not mention the retired name', () => {
    const paths = SCANNED_FILES.map((file) => join(PROJECT_ROOT, file))

    expect(offendersIn(paths)).toEqual([])
  })
})

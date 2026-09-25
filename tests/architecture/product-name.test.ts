import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { PRODUCT_VERSION } from '../../src/brand.js'
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

/** The manual the README links to; it carries the same `npx -y mcpcut@<version>` blocks the README did. */
const GUIDE_DIR = 'docs/guide'

/** Documents that tell a reader which published version to run. */
const VERSION_PINNED_FILES: readonly string[] = [
  'README.md',
  'SECURITY.md',
  ...readdirSync(join(PROJECT_ROOT, GUIDE_DIR))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `${GUIDE_DIR}/${name}`),
]

const VERSION_PIN = /mcpcut@(\d+\.\d+\.\d+)/g

const SCANNED_DIRS: readonly string[] = ['src', 'docker', 'docs/deploy', GUIDE_DIR]

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

    expect(manifest).toMatchObject({ name: 'mcpcut', bin: { mcpcut: 'dist/cli.js' } })
    expect(Object.keys((manifest as { bin: Record<string, string> }).bin)).toEqual(['mcpcut'])
  })

  test('the bin name is written once in the manifest text, not merely once after parsing', () => {
    // `JSON.parse` collapses a duplicate key silently, so the parsed object
    // above cannot see one; the scripted rename left exactly that behind.
    const text = readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')

    expect(text.match(/"mcpcut": "dist\/cli\.js"/g)).toHaveLength(1)
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

describe('the product version', () => {
  test('is the same string the package declares', () => {
    // `src/brand.ts` holds a literal on purpose (the plane must not read its
    // own `package.json` at runtime — see the constant's own doc). This test
    // is what stops the two drifting apart at the next release bump.
    const manifest = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'),
    ) as { version: string }

    expect(PRODUCT_VERSION).toBe(manifest.version)
  })

  test.each(VERSION_PINNED_FILES)('every mcpcut@x.y.z in %s is the product version', (file) => {
    // The README tells people to run `npx -y mcpcut@<version>`; a pin left
    // behind at the next bump would send them to an older release. The
    // CHANGELOG is not scanned: past versions belong there.
    const pins = [...readFileSync(join(PROJECT_ROOT, file), 'utf8').matchAll(VERSION_PIN)].map((match) => match[1])

    expect(pins.filter((pin) => pin !== PRODUCT_VERSION)).toEqual([])
  })
})

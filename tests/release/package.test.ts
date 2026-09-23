import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'

/**
 * PRD phase 6, plan R1–R2: what `npm publish` puts on the registry. Without an
 * allowlist npm takes the whole repository minus `.gitignore` — the working
 * notes, the pitch track and the dogfood project policy included — and a
 * `dist/` that was never cleaned carries modules whose sources are gone.
 */

const PROJECT_ROOT = process.cwd()

/** R1, in this order: compiled code, the font licence OFL asks to travel with the font, and the notices npm does not add by itself. */
const PACKAGE_FILES: readonly string[] = [
  'dist/**/*.js',
  'dist/ui/assets/LICENSE-Silkscreen-OFL.txt',
  'NOTICE',
  'CHANGELOG.md',
  'SECURITY.md',
]

/** Trusted publishing compares `repository.url` exactly, owner casing included. */
const REPOSITORY_URL = 'git+https://github.com/RostislavMatov/mcpcut.git'

const OFL_LICENSE_PATH = 'dist/ui/assets/LICENSE-Silkscreen-OFL.txt'

/** A dry run of `npm pack` over ~500 files; the default 5 s is not enough on a busy machine. */
const PACK_TIMEOUT_MS = 30_000

interface Manifest {
  readonly [key: string]: unknown
  readonly description: string
  readonly scripts: Readonly<Record<string, string>>
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as Manifest
}

describe('package.json: what npm publishes', () => {
  const manifest = readManifest()

  test('files is exactly the allowlist of plan R1', () => {
    expect(manifest['files']).toEqual(PACKAGE_FILES)
  })

  test('the one entry point is the mcpcut bin; there is no importable main', () => {
    // `main` would make the internal dispatcher look like a library API.
    expect(manifest['bin']).toEqual({ mcpcut: './dist/cli.js' })
    expect('main' in manifest).toBe(false)
  })

  test('repository, homepage and bugs name RostislavMatov/mcpcut', () => {
    expect(manifest['repository']).toEqual({ type: 'git', url: REPOSITORY_URL })
    expect(manifest['homepage']).toBe('https://github.com/RostislavMatov/mcpcut#readme')
    expect(manifest['bugs']).toEqual({ url: 'https://github.com/RostislavMatov/mcpcut/issues' })
  })

  test('every build starts from an empty dist/ and ships the font licence (R2)', () => {
    expect(manifest.scripts['clean']).toContain('dist')
    expect(manifest.scripts['prebuild']).toBe('npm run clean')
    expect(manifest.scripts['build']).toContain('LICENSE-Silkscreen-OFL.txt')
    expect(manifest.scripts['prepack']).toBe('npm run build')
  })

  test('publishing goes through the release guard (R3)', () => {
    expect(manifest.scripts['prepublishOnly']).toBe('node tools/release/check-release.mjs')
  })

  test('the description keeps to the wording rules', () => {
    expect(manifest.description).not.toMatch(/tamper-proof|audit-ready/i)
    if (/tamper-evident/i.test(manifest.description)) {
      expect(manifest.description).toMatch(/external anchor/i)
    }
  })

  test('the runtime floor and the licence', () => {
    expect(manifest['engines']).toEqual({ node: '>=24' })
    expect(manifest['license']).toBe('Apache-2.0')
  })
})

/** Always shipped, whatever `files` says (npm adds the first three itself). */
const REQUIRED_PATHS: readonly string[] = [
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE',
  'CHANGELOG.md',
  'SECURITY.md',
  'dist/cli.js',
  OFL_LICENSE_PATH,
]

const ALLOWED_PATH: readonly RegExp[] = [
  /^dist\/.+\.js$/,
  /^dist\/ui\/assets\/LICENSE-Silkscreen-OFL\.txt$/,
  /^(package\.json|README\.md|LICENSE|NOTICE|CHANGELOG\.md|SECURITY\.md)$/,
]

/** Named rather than implied by the allowlist: a failure message that says `.claude/` reads better. */
const FORBIDDEN_PREFIXES: readonly string[] = [
  '.claude/',
  'docs/',
  'tests/',
  'src/',
  '.mcpcut-project/',
  'tools/',
  'coverage/',
]

const FORBIDDEN_SUFFIXES: readonly string[] = ['.map', '.d.ts']

/**
 * `--ignore-scripts`: a dry run still runs `prepack`, which would rebuild
 * dist/ under the feet of the suites that spawn dist/cli.js.
 */
function packedPaths(): readonly string[] {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`npm pack --dry-run failed: ${result.stderr}`)
  const [pack] = JSON.parse(result.stdout) as ReadonlyArray<{ files: ReadonlyArray<{ path: string }> }>
  return (pack?.files ?? []).map((file) => file.path)
}

describe('npm pack: the tarball', () => {
  let paths: readonly string[] = []

  beforeAll(() => {
    if (!existsSync(join(PROJECT_ROOT, 'dist/cli.js'))) {
      throw new Error('run `npm run build` first: the package is what the build leaves in dist/')
    }
    paths = packedPaths()
  }, PACK_TIMEOUT_MS)

  test('carries the entry point, the licences and the notices', () => {
    expect(REQUIRED_PATHS.filter((path) => !paths.includes(path))).toEqual([])
  })

  test('carries nothing outside the allowlist', () => {
    const offenders = paths.filter((path) => !ALLOWED_PATH.some((pattern) => pattern.test(path)))

    expect(offenders).toEqual([])
  })

  test('carries no working notes, sources, tests, source maps or declarations', () => {
    const offenders = paths.filter(
      (path) =>
        FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
        FORBIDDEN_SUFFIXES.some((suffix) => path.endsWith(suffix)),
    )

    expect(offenders).toEqual([])
  })

  test('every compiled module has its source — no code that was deleted from src/', () => {
    const stale = paths
      .filter((path) => path.startsWith('dist/') && path.endsWith('.js'))
      .filter((path) => !existsSync(join(PROJECT_ROOT, 'src', path.slice('dist/'.length).replace(/\.js$/, '.ts'))))

    expect(stale).toEqual([])
  })
})

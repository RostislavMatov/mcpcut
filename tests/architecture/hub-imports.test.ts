import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * The hub (`hub/`, PRD `hosted-accounts` phase 2, ADR-0017) is a separate
 * process on `mcpcut.com`, not an install. It borrows a handful of
 * dependency-free primitives from `src/` instead of copying them (plan
 * `hub-signin-accounts`, decision H1), and nothing else: a hub that reached
 * `src/config.ts` would resolve an install's data directory at import, and
 * one that reached the vault, the registry or the journal would be a second
 * door into an install's state.
 *
 * Two rules, both derived rather than listed file by file:
 *  1. every `src/` file the hub reaches — directly or through another `src/`
 *     file — is in `HUB_SRC_ALLOWLIST`;
 *  2. nothing under `src/` imports `hub/`.
 */

const PROJECT_ROOT = process.cwd()

/** The only `src/` modules the hub may reach, transitively included. */
const HUB_SRC_ALLOWLIST: ReadonlySet<string> = new Set([
  'src/ui/html.ts',
  'src/ui/security-headers.ts',
  'src/ui/constants.ts',
  'src/security/token.ts',
  'src/store/sqlite.ts',
  'src/store/file-modes.ts',
  'src/net/origin-host.ts',
  'src/ui/assets/asset.ts',
  'src/ui/assets/fonts.ts',
  'src/ui/assets/favicon.ts',
  // `src/ui/constants.ts` re-exports `BRAND_NAME` from here (its own docstring:
  // "a leaf module with no imports at all"). Task 4's `hub/src/pages/layout.ts`
  // uses `BRAND_NAME`, which reaches this file transitively; it carries no
  // install state, so it is safe on the allowlist.
  'src/brand.ts',
])

const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function importSpecifiersOf(source: string): string[] {
  const specifiers: string[] = []
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1])
    }
  }
  return specifiers
}

function tsFilesUnder(relativeDir: string): string[] {
  const root = join(PROJECT_ROOT, relativeDir)
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(PROJECT_ROOT, join(entry.parentPath, entry.name)))
    .sort()
}

/** A relative specifier resolved to a repo-relative `.ts` path, or undefined for a package. */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  return normalize(join(dirname(fromFile), specifier.replace(/\.js$/, '.ts')))
}

/** Every `src/` file reachable from the hub, with the file that first pulled it in. */
function srcFilesReachedByHub(): Map<string, string> {
  const reached = new Map<string, string>()
  const queue = tsFilesUnder('hub/src')
  const seen = new Set<string>(queue)
  while (queue.length > 0) {
    const file = queue.shift() as string
    const source = readFileSync(join(PROJECT_ROOT, file), 'utf8')
    for (const specifier of importSpecifiersOf(source)) {
      const target = resolveRelative(file, specifier)
      if (target === undefined || seen.has(target)) continue
      seen.add(target)
      if (target.startsWith('src/')) reached.set(target, file)
      queue.push(target)
    }
  }
  return reached
}

describe('the hub borrows only dependency-free primitives from src/ (H1)', () => {
  test('every src/ file the hub reaches, transitively, is on the allowlist', () => {
    const offenders = [...srcFilesReachedByHub()]
      .filter(([target]) => !HUB_SRC_ALLOWLIST.has(target))
      .map(([target, via]) => `${target} (via ${via})`)

    expect(offenders).toEqual([])
  })

  test('every allowlisted file exists (a rename must update the list, not silently widen it)', () => {
    const missing = [...HUB_SRC_ALLOWLIST].filter((file) => !existsSync(join(PROJECT_ROOT, file)))

    expect(missing).toEqual([])
  })

  test('nothing under src/ imports hub/', () => {
    const offenders = tsFilesUnder('src').filter((file) => {
      const source = readFileSync(join(PROJECT_ROOT, file), 'utf8')
      return importSpecifiersOf(source).some((specifier) => {
        const target = resolveRelative(file, specifier)
        return target !== undefined && target.startsWith('hub/')
      })
    })

    expect(offenders).toEqual([])
  })

  test('the resolver sees through ../ into src/', () => {
    expect(resolveRelative('hub/src/pages/layout.ts', '../../../src/ui/html.js')).toBe('src/ui/html.ts')
    expect(resolveRelative('hub/src/x.ts', 'node:http')).toBeUndefined()
  })
})

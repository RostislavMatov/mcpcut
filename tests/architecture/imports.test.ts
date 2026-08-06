import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * Mechanical enforcement of the architectural invariant from CLAUDE.md:
 * transport (framing, splice/pipeline) must never know about JSON-RPC or
 * MCP semantics. Rather than hardcode the transport file list (which leaves a
 * newly added transport module unguarded until someone remembers to list it),
 * the transport set is *derived*: every `.ts` under `src/proxy`,
 * `src/protocol` and `src/transport` — recursively, so a new subdirectory
 * cannot slip out of coverage — minus an explicit allowlist of the semantic
 * modules that are permitted to import `protocol/classify.ts`,
 * `protocol/mcp.ts`, and `policy/*`. A brand-new file therefore defaults to
 * "must stay pure".
 */

const PROJECT_ROOT = process.cwd()

/**
 * Directories whose `.ts` files (at any depth) are transport unless
 * explicitly allowlisted. `src/transport` is claimed ahead of its creation
 * (M3): a directory that does not exist yet contributes nothing, but the
 * moment it appears every file in it is covered.
 */
const TRANSPORT_DIRS: readonly string[] = ['src/proxy', 'src/protocol', 'src/transport']

/**
 * The semantic layer: modules allowed to import JSON-RPC/MCP/policy. Anything
 * in `TRANSPORT_DIRS` NOT listed here is treated as transport and checked, so
 * the guard fails safe (toward more checking) when a new module appears.
 */
const SEMANTIC_ALLOWLIST: ReadonlySet<string> = new Set([
  'src/proxy/gate.ts',
  'src/proxy/gate-core.ts',
  'src/proxy/gate-types.ts',
  'src/proxy/gate-helpers.ts',
  'src/proxy/gate-approvals.ts',
  'src/proxy/gate-router.ts',
  'src/proxy/tool-catalog.ts',
  'src/proxy/synthesize.ts',
  'src/proxy/tools-filter.ts',
  'src/proxy/relay.ts',
  'src/proxy/wrap.ts',
  'src/proxy/wire-policy.ts',
  'src/proxy/journal-failure.ts',
  'src/protocol/classify.ts',
  'src/protocol/mcp.ts',
])

/** True for the one error a watched-but-not-yet-created directory produces. */
function isMissingDirError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

/**
 * Recursively collects every non-allowlisted `.ts` file under `dirs`
 * (relative to `rootDir`). A missing top-level directory is tolerated (it may
 * be claimed ahead of creation); any other filesystem error propagates.
 */
export function collectTransportFiles(
  rootDir: string,
  dirs: readonly string[],
  allowlist: ReadonlySet<string>,
): string[] {
  const files: string[] = []

  function walk(relativeDir: string): void {
    let entries
    try {
      entries = readdirSync(join(rootDir, relativeDir), { withFileTypes: true })
    } catch (error: unknown) {
      if (isMissingDirError(error)) return
      throw error
    }
    for (const entry of entries) {
      const relativePath = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(relativePath)
      } else if (entry.name.endsWith('.ts') && !allowlist.has(relativePath)) {
        files.push(relativePath)
      }
    }
  }

  for (const dir of dirs) walk(dir)
  return files.sort()
}

function transportFiles(): string[] {
  return collectTransportFiles(PROJECT_ROOT, TRANSPORT_DIRS, SEMANTIC_ALLOWLIST)
}

/**
 * Every way a module can pull in another: static `import`/`export ... from`,
 * a side-effect `import '...'`, a dynamic `import('...')`, and `require('...')`.
 * A guard that only understood `... from '...'` would silently miss the last
 * three (TS-M3).
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** Matches a specifier that reaches into a semantic (JSON-RPC/MCP/policy) module. */
function isForbiddenSpecifier(specifier: string): boolean {
  return (
    /(?:^|\/)classify(?:\.js)?$/.test(specifier) ||
    /(?:^|\/)protocol\/mcp(?:\.js)?$/.test(specifier) ||
    /(?:^|\/)policy\//.test(specifier)
  )
}

function importSpecifiersOf(source: string): string[] {
  const specifiers: string[] = []
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) specifiers.push(specifier)
    }
  }
  return specifiers
}

describe('transport modules stay ignorant of JSON-RPC/MCP semantics', () => {
  test.each(transportFiles())('%s imports no classify/mcp/policy module', (relativePath) => {
    const source = readFileSync(join(PROJECT_ROOT, relativePath), 'utf8')
    const specifiers = importSpecifiersOf(source)

    const forbidden = specifiers.filter(isForbiddenSpecifier)

    expect(forbidden).toEqual([])
  })

  test('the derived transport set includes the core framing/relay modules', () => {
    const files = transportFiles()
    for (const expected of [
      'src/proxy/pipeline.ts',
      'src/proxy/writer.ts',
      'src/proxy/splice.ts',
      'src/proxy/spawn.ts',
      'src/protocol/split.ts',
      'src/protocol/frame.ts',
    ]) {
      expect(files).toContain(expected)
    }
  })

  test('the walker is recursive: a nested subdirectory cannot escape coverage', () => {
    // Arrange: a synthetic tree with a transport file buried two levels deep,
    // plus an allowlisted file that must be skipped and a non-.ts file.
    const root = mkdtempSync(join(tmpdir(), 'imports-guard-test-'))
    try {
      mkdirSync(join(root, 'src/transport/http/deep'), { recursive: true })
      writeFileSync(join(root, 'src/transport/message.ts'), '')
      writeFileSync(join(root, 'src/transport/http/session.ts'), '')
      writeFileSync(join(root, 'src/transport/http/deep/nested.ts'), '')
      writeFileSync(join(root, 'src/transport/http/notes.md'), '')

      // Act
      const files = collectTransportFiles(
        root,
        ['src/transport'],
        new Set(['src/transport/http/session.ts']),
      )

      // Assert
      expect(files).toEqual(['src/transport/http/deep/nested.ts', 'src/transport/message.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a watched directory that does not exist yet contributes nothing without failing', () => {
    expect(collectTransportFiles(PROJECT_ROOT, ['src/does-not-exist-yet'], new Set())).toEqual([])
  })

  test('src/transport is already watched, so its first file is covered on arrival', () => {
    expect(TRANSPORT_DIRS).toContain('src/transport')
  })

  test('the extractor catches side-effect, dynamic, and require imports too', () => {
    expect(importSpecifiersOf("import '../policy/decide.js'")).toContain('../policy/decide.js')
    expect(importSpecifiersOf("await import('../protocol/mcp.js')")).toContain('../protocol/mcp.js')
    expect(importSpecifiersOf("const x = require('../protocol/classify.js')")).toContain(
      '../protocol/classify.js',
    )
    expect(importSpecifiersOf("import { a } from '../policy/schema.js'")).toContain(
      '../policy/schema.js',
    )
  })

  test('the forbidden-specifier matcher actually catches a semantic import', () => {
    // Guards the guard: if this ever stops matching, the test above would
    // pass vacuously no matter what a transport module imports.
    expect(isForbiddenSpecifier('../protocol/classify.js')).toBe(true)
    expect(isForbiddenSpecifier('../protocol/mcp.js')).toBe(true)
    expect(isForbiddenSpecifier('../policy/decide.js')).toBe(true)
    expect(isForbiddenSpecifier('../protocol/split.js')).toBe(false)
  })
})

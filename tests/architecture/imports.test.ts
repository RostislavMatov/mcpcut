import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * Mechanical enforcement of the architectural invariant from CLAUDE.md:
 * transport (framing, splice/pipeline) must never know about JSON-RPC or
 * MCP semantics. Rather than hardcode the transport file list (which leaves a
 * newly added transport module unguarded until someone remembers to list it),
 * the transport set is *derived*: every `.ts` under `src/proxy` and
 * `src/protocol`, minus an explicit allowlist of the semantic modules that
 * are permitted to import `protocol/classify.ts`, `protocol/mcp.ts`, and
 * `policy/*`. A brand-new file therefore defaults to "must stay pure".
 */

const PROJECT_ROOT = process.cwd()

/** Directories whose `.ts` files are transport unless explicitly allowlisted. */
const TRANSPORT_DIRS: readonly string[] = ['src/proxy', 'src/protocol']

/**
 * The semantic layer: modules allowed to import JSON-RPC/MCP/policy. Anything
 * in `TRANSPORT_DIRS` NOT listed here is treated as transport and checked, so
 * the guard fails safe (toward more checking) when a new module appears.
 */
const SEMANTIC_ALLOWLIST: ReadonlySet<string> = new Set([
  'src/proxy/gate.ts',
  'src/proxy/gate-helpers.ts',
  'src/proxy/synthesize.ts',
  'src/proxy/tools-filter.ts',
  'src/proxy/relay.ts',
  'src/proxy/wrap.ts',
  'src/proxy/wire-policy.ts',
  'src/proxy/journal-failure.ts',
  'src/protocol/classify.ts',
  'src/protocol/mcp.ts',
])

function transportFiles(): string[] {
  const files: string[] = []
  for (const dir of TRANSPORT_DIRS) {
    for (const name of readdirSync(join(PROJECT_ROOT, dir))) {
      if (!name.endsWith('.ts')) continue
      const relativePath = `${dir}/${name}`
      if (!SEMANTIC_ALLOWLIST.has(relativePath)) files.push(relativePath)
    }
  }
  return files.sort()
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

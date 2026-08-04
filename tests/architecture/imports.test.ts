import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * Mechanical enforcement of the architectural invariant from CLAUDE.md:
 * transport (framing, splice/pipeline) must never know about JSON-RPC or
 * MCP semantics. Every module listed here is required to stay ignorant of
 * `protocol/classify.ts`, `protocol/mcp.ts`, and everything under
 * `policy/`; the semantic layer sits strictly above them
 * (`proxy/gate.ts` -> `protocol/mcp.ts` -> `protocol/classify.ts` ->
 * `policy/*`).
 */

const PROJECT_ROOT = process.cwd()

/** Every transport-layer module this invariant applies to. */
const TRANSPORT_FILES: readonly string[] = [
  'src/proxy/pipeline.ts',
  'src/proxy/writer.ts',
  'src/proxy/splice.ts',
  'src/proxy/spawn.ts',
  'src/protocol/split.ts',
  'src/protocol/frame.ts',
]

/** Matches an ES module import/export specifier's quoted source path. */
const IMPORT_SPECIFIER_PATTERN = /^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm

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
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1]
    if (specifier !== undefined) {
      specifiers.push(specifier)
    }
  }
  return specifiers
}

describe('transport modules stay ignorant of JSON-RPC/MCP semantics', () => {
  test.each(TRANSPORT_FILES)('%s imports no classify/mcp/policy module', (relativePath) => {
    const source = readFileSync(join(PROJECT_ROOT, relativePath), 'utf8')
    const specifiers = importSpecifiersOf(source)

    const forbidden = specifiers.filter(isForbiddenSpecifier)

    expect(forbidden).toEqual([])
  })

  test('the forbidden-specifier matcher actually catches a semantic import', () => {
    // Guards the guard: if this ever stops matching, the test above would
    // pass vacuously no matter what pipeline.ts/writer.ts import.
    expect(isForbiddenSpecifier('../protocol/classify.js')).toBe(true)
    expect(isForbiddenSpecifier('../protocol/mcp.js')).toBe(true)
    expect(isForbiddenSpecifier('../policy/decide.js')).toBe(true)
    expect(isForbiddenSpecifier('../protocol/split.js')).toBe(false)
  })
})

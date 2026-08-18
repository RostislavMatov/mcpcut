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
  // The decision-record choke point: it fingerprints the effective policy, so
  // it is semantic by construction (extracted from `gate-helpers.ts`, M5).
  'src/proxy/gate-decision-writer.ts',
  // The decide-input assembly: it calls `classifyTool` and builds `DecideInput`,
  // so it is semantic by definition (extracted from `gate-core.ts`, M5 wave-2
  // review — the snapshot-at-decision-time fix needed the line budget).
  'src/proxy/gate-decide-input.ts',
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

/**
 * `src/net/**` is the module both HTTP fronts (agent-facing `serve`, admin UI
 * in M4) may import without pulling in transport machinery — which only holds
 * while it depends on nothing but the platform. Any project-internal import
 * would re-create the coupling the module exists to avoid.
 */
describe('src/net stays dependency-free', () => {
  test.each(collectTransportFiles(PROJECT_ROOT, ['src/net'], new Set()))(
    '%s imports only node:* modules',
    (relativePath) => {
      const source = readFileSync(join(PROJECT_ROOT, relativePath), 'utf8')

      const offending = importSpecifiersOf(source).filter(
        (specifier) => !specifier.startsWith('node:'),
      )

      expect(offending).toEqual([])
    },
  )

  test('the net directory is present and covered (the rule is not vacuous)', () => {
    expect(collectTransportFiles(PROJECT_ROOT, ['src/net'], new Set())).toContain(
      'src/net/origin-host.ts',
    )
  })
})

// ---------------------------------------------------------------------------
// The admin UI layer (M4, ADR-0004 §6). Three rules, mechanized here — before
// Task 18 the "UI never reaches the vault's value path" guarantee was only a
// source check inside `tests/ui/servers.test.ts`, which covered one file.
// ---------------------------------------------------------------------------

/** Every `.ts` under `src/ui`, recursively. Empty before the directory exists. */
function uiFiles(): string[] {
  return collectTransportFiles(PROJECT_ROOT, ['src/ui'], new Set())
}

/**
 * The ONLY modules outside `src/ui/**` allowed to import it. `ui-cmd.ts` is the
 * process entry point, `ui-wiring.ts` its composition root, and `ui-constants.ts`
 * re-exports the two bind defaults so the CLI's flag parsing does not fork them.
 * Everything else must reach the UI through none of its internals: a second
 * importer is how an operator surface quietly becomes a library.
 */
const UI_IMPORTER_ALLOWLIST: ReadonlySet<string> = new Set([
  'src/cli/ui-cmd.ts',
  'src/cli/ui-wiring.ts',
  'src/cli/ui-constants.ts',
])

/**
 * True for a specifier reaching into the traffic layer. `src/net/**` is
 * deliberately NOT matched: `net/origin-host.ts` is the shared, dependency-free
 * Host/Origin screen both HTTP fronts import (guarded by its own rule above).
 */
function isTrafficSpecifier(specifier: string): boolean {
  return /(?:^|\/)proxy\//.test(specifier) || /(?:^|\/)transport\//.test(specifier)
}

/** True for a specifier reaching the vault's secret-VALUE resolution path. */
function isVaultValueSpecifier(specifier: string): boolean {
  return /(?:^|\/)vault\/resolve(?:\.js)?$/.test(specifier)
}

/** True for a specifier that reaches into `src/ui/**` from outside it. */
function isUiSpecifier(specifier: string): boolean {
  return /(?:^|\/)ui\//.test(specifier)
}

describe('the admin UI is an operator surface, not a traffic or secret surface', () => {
  test.each(uiFiles())('%s imports no proxy/transport module', (relativePath) => {
    const source = readFileSync(join(PROJECT_ROOT, relativePath), 'utf8')

    const forbidden = importSpecifiersOf(source).filter(isTrafficSpecifier)

    expect(forbidden).toEqual([])
  })

  test.each(uiFiles())('%s never reaches a vault secret value', (relativePath) => {
    const source = readFileSync(join(PROJECT_ROOT, relativePath), 'utf8')

    // Both halves matter: the import graph AND the symbol. A re-export
    // elsewhere would defeat a specifier-only check.
    expect(importSpecifiersOf(source).filter(isVaultValueSpecifier)).toEqual([])
    expect(source).not.toContain('readSecretValues')
  })

  test('the UI directory is covered, and the rules are not vacuous', () => {
    const files = uiFiles()
    for (const expected of [
      'src/ui/server.ts',
      'src/ui/handlers/servers.ts',
      'src/ui/pages/layout.ts',
      'src/ui/assets/app-js.ts',
    ]) {
      expect(files).toContain(expected)
    }
    // Guards the guards: each matcher really does catch what it is named for.
    expect(isTrafficSpecifier('../proxy/gate.js')).toBe(true)
    expect(isTrafficSpecifier('../transport/http/server.js')).toBe(true)
    expect(isVaultValueSpecifier('../vault/resolve.js')).toBe(true)
    expect(isUiSpecifier('../ui/server.js')).toBe(true)
    // …and that the one shared HTTP primitive the UI DOES import stays allowed.
    expect(isTrafficSpecifier('../net/origin-host.js')).toBe(false)
    expect(
      importSpecifiersOf(readFileSync(join(PROJECT_ROOT, 'src/ui/server.ts'), 'utf8')),
    ).toContain('../net/origin-host.js')
  })

  test('nothing outside the UI and its CLI entry points imports src/ui/**', () => {
    const outsiders = collectTransportFiles(PROJECT_ROOT, ['src'], new Set()).filter(
      (relativePath) =>
        !relativePath.startsWith('src/ui/') && !UI_IMPORTER_ALLOWLIST.has(relativePath),
    )

    const offenders = outsiders.filter((relativePath) =>
      importSpecifiersOf(readFileSync(join(PROJECT_ROOT, relativePath), 'utf8')).some(isUiSpecifier),
    )

    expect(offenders).toEqual([])
  })

  test('the importer allowlist names real files, so it cannot rot unnoticed', () => {
    const all = collectTransportFiles(PROJECT_ROOT, ['src'], new Set())
    for (const allowed of UI_IMPORTER_ALLOWLIST) {
      expect(all).toContain(allowed)
    }
  })
})

// ---------------------------------------------------------------------------
// The storage boundary (M4.5, ADR-0006). `src/store/sqlite.ts` is the single
// point of contact with `node:sqlite`: opening, PRAGMAs, transactions and the
// busy classification all live there, so a change of driver or of that
// module's API surface is one file's problem. Until now that was a comment in
// the module and a habit; here it is a rule.
// ---------------------------------------------------------------------------

/** The one module allowed to import `node:sqlite`. Everything else goes through it. */
const SQLITE_ADAPTER = 'src/store/sqlite.ts'

/**
 * Matches the driver specifier only as an IMPORT specifier, never as prose:
 * `src/store/sqlite.ts` and several journal modules name `node:sqlite` in
 * their doc comments, and a raw substring search over the source would call
 * every one of them an offender.
 */
function isSqliteDriverSpecifier(specifier: string): boolean {
  return specifier === 'node:sqlite' || specifier.startsWith('node:sqlite/')
}

/** Every `.ts` under `src` except the adapter — the whole set the rule covers. */
function nonAdapterFiles(): string[] {
  return collectTransportFiles(PROJECT_ROOT, ['src'], new Set([SQLITE_ADAPTER]))
}

describe('node:sqlite is reached through the store adapter alone', () => {
  test('nothing outside the store adapter imports the node:sqlite driver', () => {
    // One case rather than one per file, mirroring the src-wide UI rule above:
    // the offender list is the failure message, and enumerating every module
    // in `src` would drown the suite in cases.
    const offenders = nonAdapterFiles().filter((relativePath) =>
      importSpecifiersOf(readFileSync(join(PROJECT_ROOT, relativePath), 'utf8')).some(
        isSqliteDriverSpecifier,
      ),
    )

    expect(offenders).toEqual([])
  })

  test('the adapter itself does import the driver, so the rule is not vacuous', () => {
    const source = readFileSync(join(PROJECT_ROOT, SQLITE_ADAPTER), 'utf8')

    expect(importSpecifiersOf(source).filter(isSqliteDriverSpecifier)).toEqual(['node:sqlite'])
  })

  test('the covered set is the whole of src minus the adapter', () => {
    const covered = nonAdapterFiles()

    expect(covered).not.toContain(SQLITE_ADAPTER)
    // Sampled from the modules that talk to the database THROUGH the adapter:
    // if any of them ever imported the driver directly, this rule is what
    // would catch it.
    for (const expected of ['src/journal/db.ts', 'src/journal/batch-writer.ts']) {
      expect(covered).toContain(expected)
    }
  })

  test('the matcher reads import specifiers, not doc comments that mention the driver', () => {
    expect(isSqliteDriverSpecifier('node:sqlite')).toBe(true)
    expect(isSqliteDriverSpecifier('../store/sqlite.js')).toBe(false)
    expect(importSpecifiersOf("import { DatabaseSync } from 'node:sqlite'")).toEqual(['node:sqlite'])
    expect(importSpecifiersOf('/** never imports node:sqlite directly */')).toEqual([])
  })
})

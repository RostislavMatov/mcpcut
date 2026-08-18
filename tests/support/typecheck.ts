import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Compile-time assertions for contracts whose whole point is what the
 * compiler refuses to accept.
 *
 * `tsconfig.json` excludes `tests/`, and vitest transpiles without
 * typechecking, so a `@ts-expect-error` in a test file pins nothing. Where a
 * finding is "the type system must force the next wave to handle this", the
 * only honest test is to run the project's own compiler over a fixture and
 * assert on the diagnostics. One invocation costs ~0.35 s.
 */

const PROJECT_ROOT = process.cwd()
const TSC_BIN = join(PROJECT_ROOT, 'node_modules', '.bin', 'tsc')

/** The project's compiler settings, minus the project file's `include`. */
const TSC_FLAGS: readonly string[] = [
  '--noEmit',
  '--strict',
  '--exactOptionalPropertyTypes',
  '--noUncheckedIndexedAccess',
  '--target',
  'ES2022',
  '--module',
  'NodeNext',
  '--moduleResolution',
  'NodeNext',
  '--skipLibCheck',
  '--lib',
  'ES2022',
]

/**
 * Typechecks `source` as a standalone module and returns tsc's diagnostics
 * (empty string when it compiles cleanly).
 *
 * The fixture is written under `tests/` so its relative import of `../../src`
 * and its `node_modules` resolution behave exactly as real source does.
 */
export function typecheckSource(source: string): string {
  const dir = mkdtempSync(join(PROJECT_ROOT, 'tests', 'tc-'))
  const file = join(dir, 'fixture.ts')
  try {
    writeFileSync(file, source, 'utf8')
    execFileSync(TSC_BIN, [...TSC_FLAGS, file], { encoding: 'utf8', stdio: 'pipe' })
    return ''
  } catch (error: unknown) {
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const stderr = (error as { stderr?: string }).stderr ?? ''
    return `${stdout}${stderr}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

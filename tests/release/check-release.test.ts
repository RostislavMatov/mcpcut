import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { releaseProblems } from '../../tools/release/check-release.mjs'

/**
 * Plan R3: a version number on npm can never be reused, so `npm publish`
 * refuses to run from an uncommitted tree or an untagged commit. Under
 * `npm publish --dry-run` the same findings are warnings.
 */

const GUARD_PATH = join(process.cwd(), 'tools/release/check-release.mjs')

/** Each process test runs `git` a few times and one `node`. */
const SPAWN_TIMEOUT_MS = 20_000

/** The variables a parent shell (or CI) could leak into the guard's decision. */
const LEAKY_ENV: readonly string[] = ['GITHUB_REF_TYPE', 'GITHUB_REF_NAME', 'npm_config_dry_run']

describe('releaseProblems', () => {
  const base = {
    version: '0.1.0',
    isClean: true,
    tagsAtHead: ['v0.1.0'],
    ciTag: undefined,
    bin: { mcpcut: 'dist/cli.js' },
  }

  test('a clean tree tagged with the version is fine', () => {
    expect(releaseProblems(base)).toEqual([])
  })

  test('a bin path written ./… is one finding: npm 11 publish drops such a bin', () => {
    const problems = releaseProblems({ ...base, bin: { mcpcut: './dist/cli.js' } })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('bin.mcpcut')
    expect(problems[0]).toContain('./dist/cli.js')
  })

  test('a missing bin is one finding: the package would install no command', () => {
    const problems = releaseProblems({ ...base, bin: undefined })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('bin')
  })

  test('a dirty tree is one finding', () => {
    const problems = releaseProblems({ ...base, isClean: false })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('uncommitted')
  })

  test('an untagged HEAD names the tag it expects', () => {
    const problems = releaseProblems({ ...base, tagsAtHead: [] })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('v0.1.0')
  })

  test('a tag of another version does not count', () => {
    expect(releaseProblems({ ...base, tagsAtHead: ['v0.0.9'] })).toHaveLength(1)
  })

  test('in CI the pushed tag stands in for a local one', () => {
    expect(releaseProblems({ ...base, tagsAtHead: [], ciTag: 'v0.1.0' })).toEqual([])
  })

  test('a CI tag of another version does not count', () => {
    expect(releaseProblems({ ...base, tagsAtHead: [], ciTag: 'v0.2.0' })).toHaveLength(1)
  })
})

interface ChildResult {
  readonly code: number | null
  readonly stderr: string
}

function cleanEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !LEAKY_ENV.includes(key)))
  return { ...env, ...extra }
}

function runGuard(cwd: string, extra: Readonly<Record<string, string>> = {}): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GUARD_PATH], { cwd, env: cleanEnv(extra), stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr }))
  })
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: 'ignore' })
}

function committedRepo(bin: Record<string, string> = { x: 'dist/cli.js' }): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcpcut-guard-'))
  git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0', bin }))
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

describe('check-release.mjs as npm runs it', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function repo(bin?: Record<string, string>): string {
    const dir = committedRepo(bin)
    dirs.push(dir)
    return dir
  }

  test(
    'a dirty, untagged tree stops the publish with error lines',
    async () => {
      const dir = repo()
      writeFileSync(join(dir, 'stray.txt'), 'x')

      const result = await runGuard(dir)

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^error: .*uncommitted/m)
      expect(result.stderr).toMatch(/^error: HEAD is not tagged v0\.1\.0/m)
    },
    SPAWN_TIMEOUT_MS,
  )

  test(
    'a clean, tagged tree with a ./-prefixed bin still stops the publish',
    async () => {
      const dir = repo({ x: './dist/cli.js' })
      git(dir, ['tag', '-a', 'v0.1.0', '-m', 'mcpcut 0.1.0'])

      const result = await runGuard(dir)

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^error: bin\.x is "\.\/dist\/cli\.js"/m)
    },
    SPAWN_TIMEOUT_MS,
  )

  test(
    'the same tree under --dry-run only warns, and the rehearsal goes on',
    async () => {
      const dir = repo()
      writeFileSync(join(dir, 'stray.txt'), 'x')

      const result = await runGuard(dir, { npm_config_dry_run: 'true' })

      expect(result.code).toBe(0)
      expect(result.stderr).toMatch(/^warning: /m)
      expect(result.stderr).not.toMatch(/^error: /m)
    },
    SPAWN_TIMEOUT_MS,
  )

  test(
    'a clean tree tagged v<version> passes in silence',
    async () => {
      const dir = repo()
      git(dir, ['tag', '-a', 'v0.1.0', '-m', 'mcpcut 0.1.0'])

      const result = await runGuard(dir)

      expect(result).toEqual({ code: 0, stderr: '' })
    },
    SPAWN_TIMEOUT_MS,
  )
})

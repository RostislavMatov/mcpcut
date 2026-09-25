import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { translationsFromText } from '../../tools/release/export-checks.mjs'

/**
 * Plan R5, R8, R14 (ADR-0011, decision D1): the public repository carries the
 * private history run through `git filter-repo`. The export filters a fresh
 * clone, checks the result mechanically, and only then moves `main` of the
 * public clone — and only forward, unless a rewrite is asked for.
 */

const PROJECT_ROOT = process.cwd()
const EXPORT_PATH = join(PROJECT_ROOT, 'tools/release/export-public.mjs')
const RULES_DIR = '.claude/release/filter'

/** Two `filter-repo` runs (the determinism check) plus a few clones per test. */
const EXPORT_TIMEOUT_MS = 60_000

/** The maintainer's tool, not a dependency: GitHub's runners do not have it, and the suite says so by skipping. */
const hasFilterRepo = spawnSync('git', ['filter-repo', '--version'], { stdio: 'ignore' }).status === 0

const PRIVATE_EMAIL = 'private@corp.example'
const PUBLIC_EMAIL = 'public@users.noreply.github.com'
const PUBLIC_REMOTE = 'https://github.com/RostislavMatov/mcpcut.git'

const RULES: Readonly<Record<string, string>> = {
  'paths.txt': '.claude/\ndocs/pitch/\n.mcpcut-project/\nCLAUDE.md\n',
  'replace-text.txt': 'SECRET-HOME==>HOME\n',
  'replace-message.txt': 'AcmeCorp==>an outreach company\n',
  'forbidden.txt': '# nothing below may survive the filter\nregex:corp\\.example\n',
  mailmap: `Public Name <${PUBLIC_EMAIL}> <${PRIVATE_EMAIL}>\n`,
  'translate-message.json': '{}\n',
}

interface ChildResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', `user.email=${PRIVATE_EMAIL}`, ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

function commit(root: string, files: Readonly<Record<string, string>>, message: string): void {
  write(root, files)
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', message])
}

function runExport(cwd: string, args: readonly string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EXPORT_PATH, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function rulesFiles(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...RULES, ...overrides }).map(([name, text]) => [`${RULES_DIR}/${name}`, text]),
  )
}

describe.skipIf(!hasFilterRepo)('export-public.mjs: the filtered history', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tempDir(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpcut-export-')))
    dirs.push(dir)
    return dir
  }

  function repoAt(dir: string): string {
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '-q', '-b', 'main'])
    return dir
  }

  /** Four commits: a secret in a file, a commit only under `.claude/`, excluded paths plus a company in the message, the dogfood policy. */
  function source(overrides: Readonly<Record<string, string>> = {}): string {
    const root = repoAt(join(tempDir(), 'private'))
    commit(root, { 'a.txt': 'cd SECRET-HOME/path\n', 'docs/adr/x.md': '# x\n' }, 'feat: first')
    commit(root, { '.claude/p.md': 'notes\n', ...rulesFiles(overrides) }, 'docs: working notes')
    commit(root, { 'docs/pitch/p.md': 'pitch\n', 'CLAUDE.md': 'memory\n', 'a.txt': 'cd path\n' }, 'docs: touch AcmeCorp')
    commit(root, { '.mcpcut-project/policy.json': '{}\n', 'b.txt': 'b\n' }, 'feat: fourth')
    return root
  }

  function target(): string {
    return repoAt(join(tempDir(), 'public'))
  }

  test(
    'drops the excluded paths from every commit, replaces the private strings and maps the authors',
    async () => {
      const [from, to] = [source(), target()]

      const result = await runExport(from, [to])

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/^exported 3 commits \(1 dropped as empty\), main [0-9a-f]{40} → /)
      expect(git(to, ['rev-list', '--count', 'main'])).toBe('3')
      const paths = git(to, ['log', '--all', '--name-only', '--format=']).split('\n')
      expect(paths.filter((path) => /^(\.claude\/|docs\/pitch\/|\.mcpcut-project\/|CLAUDE\.md$)/.test(path))).toEqual([])
      expect(git(to, ['log', '--all', '-p', '--format=%B'])).not.toMatch(/SECRET-HOME|AcmeCorp/)
      expect(new Set(git(to, ['log', '--all', '--format=%ae%n%ce']).split('\n'))).toEqual(new Set([PUBLIC_EMAIL]))
      expect(readFileSync(join(to, 'b.txt'), 'utf8')).toBe('b\n')
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'a second export into the same clone lands on the same main (the filter is deterministic)',
    async () => {
      const [from, to] = [source(), target()]

      await runExport(from, [to])
      const first = git(to, ['rev-parse', 'main'])
      const again = await runExport(from, [to])

      expect(again.code).toBe(0)
      expect(git(to, ['rev-parse', 'main'])).toBe(first)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'refuses to rewrite a published main unless asked to',
    async () => {
      const from = source()
      const bare = join(tempDir(), 'origin.git')
      git(tempDir(), ['init', '-q', '--bare', '-b', 'main', bare])
      const other = repoAt(join(tempDir(), 'other'))
      commit(other, { 'z.txt': 'z\n' }, 'unrelated')
      git(other, ['push', '-q', bare, 'main'])
      const to = target()
      // The remote must be the public address; `insteadOf` sends the fetch to the bare repository.
      git(to, ['remote', 'add', 'origin', PUBLIC_REMOTE])
      git(to, ['config', `url.${bare}.insteadOf`, PUBLIC_REMOTE])

      const refused = await runExport(from, [to])
      const forced = await runExport(from, [to, '--allow-rewrite'])

      expect(refused.code).toBe(1)
      expect(refused.stderr).toMatch(/^error: the published history would be rewritten/m)
      expect(forced.code).toBe(0)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'a forbidden string the rules do not cover stops the export and is named by rule and commit, never quoted',
    async () => {
      const from = source({ 'forbidden.txt': 'regex:corp\\.example\nLEAKY-TOKEN\n' })
      commit(from, { 'c.txt': 'value LEAKY-TOKEN-123\n' }, 'feat: fifth')
      const to = target()

      const result = await runExport(from, [to])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/forbidden\.txt:2/)
      expect(result.stderr).toMatch(/c\.txt/)
      expect(result.stderr).toMatch(/commit [0-9a-f]{7,}/)
      expect(result.stderr).not.toContain('LEAKY')
      expect(git(to, ['rev-list', '--all']).length).toBe(0)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'a forbidden string in a commit message stops the export too',
    async () => {
      const from = source({ 'forbidden.txt': 'Mallory\n' })
      commit(from, { 'd.txt': 'd\n' }, 'feat: thanks to Mallory')

      const result = await runExport(from, [target()])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/message of commit [0-9a-f]{7,}.*forbidden\.txt:1/)
      expect(result.stderr).not.toContain('Mallory')
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'refuses a dirty source and leaves the target alone',
    async () => {
      const [from, to] = [source(), target()]
      writeFileSync(join(from, 'stray.txt'), 'x')

      const result = await runExport(from, [to])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^error: commit first/m)
      expect(git(to, ['rev-list', '--all']).length).toBe(0)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'refuses a target that is not the root of its own clone, has a foreign origin, or lives inside the source',
    async () => {
      const from = source()
      const outer = target()
      const nested = join(outer, 'sub')
      mkdirSync(nested)
      const foreign = target()
      git(foreign, ['remote', 'add', 'origin', 'https://github.com/someone/else.git'])
      // Ignored, so the source stays clean and the refusal is about where the target is.
      commit(from, { '.gitignore': 'inner/\n' }, 'chore: ignore inner')
      const inside = repoAt(join(from, 'inner'))

      const results = await Promise.all([nested, foreign, inside].map((to) => runExport(from, [to])))

      expect(results.map((result) => result.code)).toEqual([1, 1, 1])
      expect(results[0]?.stderr).toMatch(/not the root of a git clone/)
      expect(results[1]?.stderr).toMatch(/origin/)
      expect(results[2]?.stderr).toMatch(/inside/)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'a replacement rule that matches nothing in the exported history stops the export, named but not quoted',
    async () => {
      // A misspelled name: the filter would leave the real one in place.
      const from = source({ 'replace-text.txt': 'SECRET-HOME==>HOME\nSECERT-HOME==>HOME\n' })
      const to = target()

      const result = await runExport(from, [to])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/replace-text\.txt:2 matches nothing/)
      expect(result.stderr).not.toContain('SECERT')
      expect(git(to, ['rev-list', '--all']).length).toBe(0)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'a message in Cyrillic letters without an English text stops the export, named by both ids, never quoted',
    async () => {
      const from = source()
      commit(from, { 'd.txt': 'd\n' }, 'docs: заметки о выпуске')
      const to = target()

      const result = await runExport(from, [to])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/message of commit [0-9a-f]{7,} \(source [0-9a-f]{7,}\) is in Cyrillic letters/)
      expect(result.stderr).not.toMatch(/[Ѐ-ӿ]/)
      expect(git(to, ['rev-list', '--all']).length).toBe(0)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'an English text replaces the message, and a commit id it cites becomes the public one',
    async () => {
      const from = source()
      const firstPrivate = git(from, ['rev-list', '--max-parents=0', 'main']).slice(0, 7)
      commit(from, { 'd.txt': 'd\n' }, `docs: заметки к ${firstPrivate}`)
      const russian = git(from, ['rev-parse', 'HEAD'])
      const english = `docs: notes on ${firstPrivate}\n\nThe body stays a body.\n`
      commit(from, rulesFiles({ 'translate-message.json': JSON.stringify({ [russian]: english }) }), 'docs: an English text')
      const to = target()

      const result = await runExport(from, [to])

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      const firstPublic = git(to, ['rev-list', '--max-parents=0', 'main']).slice(0, 7)
      expect(firstPublic).not.toBe(firstPrivate)
      expect(git(to, ['log', '-1', '--format=%B', 'main'])).toBe(`docs: notes on ${firstPublic}\n\nThe body stays a body.`)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'an English text citing a later commit stops the export: that id has no public counterpart',
    async () => {
      const from = source()
      commit(from, { 'd.txt': 'd\n' }, 'docs: заметки')
      const russian = git(from, ['rev-parse', 'HEAD'])
      commit(from, { 'e.txt': 'e\n' }, 'feat: later')
      const later = git(from, ['rev-parse', 'HEAD']).slice(0, 7)
      const english = `docs: notes, followed up in ${later}\n`
      commit(from, rulesFiles({ 'translate-message.json': JSON.stringify({ [russian]: english }) }), 'docs: an English text')
      const to = target()

      const result = await runExport(from, [to])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/message of commit [0-9a-f]{7,} \(source [0-9a-f]{7,}\) cites 1 commit id of the source/)
      expect(result.stderr).not.toContain(later)
      expect(git(to, ['rev-list', '--all']).length).toBe(0)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'an English text for a commit the source does not have stops the export, named by id',
    async () => {
      const ghost = 'f'.repeat(40)
      const from = source({ 'translate-message.json': JSON.stringify({ [ghost]: 'docs: ghost\n' }) })
      const to = target()

      const result = await runExport(from, [to])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(new RegExp(`translate-message\\.json: ${ghost} is not a commit of the source`))
      expect(git(to, ['rev-list', '--all']).length).toBe(0)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'a missing translate-message.json is named like any other rules file',
    async () => {
      const from = source()
      git(from, ['rm', '-q', `${RULES_DIR}/translate-message.json`])
      git(from, ['commit', '-q', '-m', 'drop translations'])

      const result = await runExport(from, [target()])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/missing rules file .*translate-message\.json/)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'a missing rules file is named, and nothing is filtered',
    async () => {
      const from = source()
      git(from, ['rm', '-q', `${RULES_DIR}/mailmap`])
      git(from, ['commit', '-q', '-m', 'drop mailmap'])

      const result = await runExport(from, [target()])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/mailmap/)
    },
    EXPORT_TIMEOUT_MS,
  )
})

describe.skipIf(!existsSync(join(PROJECT_ROOT, RULES_DIR, 'paths.txt')))('the rules of this repository', () => {
  test('drop the working notes, the pitch track, the dogfood policy and CLAUDE.md (R5, R13)', () => {
    const lines = readFileSync(join(PROJECT_ROOT, RULES_DIR, 'paths.txt'), 'utf8').split('\n')

    expect(lines).toEqual(expect.arrayContaining(['.claude/', 'docs/pitch/', '.mcpcut-project/', 'CLAUDE.md']))
  })

  test('map every identity to the GitHub noreply address (R7)', () => {
    const canonical = readFileSync(join(PROJECT_ROOT, RULES_DIR, 'mailmap'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => /<([^>]+)>/.exec(line)?.[1])

    expect(new Set(canonical)).toEqual(new Set(['96149587+RostislavMatov@users.noreply.github.com']))
  })

  test('give every translated commit an English message the export can read', () => {
    const text = readFileSync(join(PROJECT_ROOT, RULES_DIR, 'translate-message.json'), 'utf8')

    expect(() => translationsFromText(text)).not.toThrow()
  })
})

describe('export-public.mjs: arguments', () => {
  test('--branch followed by another flag is refused, not taken for a branch name', async () => {
    const result = await runExport(PROJECT_ROOT, [tmpdir(), '--branch', '--allow-rewrite'])

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: --branch needs a name/m)
  })
})


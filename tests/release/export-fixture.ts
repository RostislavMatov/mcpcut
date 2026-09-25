import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * What the export suites share (export-public.test.ts, export-translate.test.ts):
 * a private repository in the shape the export expects, an empty public
 * clone, and the real tool run as a child process against them.
 */

export const PROJECT_ROOT = process.cwd()
export const RULES_DIR = '.claude/release/filter'
const EXPORT_PATH = join(PROJECT_ROOT, 'tools/release/export-public.mjs')

/** Two `filter-repo` runs (the determinism check) plus a few clones per test. */
export const EXPORT_TIMEOUT_MS = 60_000

/** The maintainer's tool, not a dependency: GitHub's runners do not have it, and the suites say so by skipping. */
export const hasFilterRepo = spawnSync('git', ['filter-repo', '--version'], { stdio: 'ignore' }).status === 0

const PRIVATE_EMAIL = 'private@corp.example'
export const PUBLIC_EMAIL = 'public@users.noreply.github.com'
export const PUBLIC_REMOTE = 'https://github.com/RostislavMatov/mcpcut.git'

const RULES: Readonly<Record<string, string>> = {
  'paths.txt': '.claude/\ndocs/pitch/\n.mcpcut-project/\nCLAUDE.md\n',
  'replace-text.txt': 'SECRET-HOME==>HOME\n',
  'replace-message.txt': 'AcmeCorp==>an outreach company\n',
  'forbidden.txt': '# nothing below may survive the filter\nregex:corp\\.example\n',
  mailmap: `Public Name <${PUBLIC_EMAIL}> <${PRIVATE_EMAIL}>\n`,
  'translate-message.json': '{}\n',
}

export interface ChildResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface ExportFixture {
  /** Removes every directory the fixture made; goes in the suite's afterEach. */
  readonly cleanup: () => void
  readonly tempDir: () => string
  readonly repoAt: (dir: string) => string
  /** Four commits: a secret in a file, a commit only under `.claude/`, excluded paths plus a company in the message, the dogfood policy. */
  readonly source: (overrides?: Readonly<Record<string, string>>) => string
  readonly target: () => string
}

export function git(cwd: string, args: readonly string[]): string {
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

export function commit(root: string, files: Readonly<Record<string, string>>, message: string): void {
  write(root, files)
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', message])
}

export function runExport(cwd: string, args: readonly string[]): Promise<ChildResult> {
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

export function rulesFiles(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...RULES, ...overrides }).map(([name, text]) => [`${RULES_DIR}/${name}`, text]),
  )
}

export function exportFixture(): ExportFixture {
  const dirs: string[] = []

  const tempDir = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpcut-export-')))
    dirs.push(dir)
    return dir
  }

  const repoAt = (dir: string): string => {
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '-q', '-b', 'main'])
    return dir
  }

  const source = (overrides: Readonly<Record<string, string>> = {}): string => {
    const root = repoAt(join(tempDir(), 'private'))
    commit(root, { 'a.txt': 'cd SECRET-HOME/path\n', 'docs/adr/x.md': '# x\n' }, 'feat: first')
    commit(root, { '.claude/p.md': 'notes\n', ...rulesFiles(overrides) }, 'docs: working notes')
    commit(root, { 'docs/pitch/p.md': 'pitch\n', 'CLAUDE.md': 'memory\n', 'a.txt': 'cd path\n' }, 'docs: touch AcmeCorp')
    commit(root, { '.mcpcut-project/policy.json': '{}\n', 'b.txt': 'b\n' }, 'feat: fourth')
    return root
  }

  const target = (): string => repoAt(join(tempDir(), 'public'))

  const cleanup = (): void => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  }

  return { cleanup, tempDir, repoAt, source, target }
}

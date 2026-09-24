import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { deadRules, historyFindings, matchersOf } from '../../tools/release/export-checks.mjs'

/**
 * The R14 checks on their own, over plain repositories — no `filter-repo`
 * needed, so they run everywhere, CI included. What they must not do is
 * trust git's human-readable output: a quoted path (`"`, `\`, non-ASCII) or a
 * file that only a merge commit brings in has to be seen like any other.
 */

const EMAIL = 'public@users.noreply.github.com'

interface Rules {
  readonly paths: readonly unknown[]
  readonly text: readonly unknown[]
  readonly message: readonly unknown[]
  readonly forbidden: readonly unknown[]
  readonly canonicalEmails: ReadonlySet<string>
}

function rulesOf(files: Readonly<Partial<Record<'paths' | 'text' | 'message' | 'forbidden', string>>>): Rules {
  return {
    paths: matchersOf(files.paths ?? '', 'paths.txt', { hasArrow: false, hasComments: true }),
    text: matchersOf(files.text ?? '', 'replace-text.txt', { hasArrow: true, hasComments: false }),
    message: matchersOf(files.message ?? '', 'replace-message.txt', { hasArrow: true, hasComments: false }),
    forbidden: matchersOf(files.forbidden ?? '', 'forbidden.txt', { hasArrow: false, hasComments: true }),
    canonicalEmails: new Set([EMAIL]),
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', `user.email=${EMAIL}`, ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

function commit(root: string, files: Readonly<Record<string, string>>, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', message])
  return git(root, ['rev-parse', '--short', 'HEAD'])
}

describe('historyFindings: paths git would quote, and merges', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function repo(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpcut-checks-')))
    dirs.push(dir)
    git(dir, ['init', '-q', '-b', 'main'])
    return dir
  }

  test('an excluded path with a double quote, a backslash or non-ASCII letters is still found', () => {
    const root = repo()
    commit(
      root,
      { '.claude/notes "q".md': 'x\n', 'docs/pitch/a\\b.md': 'x\n', 'docs/pitch/заметки.md': 'x\n', 'ok.txt': 'ok\n' },
      'feat: first',
    )

    const findings = historyFindings(root, rulesOf({ paths: '.claude/\ndocs/pitch/\n' }))

    expect(findings).toHaveLength(3)
    expect(findings.some((f: string) => f.includes('.claude/notes "q".md') && f.includes('paths.txt:1'))).toBe(true)
    expect(findings.some((f: string) => f.includes('docs/pitch/a\\b.md') && f.includes('paths.txt:2'))).toBe(true)
    expect(findings.some((f: string) => f.includes('docs/pitch/заметки.md'))).toBe(true)
  })

  test('a file that only a merge commit brings in is found', () => {
    // `git log --name-only` shows no diff for a merge, so a file added while
    // resolving one would never be listed; the full tree of every commit is.
    const root = repo()
    commit(root, { 'a.txt': 'a\n' }, 'feat: base')
    git(root, ['checkout', '-q', '-b', 'side'])
    commit(root, { 'b.txt': 'b\n' }, 'feat: side')
    git(root, ['checkout', '-q', 'main'])
    commit(root, { 'c.txt': 'c\n' }, 'feat: main')
    git(root, ['merge', '-q', '--no-ff', '--no-commit', 'side'])
    writeFileSync(join(root, 'CLAUDE.md'), 'memory\n')
    git(root, ['add', 'CLAUDE.md'])
    git(root, ['commit', '-q', '-m', 'merge side'])

    const findings = historyFindings(root, rulesOf({ paths: 'CLAUDE.md\n' }))

    expect(findings).toEqual([expect.stringMatching(/^commit [0-9a-f]{7,} still carries CLAUDE\.md \(paths\.txt:1\)$/)])
  })

  test('a blob kept at two paths names both, and the first commit that had it', () => {
    const root = repo()
    const first = commit(root, { 'a.txt': 'value LEAK-1\n' }, 'feat: one')
    commit(root, { 'deep/b.txt': 'value LEAK-1\n' }, 'feat: two')

    const findings = historyFindings(root, rulesOf({ forbidden: 'LEAK-1\n' }))

    expect(findings).toEqual([`commit ${first}: a.txt, deep/b.txt matches forbidden.txt:1`])
  })

  test('a finding never quotes what matched', () => {
    const root = repo()
    commit(root, { 'a.txt': 'value LEAK-2\n' }, 'feat: mention LEAK-3')

    const findings = historyFindings(root, rulesOf({ forbidden: 'LEAK-2\nLEAK-3\n' }))

    expect(findings).toHaveLength(2)
    expect(findings.join('\n')).not.toMatch(/LEAK/)
  })

  test('a clean history has no findings', () => {
    const root = repo()
    commit(root, { 'a.txt': 'a\n', 'docs/x.md': '# x\n' }, 'feat: clean')

    expect(historyFindings(root, rulesOf({ paths: '.claude/\n', forbidden: 'LEAK\n' }))).toEqual([])
  })
})

describe('deadRules: a replacement that replaces nothing is a typo or a leftover', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function source(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpcut-dead-')))
    dirs.push(dir)
    git(dir, ['init', '-q', '-b', 'main'])
    commit(dir, { 'a.txt': 'thanks Mallory\n', '.claude/rules.txt': 'OnlyInNotes\n' }, 'docs: thanks AcmeCorp')
    return dir
  }

  test('a rule that matches outside the excluded paths is alive', () => {
    const rules = rulesOf({ paths: '.claude/\n', text: 'Mallory==>a reviewer\n', message: 'AcmeCorp==>a company\n' })

    expect(deadRules(source(), 'main', rules)).toEqual([])
  })

  test('a misspelled rule and a rule that only matches excluded paths are both dead', () => {
    // The misspelling is the dangerous one: the filter would leave the real
    // name in place, and a check built from the same rule would not see it.
    const rules = rulesOf({
      paths: '.claude/\n',
      text: 'Mallroy==>a reviewer\nOnlyInNotes==>x\n',
      message: 'AcmeCrop==>a company\n',
    })

    expect(deadRules(source(), 'main', rules)).toEqual(['replace-text.txt:1', 'replace-text.txt:2', 'replace-message.txt:1'])
  })
})

#!/usr/bin/env node
// Export the private history to the public clone (ADR-0011, decision D1; plan
// R5, R8, R14). A fresh clone of the private `main` goes through
// `git filter-repo` with the rules in `.claude/release/filter/` — excluded
// paths, text and message replacements, English texts for messages written in
// Russian, a mailmap — then through the R14 checks, then through the same
// filter a second time to prove it lands on the same commit. Only then does
// `main` of the public clone move, and only forward unless `--allow-rewrite`
// is given. Nothing is pushed.
//
// Usage (from the root of the private repository, with a clean tree):
//   node tools/release/export-public.mjs <public clone> [--allow-rewrite] [--branch <name>]
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  TRANSLATIONS_FILE,
  deadRules,
  deadTranslations,
  gitIn,
  hasFilterRepo,
  historyFindings,
  rulesFromTexts,
  translationsFromText,
} from './export-checks.mjs'

const RULES_DIR = '.claude/release/filter'

const RULE_FILES = ['paths.txt', 'replace-text.txt', 'replace-message.txt', 'forbidden.txt', 'mailmap', TRANSLATIONS_FILE]

/**
 * filter-repo's --commit-callback body: the English text of
 * translate-message.json replaces the message of the commit it names, and the
 * commit ids that text cites are renamed the way filter-repo renames them in
 * every other message (its own renaming ran before this callback). filter-repo
 * hands the callback its metadata as a second argument whose name it keeps to
 * itself, so the body finds it by what it holds, and stops the filter rather
 * than publish a stale id if it is not there. The file is read once per run.
 */
function translationCallback(file) {
  return [
    'import json, re',
    "table = globals().get('mcpcut_translations')",
    'if table is None:',
    `  with open(${JSON.stringify(file)}, encoding='utf-8') as source:`,
    "    table = globals()['mcpcut_translations'] = json.load(source)",
    "english = table.get((commit.original_id or b'').decode('ascii'))",
    'if english is not None:',
    "  found = [v for v in list(locals().values()) if isinstance(v, dict) and 'commit_rename_func' in v]",
    '  if not found:',
    "    raise SystemExit('export: git filter-repo gave --commit-callback no commit_rename_func')",
    "  commit.message = re.sub(br'(\\b[0-9a-f]{7,40}\\b)', found[0]['commit_rename_func'], english.encode('utf-8'))",
  ].join('\n')
}

/** The only remotes the public clone may have: the export must never fill someone else's repository. */
const PUBLIC_REMOTES = new Set([
  'https://github.com/RostislavMatov/mcpcut',
  'https://github.com/RostislavMatov/mcpcut.git',
  'git@github.com:RostislavMatov/mcpcut.git',
])

const DEFAULT_BRANCH = 'main'

class ExportError extends Error {}

function fail(message) {
  throw new ExportError(message)
}

function parseArgs(argv) {
  const [target, ...rest] = argv
  if (!target || target.startsWith('-')) fail('usage: export-public.mjs <public clone> [--allow-rewrite] [--branch <name>]')
  const branchAt = rest.indexOf('--branch')
  const branch = branchAt === -1 ? DEFAULT_BRANCH : rest[branchAt + 1]
  if (branch === undefined || branch.startsWith('-')) fail('--branch needs a name')
  return { target, allowRewrite: rest.includes('--allow-rewrite'), branch }
}

/** A git query whose "not there" is an exit code, not an error. */
function optionalGit(repo, args) {
  try {
    return gitIn(repo, args).trim()
  } catch {
    return undefined
  }
}

function isClean(repo) {
  return gitIn(repo, ['status', '--porcelain']).trim() === ''
}

function isInside(child, parent) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function readRules(sourceRoot) {
  const texts = Object.fromEntries(
    RULE_FILES.map((name) => {
      try {
        return [name, readFileSync(join(sourceRoot, RULES_DIR, name), 'utf8')]
      } catch {
        return fail(`missing rules file ${RULES_DIR}/${name}`)
      }
    }),
  )
  try {
    return { ...rulesFromTexts(texts), translations: translationsFromText(texts[TRANSLATIONS_FILE]) }
  } catch (error) {
    return fail(error.message)
  }
}

/** Checks 1–3 of the plan: all of them before anything is cloned, filtered or moved. */
function preflight(target) {
  if (!hasFilterRepo()) fail('git filter-repo is not installed — brew install git-filter-repo')
  const sourceRoot = realpathSync(gitIn(process.cwd(), ['rev-parse', '--show-toplevel']).trim())
  if (!isClean(sourceRoot)) fail('commit first — the export is a branch, not the working tree')
  const rules = readRules(sourceRoot)
  let targetRoot
  try {
    targetRoot = realpathSync(target)
  } catch {
    fail(`${target} does not exist — git init -b main it first`)
  }
  if (isInside(targetRoot, sourceRoot) || isInside(sourceRoot, targetRoot)) {
    fail('the public clone and the private repository must not be inside one another')
  }
  if (realpathSync(gitIn(targetRoot, ['rev-parse', '--show-toplevel']).trim()) !== targetRoot) {
    fail(`${target} is not the root of a git clone`)
  }
  if (!isClean(targetRoot)) fail(`${target} has uncommitted changes`)
  const origin = optionalGit(targetRoot, ['config', '--get', 'remote.origin.url'])
  if (origin !== undefined && !PUBLIC_REMOTES.has(origin)) fail(`the origin of ${target} is not the public repository`)
  return { sourceRoot, targetRoot, rules, hasOrigin: origin !== undefined }
}

function filteredClone(sourceRoot, branch, into) {
  const rules = join(sourceRoot, RULES_DIR)
  gitIn(tmpdir(), ['clone', '-q', '--no-local', '--single-branch', '--branch', branch, sourceRoot, into])
  gitIn(into, [
    'filter-repo', '--quiet', '--invert-paths',
    '--paths-from-file', join(rules, 'paths.txt'),
    '--replace-text', join(rules, 'replace-text.txt'),
    '--replace-message', join(rules, 'replace-message.txt'),
    '--mailmap', join(rules, 'mailmap'),
    '--commit-callback', translationCallback(join(rules, TRANSLATIONS_FILE)),
  ])
  if (branch !== DEFAULT_BRANCH) gitIn(into, ['branch', '-q', '-M', branch, DEFAULT_BRANCH])
  return gitIn(into, ['rev-parse', DEFAULT_BRANCH]).trim()
}

function isAncestor(repo, ancestor, descendant) {
  try {
    gitIn(repo, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}


/** R8: after publication the public history only grows; a local unpushed `main` is protected the same way. */
function checkFastForward({ targetRoot, hasOrigin }, head, allowRewrite) {
  if (hasOrigin) gitIn(targetRoot, ['fetch', '-q', 'origin'])
  const published = ['refs/remotes/origin/main', 'refs/heads/main'].map((ref) =>
    optionalGit(targetRoot, ['rev-parse', '--verify', '--quiet', ref]),
  )
  const rewritten = published.filter((ref) => ref !== undefined && !isAncestor(targetRoot, ref, head))
  if (rewritten.length > 0 && !allowRewrite) {
    fail('the published history would be rewritten — a filter rule now touches published commits (--allow-rewrite only on the maintainer\'s explicit decision: every existing clone has to be made again)')
  }
}

function exportTo(args) {
  const context = preflight(args.target)
  const dead = deadRules(context.sourceRoot, args.branch, context.rules)
  if (dead.length > 0) {
    fail(`${dead.join(', ')} matches nothing in the history being exported — a typo would leave the real string in place; fix or delete the rule`)
  }
  const ghosts = deadTranslations(context.sourceRoot, context.rules.translations)
  if (ghosts.length > 0) {
    fail(`${TRANSLATIONS_FILE}: ${ghosts.join(', ')} ${ghosts.length === 1 ? 'is not a commit' : 'are not commits'} of the source — fix or delete the entry`)
  }
  const work = mkdtempSync(join(tmpdir(), 'mcpcut-export-'))
  try {
    const repo = join(work, 'repo')
    const head = filteredClone(context.sourceRoot, args.branch, repo)
    const findings = historyFindings(repo, context.rules)
    if (findings.length > 0) fail(`the filtered history is not clean:\n  ${findings.join('\n  ')}`)
    if (filteredClone(context.sourceRoot, args.branch, join(work, 'again')) !== head) {
      fail('filter is not deterministic — the public history could not grow by fast-forward')
    }
    // Only `main` crosses into the public clone: tags and notes of the filtered
    // clone never do, which is why the checks walk commits and not tag objects.
    // Widen this fetch and the checks have to widen with it.
    gitIn(context.targetRoot, ['fetch', '-q', repo, DEFAULT_BRANCH])
    checkFastForward(context, head, args.allowRewrite)
    gitIn(context.targetRoot, ['checkout', '-q', '-B', DEFAULT_BRANCH, head])
    const exported = Number(gitIn(repo, ['rev-list', '--count', DEFAULT_BRANCH]).trim())
    const source = Number(gitIn(context.sourceRoot, ['rev-list', '--count', args.branch]).trim())
    return `exported ${exported} commits (${source - exported} dropped as empty), main ${head} → ${args.target}\n`
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function main() {
  try {
    process.stdout.write(exportTo(parseArgs(process.argv.slice(2))))
  } catch (error) {
    const message = error instanceof ExportError ? error.message : `export failed: ${error.message.split('\n')[0]}`
    process.stderr.write(`error: ${message}\n`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()

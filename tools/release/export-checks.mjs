// The mechanical checks of plan R14, run by export-public.mjs over the
// filtered clone before anything reaches the public one. A finding names the
// rule, the commit and the path — never the string that matched: the export
// may run in a terminal that is being recorded.
import { execFileSync, spawnSync } from 'node:child_process'

/** Every blob of the history fits in memory many times over (≈ 45 MB on 2026-09-24). */
const GIT_MAX_BUFFER = 1024 * 1024 * 1024

const REPLACE_ARROW = '==>'

/** Text without `input`; with it (a batch of object ids), the raw bytes git printed. */
export function gitIn(repo, args, input) {
  const options = { maxBuffer: GIT_MAX_BUFFER }
  return input === undefined
    ? execFileSync('git', ['-C', repo, ...args], { ...options, encoding: 'utf8' })
    : execFileSync('git', ['-C', repo, ...args], { ...options, input })
}

/**
 * One matcher per non-blank line. `regex:` and `literal:` as filter-repo reads
 * them; `glob:` is refused rather than half-supported. `#` lines are comments
 * only where filter-repo also skips them (paths, forbidden).
 */
export function matchersOf(text, fileName, { hasArrow, hasComments }) {
  return text.split('\n').flatMap((line, index) => {
    if (line.trim() === '' || (hasComments && line.startsWith('#'))) return []
    const left = hasArrow ? line.split(REPLACE_ARROW)[0] : line
    return [{ rule: `${fileName}:${index + 1}`, ...patternOf(left, `${fileName}:${index + 1}`) }]
  })
}

function patternOf(left, rule) {
  if (left.startsWith('glob:')) throw new Error(`${rule} uses glob:, which the export cannot check — use regex:`)
  if (left.startsWith('regex:')) return { regex: new RegExp(left.slice('regex:'.length)) }
  const literal = left.startsWith('literal:') ? left.slice('literal:'.length) : left
  return { literal: Buffer.from(literal, 'utf8') }
}

function matchesBuffer(matcher, buffer) {
  return matcher.regex ? matcher.regex.test(buffer.toString('utf8')) : buffer.includes(matcher.literal)
}

function matchesPath(matcher, path) {
  if (matcher.regex) return matcher.regex.test(path)
  const literal = matcher.literal.toString('utf8')
  const bare = literal.replace(/\/$/, '')
  return path === bare || path.startsWith(`${bare}/`)
}

/** (a) No commit carries a path the filter removes. */
function pathFindings(repo, pathMatchers) {
  const findings = []
  let commit = ''
  for (const line of gitIn(repo, ['log', '--all', '--name-only', '--format=%x00%h']).split('\n')) {
    if (line.startsWith('\0')) commit = line.slice(1)
    const matcher = line === '' || line.startsWith('\0') ? undefined : pathMatchers.find((m) => matchesPath(m, line))
    if (matcher) findings.push(`commit ${commit} still carries ${line} (${matcher.rule})`)
  }
  return findings
}

/** Blob id → the first path it was seen at, for every blob of every commit. */
function blobPaths(repo) {
  const entries = gitIn(repo, ['rev-list', '--objects', '--all'])
    .split('\n')
    .filter((line) => line.includes(' '))
    .map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)])
  const types = gitIn(repo, ['cat-file', '--batch-check=%(objecttype)'], entries.map(([id]) => id).join('\n') + '\n')
    .toString('utf8')
    .split('\n')
  return new Map(entries.filter((_, index) => types[index] === 'blob'))
}

/** `git cat-file --batch` output, split back into one buffer per blob. */
function* blobContents(repo, ids) {
  const output = gitIn(repo, ['cat-file', '--batch'], ids.join('\n') + '\n')
  let offset = 0
  for (const id of ids) {
    const headerEnd = output.indexOf(0x0a, offset)
    const size = Number(output.toString('utf8', offset, headerEnd).split(' ')[2])
    yield [id, output.subarray(headerEnd + 1, headerEnd + 1 + size)]
    offset = headerEnd + 1 + size + 1
  }
}

function commitOfBlob(repo, id) {
  return gitIn(repo, ['log', '--all', '-1', '--format=%h', `--find-object=${id}`]).trim() || 'unknown'
}

/** (b) No blob of any commit carries a left side of replace-text or a forbidden string. */
function blobFindings(repo, matchers) {
  const paths = blobPaths(repo)
  const findings = []
  for (const [id, content] of blobContents(repo, [...paths.keys()])) {
    for (const matcher of matchers.filter((m) => matchesBuffer(m, content))) {
      findings.push(`commit ${commitOfBlob(repo, id)}: ${paths.get(id)} matches ${matcher.rule}`)
    }
  }
  return findings
}

/** (c) No commit message carries a left side of replace-message or a forbidden string. */
function messageFindings(repo, matchers) {
  return gitIn(repo, ['log', '--all', '--format=%h%x00%B%x1e'])
    .split('\x1e')
    .map((entry) => entry.replace(/^\n/, ''))
    .filter((entry) => entry.includes('\0'))
    .flatMap((entry) => {
      const [commit, message] = entry.split('\0')
      const body = Buffer.from(message, 'utf8')
      return matchers
        .filter((m) => matchesBuffer(m, body))
        .map((m) => `message of commit ${commit} matches ${m.rule}`)
    })
}

/** The canonical addresses of a mailmap: the first `<…>` of every line. */
export function canonicalEmailsOf(mailmapText) {
  return new Set(
    mailmapText
      .split('\n')
      .map((line) => /<([^>]+)>/.exec(line)?.[1])
      .filter((email) => email !== undefined),
  )
}

/** (d) Every author and committer is one of the mailmap's public identities. */
function identityFindings(repo, canonical) {
  return gitIn(repo, ['log', '--all', '--format=%h%x00%ae%x00%ce'])
    .split('\n')
    .filter((line) => line !== '')
    .flatMap((line) => {
      const [commit, author, committer] = line.split('\0')
      return [author, committer].some((email) => !canonical.has(email))
        ? [`commit ${commit} has an author or committer that is not a mailmap identity`]
        : []
    })
}

/** Checks (a)–(d); (e), determinism, needs a second filter and lives with the caller. */
export function historyFindings(repo, rules) {
  return [
    ...pathFindings(repo, rules.paths),
    ...blobFindings(repo, [...rules.text, ...rules.forbidden]),
    ...messageFindings(repo, [...rules.message, ...rules.forbidden]),
    ...identityFindings(repo, rules.canonicalEmails),
  ]
}

export function hasFilterRepo() {
  return spawnSync('git', ['filter-repo', '--version'], { stdio: 'ignore' }).status === 0
}

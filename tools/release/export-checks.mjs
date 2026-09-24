// The mechanical checks of plan R14, run by export-public.mjs over the
// filtered clone before anything reaches the public one, and the dead-rule
// check run over the source before filtering. A finding names the rule, the
// commit and the path — never the string that matched: the export may run in
// a terminal that is being recorded.
//
// The history is read by export-history.mjs (full trees, NUL-separated), not
// from git's human-readable output.
import { spawnSync } from 'node:child_process'
import { blobContents, identitiesOf, indexHistory, messagesOf } from './export-history.mjs'

export { gitIn } from './export-history.mjs'

const REPLACE_ARROW = '==>'

/** A finding lists at most this many paths of one blob, then says how many more. */
const MAX_PATHS_PER_FINDING = 5

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
  const bare = matcher.literal.toString('utf8').replace(/\/$/, '')
  return path === bare || path.startsWith(`${bare}/`)
}

/** A path as a finding may print it: control characters (a newline in a name) become `?`. */
function printable(path) {
  return path.replace(/[\u0000-\u001f\u007f]/g, '?')
}

function pathList(paths) {
  const all = [...paths].map(printable)
  const more = all.length - MAX_PATHS_PER_FINDING
  return all.slice(0, MAX_PATHS_PER_FINDING).join(', ') + (more > 0 ? ` (+${more} more)` : '')
}

/** (a) No commit's tree carries a path the filter removes. */
function pathFindings(index, pathMatchers) {
  return [...index.paths].flatMap(([path, commit]) => {
    const matcher = pathMatchers.find((m) => matchesPath(m, path))
    return matcher ? [`commit ${commit} still carries ${printable(path)} (${matcher.rule})`] : []
  })
}

/** Blob id → the matchers its content matches, for every blob of the index. */
function blobMatches(repo, blobIds, matchers) {
  const matched = []
  for (const [id, content] of blobContents(repo, blobIds)) {
    const hits = matchers.filter((m) => matchesBuffer(m, content))
    if (hits.length > 0) matched.push([id, hits])
  }
  return matched
}

/** (b) No blob of any commit carries a left side of replace-text or a forbidden string. */
function blobFindings(repo, index, matchers) {
  return blobMatches(repo, [...index.blobs.keys()], matchers).flatMap(([id, hits]) => {
    const { commit, paths } = index.blobs.get(id)
    return hits.map((m) => `commit ${commit}: ${pathList(paths)} matches ${m.rule}`)
  })
}

/** (c) No commit message carries a left side of replace-message or a forbidden string. */
function messageFindings(repo, matchers) {
  return messagesOf(repo, ['--all']).flatMap(({ commit, message }) => {
    const body = Buffer.from(message, 'utf8')
    return matchers.filter((m) => matchesBuffer(m, body)).map((m) => `message of commit ${commit} matches ${m.rule}`)
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
  return identitiesOf(repo, ['--all']).flatMap(({ commit, emails }) =>
    emails.some((email) => !canonical.has(email))
      ? [`commit ${commit} has an author or committer that is not a mailmap identity`]
      : [],
  )
}

/** Checks (a)–(d) over every ref of `repo`; (e), determinism, needs a second filter and lives with the caller. */
export function historyFindings(repo, rules) {
  const index = indexHistory(repo, ['--all'])
  return [
    ...pathFindings(index, rules.paths),
    ...blobFindings(repo, index, [...rules.text, ...rules.forbidden]),
    ...messageFindings(repo, [...rules.message, ...rules.forbidden]),
    ...identityFindings(repo, rules.canonicalEmails),
  ]
}

/**
 * The replacement rules that match nothing in `branch` of the source, outside
 * the excluded paths. Such a rule is a typo or a leftover, and a typo is the
 * one mistake the checks above cannot see: the filter leaves the real string
 * in place, and a check built from the same misspelled rule looks for the
 * misspelling. Blobs stored only at excluded paths do not count — the rules
 * files themselves live there and name every left side.
 */
export function deadRules(sourceRepo, branch, rules) {
  const index = indexHistory(sourceRepo, [branch])
  const kept = [...index.blobs]
    .filter(([, { paths }]) => [...paths].some((path) => !rules.paths.some((m) => matchesPath(m, path))))
    .map(([id]) => id)
  const textHit = new Set(blobMatches(sourceRepo, kept, rules.text).flatMap(([, hits]) => hits.map((m) => m.rule)))
  const bodies = messagesOf(sourceRepo, [branch]).map(({ message }) => Buffer.from(message, 'utf8'))
  return [
    ...rules.text.filter((m) => !textHit.has(m.rule)),
    ...rules.message.filter((m) => !bodies.some((body) => matchesBuffer(m, body))),
  ].map((m) => m.rule)
}

export function hasFilterRepo() {
  return spawnSync('git', ['filter-repo', '--version'], { stdio: 'ignore' }).status === 0
}

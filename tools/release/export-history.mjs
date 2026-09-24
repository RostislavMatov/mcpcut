// Reading a history for the R14 checks (export-checks.mjs) without trusting
// git's human-readable output. Paths come from `ls-tree -z` over the FULL tree
// of every commit: NUL-separated output is never quoted (a `"`, a `\` or a
// non-ASCII byte in a name would otherwise arrive as a C-style quoted
// string), and a full tree also holds what only a merge commit brought in,
// which `log --name-only` never lists.
import { execFileSync } from 'node:child_process'

/** Every blob of the history fits in memory many times over (≈ 45 MB on 2026-09-24). */
const GIT_MAX_BUFFER = 1024 * 1024 * 1024

const NUL = '\0'

/** Text without `input`; with it (a batch of object ids), the raw bytes git printed. */
export function gitIn(repo, args, input) {
  const options = { maxBuffer: GIT_MAX_BUFFER }
  return input === undefined
    ? execFileSync('git', ['-C', repo, ...args], { ...options, encoding: 'utf8' })
    : execFileSync('git', ['-C', repo, ...args], { ...options, input })
}

/** Oldest first, so the first commit a path or blob is met in is where it entered. */
function commitsOf(repo, revs) {
  return gitIn(repo, ['rev-list', '--reverse', '--topo-order', ...revs])
    .split('\n')
    .filter((line) => line !== '')
}

/** `<mode> SP <type> SP <id> TAB <path>` entries of one commit's full tree. */
function treeEntriesOf(repo, commit) {
  return gitIn(repo, ['ls-tree', '-r', '-z', '--full-tree', commit])
    .split(NUL)
    .filter((entry) => entry !== '')
    .map((entry) => {
      const tab = entry.indexOf('\t')
      const [, type, id] = entry.slice(0, tab).split(' ')
      return { type, id, path: entry.slice(tab + 1) }
    })
}

/**
 * Every path and every blob the history holds, each with the first commit it
 * appears in; a blob also keeps every path it was stored at. `revs` is what
 * `rev-list` takes: `['--all']`, or one branch.
 */
export function indexHistory(repo, revs) {
  const paths = new Map()
  const blobs = new Map()
  for (const commit of commitsOf(repo, revs)) {
    const short = commit.slice(0, 7)
    for (const { type, id, path } of treeEntriesOf(repo, commit)) {
      if (!paths.has(path)) paths.set(path, short)
      if (type !== 'blob') continue
      const known = blobs.get(id)
      if (!known) blobs.set(id, { commit: short, paths: new Set([path]) })
      else if (!known.paths.has(path)) blobs.set(id, { ...known, paths: new Set([...known.paths, path]) })
    }
  }
  return { paths, blobs }
}

/** `git cat-file --batch` output, split back into one buffer per blob. */
export function* blobContents(repo, ids) {
  if (ids.length === 0) return
  const output = gitIn(repo, ['cat-file', '--batch'], ids.join('\n') + '\n')
  let offset = 0
  for (const id of ids) {
    const headerEnd = output.indexOf(0x0a, offset)
    const size = Number(output.toString('utf8', offset, headerEnd).split(' ')[2])
    yield [id, output.subarray(headerEnd + 1, headerEnd + 1 + size)]
    offset = headerEnd + 1 + size + 1
  }
}

/** Commit messages; `-z` ends each record with NUL, which a message cannot contain. */
export function messagesOf(repo, revs) {
  return gitIn(repo, ['log', '-z', '--format=%h%n%B', ...revs])
    .split(NUL)
    .filter((record) => record !== '')
    .map((record) => {
      const newline = record.indexOf('\n')
      return { commit: record.slice(0, newline), message: record.slice(newline + 1) }
    })
}

/** Author and committer addresses of every commit. */
export function identitiesOf(repo, revs) {
  return gitIn(repo, ['log', '-z', '--format=%h%n%ae%n%ce', ...revs])
    .split(NUL)
    .filter((record) => record !== '')
    .map((record) => {
      const [commit, author, committer] = record.split('\n')
      return { commit, emails: [author, committer] }
    })
}

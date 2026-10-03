import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

/**
 * The one resolver every agent-named path goes through before a file is
 * touched (ADR-0020 §3). The reference filesystem server's two advisories set
 * the floor: CVE-2025-53110 compared strings with `startsWith`, so
 * `/allowed-evil` passed for `/allowed`; CVE-2025-53109 checked the path as
 * written, so a symlink inside the folder led out of it.
 *
 * Here containment is decided on CANONICAL paths only:
 *
 *  1. Syntax first, no file system call: empty, NUL byte, over-long, relative
 *     paths and names Windows reserves are refused.
 *  2. The target goes through `realpath` (native semantics: on macOS and
 *     Windows it also returns the on-disk letter case). A target that does not
 *     exist yet resolves through its nearest existing ancestor, and a dangling
 *     symlink on the way is refused — writing to it would create a file
 *     wherever it points.
 *  3. Roots are canonicalized again on every call (a root swapped for a
 *     symlink after it was granted is followed, not trusted), and a root that
 *     no longer resolves is skipped.
 *  4. Containment is `path.relative` segment logic, never a string prefix, and
 *     letter case is never folded: folding on a case-sensitive volume would
 *     open a different folder.
 *
 * Opening the file without following a last-moment symlink swap (O_NOFOLLOW,
 * dev/ino check) is the I/O layer's job; this module only names the file.
 */

/** The per-root trash folder (ADR-0020 §4); no file tool may name it. */
export const TRASH_DIR_NAME = '.mcpcut-trash'

/** Longer paths are refused outright — no real folder tree needs more. */
export const MAX_PATH_LENGTH = 4096

export type PathRefusal =
  | 'empty'
  | 'nul-byte'
  | 'too-long'
  | 'not-absolute'
  | 'reserved-name'
  | 'outside-roots'
  | 'dangling-symlink'
  | 'trash'
  | 'unresolvable'

export interface ResolvedPath {
  /** The canonical root the target lies in; of nested roots, the deepest. */
  readonly root: string
  /** The canonical target. */
  readonly absolute: string
  /** The target relative to `root`; `''` for the root itself. */
  readonly relative: string
  readonly exists: boolean
}

export type PathResult =
  | { readonly ok: true; readonly path: ResolvedPath }
  | { readonly ok: false; readonly refusal: PathRefusal; readonly message: string }

type Refused = Extract<PathResult, { ok: false }>

const LIST_ROOTS_HINT = 'call list_roots to see your folders'

const REFUSAL_MESSAGES: Readonly<Record<PathRefusal, string>> = {
  empty: `The path is empty — ${LIST_ROOTS_HINT}.`,
  'nul-byte': 'The path contains a NUL byte and was refused.',
  'too-long': `The path is longer than ${MAX_PATH_LENGTH} characters and was refused.`,
  'not-absolute': `Use an absolute path inside one of your folders — ${LIST_ROOTS_HINT}.`,
  'reserved-name':
    'The path has a name Windows reserves (CON, NUL, COM1…, a stream after ":", or a trailing dot or space).',
  'outside-roots': `The path is outside your folders — ${LIST_ROOTS_HINT}.`,
  'dangling-symlink': 'The path is a symbolic link to something that does not exist and was refused.',
  trash: 'The trash is not reachable through file tools; an administrator restores files from it.',
  unresolvable: 'The path could not be resolved (a link loop or a folder that cannot be read).',
}

/** CON, PRN, AUX, NUL, COM1–9, LPT1–9 (and the superscript digits), with or without an extension. */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i

const TRAILING_DOT_OR_SPACE = /[. ]$/

function refuse(refusal: PathRefusal): Refused {
  return { ok: false, refusal, message: REFUSAL_MESSAGES[refusal] }
}

/**
 * Names Windows cannot hold safely: an alternate data stream (`file:stream`),
 * a reserved device name, or a segment ending in a dot or space (Windows trims
 * those, so two different names would reach one file). Ordinary on POSIX.
 */
export function checkName(raw: string, platform: NodeJS.Platform = process.platform): PathRefusal | null {
  if (platform !== 'win32') return null
  const rest = raw.slice(path.win32.parse(raw).root.length)
  if (rest.includes(':')) return 'reserved-name'
  const segments = rest.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
  const isReserved = (segment: string): boolean =>
    WINDOWS_RESERVED_NAME.test(segment) || TRAILING_DOT_OR_SPACE.test(segment)
  return segments.some(isReserved) ? 'reserved-name' : null
}

function checkSyntax(raw: string): PathRefusal | null {
  if (raw === '') return 'empty'
  if (raw.includes('\u0000')) return 'nul-byte'
  if (raw.length > MAX_PATH_LENGTH) return 'too-long'
  if (!path.isAbsolute(raw)) return 'not-absolute'
  return checkName(raw)
}

type RealpathOutcome = { readonly kind: 'found'; readonly real: string } | { readonly kind: 'missing' | 'error' }

async function realpathOf(target: string): Promise<RealpathOutcome> {
  try {
    return { kind: 'found', real: await realpath(target) }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    return { kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error' }
  }
}

async function isSymlink(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isSymbolicLink()
  } catch {
    return false
  }
}

type CanonicalTarget = { readonly ok: true; readonly real: string; readonly exists: boolean } | Refused

/** `realpath` of the target, or of its nearest existing ancestor plus the missing names. */
async function canonicalTarget(lexical: string): Promise<CanonicalTarget> {
  let current = lexical
  let missing: readonly string[] = []
  for (;;) {
    const outcome = await realpathOf(current)
    if (outcome.kind === 'found') return { ok: true, real: path.join(outcome.real, ...missing), exists: missing.length === 0 }
    if (outcome.kind === 'error') return refuse('unresolvable')
    if (await isSymlink(current)) return refuse('dangling-symlink')
    const parent = path.dirname(current)
    if (parent === current) return refuse('unresolvable')
    missing = [path.basename(current), ...missing]
    current = parent
  }
}

/**
 * The canonical form of an absolute path, through its nearest existing
 * ancestor when it does not exist yet; `null` when it cannot be resolved (a
 * link loop, a dangling symlink, an unreadable folder).
 */
export async function canonicalPath(raw: string): Promise<string | null> {
  const target = await canonicalTarget(path.resolve(raw))
  return target.ok ? target.real : null
}

async function canonicalRoots(roots: readonly string[]): Promise<readonly string[]> {
  const outcomes = await Promise.all(roots.map((root) => realpathOf(root)))
  return outcomes.flatMap((outcome) => (outcome.kind === 'found' ? [outcome.real] : []))
}

/** Segment-wise containment of one canonical path in another; never a string prefix. */
export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  if (relative === '') return true
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function deepestRootOf(target: string, roots: readonly string[]): string | undefined {
  return roots
    .filter((root) => isWithin(root, target))
    .reduce<string | undefined>((deepest, root) => (deepest === undefined || root.length > deepest.length ? root : deepest), undefined)
}

function isTrash(relative: string): boolean {
  return relative.split(path.sep)[0]?.toLowerCase() === TRASH_DIR_NAME
}

/**
 * Resolves an agent-named path against the roots it may use. `ok` means the
 * canonical target lies inside one of them and outside its trash; nothing
 * about the agent's operations on it — that is `rights.ts`.
 */
export async function resolveWithinRoots(raw: string, roots: readonly string[]): Promise<PathResult> {
  const syntaxRefusal = checkSyntax(raw)
  if (syntaxRefusal !== null) return refuse(syntaxRefusal)
  const target = await canonicalTarget(path.resolve(raw))
  if (!target.ok) return target
  const root = deepestRootOf(target.real, await canonicalRoots(roots))
  if (root === undefined) return refuse('outside-roots')
  const relative = path.relative(root, target.real)
  if (isTrash(relative)) return refuse('trash')
  return { ok: true, path: { root, absolute: target.real, relative, exists: target.exists } }
}

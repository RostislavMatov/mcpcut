import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { MAX_PATH_LENGTH, TRASH_DIR_NAME } from './constants.js'
import {
  existingChain,
  hasDuplicateIdentity,
  identitiesCollapse,
  isUsableIdentity,
  sameIdentity,
  statIdentity,
  type ChainEntry,
  type FileIdentity,
  type StatFn,
} from './identity.js'
import { checkName, hasTrashSegment, isLexicallyUnder, isWithinOn } from './names.js'
import { volumeKindOf, type VolumeKind } from './volume.js'

/**
 * The one resolver every agent-named path goes through before a file is
 * touched (ADR-0020 §3). The reference filesystem server's two advisories set
 * the floor: CVE-2025-53110 compared strings with `startsWith`, so
 * `/allowed-evil` passed for `/allowed`; CVE-2025-53109 checked the path as
 * written, so a symlink inside the folder led out of it.
 *
 *  1. Syntax, no file system call: empty, NUL byte, over-long, relative, and
 *     on Windows device paths and reserved names.
 *  2. A lexical gate against the roots as declared and as canonical, so a
 *     path nowhere near a root (`\\attacker\share\x`) is never opened.
 *  3. `realpath` of the target, or of its nearest existing ancestor plus the
 *     missing names; a dangling symlink on the way is refused.
 *  4. The decision is made on FILE IDENTITIES (dev, ino) of the target's
 *     existing ancestors: the deepest root whose identity is among them, and
 *     the trash of any root among them refuses. Spellings — NFC or NFD, letter
 *     case, 8.3 short names — cannot make one folder look like another.
 *  5. A trash-like name at any depth below the root is refused, so an agent
 *     cannot create the trash folder before mcpcut does under a spelling the
 *     volume folds (`.mcpcut-traſh`).
 *  6. A target on a network or FUSE drive is refused (`volume.ts`): there the
 *     identities of step 4 may be made up per spelling.
 *
 * Opening without following a last-moment symlink swap is the I/O layer's
 * job (O_NOFOLLOW, dev/ino of the descriptor); this module only names the file.
 */

export type PathRefusal =
  | 'empty'
  | 'nul-byte'
  | 'too-long'
  | 'not-absolute'
  | 'reserved-name'
  | 'device-path'
  | 'outside-roots'
  | 'dangling-symlink'
  | 'trash'
  | 'unresolvable'

export interface ResolvedPath {
  /** The root the target lies in (of nested roots, the deepest), spelled as in `absolute`. */
  readonly root: string
  /** The canonical target. */
  readonly absolute: string
  /** The target relative to `root`; `''` for the root itself. */
  readonly relative: string
  readonly exists: boolean
  /** The target's existing ancestors with their identities, closest first — what rights are matched on. */
  readonly chain: readonly ChainEntry[]
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
  'device-path': `Device and extended paths (\\\\.\\, \\\\?\\) are refused — ${LIST_ROOTS_HINT}.`,
  'outside-roots': `The path is outside your folders — ${LIST_ROOTS_HINT}.`,
  'dangling-symlink': 'The path is a symbolic link to something that does not exist and was refused.',
  trash: 'The trash is not reachable through file tools; an administrator restores files from it.',
  unresolvable: 'The path could not be resolved (a link loop or a folder that cannot be read).',
}

interface RootInfo {
  readonly declared: string
  readonly canonical: string
  readonly identity: FileIdentity
  readonly trash: FileIdentity | null
}

function refuse(refusal: PathRefusal, message: string = REFUSAL_MESSAGES[refusal]): Refused {
  return { ok: false, refusal, message }
}

/** What an agent reads when the target lies on a network or FUSE drive. */
function networkVolumeRefusal(fsType: string): Refused {
  return refuse(
    'unresolvable',
    `The path is on a network or FUSE drive (${fsType}), where folders cannot be told apart reliably, so it is not reachable through file tools; ask an administrator.`,
  )
}

/** Checks the volume a canonical path lies on. */
export type VolumeOf = (canonical: string) => Promise<VolumeKind>

const UNRELIABLE_IDENTITIES_MESSAGE =
  'The path could not be resolved safely: file identities are not reliable on this file system, so folders cannot be told apart; ask an administrator.'

function checkSyntax(raw: string): PathRefusal | null {
  if (raw === '') return 'empty'
  if (raw.includes('\u0000')) return 'nul-byte'
  if (raw.length > MAX_PATH_LENGTH) return 'too-long'
  const nameRefusal = checkName(raw)
  if (nameRefusal !== null) return nameRefusal
  return path.isAbsolute(raw) ? null : 'not-absolute'
}

export type RealpathOutcome = { readonly kind: 'found'; readonly real: string } | { readonly kind: 'missing' | 'error' }

export async function realpathOf(target: string): Promise<RealpathOutcome> {
  try {
    return { kind: 'found', real: await realpath(target) }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    return { kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error' }
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
    if ((await statIdentity(current))?.isSymbolicLink === true) return refuse('dangling-symlink')
    const parent = path.dirname(current)
    if (parent === current) return refuse('unresolvable')
    missing = [path.basename(current), ...missing]
    current = parent
  }
}

/**
 * The canonical form of an absolute path, through its nearest existing
 * ancestor when it does not exist yet; `null` when it cannot be resolved.
 */
export async function canonicalPath(raw: string): Promise<string | null> {
  const target = await canonicalTarget(path.resolve(raw))
  return target.ok ? target.real : null
}

/** A root that no longer resolves, or whose file system gives unreliable identities, is skipped — never trusted. Its trash counts only as a real folder. */
async function describeRoot(declared: string, stat: StatFn): Promise<RootInfo | null> {
  const outcome = await realpathOf(declared)
  if (outcome.kind !== 'found') return null
  const identity = await stat(outcome.real)
  if (identity === null) return null
  const trash = await stat(path.join(outcome.real, TRASH_DIR_NAME))
  const isRealTrash = trash !== null && trash.isDirectory && !trash.isSymbolicLink
  // Identities that cannot tell the root from its trash (or are 0) would collapse containment: unusable.
  if (identitiesCollapse(identity, isRealTrash ? trash : null)) return null
  return { declared: path.resolve(declared), canonical: outcome.real, identity, trash: isRealTrash ? trash : null }
}

function deepestRoot(chain: readonly ChainEntry[], roots: readonly RootInfo[]): ChainEntry | undefined {
  return chain.find((entry) => roots.some((root) => sameIdentity(root.identity, entry)))
}

function touchesTrash(chain: readonly ChainEntry[], roots: readonly RootInfo[]): boolean {
  return chain.some((entry) => roots.some((root) => root.trash !== null && sameIdentity(root.trash, entry)))
}

/**
 * The entries from the target up to the root decide the outcome, so each must
 * carry a real identity (entries above the root decide nothing and are not
 * looked at for that). No two ancestors of any depth may share one: on a real
 * disk they never do, and where they do the file system cannot tell folders apart.
 */
function isChainReliable(chain: readonly ChainEntry[], root: ChainEntry): boolean {
  const decisive = chain.slice(0, chain.indexOf(root) + 1)
  return decisive.every((entry) => isUsableIdentity(entry)) && !hasDuplicateIdentity(chain)
}

/** `target` below an ancestor taken from its own `dirname` chain — a plain slice, no re-spelling. */
function relativeBelow(ancestor: string, target: string): string {
  if (target === ancestor) return ''
  return target.slice(ancestor.endsWith(path.sep) ? ancestor.length : ancestor.length + 1)
}

/**
 * Resolves an agent-named path against the roots of the file module. `ok`
 * means the canonical target lies inside one of them and outside every
 * trash; nothing about the agent's operations on it — that is `rights.ts`.
 */
export async function resolveWithinRoots(
  raw: string,
  roots: readonly string[],
  stat: StatFn = statIdentity,
  volumeOf: VolumeOf = volumeKindOf,
): Promise<PathResult> {
  const syntaxRefusal = checkSyntax(raw)
  if (syntaxRefusal !== null) return refuse(syntaxRefusal)
  const lexical = path.resolve(raw)
  const infos = (await Promise.all(roots.map((root) => describeRoot(root, stat)))).filter((info) => info !== null)
  if (!isLexicallyUnder(lexical, infos.flatMap((info) => [info.declared, info.canonical]))) return refuse('outside-roots')
  const target = await canonicalTarget(lexical)
  if (!target.ok) return target
  const volume = await volumeOf(target.real)
  if (volume.kind === 'network') return networkVolumeRefusal(volume.fsType)
  const chain = await existingChain(target.real, stat)
  const root = deepestRoot(chain, infos)
  if (root === undefined || !isWithinOn(root.path, target.real)) return refuse('outside-roots')
  if (!isChainReliable(chain, root)) return refuse('unresolvable', UNRELIABLE_IDENTITIES_MESSAGE)
  const relative = relativeBelow(root.path, target.real)
  if (hasTrashSegment(relative) || touchesTrash(chain, infos)) return refuse('trash')
  return { ok: true, path: { root: root.path, absolute: target.real, relative, exists: target.exists, chain } }
}

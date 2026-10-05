import { lstat, mkdir, readdir, realpath, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { MAX_PATH_LENGTH, TRASH_DIR_NAME } from './constants.js'
import { identitiesCollapse, statIdentity, type StatFn } from './identity.js'
import { canonicalDataDir, overlapMessage, overlapsDataDir } from './data-overlap.js'
import { hasTrashSegment } from './names.js'
import { resolveWithinRoots } from './paths.js'

/**
 * Declaring a root (ADR-0020 §2, §3.7-3.8): the admin's path is made canonical,
 * checked, and the trash folder is created by mcpcut itself — before any agent
 * can name a path there. Every refusal is ONE line that says what to do.
 */

export type PrepareRootResult =
  | { readonly ok: true; readonly path: string; readonly trashCreated: boolean }
  | { readonly ok: false; readonly message: string }

const TRASH_MODE = 0o700
const PERMISSION_BITS = 0o777
/** What mcpcut itself puts in a trash: `<ulid>` folders, `<ulid>.json` manifests, and a manifest's temp file while it is written. */
const TRASH_ENTRY_NAME = /^(?:[0-9A-HJKMNP-TV-Z]{26}(?:\.json)?|\.manifest-[0-9A-HJKMNP-TV-Z]{26}\.tmp)$/

function refuse(message: string): PrepareRootResult {
  return { ok: false, message }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

/** The syntax of what the admin typed, before the disk is touched. */
function syntaxProblem(raw: string): string | null {
  if (raw === '') return 'the folder path is empty: pass an absolute path, e.g. /srv/data'
  if (raw.includes('\u0000')) return 'the path contains a NUL byte: retype the folder path'
  if (raw.length > MAX_PATH_LENGTH) return `the path is longer than ${MAX_PATH_LENGTH} characters: use a shorter folder`
  if (!path.isAbsolute(raw)) return `the path must be absolute: use ${path.resolve(raw)} (or another full path)`
  return null
}

/** A canonical folder, or the one-line reason it cannot be a root. */
async function existingFolder(raw: string): Promise<{ readonly real: string } | { readonly message: string }> {
  let real: string
  try {
    real = await realpath(raw)
  } catch (error: unknown) {
    const reason = errorCode(error) === 'ENOENT' ? 'does not exist' : `cannot be read (${errorCode(error) ?? 'error'})`
    return { message: `${raw} ${reason}: create it first (mkdir -p ${shellQuote(raw)}) or check the spelling` }
  }
  const stats = await stat(real).catch(() => null)
  if (stats === null || !stats.isDirectory()) {
    return { message: `${real} is not a folder: pass the folder that holds the files` }
  }
  return { real }
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

type TrashOutcome = { readonly ok: true; readonly created: boolean } | { readonly ok: false; readonly message: string }

/**
 * An existing entry named like the trash must be a real folder, not a link,
 * and ours: otherwise the agent (or anyone else) prepared it, and deleted
 * files would land where they choose.
 */
async function checkExistingTrash(trash: string): Promise<TrashOutcome> {
  const info = await lstat(trash).catch(() => null)
  if (info === null) return { ok: false, message: `${trash} cannot be inspected: remove or rename it, then run the command again` }
  if (info.isSymbolicLink()) {
    return { ok: false, message: `${trash} is a symbolic link: remove or rename it, then run the command again` }
  }
  if (!info.isDirectory()) {
    return { ok: false, message: `${trash} is not a folder: remove or rename it, then run the command again` }
  }
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    return { ok: false, message: `${trash} is owned by another user: remove or rename it, then run the command again` }
  }
  return checkExistingTrashShape(trash, info.mode)
}

/** On POSIX the trash is private (700) and holds only what mcpcut put there: nothing an agent or a stranger prepared. */
async function checkExistingTrashShape(trash: string, mode: number): Promise<TrashOutcome> {
  const inspect = 'inspect it, then remove or rename it and run the command again'
  if (process.platform !== 'win32' && (mode & PERMISSION_BITS) !== TRASH_MODE) {
    const actual = (mode & PERMISSION_BITS).toString(8)
    return { ok: false, message: `${trash} has mode ${actual}, not 700: ${inspect}` }
  }
  const names = await readdir(trash).catch(() => null)
  if (names === null) return { ok: false, message: `${trash} cannot be read: ${inspect}` }
  if (names.some((name) => !TRASH_ENTRY_NAME.test(name))) {
    return { ok: false, message: `${trash} holds entries mcpcut did not put there: ${inspect}` }
  }
  return { ok: true, created: false }
}

async function ensureTrash(root: string): Promise<TrashOutcome> {
  const trash = path.join(root, TRASH_DIR_NAME)
  try {
    await mkdir(trash, { mode: TRASH_MODE })
    return { ok: true, created: true }
  } catch (error: unknown) {
    if (errorCode(error) === 'EEXIST') return checkExistingTrash(trash)
    return { ok: false, message: `cannot create ${trash} (${errorCode(error) ?? 'error'}): give mcpcut write access to ${root}` }
  }
}

/**
 * Canonicalises and checks `raw`, then creates the root's trash. `existing`
 * are the roots already declared: a candidate inside one of their trashes is
 * refused by identity, not by spelling. Nested roots are allowed. A folder
 * that is, lies in or holds `dataDir` (mcpcut's own data) is refused.
 */
export async function prepareRoot(
  raw: string,
  existing: readonly string[] = [],
  identityOf: StatFn = statIdentity,
  dataDir?: string,
): Promise<PrepareRootResult> {
  const problem = syntaxProblem(raw)
  if (problem !== null) return refuse(problem)
  const folder = await existingFolder(raw)
  if ('message' in folder) return refuse(folder.message)
  const data = dataDir === undefined ? undefined : await canonicalDataDir(dataDir)
  if (data !== undefined && overlapsDataDir(folder.real, data)) return refuse(overlapMessage(folder.real, data))
  const trashNote = 'a root cannot be (or lie inside) a trash folder: declare the folder that holds the files'
  if (hasTrashSegment(folder.real)) return refuse(`${folder.real} is a trash folder: ${trashNote}`)
  const within = await resolveWithinRoots(folder.real, existing)
  if (!within.ok && within.refusal === 'trash') return refuse(`${folder.real} lies inside a trash folder: ${trashNote}`)
  const trash = await ensureTrash(folder.real)
  if (!trash.ok) return refuse(trash.message)
  if (await hasUnstableIdentities(folder.real, identityOf)) {
    if (trash.created) await rmdir(path.join(folder.real, TRASH_DIR_NAME)).catch(() => undefined)
    return refuse(`${folder.real} is on a file system that does not report stable file identities, so the folder cannot be shared safely: choose a folder on a local disk`)
  }
  return { ok: true, path: folder.real, trashCreated: trash.created }
}

/** The root and its trash must be told apart by identity (and neither may be 0), or containment would collapse. */
async function hasUnstableIdentities(folder: string, identityOf: StatFn): Promise<boolean> {
  const [identity, trash] = await Promise.all([identityOf(folder), identityOf(path.join(folder, TRASH_DIR_NAME))])
  return identity === null || trash === null || identitiesCollapse(identity, trash)
}

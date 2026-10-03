import { constants } from 'node:fs'
import { lstat, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { ulid } from 'ulid'
import { z } from 'zod'
import { TRASH_DIR_NAME } from './constants.js'
import { O_NOFOLLOW, O_NONBLOCK, fail, failFromErrno, succeed, type IoResult } from './io-common.js'

/**
 * The trash's manifests (ADR-0020 §4): `<trash>/<ulid>.json` beside the entry
 * folder `<trash>/<ulid>/`. A manifest is read through a schema and checked
 * against the id in its file name; a corrupt one is reported, never trusted.
 */

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/
const MAX_MANIFEST_BYTES = 64 * 1024
const MANIFEST_MODE = 0o600

export const trashManifestSchema = z.strictObject({
  id: z.string().regex(ULID_PATTERN),
  root: z.string().min(1),
  relative: z.string().min(1),
  originalPath: z.string().min(1),
  kind: z.enum(['file', 'directory']),
  /** Bytes for a file; 0 for a folder. */
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  deletedAt: z.iso.datetime(),
  deletedBy: z.string().min(1),
})

export type TrashManifest = z.infer<typeof trashManifestSchema>

/** Only a canonical ULID may be put into a path: no separator, no dots, no case games. */
export function isTrashId(value: string): boolean {
  return ULID_PATTERN.test(value)
}

export function trashDirOf(root: string): string {
  return path.join(root, TRASH_DIR_NAME)
}

export function manifestPath(trashDir: string, id: string): string {
  return path.join(trashDir, `${id}.json`)
}

const NO_TRASH_MESSAGE = 'The root has no trash folder: an administrator runs `mcpcut files root add <root>` again.'

/** The root's trash as a real folder (not a symlink), or `no-trash`. */
export async function requireTrashDir(root: string): Promise<IoResult<string>> {
  const trashDir = trashDirOf(root)
  try {
    const stats = await lstat(trashDir)
    if (stats.isDirectory() && !stats.isSymbolicLink()) return succeed(trashDir)
  } catch {
    // A missing or unreadable trash is the same answer: there is none to use.
  }
  return fail('no-trash', NO_TRASH_MESSAGE)
}

function corrupt(id: string): IoResult<never> {
  return fail('io-error', `The trash manifest ${id} is corrupt and was skipped: remove its files by hand after checking them.`)
}

/** Reads and validates `<trash>/<id>.json`; the caller has validated `id` as a ULID. */
export async function readManifest(trashDir: string, id: string): Promise<IoResult<TrashManifest>> {
  let handle
  try {
    handle = await open(manifestPath(trashDir, id), constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error: unknown) {
    return failFromErrno(error, 'reading the trash manifest')
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) return corrupt(id)
    const parsed = trashManifestSchema.safeParse(JSON.parse(await handle.readFile('utf8')))
    return parsed.success && parsed.data.id === id ? succeed(parsed.data) : corrupt(id)
  } catch {
    return corrupt(id)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Writes the manifest atomically: a temp file in the trash, fsync, then `rename`. */
export async function writeManifest(trashDir: string, manifest: TrashManifest): Promise<IoResult<null>> {
  const temp = path.join(trashDir, `.manifest-${ulid()}.tmp`)
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW
  try {
    const handle = await open(temp, flags, MANIFEST_MODE)
    try {
      await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, manifestPath(trashDir, manifest.id))
    return succeed(null)
  } catch (error: unknown) {
    await rm(temp, { force: true }).catch(() => undefined)
    return failFromErrno(error, 'writing the trash manifest')
  }
}

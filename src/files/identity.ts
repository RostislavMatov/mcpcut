import { lstat } from 'node:fs/promises'
import path from 'node:path'

/**
 * File identity — device and inode, as 64-bit integers (ADR-0020 §3). Two
 * spellings of one folder (NFC and NFD on macOS, a different letter case, an
 * 8.3 short name on Windows, a path through a symlink) are one identity, so
 * rules, roots and the trash are matched on identities, never on how a path
 * was typed.
 */

export interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

/** One existing ancestor of a target (the target itself first, if it exists). */
export interface ChainEntry extends FileIdentity {
  readonly path: string
}

export interface IdentityStat extends FileIdentity {
  readonly isDirectory: boolean
  readonly isSymbolicLink: boolean
}

/** `lstat` with bigint numbers; `null` when the path does not exist or cannot be read. */
export async function statIdentity(target: string): Promise<IdentityStat | null> {
  try {
    const stats = await lstat(target, { bigint: true })
    return { dev: stats.dev, ino: stats.ino, isDirectory: stats.isDirectory(), isSymbolicLink: stats.isSymbolicLink() }
  } catch {
    return null
  }
}

export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * The existing ancestors of a canonical path, closest first, up to the file
 * system root. A canonical path has no symlinks in it, so `lstat` of each
 * ancestor is the folder itself; names past the nearest existing one (a file
 * about to be created) have no identity yet and are skipped.
 */
export async function existingChain(canonical: string): Promise<readonly ChainEntry[]> {
  const ancestors: string[] = []
  for (let current = canonical; ; current = path.dirname(current)) {
    ancestors.push(current)
    if (path.dirname(current) === current) break
  }
  const stats = await Promise.all(ancestors.map((ancestor) => statIdentity(ancestor)))
  return ancestors.flatMap((ancestor, index) => {
    const stat = stats[index]
    return stat === null || stat === undefined ? [] : [{ path: ancestor, dev: stat.dev, ino: stat.ino }]
  })
}

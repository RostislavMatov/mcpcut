import { readFileSync as fsReadFileSync, statSync as fsStatSync } from 'node:fs'
import { stat as fsStat } from 'node:fs/promises'
import type { LoadPolicyOptions } from './load.js'

/**
 * File-system helpers for the hot-reload provider (`policy/reload.ts`): how a
 * file's VERSION is observed, in both the synchronous form the gate's hot
 * path uses and the asynchronous form explicit `refresh()` callers use, plus
 * the injectable seams tests replace them with.
 */

/** What a version check compares: the two `stat` fields a hand edit always moves. */
export interface PolicyFileVersion {
  readonly mtimeMs: number
  readonly size: number
}

/** Async `stat` seam. Rejects with `code: 'ENOENT'` for a missing file. */
export type PolicyStat = (path: string) => Promise<PolicyFileVersion>
/** Sync `stat` seam for the hot path. Throws with `code: 'ENOENT'` for a missing file. */
export type PolicyStatSync = (path: string) => PolicyFileVersion
/** Sync UTF-8 read seam for the hot path. */
export type PolicyReadFileSync = (path: string) => string

/** The sync pair the hot path needs; `null` when only an async reader was injected. */
export interface PolicySyncFs {
  readonly statSync: PolicyStatSync
  readonly readFileSync: PolicyReadFileSync
}

/** Sentinel version keys for the two ways a check can fail before any read. */
export const VERSION_ABSENT = 'absent'
export const VERSION_STAT_ERROR_PREFIX = 'stat-error:'

export interface ObservedVersion {
  readonly key: string
  readonly error?: string
}

/**
 * The version key for one check. A missing file and a failing `stat` are
 * versions in their own right, so each is reported once and a later
 * reappearance (or a different failure) is seen as a change.
 */
export async function observeVersion(stat: PolicyStat, sourcePath: string): Promise<ObservedVersion> {
  try {
    return { key: versionKeyOf(await stat(sourcePath)) }
  } catch (error: unknown) {
    return describeStatFailure(error, sourcePath)
  }
}

export function observeVersionSync(statSync: PolicyStatSync, sourcePath: string): ObservedVersion {
  try {
    return { key: versionKeyOf(statSync(sourcePath)) }
  } catch (error: unknown) {
    return describeStatFailure(error, sourcePath)
  }
}

function versionKeyOf(version: PolicyFileVersion): string {
  return `${version.mtimeMs}:${version.size}`
}

function describeStatFailure(error: unknown, sourcePath: string): ObservedVersion {
  if (isEnoent(error)) {
    return { key: VERSION_ABSENT, error: `policy file not found: ${sourcePath}` }
  }
  const cause = describeCause(error)
  return {
    key: `${VERSION_STAT_ERROR_PREFIX}${cause}`,
    error: `cannot stat policy file "${sourcePath}": ${cause}`,
  }
}

/**
 * The first candidate, in resolution order, that a fresh start would find.
 * Anything but ENOENT counts as present: an unreadable file at a higher
 * priority would fail a fresh start outright, which is just as much a
 * divergence from this process as a readable one.
 */
export async function firstExisting(stat: PolicyStat, candidates: readonly string[]): Promise<string | null> {
  for (const path of candidates) {
    try {
      await stat(path)
      return path
    } catch (error: unknown) {
      if (!isEnoent(error)) return path
    }
  }
  return null
}

export function firstExistingSync(statSync: PolicyStatSync, candidates: readonly string[]): string | null {
  for (const path of candidates) {
    try {
      statSync(path)
      return path
    } catch (error: unknown) {
      if (!isEnoent(error)) return path
    }
  }
  return null
}

/**
 * The async `stat` to use. Defaults to the file system — unless `loadOptions`
 * injects a `readFile` and nothing injects a `stat`: then the version is
 * derived from that same reader, so a test that fakes the file's CONTENT has
 * faked its version too, and no real `stat` runs against a fake path.
 */
export function defaultStatFor(loadOptions: LoadPolicyOptions): PolicyStat {
  const readFile = loadOptions.readFile
  return readFile !== undefined ? statViaReadFile(readFile) : fileSystemStat
}

/**
 * The sync pair for the hot path. Both injected → used; neither injected and
 * no async reader either → the real file system; otherwise `null`: an
 * injected async reader has no sync counterpart, so that configuration (test
 * seams only) keeps the scheduled asynchronous check.
 */
export function syncFsOf(
  loadOptions: LoadPolicyOptions,
  statSync: PolicyStatSync | undefined,
  readFileSync: PolicyReadFileSync | undefined,
): PolicySyncFs | null {
  if (statSync !== undefined && readFileSync !== undefined) return { statSync, readFileSync }
  if (loadOptions.readFile === undefined && statSync === undefined && readFileSync === undefined) {
    return { statSync: fileSystemStatSync, readFileSync: fileSystemReadSync }
  }
  return null
}

async function fileSystemStat(path: string): Promise<PolicyFileVersion> {
  const stats = await fsStat(path)
  return { mtimeMs: stats.mtimeMs, size: stats.size }
}

function fileSystemStatSync(path: string): PolicyFileVersion {
  const stats = fsStatSync(path)
  return { mtimeMs: stats.mtimeMs, size: stats.size }
}

function fileSystemReadSync(path: string): string {
  return fsReadFileSync(path, 'utf8')
}

/**
 * Versioning through an injected reader: the content IS the version. `size`
 * carries the text length and `mtimeMs` a cheap content fingerprint, so an
 * edit that keeps the length (`allow` -> `deny!`) still moves the key.
 */
function statViaReadFile(readFile: NonNullable<LoadPolicyOptions['readFile']>): PolicyStat {
  return async (path) => {
    const text = await readFile(path)
    return { mtimeMs: contentFingerprint(text), size: text.length }
  }
}

/** FNV-1a over UTF-16 code units: not a security primitive, only a change detector for a test seam. */
function contentFingerprint(text: string): number {
  const FNV_OFFSET = 0x811c9dc5
  const FNV_PRIME = 0x01000193
  let hash = FNV_OFFSET
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME) >>> 0
  }
  return hash
}

export function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

export function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** A diagnostics callback that throws must not take the provider down with it. */
export function safely(callback: () => void): void {
  try {
    callback()
  } catch {
    // Deliberately dropped: the only place left to report to is the callback that just failed.
  }
}

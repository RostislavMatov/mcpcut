import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The ONE implementation of the project's core "no secret ever persists
 * unredacted" sweep, shared by every suite that asserts over persisted bytes
 * (agents hardening, the m3/m4 e2e gates, the UI first-run test).
 * Keeping it single means the next hardening — an extra rendering, a new
 * side file, files created mid-scan — lands in every suite at once instead
 * of leaving diverged copies silently weaker.
 *
 * Recursively reads EVERY file under `dir` (state.db with its -wal/-shm
 * sidecars, vault.enc, *.jsonl journals, policy.json, approvals/**) and
 * returns the concatenated bytes rendered as BOTH utf8 and latin1, so a
 * secret cannot hide behind a byte sequence that is invalid UTF-8 inside a
 * binary page. `fileNames` (basenames) lets callers assert positive
 * sentinels — the scan really reached the store — before asserting a
 * secret's absence, so the check can never pass vacuously.
 */
export interface PersistedBytes {
  readonly fileNames: readonly string[]
  readonly renderings: readonly string[]
}

export interface PersistedBytesOptions {
  /**
   * Absolute paths left out of the sweep. The one legitimate use is the
   * setup code file BEFORE the owner is created, which holds the code by
   * design (phase 6, F6); a caller excluding it must assert its removal
   * afterwards and sweep again with nothing excluded.
   */
  readonly exclude?: readonly string[]
}

export async function collectPersistedBytes(
  dir: string,
  opts: PersistedBytesOptions = {},
): Promise<PersistedBytes> {
  const excluded = new Set(opts.exclude ?? [])
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files = entries.filter(
    (entry) => entry.isFile() && !excluded.has(join(entry.parentPath, entry.name)),
  )
  const chunks = await Promise.all(
    files.map((entry) => readFile(join(entry.parentPath, entry.name))),
  )
  const blob = Buffer.concat(chunks)
  return {
    fileNames: files.map((entry) => entry.name).sort(),
    renderings: [blob.toString('utf8'), blob.toString('latin1')],
  }
}

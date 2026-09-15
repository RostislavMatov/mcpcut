import { existsSync } from 'node:fs'
import { open, rm, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNAL_FILE_MODE } from '../config.js'
import { errnoCodeOf } from '../errno.js'
import { BOOTSTRAP_TOKEN_FILE_NAME } from './constants.js'

/**
 * The one-time bootstrap token file (phase 6, F6 / Q27).
 *
 * Before this file existed the first `ui` start printed the owner's token to
 * stderr, and under the service manager stderr IS `run/ui.log` — a live
 * credential in a log that is tailed, rotated by hand and shown to every
 * operator who can read it. Now the token goes to exactly one place, a 0600
 * file beside the store, and stderr names the path. The file is removed by
 * the first successful sign-in of ANY admin, web or console: once someone is
 * in, the credential has done its job and a copy left behind is only a leak.
 *
 * Every operation here is a host fact, not plane state, which is why none of
 * this touches the store: a wiped `state.db` may leave the file behind, and
 * the next bootstrap must be able to replace it rather than refuse.
 */

/** Where the file lives: `<journalDir>/bootstrap-token`, beside `state.db`. */
export function bootstrapTokenPathFor(journalDir: string): string {
  return join(journalDir, BOOTSTRAP_TOKEN_FILE_NAME)
}

/**
 * Opens the path exclusively (`'wx'`, 0600), replacing a leftover once.
 *
 * `'wx'` refuses a symlink as well as a file, so the leftover is removed as a
 * LINK — never followed, never written through — and the create is retried a
 * single time. A second refusal is the caller's problem: something other than
 * a stale file is sitting at the path.
 */
async function openExclusive(path: string): Promise<FileHandle> {
  try {
    return await open(path, 'wx', JOURNAL_FILE_MODE)
  } catch (error: unknown) {
    if (errnoCodeOf(error) !== 'EEXIST') throw error
  }
  await rm(path, { force: true })
  return open(path, 'wx', JOURNAL_FILE_MODE)
}

/**
 * Creates the file 0600 with `wx` and writes the token plus a newline; a
 * leftover from a wiped store is removed and the create retried once. The
 * write is fsynced so a crash right after the notice cannot leave an empty
 * file that names a token nobody has. A failed write removes the file the
 * create made — it is ours, since `'wx'` only succeeds on a free path — so
 * the caller's refusal is not contradicted by an empty file on disk.
 */
export async function writeBootstrapTokenFile(path: string, token: string): Promise<void> {
  const handle = await openExclusive(path)
  try {
    try {
      await handle.writeFile(`${token}\n`, { encoding: 'utf8' })
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error: unknown) {
    await rm(path, { force: true })
    throw error
  }
}

/** What removing the file came to. `absent` is the normal case after the first sign-in. */
export type ConsumeOutcome =
  | { readonly kind: 'removed' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Removes the file; never throws — a sign-in must not fail because a file
 * could not be unlinked. The caller decides what to do with `failed` (the
 * login flow writes a stderr line and answers as it would have anyway).
 * `unlink` rather than `rm --force`, because "was there and is gone" and
 * "was never there" are different facts for the caller's diagnostic.
 */
export async function consumeBootstrapTokenFile(path: string): Promise<ConsumeOutcome> {
  try {
    await unlink(path)
    return { kind: 'removed' }
  } catch (error: unknown) {
    if (errnoCodeOf(error) === 'ENOENT') return { kind: 'absent' }
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Sync, for the console's opening frame: a host fact like the install config,
 * read once when the sign-in screen is built. `false` on any error — a path
 * the process cannot answer for is not a file worth pointing an operator at.
 */
export function hasBootstrapTokenFile(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

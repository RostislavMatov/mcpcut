import { readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { errnoCodeOf } from '../../errno.js'
import { installConfigPath } from '../../setup/config-path.js'
import { writeFileAtomic } from '../../vault/files.js'
import { parseRemoteUrl } from './url.js'

/**
 * The remembered remote address (owner request, 2026-09-20): "remember the
 * last address — it's only logical." A one-field file beside the install
 * config, `<same dir>/remote.json`, so `MCPCUT_CONFIG` moves both together
 * and there is exactly one place on disk that names "this machine's install".
 *
 * Deliberately NOT a field of the install config itself: `setup/schema.ts`
 * is the schema of a config an operator edits by hand and `setup` rewrites in
 * full, while this file is written by an ordinary console session with no
 * `setup` in sight — mixing the two would mean a successful connect silently
 * rewriting a file `setup` owns (ADR-0014 §11 already drew this line for the
 * install config's own schema; the same reasoning applies here a second
 * time).
 *
 * The file NEVER holds a token, a name, or anything else that could
 * authenticate a request — only the address, which is exactly as sensitive as
 * a bookmark. `strictObject` is not a formality: an extra key is refused on
 * read rather than silently carried through, so a future mistake that put a
 * secret beside `url` fails loudly here instead of round-tripping it.
 *
 * Every read outcome is `absent` | `ok` | `invalid` — never a throw. A
 * console opening for the first time in months must not crash because this
 * one small file got corrupted; `invalid` is reported once, on stderr, by the
 * caller that knows where the console's own stderr is (`tui-cmd.ts`), and
 * then treated exactly like `absent`.
 */

export const SAVED_REMOTE_FILE_NAME = 'remote.json'

/** The schema's own version; bumped only if the shape ever needs to change. */
const SAVED_REMOTE_VERSION = 1

const savedRemoteSchema = z.strictObject({
  version: z.literal(SAVED_REMOTE_VERSION),
  url: z.string(),
})

/** Where the file lives: beside the resolved install config, never inside a data directory. */
export function savedRemotePathFor(env: NodeJS.ProcessEnv, home?: string): string {
  return join(dirname(installConfigPath(env, home)), SAVED_REMOTE_FILE_NAME)
}

export type SavedRemoteRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly url: string }
  | { readonly kind: 'invalid'; readonly message: string }

/**
 * Reads the saved address, re-validating it with the SAME parser `--remote`
 * itself is refused by: a file edited by hand into something `parseRemoteUrl`
 * would reject (credentials, a path, the wrong scheme) is `invalid`, not a
 * URL the console would go on to dial.
 */
export async function readSavedRemote(path: string): Promise<SavedRemoteRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (errnoCodeOf(error) === 'ENOENT') return { kind: 'absent' }
    return { kind: 'invalid', message: messageOf(error) }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'invalid', message: `${path}: not valid JSON` }
  }

  const shape = savedRemoteSchema.safeParse(parsed)
  if (!shape.success) return { kind: 'invalid', message: `${path}: unexpected shape` }

  const url = parseRemoteUrl(shape.data.url)
  if (!url.ok) return { kind: 'invalid', message: `${path}: ${url.message}` }

  return { kind: 'ok', url: url.url.origin }
}

/**
 * Writes the address atomically (temp file + rename, `writeFileAtomic`),
 * owner-only and with the parent directory created when it does not exist —
 * the same durability the install config itself is written with
 * (`setup/write.ts`), reused rather than re-implemented a third time.
 */
export async function writeSavedRemote(path: string, url: string): Promise<void> {
  const document = { version: SAVED_REMOTE_VERSION, url }
  await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`)
}

/**
 * Forgets the saved address. Idempotent — an absent file is exactly what a
 * second "forget" should find — and a failure that is NOT "already gone"
 * still throws, for the caller to turn into a stderr warning rather than a
 * silent no-op.
 */
export async function forgetSavedRemote(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    if (errnoCodeOf(error) !== 'ENOENT') throw error
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
